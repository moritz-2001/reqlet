//! Exercises public catalog projections as consumed by editors and inspectors.
//! Fixtures compile ordinary projects so tests also cover descriptor navigation.
#![cfg(feature = "compile")]

use protobuf_catalog::{
    Catalog,
    compile::{self, Project},
    json::{JsonForm, JsonNullBehavior, JsonShape},
};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

#[test]
fn snapshot_preserves_editor_payload_and_adds_semantics_without_expanding_cycles() {
    let fixture = Fixture::new(
        r#"syntax = "proto3";
package example;
enum State {
  option allow_alias = true;
  UNKNOWN = 0;
  ACTIVE = 2;
  ALIAS = 2;
  EARLIER_NUMBER = 1;
}
// An editable request.
message Request {
  reserved 10 to 12;
  reserved "removed";
  // Name displayed in the application.
  string first_name = 1 [json_name = "display", deprecated = true];
  repeated Request children = 2;
  map<string, Request> lookup = 3;
  State state = 4;
  oneof contact { string email = 5; int64 phone = 6; }
  optional bool enabled = 7;
}
service Requests {
  rpc Watch(stream Request) returns (stream Request);
}
"#,
    );
    let catalog = fixture.load();
    let snapshot = serde_json::to_value(catalog.to_snapshot()).unwrap();

    let fields = &snapshot["messages"]["example.Request"];
    assert_eq!(fields[0]["name"], "first_name");
    assert_eq!(fields[0]["jsonName"], "display");
    assert_eq!(fields[0]["type"], "string");
    assert_eq!(fields[0]["number"], 1);
    assert_eq!(fields[0]["deprecated"], true);
    assert!(
        fields[0]["documentation"]
            .as_str()
            .unwrap()
            .starts_with("Deprecated. ")
    );
    assert!(
        fields[0]["declaration"]["documentation"]["leading"]
            .as_str()
            .unwrap()
            .contains("Name displayed")
    );
    assert_eq!(fields[1]["type"], "example.Request");
    assert_eq!(fields[1]["repeated"], true);
    assert_eq!(fields[2]["repeated"], false);
    assert_eq!(fields[2]["mapValue"], "example.Request");
    assert_eq!(fields[2]["mapKeyType"], "string");
    assert_eq!(fields[2]["shape"]["value"]["name"], "example.Request");
    assert_eq!(fields[4]["oneof"], "contact");
    assert!(fields[6]["oneof"].is_null());
    assert_eq!(fields[6]["presence"], "explicit");

    assert_eq!(
        snapshot["enums"]["example.State"],
        json!(["UNKNOWN", "ACTIVE", "ALIAS", "EARLIER_NUMBER"])
    );
    let enum_details = &snapshot["enumDetails"]["example.State"];
    assert_eq!(enum_details["allowAlias"], true);
    assert_eq!(enum_details["values"][2]["number"], 2);
    let details = &snapshot["messageDetails"]["example.Request"];
    assert_eq!(details["oneofs"].as_array().unwrap().len(), 1);
    assert_eq!(
        details["reservedRanges"][0],
        json!({"start":10,"endExclusive":13})
    );
    assert_eq!(details["reservedNames"], json!(["removed"]));
    assert_eq!(snapshot["messageFiles"]["example.Request"], "request.proto");
    assert_eq!(snapshot["files"]["request.proto"]["syntax"], "proto3");
    assert!(
        snapshot["fileSources"]["request.proto"]
            .as_str()
            .unwrap()
            .contains("An editable request")
    );
    let method = &snapshot["services"]["example.Requests"]["methods"][0];
    assert_eq!(method["input"], "example.Request");
    assert_eq!(method["output"], "example.Request");
    assert_eq!(method["clientStreaming"], true);
    assert_eq!(method["serverStreaming"], true);
    assert_eq!(snapshot["messages"].as_object().unwrap().len(), 1);
}

#[test]
fn json_mapping_distinguishes_canonical_output_from_accepted_inputs() {
    let fixture = Fixture::new(
        r#"syntax = "proto3";
message Request {
  int64 sequence = 1;
  uint32 count = 2;
  bytes payload = 3;
  double ratio = 4;
  repeated int64 sequences = 5;
  map<bool, int64> values = 6;
}
"#,
    );
    let catalog = fixture.load();
    let request = catalog.message("Request").unwrap();
    let sequence = request.field("sequence").unwrap().json_representation();
    assert_eq!(sequence.canonical, vec![JsonForm::DecimalString]);
    assert_eq!(
        sequence.accepted,
        vec![JsonForm::Number, JsonForm::NumericString]
    );
    assert_eq!(sequence.null_behavior, JsonNullBehavior::Unset);
    let count = request.field("count").unwrap().json_representation();
    assert_eq!(count.canonical, vec![JsonForm::Number]);
    assert!(count.accepted.contains(&JsonForm::NumericString));
    let payload = request.field("payload").unwrap().json_representation();
    assert_eq!(payload.canonical, vec![JsonForm::Base64PaddedString]);
    assert_eq!(payload.accepted, vec![JsonForm::Base64String]);
    let ratio = request.field("ratio").unwrap().json_representation();
    assert_eq!(
        ratio.canonical,
        vec![JsonForm::Number, JsonForm::SpecialFloatString]
    );
    assert!(ratio.accepted.contains(&JsonForm::NumericString));

    let sequences = request.field("sequences").unwrap().json_representation();
    assert_eq!(sequences.null_behavior, JsonNullBehavior::Unset);
    let JsonShape::Array { element } = sequences.shape else {
        panic!("expected array")
    };
    assert_eq!(element.canonical, vec![JsonForm::DecimalString]);
    assert_eq!(element.null_behavior, JsonNullBehavior::Rejected);
    let values = request.field("values").unwrap().json_representation();
    let JsonShape::Map { value, .. } = values.shape else {
        panic!("expected map")
    };
    assert_eq!(value.null_behavior, JsonNullBehavior::Rejected);
}

