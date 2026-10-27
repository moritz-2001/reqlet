//! Exercises project loading through the public catalog interface; `Fixture` owns temporary files.

#![cfg(feature = "compile")]

use protobuf_catalog::compile::{LoadError, Project, load, load_partial};
use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn partially_loads_independent_files_and_reports_failed_entry_points() {
    let fixture = Fixture::new();
    fixture.write(
        "a_broken.proto",
        "syntax = \"proto3\"; import \"missing.proto\"; message Broken {}",
    );
    fixture.write(
        "b_dependent.proto",
        "syntax = \"proto3\"; import \"a_broken.proto\"; message Dependent { Broken value = 1; }",
    );
    fixture.write(
        "c_valid.proto",
        "syntax = \"proto3\"; package demo; message Valid { string name = 1; }",
    );

    let result = load_partial(&fixture.project()).unwrap();
    assert!(result.catalog.message("demo.Valid").is_some());
    assert!(result.catalog.message("Broken").is_none());
    assert!(result.catalog.message("Dependent").is_none());
    assert_eq!(
        result
            .failures
            .iter()
            .map(|failure| failure.file.as_path())
            .collect::<Vec<_>>(),
        vec![Path::new("a_broken.proto"), Path::new("b_dependent.proto")]
    );
    assert!(
        result
            .failures
            .iter()
            .all(|failure| failure.error.to_string().contains("missing.proto"))
    );
    assert!(load(&fixture.project()).is_err());

    fixture.write(
        "missing.proto",
        "syntax = \"proto3\"; message Dependency {}",
    );
    let recovered = load_partial(&fixture.project()).unwrap();
    assert!(recovered.failures.is_empty());
    assert!(recovered.catalog.message("Dependent").is_some());
}

#[test]
fn partial_loading_still_fails_when_no_entry_point_compiles() {
    let fixture = Fixture::new();
    fixture.write(
        "broken.proto",
        "syntax = \"proto3\"; import \"missing.proto\";",
    );

    assert!(
        load_partial(&fixture.project())
            .unwrap_err()
            .to_string()
            .contains("missing.proto")
    );
}

#[test]
fn captures_the_exact_sources_used_for_imports_and_recursive_types() {
    let fixture = Fixture::new();
    let child = "syntax = \"proto3\"; package demo; message Child { Child child = 1; }\n";
    let request = "syntax = \"proto3\"; package demo; import \"child.proto\"; message Request { string first_name = 1; map<string, Child> children = 2; }\n";
    fixture.write("child.proto", child);
    fixture.write("request.proto", request);

    let catalog = load(&fixture.project()).unwrap();
    let message = catalog.message("demo.Request").unwrap();
    assert_eq!(
        message
            .field("first_name")
            .unwrap()
            .descriptor()
            .json_name(),
        "firstName"
    );
    assert!(message.field("children").unwrap().descriptor().is_map());
    let child_message = catalog.message("demo.Child").unwrap();
    assert_eq!(
        child_message.field("child").unwrap().descriptor().kind(),
        protox::prost_reflect::Kind::Message(child_message.descriptor().clone())
    );
    assert_eq!(catalog.file("child.proto").unwrap().source(), Some(child));
    assert_eq!(
        catalog.file("request.proto").unwrap().source(),
        Some(request)
    );

    fixture.write(
        "request.proto",
        "syntax = \"proto3\"; message Replacement {}",
    );
    assert_eq!(
        catalog.file("request.proto").unwrap().source(),
        Some(request)
    );
    assert!(catalog.message("demo.Request").is_some());
    assert!(
        load(&fixture.project())
            .unwrap()
            .message("Replacement")
            .is_some()
    );
}

#[test]
fn captures_unicode_comments_without_normalizing_source_text() {
    let fixture = Fixture::new();
    let source = "syntax = \"proto3\";\r\n// Grüße 👋\r\nmessage Request {}\r\n";
    fixture.write("request.proto", source);

    let catalog = load(&fixture.project()).unwrap();
    assert_eq!(
        catalog.file("request.proto").unwrap().source(),
        Some(source)
    );
}

