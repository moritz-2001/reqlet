// Adapts the reusable protobuf catalog to the existing Tauri completion command.
use protobuf_catalog::compile::{self, Project};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Compiles a project off the async runtime and serializes one catalog snapshot.
#[tauri::command]
pub(super) async fn protobuf_load_source(
    root_path: String,
    include_paths: Vec<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || load(Path::new(&root_path), &include_paths))
        .await
        .map_err(|error| error.to_string())?
}

fn load(root: &Path, includes: &[String]) -> Result<Value, String> {
    let result = compile::load_partial(&Project {
        root: root.to_owned(),
        include_paths: includes.iter().map(PathBuf::from).collect(),
    })
    .map_err(|error| match error {
        compile::LoadError::Compilation { source } => format!("{source:?}"),
        error => error.to_string(),
    })?;

    let mut snapshot =
        serde_json::to_value(result.catalog.to_snapshot()).map_err(|error| error.to_string())?;
    snapshot["loadDiagnostics"] = serde_json::json!(
        result
            .failures
            .into_iter()
            .map(|failure| {
                let detail = match failure.error {
                    compile::LoadError::Compilation { source } => format!("{source:?}"),
                    error => error.to_string(),
                };
                format!("{}: {detail}", failure.file.display())
            })
            .collect::<Vec<_>>()
    );
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn returns_valid_messages_and_diagnostics_for_failed_files() {
        let directory = fixture();
        std::fs::write(
            directory.join("broken.proto"),
            "syntax = \"proto3\"; import \"missing.proto\";",
        )
        .unwrap();
        std::fs::write(
            directory.join("valid.proto"),
            "syntax = \"proto3\"; message Valid {} ",
        )
        .unwrap();

        let catalog = load(&directory, &[]).unwrap();
        assert!(catalog["messages"]["Valid"].is_array());
        let diagnostics = catalog["loadDiagnostics"].as_array().unwrap();
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].as_str().unwrap().contains("missing.proto"));
        assert!(diagnostics[0].as_str().unwrap().contains("broken.proto"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn loads_imports_json_names_maps_and_recursive_messages() {
        let directory = fixture();
        std::fs::write(
            directory.join("child.proto"),
            "syntax = \"proto3\"; package demo; message Child { Child child = 1; }",
        )
        .unwrap();
        std::fs::write(directory.join("root.proto"), "syntax = \"proto3\"; package demo; import \"child.proto\"; message Request { string first_name = 1; map<string, Child> children = 2; }").unwrap();
        let catalog = load(&directory, &[]).unwrap();
        assert_eq!(
            catalog["messages"]["demo.Request"][0]["jsonName"],
            "firstName"
        );
        assert_eq!(
            catalog["messages"]["demo.Request"][1]["mapValue"],
            "demo.Child"
        );
        assert!(catalog["messages"]["demo.Child"].is_array());
        assert_eq!(catalog["messages"].as_object().unwrap().len(), 2);
        assert_eq!(catalog["messageFiles"]["demo.Request"], "root.proto");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn preserves_editor_metadata_for_nested_types_and_documented_fields() {
        let directory = fixture();
        std::fs::write(
            directory.join("request.proto"),
            r#"syntax = "proto3";
package demo;
message Request {
  enum State { UNKNOWN = 0; ACTIVE = 1; }
  message Detail { string value = 1; }
  // The name shown to the user.
  string display_name = 1 [json_name = "display", deprecated = true];
  repeated Detail details = 2;
  State state = 3;
  map<string, State> states = 4;
  repeated bool flags = 5;
}
"#,
        )
        .unwrap();

        let catalog = load(&directory, &[]).unwrap();
        let fields = &catalog["messages"]["demo.Request"];
        assert_eq!(fields[0]["name"], "display_name");
        assert_eq!(fields[0]["jsonName"], "display");
        let documentation = fields[0]["documentation"].as_str().unwrap();
        assert!(documentation.starts_with("Deprecated."));
        assert!(documentation.contains("The name shown to the user."));
        assert_eq!(fields[1]["type"], "demo.Request.Detail");
        assert_eq!(fields[1]["repeated"], true);
        assert_eq!(fields[2]["type"], "demo.Request.State");
        assert_eq!(fields[3]["mapValue"], "demo.Request.State");
        assert_eq!(fields[3]["repeated"], false);
        assert_eq!(fields[4]["type"], "bool");
        assert_eq!(fields[4]["repeated"], true);
        assert_eq!(
            catalog["enums"]["demo.Request.State"],
            json!(["UNKNOWN", "ACTIVE"])
        );
        assert_eq!(catalog["messages"].as_object().unwrap().len(), 2);
        assert_eq!(
            catalog["messageFiles"]["demo.Request.Detail"],
            "request.proto"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn distinguishes_explicit_oneofs_from_proto3_optional_fields() {
        let directory = fixture();
        std::fs::write(
            directory.join("request.proto"),
            r#"syntax = "proto3";
message Request {
  oneof contact { string email = 1; int64 phone = 2; }
  optional bool enabled = 3;
  string name = 4;
}
"#,
        )
        .unwrap();

        let catalog = load(&directory, &[]).unwrap();
        let fields = &catalog["messages"]["Request"];
        assert_eq!(fields[0]["oneof"], "contact");
        assert_eq!(fields[1]["oneof"], "contact");
        assert!(fields[2]["oneof"].is_null());
        assert!(fields[3]["oneof"].is_null());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn loads_proto2_fields_and_enum_aliases() {
        let directory = fixture();
        std::fs::write(
            directory.join("request.proto"),
            r#"syntax = "proto2";
package legacy;
enum State {
  option allow_alias = true;
  UNKNOWN = 0;
  UNSPECIFIED = 0;
  ACTIVE = 1;
}
message Request {
  required string name = 1;
  optional State state = 2 [default = ACTIVE];
  repeated sint64 values = 3 [packed = true];
}
"#,
        )
        .unwrap();

        let catalog = load(&directory, &[]).unwrap();
        let fields = &catalog["messages"]["legacy.Request"];
        assert_eq!(fields[0]["type"], "string");
        assert_eq!(fields[1]["type"], "legacy.State");
        assert!(fields[1]["oneof"].is_null());
        assert_eq!(fields[2]["type"], "sint64");
        assert_eq!(fields[2]["repeated"], true);
        let aliases = catalog["enums"]["legacy.State"].as_array().unwrap();
        assert_eq!(aliases.len(), 3);
        for name in ["UNKNOWN", "UNSPECIFIED", "ACTIVE"] {
            assert!(aliases.contains(&json!(name)));
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn resolves_builtin_well_known_imports_without_local_copies() {
        let directory = fixture();
        std::fs::write(
            directory.join("request.proto"),
            r#"syntax = "proto3";
import "google/protobuf/any.proto";
import "google/protobuf/timestamp.proto";
import "google/protobuf/struct.proto";
import "google/protobuf/wrappers.proto";
message Request {
  google.protobuf.Any payload = 1;
  google.protobuf.Timestamp created_at = 2;
  google.protobuf.Struct properties = 3;
  google.protobuf.Int64Value sequence = 4;
}
"#,
        )
        .unwrap();

        let catalog = load(&directory, &[]).unwrap();
        let fields = &catalog["messages"]["Request"];
        assert_eq!(fields[0]["type"], "google.protobuf.Any");
        assert_eq!(fields[1]["type"], "google.protobuf.Timestamp");
        assert_eq!(fields[2]["type"], "google.protobuf.Struct");
        assert_eq!(fields[3]["type"], "google.protobuf.Int64Value");
        assert!(catalog["messages"]["google.protobuf.Value"].is_array());
        assert_eq!(
            catalog["messageFiles"]["google.protobuf.Timestamp"],
            "google/protobuf/timestamp.proto"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn compiles_only_imported_sources_from_dependency_roots() {
        let directory = fixture();
        let project = directory.join("project");
        let dependency = directory.join("dependency");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&dependency).unwrap();
        std::fs::write(
            project.join("root.proto"),
            "syntax = \"proto3\"; import \"child.proto\"; message Request { Child child = 1; }",
        )
        .unwrap();
        write_message(&dependency.join("child.proto"));
        std::fs::write(dependency.join("unrelated.proto"), "invalid protobuf").unwrap();

        let catalog = load(&project, &[dependency.to_string_lossy().into_owned()]).unwrap();
        assert!(catalog["messages"]["Request"].is_array());
        assert!(catalog["messages"]["Child"].is_array());
        assert_eq!(catalog["messageFiles"]["Child"], "child.proto");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_projects_and_imports_above_the_source_byte_limit() {
        let directory = fixture();
        // Whitespace is valid protobuf, so rejection proves the size bound rather than a parse error.
        std::fs::write(
            directory.join("oversized.proto"),
            vec![b' '; 32 * 1024 * 1024 + 1],
        )
        .unwrap();
        assert!(load(&directory, &[]).unwrap_err().contains("32 MiB"));

        // A non-.proto dependency bypasses discovery and must still be bounded at import time.
        std::fs::rename(
            directory.join("oversized.proto"),
            directory.join("oversized.inc"),
        )
        .unwrap();
        std::fs::write(
            directory.join("root.proto"),
            "syntax = \"proto3\"; import \"oversized.inc\"; message Request {}",
        )
        .unwrap();
        assert!(load(&directory, &[]).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skips_directory_symlinks_and_rejects_imports_escaping_the_project() {
        let directory = fixture();
        let project = directory.join("project");
        let outside = directory.join("outside");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&outside).unwrap();
        write_message(&project.join("root.proto"));
        write_message(&outside.join("child.proto"));
        std::fs::write(outside.join("invalid.proto"), "invalid protobuf").unwrap();
        std::os::unix::fs::symlink(&outside, project.join("outside")).unwrap();
        std::os::unix::fs::symlink(&project, project.join("cycle")).unwrap();

        let catalog = load(&project, &[]).unwrap();
        assert_eq!(catalog["messages"].as_object().unwrap().len(), 1);

        std::fs::write(
            project.join("root.proto"),
            "syntax = \"proto3\"; import \"outside/child.proto\"; message Request { Child child = 1; }",
        )
        .unwrap();
        assert!(load(&project, &[]).is_err());

        std::fs::write(
            project.join("root.proto"),
            "syntax = \"proto3\"; import \"../outside/child.proto\"; message Request { Child child = 1; }",
        )
        .unwrap();
        assert!(load(&project, &[]).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reports_empty_folders_and_unresolved_imports() {
        let directory = fixture();
        assert!(load(&directory, &[]).unwrap_err().contains("No .proto"));
        std::fs::write(
            directory.join("root.proto"),
            "syntax = \"proto3\"; import \"missing.proto\";",
        )
        .unwrap();
        assert!(load(&directory, &[]).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn loads_project_when_its_folder_is_repeated_as_an_import_root() {
        let directory = fixture();
        write_message(&directory.join("root.proto"));
        let expected = load(&directory, &[]).unwrap();
        let path = directory.to_string_lossy().into_owned();

        assert_eq!(load(&directory, &[path.clone(), path]).unwrap(), expected);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn loads_repeated_dependency_roots() {
        let directory = fixture();
        let project = directory.join("project");
        let dependency = directory.join("dependency");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&dependency).unwrap();
        std::fs::write(
            project.join("root.proto"),
            "syntax = \"proto3\"; import \"child.proto\"; message Request { Child child = 1; }",
        )
        .unwrap();
        write_message(&dependency.join("child.proto"));
        let path = dependency.to_string_lossy().into_owned();
        let expected = load(&project, &[path.clone()]).unwrap();

        assert_eq!(load(&project, &[path.clone(), path]).unwrap(), expected);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn loads_equivalent_import_root_paths() {
        let directory = fixture();
        let nested = directory.join("nested");
        std::fs::create_dir(&nested).unwrap();
        write_message(&directory.join("root.proto"));
        let expected = load(&directory, &[]).unwrap();
        let includes = [directory.join("."), nested.join("..")]
            .map(|path| path.to_string_lossy().into_owned());

        assert_eq!(load(&directory, &includes).unwrap(), expected);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn loads_symlink_aliases_of_the_project_root() {
        let directory = fixture();
        let alias = directory.join("alias");
        write_message(&directory.join("root.proto"));
        std::os::unix::fs::symlink(&directory, &alias).unwrap();
        let expected = load(&directory, &[]).unwrap();
        let includes = [&directory, &alias].map(|path| path.to_string_lossy().into_owned());

        assert_eq!(load(&alias, &includes).unwrap(), expected);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn loads_one_canonical_import_reachable_through_overlapping_roots() {
        let directory = fixture();
        let dependency = directory.join("dependency");
        std::fs::create_dir(&dependency).unwrap();
        // Only .proto files are discovered; this dependency is opened through its import.
        write_message(&dependency.join("child.inc"));
        std::os::unix::fs::symlink(dependency.join("child.inc"), directory.join("child.inc"))
            .unwrap();
        std::fs::write(
            directory.join("root.proto"),
            "syntax = \"proto3\"; import \"child.inc\"; message Request { Child child = 1; }",
        )
        .unwrap();

        let catalog = load(&directory, &[dependency.to_string_lossy().into_owned()]).unwrap();
        assert!(catalog["messages"]["Request"].is_array());
        assert!(catalog["messages"]["Child"].is_array());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_distinct_files_with_the_same_import_name() {
        let directory = fixture();
        let project = directory.join("project");
        let first_dependency = directory.join("first");
        let second_dependency = directory.join("second");
        for path in [&project, &first_dependency, &second_dependency] {
            std::fs::create_dir(path).unwrap();
        }
        std::fs::write(
            project.join("root.proto"),
            "syntax = \"proto3\"; import \"child.proto\"; message Request { Child child = 1; }",
        )
        .unwrap();
        // Identical contents do not make two physical files an unambiguous import.
        write_message(&first_dependency.join("child.proto"));
        write_message(&second_dependency.join("child.proto"));
        let includes =
            [first_dependency, second_dependency].map(|path| path.to_string_lossy().into_owned());

        assert!(load(&project, &includes[..1]).is_ok());
        assert!(load(&project, &includes[1..]).is_ok());
        assert!(load(&project, &includes).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    fn write_message(path: &Path) {
        std::fs::write(
            path,
            "syntax = \"proto3\"; message Child { string value = 1; }",
        )
        .unwrap();
    }

    fn fixture() -> PathBuf {
        static NEXT_FIXTURE: std::sync::atomic::AtomicUsize =
            std::sync::atomic::AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "reqlet-protobuf-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }
}