#[test]
fn well_known_json_views_cover_dynamic_values_wrappers_and_any_without_recursion() {
    let fixture = Fixture::new(
        r#"syntax = "proto3";
import "google/protobuf/any.proto";
import "google/protobuf/timestamp.proto";
import "google/protobuf/duration.proto";
import "google/protobuf/field_mask.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/struct.proto";
import "google/protobuf/wrappers.proto";
message Request {
  google.protobuf.Any payload = 1;
  google.protobuf.Timestamp created = 2;
  google.protobuf.Duration duration = 3;
  google.protobuf.FieldMask mask = 4;
  google.protobuf.Empty empty = 5;
  google.protobuf.Struct properties = 6;
  google.protobuf.ListValue list = 7;
  google.protobuf.Value dynamic = 8;
  google.protobuf.Int64Value wrapped = 9;
  repeated google.protobuf.Int64Value wrapped_list = 10;
  repeated google.protobuf.Value dynamic_list = 11;
  repeated google.protobuf.NullValue null_list = 12;
}
"#,
    );
    let catalog = fixture.load();
    let view = |name: &str| catalog.message(name).unwrap().json_representation();
    assert!(matches!(view("google.protobuf.Any").shape, JsonShape::Any));
    assert!(matches!(
        view("google.protobuf.Timestamp").shape,
        JsonShape::Timestamp
    ));
    assert!(matches!(
        view("google.protobuf.Duration").shape,
        JsonShape::Duration
    ));
    assert!(matches!(
        view("google.protobuf.FieldMask").shape,
        JsonShape::FieldMask
    ));
    assert!(matches!(
        view("google.protobuf.Empty").shape,
        JsonShape::Message { .. }
    ));
    assert!(matches!(
        view("google.protobuf.Struct").shape,
        JsonShape::DynamicObject
    ));
    let wrapper = view("google.protobuf.Int64Value");
    assert_eq!(wrapper.canonical, vec![JsonForm::DecimalString]);
    assert_eq!(wrapper.null_behavior, JsonNullBehavior::Value);

    let request = catalog.message("Request").unwrap();
    assert_eq!(
        request
            .field("wrapped")
            .unwrap()
            .json_representation()
            .null_behavior,
        JsonNullBehavior::Value
    );
    let list = view("google.protobuf.ListValue");
    let JsonShape::Array { element } = list.shape else {
        panic!("expected array")
    };
    assert_eq!(element.null_behavior, JsonNullBehavior::Value);
    assert!(matches!(element.shape, JsonShape::DynamicValue));
    let wrapped_list = request.field("wrapped_list").unwrap().json_representation();
    let JsonShape::Array { element } = wrapped_list.shape else {
        panic!("expected array")
    };
    assert_eq!(element.null_behavior, JsonNullBehavior::Rejected);
    for field in ["dynamic_list", "null_list"] {
        let representation = request.field(field).unwrap().json_representation();
        let JsonShape::Array { element } = representation.shape else {
            panic!("expected array")
        };
        assert_eq!(element.null_behavior, JsonNullBehavior::Value);
        if field == "null_list" {
            assert_eq!(element.canonical, vec![JsonForm::Null]);
            assert!(element.accepted.contains(&JsonForm::EnumNumber));
        }
    }
}

#[test]
fn descriptor_only_snapshot_keeps_semantics_and_does_not_claim_source_text() {
    let fixture = Fixture::new(
        r#"syntax = "proto2";
enum State { ACTIVE = 1; reserved 4 to 6; }
message Request { optional State state = 1 [default = ACTIVE]; }
"#,
    );
    let original = fixture.load();
    let catalog = Catalog::from_descriptor_pool(original.descriptor_pool().clone());
    let snapshot = catalog.to_snapshot();
    assert!(snapshot.file_sources.is_empty());
    assert_eq!(
        snapshot.messages["Request"][0].declaration.descriptor_path,
        vec![4, 0, 2, 0]
    );
    assert_eq!(
        snapshot.messages["Request"][0].explicit_default.as_deref(),
        Some("ACTIVE")
    );
    assert_eq!(
        snapshot.enum_details["State"].reserved_ranges[0].end_exclusive,
        7
    );
    assert_eq!(
        snapshot.messages["Request"][0].json.canonical,
        vec![JsonForm::EnumName]
    );
    assert_eq!(
        snapshot.messages["Request"][0].json.accepted,
        vec![JsonForm::EnumName, JsonForm::EnumNumber]
    );
}

struct Fixture {
    directory: PathBuf,
}

impl Fixture {
    fn new(source: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let directory = std::env::temp_dir().join(format!(
            "protobuf-catalog-projections-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("request.proto"), source).unwrap();
        Self { directory }
    }

    fn load(&self) -> Catalog {
        compile::load(&Project {
            root: self.directory.clone(),
            include_paths: Vec::new(),
        })
        .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