#[test]
fn loads_builtin_descriptors_without_inventing_source_text() {
    let fixture = Fixture::new();
    fixture.write(
        "request.proto",
        "syntax = \"proto3\"; import \"google/protobuf/timestamp.proto\"; message Request { google.protobuf.Timestamp created_at = 1; }",
    );

    let catalog = load(&fixture.project()).unwrap();
    assert!(catalog.message("google.protobuf.Timestamp").is_some());
    assert_eq!(
        catalog
            .file("google/protobuf/timestamp.proto")
            .unwrap()
            .source(),
        None
    );
}

#[test]
fn loads_google_http_annotations_without_external_import_directories() {
    let fixture = Fixture::new();
    fixture.directory("etcd");
    fixture.write(
        "etcd/rpc.proto",
        r#"syntax = "proto3";
package etcdserverpb;
import "google/api/annotations.proto";
message Request { string key = 1; }
message Response {}
service KV {
  rpc Range(Request) returns (Response) {
    option (google.api.http) = {
      post: "/v3/kv/range"
      body: "*"
      additional_bindings { get: "/v3/kv/{key}" }
    };
  }
}
"#,
    );

    let catalog = load(&fixture.project()).unwrap();
    assert!(catalog.message("etcdserverpb.Request").is_some());
    assert!(catalog.service("etcdserverpb.KV").is_some());
    assert!(catalog.message("google.api.HttpRule").is_some());
    assert!(catalog.file("google/api/annotations.proto").is_some());
    assert!(catalog.file("google/api/http.proto").is_some());
}

#[test]
fn configured_google_api_files_override_bundled_definitions() {
    let fixture = Fixture::new();
    fixture.directory("google");
    fixture.directory("google/api");
    fixture.write(
        "request.proto",
        "syntax = \"proto3\"; import \"google/api/http.proto\"; message Request { google.api.LocalDefinition value = 1; }",
    );
    let local = "syntax = \"proto3\"; package google.api; message LocalDefinition {}";
    fixture.write("google/api/http.proto", local);

    let catalog = load(&fixture.project()).unwrap();
    assert!(catalog.message("google.api.LocalDefinition").is_some());
    assert_eq!(
        catalog.file("google/api/http.proto").unwrap().source(),
        Some(local)
    );
}

#[test]
fn only_compiles_imported_sources_from_dependency_roots() {
    let fixture = Fixture::new();
    fixture.directory("project");
    fixture.directory("dependency");
    fixture.write(
        "project/request.proto",
        "syntax = \"proto3\"; import \"child.inc\"; message Request { Child child = 1; }",
    );
    fixture.write("dependency/child.inc", CHILD);
    fixture.write("dependency/unrelated.proto", "invalid protobuf");
    let project = Project {
        root: fixture.path("project"),
        include_paths: vec![fixture.path("dependency")],
    };

    let catalog = load(&project).unwrap();
    assert!(catalog.message("Request").is_some());
    assert!(catalog.message("Child").is_some());
    assert_eq!(catalog.file("child.inc").unwrap().source(), Some(CHILD));
    assert!(catalog.file("unrelated.proto").is_none());
}

#[test]
fn deduplicates_repeated_and_equivalent_import_roots() {
    let fixture = Fixture::new();
    fixture.directory("project");
    fixture.directory("dependency");
    fixture.directory("dependency/nested");
    fixture.write(
        "project/request.proto",
        "syntax = \"proto3\"; import \"child.proto\"; message Request { Child child = 1; }",
    );
    fixture.write("dependency/child.proto", CHILD);
    let project = Project {
        root: fixture.path("project"),
        include_paths: vec![
            fixture.path("project"),
            fixture.path("project/../project"),
            fixture.path("dependency"),
            fixture.path("dependency/nested/.."),
        ],
    };

    let catalog = load(&project).unwrap();
    assert!(catalog.message("Request").is_some());
    assert_eq!(catalog.file("child.proto").unwrap().source(), Some(CHILD));
}

