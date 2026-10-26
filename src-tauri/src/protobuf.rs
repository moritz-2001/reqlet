// Loads local protobuf projects into a finite editor catalog; ProjectResolver confines imports.
use protox::prost_reflect::Kind;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

/// Compiles a project off the async runtime, returning only serializable editing metadata.
#[tauri::command]
pub(super) async fn protobuf_load_source(
    root_path: String,
    include_paths: Vec<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || load(Path::new(&root_path), &include_paths))
        .await
        .map_err(|e| e.to_string())?
}

fn load(root: &Path, includes: &[String]) -> Result<Value, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("Project folder {}: {e}", root.display()))?;
    let mut roots = vec![root.clone()];
    for include in includes {
        let path = PathBuf::from(include)
            .canonicalize()
            .map_err(|e| format!("Import directory {include}: {e}"))?;
        if !roots.contains(&path) {
            roots.push(path);
        }
    }

    let mut files = Vec::new();
    scan(&root, &mut files, &mut 0)?;
    files.sort();
    if files.is_empty() {
        return Err("No .proto files found in this folder.".into());
    }

    let mut compiler = protox::Compiler::with_file_resolver(ProjectResolver {
        roots,
        bytes: std::cell::Cell::new(0),
        files: std::cell::Cell::new(0),
    });
    compiler.include_imports(true).include_source_info(true);
    compiler.open_files(&files).map_err(|e| format!("{e:?}"))?;
    let pool = compiler.descriptor_pool();
    let mut messages = BTreeMap::new();
    let mut message_files = BTreeMap::new();
    for message in pool.all_messages().filter(|m| !m.is_map_entry()) {
        let fields: Vec<Value> = message.fields().map(describe_field).collect();
        message_files.insert(
            message.full_name().to_owned(),
            message.parent_file().name().to_owned(),
        );
        messages.insert(message.full_name().to_owned(), fields);
    }
    let enums: BTreeMap<_, _> = pool
        .all_enums()
        .map(|e| {
            (
                e.full_name().to_owned(),
                e.values().map(|v| v.name().to_owned()).collect::<Vec<_>>(),
            )
        })
        .collect();
    Ok(json!({"messages":messages, "enums":enums, "messageFiles":message_files}))
}

fn describe_field(field: protox::prost_reflect::FieldDescriptor) -> Value {
    let oneof = field
        .containing_oneof()
        .filter(|_| {
            !field
                .field_descriptor_proto()
                .proto3_optional
                .unwrap_or(false)
        })
        .map(|group| group.name().to_owned());
    let map_value = match field.kind() {
        Kind::Message(message) if field.is_map() => {
            Some(kind_name(message.map_entry_value_field().kind()))
        }
        _ => None,
    };
    let mut documentation = field
        .parent_file()
        .file_descriptor_proto()
        .source_code_info
        .as_ref()
        .and_then(|info| {
            info.location
                .iter()
                .find(|location| location.path == field.path())
        })
        .and_then(|location| location.leading_comments.clone())
        .unwrap_or_default();
    if field
        .field_descriptor_proto()
        .options
        .as_ref()
        .is_some_and(|options| options.deprecated.unwrap_or(false))
    {
        documentation = format!("Deprecated. {documentation}");
    }

    json!({
        "name": field.name(), "jsonName": field.json_name(), "type": kind_name(field.kind()),
        "repeated": field.is_list(), "mapValue": map_value, "oneof": oneof,
        "documentation": documentation,
    })
}

fn kind_name(kind: Kind) -> String {
    match kind {
        Kind::Message(m) => m.full_name().to_owned(),
        Kind::Enum(e) => e.full_name().to_owned(),
        other => format!("{other:?}").to_lowercase(),
    }
}

fn scan(directory: &Path, files: &mut Vec<PathBuf>, bytes: &mut u64) -> Result<(), String> {
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.file_type().map_err(|e| e.to_string())?;
        if metadata.is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            scan(&entry.path(), files, bytes)?;
        } else if entry.path().extension().is_some_and(|ext| ext == "proto") {
            *bytes += entry.metadata().map_err(|e| e.to_string())?.len();
            files.push(entry.path());
            if files.len() > 10000 || *bytes > 32 * 1024 * 1024 {
                return Err("Protobuf project exceeds 10,000 files or 32 MiB.".into());
            }
        }
    }
    Ok(())
}

/// Resolves only canonical files within configured roots, including imported dependencies.
struct ProjectResolver {
    /// Canonical, distinct roots in configuration order; the project root comes first so
    /// discovered source paths retain their project-relative names.
    roots: Vec<PathBuf>,
    /// Total source bytes opened during this compilation, including imported dependencies.
    bytes: std::cell::Cell<u64>,
    /// Number of opened sources in this compilation; together with bytes, bounds the import graph.
    files: std::cell::Cell<usize>,
}
impl protox::file::FileResolver for ProjectResolver {
    fn resolve_path(&self, path: &Path) -> Option<String> {
        self.roots.iter().find_map(|root| {
            path.strip_prefix(root)
                .ok()?
                .to_str()
                .map(|s| s.replace('\\', "/"))
        })
    }

    fn open_file(&self, name: &str) -> Result<protox::file::File, protox::Error> {
        if Path::new(name)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err(protox::Error::file_not_found(name));
        }
        let mut found = None;
        for root in &self.roots {
            let candidate = root.join(name);
            if !candidate.exists() {
                continue;
            }
            let path = candidate
                .canonicalize()
                .map_err(|_| protox::Error::file_not_found(name))?;
            if !path.starts_with(root) {
                return Err(protox::Error::file_not_found(name));
            }
            // Overlapping roots can expose the same canonical file more than once.
            if let Some(previous) = &found {
                if previous != &path {
                    return Err(protox::Error::file_not_found(name));
                }
            } else {
                found = Some(path);
            }
        }
        if let Some(path) = found {
            let size = std::fs::metadata(&path)
                .map_err(|_| protox::Error::file_not_found(name))?
                .len();
            self.bytes.set(self.bytes.get() + size);
            self.files.set(self.files.get() + 1);
            if self.bytes.get() > 32 * 1024 * 1024 || self.files.get() > 10000 {
                return Err(protox::Error::file_not_found(name));
            }
            return protox::file::File::open(name, &path);
        }
        protox::file::GoogleFileResolver::new().open_file(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
