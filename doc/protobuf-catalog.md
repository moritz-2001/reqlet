# Protobuf catalog

[`protobuf-catalog`](../crates/protobuf-catalog/src/lib.rs) is a reusable Rust
library for exploring an immutable protobuf project. It has no dependency on
Tauri, Vue, CodeMirror, request configuration, or an async runtime. The application
uses its serializable projection for JSON completion; the Rust API also supports
schema inspection, declaration navigation, and reference queries.

## Loading and using a catalog

```rust
use protobuf_catalog::{compile, FieldShape, ValueType};

let catalog = compile::load(&compile::Project {
    root: "models".into(),
    include_paths: vec!["third_party".into()],
})?;

if let Some(request) = catalog.message("company.users.CreateUserRequest") {
    for field in request.fields() {
        println!("{} #{}", field.json_name(), field.number());
        if let FieldShape::Singular(ValueType::Message(child)) = field.shape() {
            println!("references {}", child.full_name());
        }
    }

    let declaration = request.declaration();
    if let Some(source) = declaration.file.source() {
        // This is the exact file text used to produce this snapshot.
    }
}
```

The default `compile` feature provides
[`compile::load`](../crates/protobuf-catalog/src/compile.rs), with project discovery,
configured import roots, built-in protobuf well-known descriptors and Google HTTP
annotation definitions, and structured load errors. The bundled
[`annotations.proto`](../crates/protobuf-catalog/vendor/google/api/annotations.proto)
and [`http.proto`](../crates/protobuf-catalog/vendor/google/api/http.proto) come
from the Apache-2.0 licensed [Google APIs repository](https://github.com/googleapis/googleapis/tree/master/google/api),
retrieved on 2026-10-27. Configured local files take precedence; other third-party
imports must be supplied in an import root.
`compile::load` remains strict. `compile::load_partial` instead returns a
`PartialLoad` containing the current catalog and a `FileFailure` for each skipped
entry point. It keeps independently compiled messages available, while global
setup failures, resource limits, and a failure of every entry point return an
error. For example, `let result = compile::load_partial(&project)?;` allows
`result.catalog.message("company.users.CreateUserRequest")` to be queried while
`result.failures` reports unrelated failures. A failed entry point's successfully
compiled dependencies can still appear in the catalog.
It skips symlink entries during discovery, confines imports to canonical roots,
deduplicates equivalent roots, and rejects different files exposed under the same
import name. Limits cover 10,000 discovered/local source files and 32 MiB of actual
UTF-8 source bytes, including imported files with other extensions. Source reads
are bounded before parsing. Compiler errors retain their original diagnostics.

Without a compiler or filesystem, use
`Catalog::decode_descriptor_set(&bytes)` or
`Catalog::from_descriptor_pool(pool)`. `default-features = false` omits `protox`;
navigation, descriptor decoding, source-location metadata, JSON views, and
serialization remain available. Descriptor sets do not contain original source
text, even when they include source locations and comments.

## Ownership and interfaces

[`Catalog`](../crates/protobuf-catalog/src/lib.rs) shares immutable descriptors,
captured sources, and a reverse-reference index through `Arc`. The descriptors
from `prost-reflect` are the semantic authority. No parallel mutable descriptor
model is maintained. Each construction builds the reference index once.

[`Message`, `Field`, `Enum`, `EnumValue`, `Oneof`, `File`, `Service`, and `Method`](../crates/protobuf-catalog/src/model.rs)
are inexpensive cloneable handles. A handle retains the entire snapshot and stays
valid after the original catalog is dropped or a replacement is loaded. This also
means keeping an old handle retains its old source text. A reload does not mutate
existing handles. Persist fully qualified names, rather than a handle or an index.

The main navigation operations are:

- `catalog.message`, `enum_type`, `service`, and `file` perform exact lookup.
  Type names have no leading dot; file names are logical import names rather than
  absolute filesystem paths. Missing identities return `None`.
- `message.fields()` uses ascending field-number order. `field`,
  `field_by_json_name`, and `field_by_number` keep their lookup rules explicit.
- `field.shape()` distinguishes singular, repeated, and map values. Message and
  enum values return handles, so recursive graphs remain finite. Map key types
  preserve their exact protobuf scalar kind; synthetic entry messages are hidden.
- `field.presence()` distinguishes untracked presence, explicit presence, and
  proto2 required fields. Explicit presence does not imply an `optional` keyword.
  `oneof()` and `message.oneofs()` expose only real exclusive groups.
- `enum.values()` preserves source declaration order, numeric aliases, comments,
  and deprecation. Declaration order determines the first alias for JSON output.
- `message.references()` and `enum.references()` return ordinary field value uses,
  extension value uses, and RPC endpoint uses. Maps reference their ordinary field;
  extension extendee relationships are not counted as value-type references.
- Services navigate to method signatures, streaming directions, and input/output
  message handles. File handles navigate to imports and top-level declarations.
- `descriptor()` and `descriptor_pool()` expose complete read-only metadata,
  including custom options, reserved ranges, packing, and synthetic declarations.
  `field.explicit_default()` returns a declared default, independently of an
  effective protobuf default or an editor's insertion policy.

The reverse-reference index stores descriptors instead of catalog handles. A
catalog handle inside its own index would form an `Arc` ownership cycle.

## Source context

[`Declaration`](../crates/protobuf-catalog/src/source.rs) is ordinary owned
metadata containing a file handle, a descriptor path, separated leading/trailing/
detached comments, and an optional declaration span. Its fields are directly
accessible. Captured text is stored once per logical file and shared by handles.

Locations and text are independently optional. A descriptor-only catalog can have
locations without text; built-in descriptor files may have neither. Lines are
one-based, columns are zero-based UTF-8 byte offsets, and the end is exclusive.
Frontend consumers must convert columns before using JavaScript UTF-16 offsets.
Missing or malformed span metadata is represented as `None`.

## JSON and frontend projections

[`json`](../crates/protobuf-catalog/src/json.rs) describes protobuf JSON shapes,
canonical output forms, accepted input forms, and null semantics. It handles
numeric widths, enums, bytes, wrapper types, Timestamp, Duration, FieldMask,
Struct, ListValue, Value, NullValue, and Any. Ordinary messages are named references,
so examining a JSON view never recursively materializes a message graph. These
views describe the [ProtoJSON mapping](https://protobuf.dev/programming-guides/json/);
they do not perform validation or choose editor insertion defaults.

[`CatalogSnapshot`](../crates/protobuf-catalog/src/snapshot.rs), returned by
`catalog.to_snapshot()`, is a typed `serde::Serialize` projection with qualified
name references. It retains `messages`, `enums`, and `messageFiles` for existing
completion consumers, and adds richer field shapes, presence, defaults,
declarations, enum details, file relationships, services, and JSON representations.
Source text appears only in `fileSources`. Projection copies source text once;
do not rebuild it for each completion request.

[`src-tauri/src/protobuf.rs`](../src-tauri/src/protobuf.rs) now only schedules
compilation on the blocking pool, translates diagnostics, and serializes this
snapshot. App continues to own source configuration, load generations, stale
catalog handling, and request bindings. The frontend completion algorithm remains
editor-local and does not depend on the Rust handles.

## Verification

Public-contract tests live in
[`tests/catalog.rs`](../crates/protobuf-catalog/tests/catalog.rs),
[`tests/loading.rs`](../crates/protobuf-catalog/tests/loading.rs), and
[`tests/projections.rs`](../crates/protobuf-catalog/tests/projections.rs).
They exercise compiled and descriptor-only construction, metadata and navigation,
recursive graphs, aliases, custom options, source snapshots, references, loader
boundaries, JSON views, and legacy-compatible serialized fields. Native adapter
tests continue to verify the completion payload.

```sh
cargo test --manifest-path crates/Cargo.toml -p protobuf-catalog
cargo test --manifest-path crates/Cargo.toml -p protobuf-catalog --no-default-features
cargo test --manifest-path src-tauri/Cargo.toml
```
