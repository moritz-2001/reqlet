# Protobuf JSON completion

Register a project under **Protobuf models → Add protobuf folder** in the desktop
app. The chosen directory is both a recursive `.proto` discovery root and an
import root. Expand Import directories in the manager and use Add import directory
when imports live elsewhere. Directory rows support Browse and Remove; duplicate
selections are ignored. Loading also deduplicates canonical directories, so adding
the project folder itself, an equivalent path such as `models/../models`, or a
symlink to an existing root remains valid. Load diagnostics retain the compiler
details, and inaccessible directories show a local recovery hint.
If some files fail to compile, the app still offers messages from independent
files that loaded successfully. The source manager marks the catalog as partially
loaded and lists the failed files and their diagnostics. Files depending on a
failed import cannot contribute messages until the problem is fixed and the
source is reloaded. If no entry point loads, an earlier catalog remains available
as stale data when possible.
Protobuf well-known types and the Google HTTP annotation files
`google/api/annotations.proto` and `google/api/http.proto` are bundled. Other
third-party imports still need an import directory containing their logical paths.
Use Reload after changing files, or Relink after moving the project. The manager is a modal dialog: focus moves to Add protobuf folder, Escape/Close dismiss it, and focus returns to the opener. Removing a source offers one Undo snapshot with its original identity and position, restoring existing request selections; the snapshot lasts until another removal or application restart. Usage counts include saved requests and drafts.

In a request's **Advanced → Protobuf completion** section, select its source and
search messages by name, package, or relative source file, for example
`company.users.CreateUserRequest`. The combobox shows package/file context;
arrows select a result, Enter commits it, and Escape dismisses results. Search
text is transient and never replaces a committed binding. **Manage protobuf
folders** opens the source manager directly. Clearing the source disables
assistance and preserves text. A bound Body toolbar shows a link back to this
configuration. Status text distinguishes loading, ready, missing messages,
relinking, stale catalogs, and assistance inactive for a non-JSON MIME type.
Recovery feedback stays beside the body, with Fix source opening management.

JSON completion suggests canonical field names, nested message fields, repeated
message elements, map values, enums, and booleans. Ctrl+Space opens suggestions;
arrows select, Enter accepts, and Escape dismisses. Acceptance is undoable. Field
comments and deprecation notes appear with suggestions. Existing protobuf field
spellings are recognized alongside canonical JSON spellings. Content-Type still
controls JSON editing; selecting a model never changes the HTTP payload.

For a ready-to-use example, add [`examples/protobuf`](examples/protobuf) as a
protobuf folder and select `demo.CreateUserRequest`. In a JSON body, type `{"f`
to see `firstName` and `featureFlags`, or type an enum prefix inside
`{"role":"A"}` to see `ADMIN`. Nested `address` fields and boolean values in
`featureFlags` also offer completion.

## Interfaces and flow

- [`ProtobufSource`, `ProtobufMessageBinding`, and catalogs](../src/protobuf.ts)
  separate persistent configuration from runtime schemas. RequestData has optional
  `protobuf` metadata; workspace sources are additive optional data for backwards
  compatibility. An omitted sources list means no models are configured.
- [`protobuf-catalog`](../crates/protobuf-catalog/src/lib.rs) provides immutable
  protobuf models, source snapshots, rich metadata, references, and JSON views.
  [Its usage and architecture](protobuf-catalog.md) describe the Rust interface.
  [`protobuf.rs`](../src-tauri/src/protobuf.rs) calls its optional protox compiler
  in a blocking task and serializes a typed catalog snapshot with partial-load
  diagnostics. The crate's
  resolver confines imports to canonical configured roots,
  deduplicates equivalent roots, and bounds project inputs. A canonical file
  reachable through more than one root is a single import candidate. Different
  files with the same relative import name remain ambiguous even when their
  contents match; fix the import directories instead of relying on root order.
  Protobuf well-known types and Google HTTP annotation imports are built in;
  configured local files take precedence. Directory symlinks are skipped during root
  discovery.
- [`App.vue`](../src/App.vue) owns catalogs and load generations. Failed reloads
  retain a visibly stale catalog; changing paths clears it. Late results cannot
  replace newer configurations. Missing files never invalidate workspace storage.
