// Exercises the catalog's public navigation contract; Fixture owns temporary protobuf projects.
#![cfg(feature = "compile")]

use protobuf_catalog::{
    Catalog, FieldShape, MapKeyType, Presence, Reference, ScalarType, ValueType,
    compile::{self, Project},
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

#[test]
fn navigates_declarations_and_looks_up_fields_without_exposing_map_entries() {
    let fixture = Fixture::catalog();
    let catalog = fixture.load();
    let request = catalog.message("demo.Request").unwrap();

    assert_eq!(request.name(), "Request");
    assert_eq!(request.full_name(), "demo.Request");
    assert_eq!(
        request
            .fields()
            .map(|field| field.number())
            .collect::<Vec<_>>(),
        [1, 2, 3, 4, 5, 6, 7, 8]
    );
    let first_name = request.field("first_name").unwrap();
    assert_eq!(first_name.json_name(), "displayName");
    assert_eq!(first_name.full_name(), "demo.Request.first_name");
    assert_eq!(first_name.parent_message().full_name(), "demo.Request");
    assert_eq!(
        request.field_by_json_name("displayName").unwrap().number(),
        1
    );
    assert_eq!(request.field_by_number(1).unwrap().name(), "first_name");
    assert!(request.field("displayName").is_none());
    assert!(request.field_by_json_name("first_name").is_none());
    assert!(request.field_by_number(99).is_none());
    assert!(catalog.message("demo.Missing").is_none());

    assert_eq!(
        request
            .nested_messages()
            .map(|message| message.full_name().to_owned())
            .collect::<Vec<_>>(),
        ["demo.Request.Item"]
    );
    assert_eq!(
        request
            .nested_enums()
            .map(|enumeration| enumeration.full_name().to_owned())
            .collect::<Vec<_>>(),
        ["demo.Request.Kind"]
    );
    assert!(
        catalog
            .messages()
            .all(|message| !message.descriptor().is_map_entry())
    );
    assert_eq!(catalog.messages().count(), 3);
    assert_eq!(catalog.enums().count(), 2);
    assert_eq!(catalog.services().count(), 1);

    let file = catalog.file("request.proto").unwrap();
    assert_eq!(file.name(), "request.proto");
    assert_eq!(file.source(), Some(REQUEST));
    assert_eq!(
        file.messages()
            .map(|message| message.name().to_owned())
            .collect::<Vec<_>>(),
        ["Request"]
    );
    assert_eq!(
        file.dependencies()
            .map(|file| file.name().to_owned())
            .collect::<Vec<_>>(),
        ["common.proto"]
    );
    assert_eq!(catalog.file("common.proto").unwrap().enums().count(), 1);
}

#[test]
fn resolves_recursive_collection_and_enum_types_into_same_snapshot_handles() {
    let fixture = Fixture::catalog();
    let catalog = fixture.load();
    let request = catalog.message("demo.Request").unwrap();

    assert!(matches!(
        request.field("first_name").unwrap().shape(),
        FieldShape::Singular(ValueType::Scalar(ScalarType::String))
    ));
    match request.field("items").unwrap().shape() {
        FieldShape::Repeated(ValueType::Message(item)) => {
            assert_eq!(item.full_name(), "demo.Request.Item");
            assert_eq!(item.field("node").unwrap().number(), 1);
        }
        _ => panic!("items must be a repeated nested message"),
    }
    match request.field("nodes").unwrap().shape() {
        FieldShape::Map {
            key: MapKeyType::String,
            value: ValueType::Message(node),
        } => {
            assert_eq!(node.full_name(), "demo.Node");
            match node.field("child").unwrap().shape() {
                FieldShape::Singular(ValueType::Message(child)) => {
                    assert_eq!(child.full_name(), node.full_name());
                    assert_eq!(child.field("label").unwrap().json_name(), "label");
                }
                _ => panic!("Node.child must preserve its recursive message reference"),
            }
        }
        _ => panic!("nodes must hide the synthetic map-entry message"),
    }
    assert!(matches!(
        request.field("counts").unwrap().shape(),
        FieldShape::Map {
            key: MapKeyType::Int32,
            value: ValueType::Scalar(ScalarType::Uint64)
        }
    ));
    match request.field("mode").unwrap().shape() {
        FieldShape::Singular(ValueType::Enum(enumeration)) => {
            assert_eq!(enumeration.full_name(), "demo.Mode");
            assert_eq!(enumeration.value("MODE_FAST").unwrap().number(), 1);
        }
        _ => panic!("mode must navigate to its enum declaration"),
    }
}

#[test]
fn distinguishes_presence_from_real_oneof_membership() {
    let fixture = Fixture::catalog();
    fixture.write("legacy.proto", LEGACY);
    let catalog = fixture.load();
    let request = catalog.message("demo.Request").unwrap();

    assert_eq!(
        request.field("first_name").unwrap().presence(),
        Presence::Untracked
    );
    assert_eq!(
        request.field("alias").unwrap().presence(),
        Presence::Explicit
    );
    assert!(request.field("alias").unwrap().oneof().is_none());
    assert!(
        request
            .field("alias")
            .unwrap()
            .descriptor()
            .containing_oneof()
            .is_some()
    );
    assert_eq!(
        request.field("items").unwrap().presence(),
        Presence::Untracked
    );
    assert_eq!(
        request.field("nodes").unwrap().presence(),
        Presence::Untracked
    );
    assert_eq!(
        request
            .oneofs()
            .map(|oneof| oneof.name().to_owned())
            .collect::<Vec<_>>(),
        ["selection"]
    );

    let selected = request.field("selected_node").unwrap();
    assert_eq!(selected.presence(), Presence::Explicit);
    let oneof = selected.oneof().unwrap();
    assert_eq!(oneof.name(), "selection");
    assert_eq!(
        oneof
            .fields()
            .map(|field| field.name().to_owned())
            .collect::<Vec<_>>(),
        ["selected_node", "selected_label"]
    );

    let legacy = catalog.message("demo.Legacy").unwrap();
    assert_eq!(
        legacy.field("required_id").unwrap().presence(),
        Presence::Required
    );
    assert_eq!(
        legacy.field("optional_label").unwrap().presence(),
        Presence::Explicit
    );
    assert_eq!(legacy.field("node").unwrap().presence(), Presence::Explicit);
}

#[test]
fn preserves_enum_numbers_aliases_comments_and_structured_deprecation() {
    let fixture = Fixture::catalog();
    let catalog = fixture.load();
    let mode = catalog.enum_type("demo.Mode").unwrap();

    assert_eq!(mode.name(), "Mode");
    assert_eq!(
        mode.values()
            .map(|value| (value.name().to_owned(), value.number()))
            .collect::<Vec<_>>(),
        [
            ("MODE_UNSPECIFIED".into(), 0),
            ("MODE_FAST".into(), 1),
            ("MODE_QUICK".into(), 1)
        ]
    );
    assert!(mode.value("UNKNOWN").is_none());
    assert!(
        mode.declaration()
            .documentation
            .leading
            .contains("Available execution modes.")
    );
    let fast = mode.value("MODE_FAST").unwrap();
    assert!(
        fast.declaration()
            .documentation
            .leading
            .contains("Runs immediately.")
    );
    assert_eq!(fast.descriptor().number(), 1);
    assert!(mode.value("MODE_QUICK").unwrap().deprecated());

    let first_name = catalog
        .message("demo.Request")
        .unwrap()
        .field("first_name")
        .unwrap();
    assert!(first_name.deprecated());
    assert_eq!(
        first_name.declaration().documentation.leading.trim(),
        "User-visible name."
    );
}

#[test]
fn retains_source_comments_and_byte_coordinates_for_unicode_source() {
    let fixture = Fixture::new();
    let source = "syntax = \"proto3\";\npackage demo;\n\n// Detached context.\n\n// Item documentation with Grüße.\nmessage Item {\n  /* Größe */ string display_name = 1; // Tail documentation.\n}\n";
    fixture.write("unicode.proto", source);
    let catalog = fixture.load();
    let message = catalog.message("demo.Item").unwrap();
    let declaration = message.declaration();

    assert_eq!(declaration.file.source(), Some(source));
    assert!(
        declaration
            .documentation
            .leading
            .contains("Item documentation with Grüße.")
    );
    assert!(
        declaration
            .documentation
            .detached
            .iter()
            .any(|comment| comment.contains("Detached context."))
    );
    let message_location = declaration.location.unwrap();
    assert_eq!(message_location.start_line, 7);
    assert_eq!(message_location.start_column, 0);
    assert_eq!(message_location.end_line, 9);
    assert_eq!(message_location.end_column, 1);

    let field = message.field("display_name").unwrap();
    let field_declaration = field.declaration();
    assert!(
        field_declaration
            .documentation
            .trailing
            .contains("Tail documentation.")
    );
    let location = field_declaration.location.unwrap();
    let field_line = source.lines().nth(7).unwrap();
    assert_eq!(location.start_line, 8);
    assert_eq!(location.end_line, 8);
    assert_eq!(
        location.start_column as usize,
        field_line.find("string").unwrap()
    );
    assert_eq!(
        location.end_column as usize,
        field_line.find(';').unwrap() + 1
    );
    assert_ne!(
        location.start_column as usize,
        field_line[..field_line.find("string").unwrap()]
            .chars()
            .count()
    );
}

#[test]
fn descriptor_only_catalogs_preserve_semantics_without_inventing_source_text() {
    let fixture = Fixture::catalog();
    let compiled = fixture.load();
    let bytes = compiled.descriptor_pool().encode_to_vec();
    let decoded = Catalog::decode_descriptor_set(&bytes).unwrap();
    let wrapped = Catalog::from_descriptor_pool(compiled.descriptor_pool().clone());

    for catalog in [decoded, wrapped] {
        assert!(catalog.files().all(|file| file.source().is_none()));
        let request = catalog.message("demo.Request").unwrap();
        assert_eq!(
            request.field_by_json_name("displayName").unwrap().number(),
            1
        );
        assert!(request.declaration().location.is_some());
        assert!(
            request
                .field("first_name")
                .unwrap()
                .declaration()
                .documentation
                .leading
                .contains("User-visible name.")
        );
        assert_eq!(
            catalog
                .service("demo.Users")
                .unwrap()
                .method("Watch")
                .unwrap()
                .output()
                .full_name(),
            "demo.Node"
        );
    }
    assert!(Catalog::decode_descriptor_set(&[0xff]).is_err());
}

#[test]
fn handles_keep_their_immutable_source_snapshot_after_reload_and_catalog_drop() {
    let fixture = Fixture::new();
    let original = "syntax = \"proto3\"; package demo; message Request { string old_name = 1; }";
    fixture.write("request.proto", original);
    let old_message = fixture.load().message("demo.Request").unwrap();

    let replacement = "syntax = \"proto3\"; package demo; message Request { bool new_name = 2; }";
    fixture.write("request.proto", replacement);
    let reloaded = fixture.load();
    let new_message = reloaded.message("demo.Request").unwrap();
    drop(reloaded);
    fs::remove_file(fixture.root.join("request.proto")).unwrap();

    assert!(old_message.field("old_name").is_some());
    assert!(old_message.field("new_name").is_none());
    assert_eq!(old_message.declaration().file.source(), Some(original));
    assert!(new_message.field("new_name").is_some());
    assert!(new_message.field("old_name").is_none());
    assert_eq!(new_message.declaration().file.source(), Some(replacement));
}

#[test]
fn navigates_services_and_finds_references_through_maps_and_method_signatures() {
    let fixture = Fixture::catalog();
    let catalog = fixture.load();
    let service = catalog.service("demo.Users").unwrap();
    let watch = service.method("Watch").unwrap();

    assert_eq!(service.name(), "Users");
    assert_eq!(service.methods().count(), 2);
    assert!(service.method("Missing").is_none());
    assert_eq!(watch.name(), "Watch");
    assert_eq!(watch.full_name(), "demo.Users.Watch");
    assert_eq!(watch.input().full_name(), "demo.Request");
    assert_eq!(watch.output().full_name(), "demo.Node");
    assert!(watch.client_streaming());
    assert!(watch.server_streaming());
    assert_eq!(watch.declaration().file.name(), "request.proto");
    assert!(
        watch
            .declaration()
            .documentation
            .leading
            .contains("Streams matching nodes.")
    );

    let mut node_references = catalog
        .message("demo.Node")
        .unwrap()
        .references()
        .map(reference_name)
        .collect::<Vec<_>>();
    node_references.sort();
    assert_eq!(
        node_references,
        [
            "field:demo.Node.child",
            "field:demo.Request.Item.node",
            "field:demo.Request.nodes",
            "field:demo.Request.selected_node",
            "input:demo.Users.Echo",
            "output:demo.Users.Echo",
            "output:demo.Users.Watch",
        ]
    );
    assert_eq!(
        catalog
            .enum_type("demo.Mode")
            .unwrap()
            .references()
            .map(reference_name)
            .collect::<Vec<_>>(),
        ["field:demo.Request.mode"]
    );
    assert_eq!(
        catalog
            .message("demo.Request")
            .unwrap()
            .references()
            .map(reference_name)
            .collect::<Vec<_>>(),
        ["input:demo.Users.Watch"]
    );
}

#[test]
fn exposes_lossless_descriptors_for_options_reserved_ranges_and_explicit_defaults() {
    let fixture = Fixture::catalog();
    fixture.write("legacy.proto", LEGACY);
    let catalog = fixture.load();
    let legacy = catalog.message("demo.Legacy").unwrap();
    let descriptor = legacy.descriptor().descriptor_proto();

    assert_eq!(descriptor.reserved_name, ["removed_field"]);
    assert_eq!(descriptor.reserved_range[0].start, Some(10));
    assert_eq!(descriptor.reserved_range[0].end, Some(20));
    let label = legacy.field("optional_label").unwrap();
    assert_eq!(
        label
            .descriptor()
            .field_descriptor_proto()
            .default_value
            .as_deref(),
        Some("untitled")
    );
    assert!(
        matches!(label.explicit_default(), Some(prost_reflect::Value::String(value)) if value == "untitled")
    );
    assert!(
        legacy
            .field("required_id")
            .unwrap()
            .explicit_default()
            .is_none()
    );
    assert_eq!(
        catalog.file("legacy.proto").unwrap().descriptor().name(),
        "legacy.proto"
    );
    assert!(
        catalog
            .enum_type("demo.Mode")
            .unwrap()
            .descriptor()
            .enum_descriptor_proto()
            .options
            .as_ref()
            .unwrap()
            .allow_alias
            .unwrap()
    );

    let request = catalog.message("demo.Request").unwrap();
    assert!(
        request
            .field("first_name")
            .unwrap()
            .descriptor()
            .field_descriptor_proto()
            .options
            .as_ref()
            .unwrap()
            .deprecated
            .unwrap()
    );
    assert_eq!(
        catalog
            .descriptor_pool()
            .get_message_by_name("demo.Request")
            .unwrap()
            .full_name(),
        "demo.Request"
    );
}

#[test]
fn includes_extensions_that_reference_a_message_as_their_value_type() {
    let fixture = Fixture::catalog();
    fixture.write("legacy.proto", LEGACY);
    let catalog = fixture.load();
    let references = catalog
        .message("demo.Node")
        .unwrap()
        .references()
        .map(reference_name)
        .collect::<Vec<_>>();

    assert!(
        references
            .iter()
            .any(|reference| reference == "extension:demo.extension_node")
    );
    assert!(
        references
            .iter()
            .any(|reference| reference == "field:demo.Legacy.node")
    );
}

#[test]
fn preserves_custom_options_through_compilation_and_descriptor_roundtrips() {
    let fixture = Fixture::new();
    fixture.write(
        "options.proto",
        r#"syntax = "proto2";
package demo;
import "google/protobuf/descriptor.proto";

extend google.protobuf.MessageOptions {
  optional string audience = 50001;
}

message Tagged {
  option (audience) = "internal";
}
"#,
    );
    let compiled = fixture.load();
    let decoded =
        Catalog::decode_descriptor_set(&compiled.descriptor_pool().encode_to_vec()).unwrap();

    for catalog in [compiled, decoded] {
        let audience = catalog
            .descriptor_pool()
            .get_extension_by_name("demo.audience")
            .unwrap();
        let tagged = catalog.message("demo.Tagged").unwrap();
        let options = tagged.descriptor().options();
        assert!(options.has_extension(&audience));
        assert_eq!(
            options.get_extension(&audience).as_ref(),
            &prost_reflect::Value::String("internal".into())
        );
    }
}

fn reference_name(reference: Reference) -> String {
    match reference {
        Reference::Field(field) => format!("field:{}", field.full_name()),
        Reference::Extension(extension) => format!("extension:{}", extension.full_name()),
        Reference::MethodInput(method) => format!("input:{}", method.full_name()),
        Reference::MethodOutput(method) => format!("output:{}", method.full_name()),
    }
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "protobuf-catalog-model-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn catalog() -> Self {
        let fixture = Self::new();
        fixture.write("common.proto", COMMON);
        fixture.write("request.proto", REQUEST);
        fixture
    }

    fn write(&self, name: &str, contents: &str) {
        fs::write(self.root.join(name), contents).unwrap();
    }

    fn load(&self) -> Catalog {
        compile::load(&Project {
            root: self.root.clone(),
            include_paths: Vec::new(),
        })
        .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

const COMMON: &str = r#"syntax = "proto3";
package demo;

message Node {
  Node child = 1;
  string label = 2;
}

// Available execution modes.
enum Mode {
  option allow_alias = true;
  MODE_UNSPECIFIED = 0;
  // Runs immediately.
  MODE_FAST = 1;
  MODE_QUICK = 1 [deprecated = true];
}
"#;

const REQUEST: &str = r#"syntax = "proto3";
package demo;
import "common.proto";

message Request {
  message Item { Node node = 1; }
  enum Kind { KIND_UNSPECIFIED = 0; KIND_USER = 1; }
  repeated Item items = 3;
  // User-visible name.
  string first_name = 1 [json_name = "displayName", deprecated = true];
  optional string alias = 2;
  map<string, Node> nodes = 4;
  map<int32, uint64> counts = 5;
  Mode mode = 6;
  oneof selection {
    Node selected_node = 7;
    string selected_label = 8;
  }
}

service Users {
  // Streams matching nodes.
  rpc Watch(stream Request) returns (stream Node);
  rpc Echo(Node) returns (Node);
}
"#;

const LEGACY: &str = r#"syntax = "proto2";
package demo;
import "common.proto";

message Legacy {
  extensions 100 to max;
  reserved 10 to 19;
  reserved "removed_field";
  required int32 required_id = 1;
  optional string optional_label = 2 [default = "untitled"];
  optional Node node = 3;
}

extend Legacy {
  optional Node extension_node = 100;
}
"#;