#[test]
fn reports_ambiguous_import_names_with_both_canonical_paths() {
    let fixture = Fixture::new();
    for directory in ["project", "first", "second"] {
        fixture.directory(directory);
    }
    fixture.write(
        "project/request.proto",
        "syntax = \"proto3\"; import \"child.proto\"; message Request { Child child = 1; }",
    );
    fixture.write("first/child.proto", CHILD);
    fixture.write("second/child.proto", CHILD);
    let project = Project {
        root: fixture.path("project"),
        include_paths: vec![fixture.path("first"), fixture.path("second")],
    };

    match load(&project).unwrap_err() {
        LoadError::AmbiguousImport {
            name,
            first,
            second,
        } => {
            assert_eq!(name, "child.proto");
            assert_eq!(
                first,
                fixture.path("first/child.proto").canonicalize().unwrap()
            );
            assert_eq!(
                second,
                fixture.path("second/child.proto").canonicalize().unwrap()
            );
        }
        error => panic!("expected ambiguous import, got {error:?}"),
    }
}

#[test]
fn reports_empty_projects_and_filesystem_errors_structurally() {
    let fixture = Fixture::new();
    assert!(matches!(
        load(&fixture.project()).unwrap_err(),
        LoadError::NoSources { root } if root == fixture.root.canonicalize().unwrap()
    ));
    let project = Project {
        root: fixture.path("missing"),
        include_paths: Vec::new(),
    };
    let error = load(&project).unwrap_err();
    assert!(error.source().is_some());
    assert!(matches!(error, LoadError::Io { path, .. } if path == project.root));
}

#[test]
fn retains_original_compiler_diagnostics_for_missing_imports_and_invalid_source() {
    let fixture = Fixture::new();
    fixture.write(
        "request.proto",
        "syntax = \"proto3\"; import \"missing.proto\"; message Request {}",
    );
    match load(&fixture.project()).unwrap_err() {
        LoadError::Compilation { source } => {
            assert!(source.is_file_not_found());
            assert_eq!(source.file(), Some("request.proto"));
        }
        error => panic!("expected compiler diagnostics, got {error:?}"),
    }

    fixture.write("request.proto", "syntax = \"proto3\"; message Request {");
    match load(&fixture.project()).unwrap_err() {
        LoadError::Compilation { source } => {
            assert!(source.is_parse());
            assert_eq!(source.file(), Some("request.proto"));
        }
        error => panic!("expected parse diagnostics, got {error:?}"),
    }
}

#[test]
fn rejects_invalid_utf8_with_the_source_path() {
    let fixture = Fixture::new();
    fs::write(fixture.path("request.proto"), [0xff]).unwrap();

    match load(&fixture.project()).unwrap_err() {
        LoadError::Io { path, source, .. } => {
            assert_eq!(path, fixture.path("request.proto").canonicalize().unwrap());
            assert_eq!(source.kind(), std::io::ErrorKind::InvalidData);
        }
        error => panic!("expected UTF-8 filesystem error, got {error:?}"),
    }
}

#[test]
fn bounds_actual_source_bytes_for_entry_points_and_imported_files() {
    let fixture = Fixture::new();
    let oversized = fixture.path("oversized.proto");
    fs::write(&oversized, vec![b' '; 32 * 1024 * 1024 + 1]).unwrap();
    assert!(matches!(
        load(&fixture.project()).unwrap_err(),
        LoadError::SourcesTooLarge {
            limit: 33_554_432,
            ..
        }
    ));

    fs::rename(&oversized, fixture.path("oversized.inc")).unwrap();
    fixture.write(
        "request.proto",
        "syntax = \"proto3\"; import \"oversized.inc\"; message Request {}",
    );
    assert!(matches!(
        load(&fixture.project()).unwrap_err(),
        LoadError::SourcesTooLarge {
            limit: 33_554_432,
            ..
        }
    ));
}