- [`resolveProtobufAssistance`](../src/protobuf.ts) is a pure request-local resolver. It receives a binding, configurations, runtime states, and MIME type, returning a label, status, recovery action, and optional context. For example, `resolveProtobufAssistance(request.protobuf, sources, states, "text/plain")` retains the binding but returns no active context. App retains ownership of loading and generation protection.
- [`ProtobufBindingPicker.vue`](../src/components/ProtobufBindingPicker.vue) receives controlled sources, states, and `modelValue`; `update:modelValue` commits selections. It owns only transient search/focus state. Catalog `messageFiles` maps message identities to relative filenames, and remains optional for older consumers.
- [`ProtobufManager.vue`](../src/components/ProtobufManager.vue) emits controlled
  source replacements and reload intents. Its `open()` operation reveals the
  manager without granting request editors ownership of workspace configuration.
- [`protobufCompletion.ts`](../src/components/protobufCompletion.ts) reads the
  tolerant JSON syntax tree and follows a finite graph of named types. A dedicated
  TextEditor compartment installs assistance without replacing its view/history.

For example, a request stores only
`protobuf: { sourceId: "users-model", messageName: "company.users.CreateUserRequest" }`.
Many requests can share that source's runtime catalog. Transport does not need
any descriptors. A binding-only edit also preserves a history draft's captured
request; editing its actual inputs retains the normal environment preparation rule.

Portable collection exports retain source names and bindings while excluding
local paths and model files. Imports remap source identities and create unlinked
sources; choose Relink before using completion. History captures only HTTP inputs,
so a new draft from history has no model selected.

## Limits and verification

Folders load on startup or Reload; filesystem watching is not enabled. Browser
preview preserves bindings but local loading requires desktop. Any offers `@type`
without embedded-message expansion. Well-known scalar/open JSON types do not
expose their internal descriptor fields. Semantic validation, binary encoding,
gRPC, and response schemas are outside this feature. Compiler errors report
unsupported protobuf syntax, including unsupported Editions features.

Tests in [`protobuf.test.ts`](../tests/protobuf.test.ts) cover completion context,
aliases, nested/repeated/map fields, enum values, environment placeholders,
portable relinking, transport independence, actual completion acceptance, Undo,
and editor identity. Keyboard regressions exercise quoted and mid-token enum and
boolean values in ordinary fields, arrays, and maps. Acceptance replaces only
the current value token, preserving its enclosing array or map and neighboring
entries. Placeholder-looking text in an earlier string does not disable later
completion; positions before property separators do not offer value edits.
Automatic typing also completes unfinished quoted field names, and a keyboard
test verifies the installed Ctrl+Space binding. macOS may reserve that shortcut
for switching input sources; automatic completion remains available while typing.

[`ProtobufUi.test.ts`](../tests/ProtobufUi.test.ts) covers manager focus restoration,
removal Undo, dependency browsing, committed message selection, and status
resolution. [`App.protobuf.test.ts`](../tests/App.protobuf.test.ts) exercises
startup loading, failed reloads, changed dependencies, out-of-order relink results,
removal/Undo during loading, and captured-input preservation through model
selection and clearing. It checks the application through rendered controls and
editor contracts with folder selection, native loading, and HTTP transport mocked.
[`workspace.test.ts`](../tests/workspace.test.ts) and
[`interchange.test.ts`](../tests/interchange.test.ts) verify saved/draft bindings,
unavailable sources, portable path exclusion, and identity remapping. Imports
allocate source IDs through the same bounded allocator as collection nodes,
reserving original identities before remapping each binding once.

Native fixtures cover imported recursive messages, JSON names, documentation,
deprecation, nested types, proto2 enum aliases, proto3 optional/oneof distinctions,
built-in standard imports, dependency-only roots, equivalent and overlapping
roots, genuine import collisions, byte limits, and invalid projects. Unix tests
also exercise symlink aliases, discovery cycles, and imports escaping the root.
Run `pnpm test`, `pnpm build`, and
`cargo test --manifest-path src-tauri/Cargo.toml`.