#[test]
fn bounds_the_combined_size_of_individually_valid_sources() {
    let fixture = Fixture::new();
    // Neither source exceeds the budget alone. Whitespace also avoids conflating
    // the resource limit with a parsing error.
    fixture.write("first.proto", &" ".repeat(17 * 1024 * 1024));
    fixture.write("second.proto", &" ".repeat(16 * 1024 * 1024));

    assert!(matches!(
        load(&fixture.project()).unwrap_err(),
        LoadError::SourcesTooLarge { .. }
    ));
}

#[test]
fn bounds_the_number_of_discovered_entry_points() {
    let fixture = Fixture::new();
    for index in 0..10_001 {
        fixture.write(&format!("entry-{index}.proto"), "");
    }

    assert!(matches!(
        load(&fixture.project()).unwrap_err(),
        LoadError::TooManySources { limit: 10_000, .. }
    ));
}

#[cfg(unix)]
#[test]
fn skips_directory_symlinks_and_rejects_imports_escaping_the_project() {
    let fixture = Fixture::new();
    fixture.directory("project");
    fixture.directory("outside");
    fixture.write("project/request.proto", CHILD);
    fixture.write("outside/child.proto", CHILD);
    fixture.write("outside/invalid.proto", "invalid protobuf");
    std::os::unix::fs::symlink(fixture.path("outside"), fixture.path("project/outside")).unwrap();
    std::os::unix::fs::symlink(fixture.path("project"), fixture.path("project/cycle")).unwrap();
    let project = Project {
        root: fixture.path("project"),
        include_paths: Vec::new(),
    };
    assert!(load(&project).unwrap().message("Child").is_some());

    fixture.write(
        "project/request.proto",
        "syntax = \"proto3\"; import \"outside/child.proto\"; message Request { Child child = 1; }",
    );
    assert!(matches!(
        load(&project).unwrap_err(),
        LoadError::EscapingImport { .. }
    ));

    fixture.write(
        "project/request.proto",
        "syntax = \"proto3\"; import \"../outside/child.proto\"; message Request { Child child = 1; }",
    );
    // The parser may reject parent-relative imports before resolution begins.
    assert!(load(&project).is_err());
}

#[cfg(unix)]
#[test]
fn accepts_symlink_aliases_of_roots_and_one_file_shared_by_overlapping_roots() {
    let fixture = Fixture::new();
    fixture.directory("dependency");
    fixture.write("dependency/child.inc", CHILD);
    std::os::unix::fs::symlink(
        fixture.path("dependency/child.inc"),
        fixture.path("child.inc"),
    )
    .unwrap();
    std::os::unix::fs::symlink(&fixture.root, fixture.path("alias")).unwrap();
    fixture.write(
        "request.proto",
        "syntax = \"proto3\"; import \"child.inc\"; message Request { Child child = 1; }",
    );
    let project = Project {
        root: fixture.path("alias"),
        include_paths: vec![fixture.root.clone(), fixture.path("dependency")],
    };

    let catalog = load(&project).unwrap();
    assert!(catalog.message("Request").is_some());
    assert_eq!(catalog.file("child.inc").unwrap().source(), Some(CHILD));
}

const CHILD: &str = "syntax = \"proto3\"; message Child { string value = 1; }";

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "protobuf-catalog-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self { root }
    }

    fn project(&self) -> Project {
        Project {
            root: self.root.clone(),
            include_paths: Vec::new(),
        }
    }

    fn path(&self, relative: impl AsRef<Path>) -> PathBuf {
        self.root.join(relative)
    }

    fn directory(&self, relative: &str) {
        fs::create_dir(self.path(relative)).unwrap();
    }

    fn write(&self, relative: &str, source: &str) {
        fs::write(self.path(relative), source).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
