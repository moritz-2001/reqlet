# Protobuf request completion plan

Status: original design, 23 October 2026. See [implemented subsystem](protobuf.md)
for current interfaces, usage, and limitations.

The confirmed scope is JSON request bodies with completion derived from protobuf
messages. A user registers a local protobuf folder once, then selects a message
for each request. The selected message supplies editing assistance; sending still
uses the existing JSON text and HTTP transport.

## User flow

1. Open a workspace-level **Protobuf models** manager and choose **Add folder**.
   Give the source a name and select its root directory with a native picker.
   An advanced section accepts additional import directories when dependencies
   live outside that root.
2. Load all `.proto` files below the root, resolve their imports, and display the
   message count or file-specific diagnostics. Provide **Reload**, **Relink**,
   rename, and remove actions. Loading happens on workspace startup and explicit
   Reload; automatic filesystem watching is deferred.
3. In the request's Body panel, choose a model source and search for a message,
   such as `acme.users.v1.CreateUserRequest`. Include nested messages and show
   package and relative file names to distinguish similar names. **None** clears
   the binding. An **Add protobuf folder** action opens the same manager.
4. Edit JSON normally. Offer property names at the caret, nested field completion,
   enum values, boolean values, and small type-appropriate insertion snippets.
   Suggestions include field types, comments, and deprecation information.
5. Save, duplicate, close, and reopen requests or drafts with their selection
   intact. Switching messages changes assistance without rewriting the body.

The existing enabled Content-Type header remains authoritative. Assistance runs
only in editable JSON bodies, including `+json` MIME types. Keep a selected
message when another content type is chosen and explain that assistance is
inactive. Selecting a message does not change headers or infer an endpoint URL.

## Main interfaces and ownership

Use two small protobuf-specific contracts rather than introducing a general
schema-provider framework before another schema format needs one:

```ts
/** A shared model source, configured once for requests in this workspace. */
interface ProtobufSource {
  /** Stable identity retained when its display name or local location changes. */
  id: string;
  /** User-visible label for choosing among model sources. */
  name: string;
  /** Local import root; null means an imported source needs to be linked. */
  rootPath: string | null;
  /** Additional local import roots, searched in order after rootPath. */
  includePaths: string[];
}

/** Editing metadata identifying a message without embedding its definition. */
interface ProtobufMessageBinding {
  /** Identity of the shared source; an unavailable source remains selected. */
  sourceId: string;
  /** Fully qualified message name, without a leading dot, including nesting. */
  messageName: string;
}
```

Add `protobufSources: ProtobufSource[]` to
[`WorkspaceData`](../src/workspace.ts) and optional
`protobuf?: ProtobufMessageBinding` to [`RequestData`](../src/request.ts).
Absence means ordinary body editing. Define these types in a new
`src/protobuf.ts`; keep transport contracts free of schema metadata.

The persistent source is configuration. A runtime catalog is an immutable,
serializable graph of messages and enums keyed by fully qualified names. Fields
carry their protobuf name, JSON name, number, value type, cardinality, real oneof
membership, comments, and deprecation metadata. Message and enum references use
names rather than recursively embedding definitions, so recursive types remain
finite. Include source locations for message search and documentation. Hide
synthetic map-entry messages from the picker and normalize synthetic optional
oneofs separately from user-declared oneofs.

| Boundary | Responsibility |
| --- | --- |
| Native protobuf loader | Read the selected directories, resolve imports, compile descriptors, and return a catalog or structured diagnostics. |
| Workspace controller | Own persistent sources and request bindings; own one runtime load state per source; discard outdated asynchronous results. |
| Pure protobuf functions | Resolve bindings, navigate the catalog, and determine suggestions for a JSON position. |
| Protobuf manager and message picker | Render controlled data; emit configuration replacements, message selections, and reload intents. |
| BodyText and TextEditor | Receive a resolved catalog/message context; adapt suggestions to CodeMirror transactions. |

Expose `loadProtobufSource(source)` as an asynchronous frontend adapter and
`resolveProtobufMessage(binding, sourceStates)` as a pure resolver returning a
ready context or an actionable unavailable state. A new
`protobufCompletion(context)` CodeMirror extension consumes only that ready
context. Keep filesystem access out of components and completion functions.
Keep CodeMirror types inside the editor integration rather than persistent data.

## Folder loading and lifecycle

Add a separate `src-tauri/src/protobuf.rs` module and register its loading command
in [`lib.rs`](../src-tauri/src/lib.rs). Use the Tauri dialog plugin for directory
selection and a dedicated native command for loading, without exposing a general
frontend filesystem API. The existing setup has neither a dialog plugin nor a
protobuf dependency; update Cargo, frontend dependencies, initialization, and
[`capabilities/default.json`](../src-tauri/capabilities/default.json) together.
The dialog plugin supports directory selection through
`open({ directory: true })`. See the
[Tauri dialog documentation](https://v2.tauri.app/plugin/dialog/).

Prefer `protox` for runtime compilation and its descriptor reflection support to
produce the catalog, avoiding an installed `protoc` requirement or generated
application models. It supports explicit include paths, imported descriptors,
and source comments. See the [project](https://github.com/andrewhickman/protox)
and [Compiler interface](https://docs.rs/protox/latest/protox/struct.Compiler.html).
Verify the selected release against project fixtures before fixing the dependency
version. Start with proto2/proto3; test any required Editions syntax explicitly
and report unsupported syntax rather than promising broad Editions support.

Loading is a bounded native blocking task; construct the compiler inside that
task and return ordinary data. Scan root files in deterministic order and resolve
imports relative to the root, then configured include paths, with standard
protobuf imports available. Include directories provide dependencies rather than
being scanned as additional projects. Reject ambiguous virtual import paths and
duplicate symbols with actionable diagnostics. Handle permission errors, empty
folders, unresolved imports, parse errors, and unsupported syntax explicitly.
Canonicalize paths, confine imported files to configured roots, avoid directory
symlink loops, and bound file count and total input bytes.

The workspace owns one load state per source: unlinked, loading, ready, or error.
A reload replaces the catalog atomically only after complete success. On a failed
reload, preserve the last successful catalog in memory, label it stale, and keep
its completion available. Changing root/import paths clears that prior catalog
before loading because it may describe a different project. Source removal
discards its runtime state but preserves existing bindings as unavailable until
the user clears or rebinds them. Track a generation per source so a late result
cannot overwrite a relink, newer reload, or removed source.

Load catalogs once per source, share them across request tabs, and keep them out
of localStorage and collection files. A fresh launch recompiles configured local
sources. Browser preview keeps ordinary editing and persisted bindings usable;
local-folder loading reports that it requires desktop. Browser folder upload and
persisted descriptor snapshots are deferred.

## Completion behavior

Add `@codemirror/autocomplete` and use the existing tolerant JSON syntax tree in
[`TextEditor.vue`](../src/components/TextEditor.vue). Completion must work while
property names, strings, and objects are unfinished; it cannot depend on parsing
the whole body successfully. Keep caret-to-JSON-path analysis separate from
catalog lookup, then let the CodeMirror adapter determine local insertion ranges.
CodeMirror supports custom completion sources and syntax-aware context lookup;
see its [autocompletion example](https://codemirror.net/examples/autocompletion/).

- Insert the canonical JSON field name, honoring `json_name`; recognize both it
  and the original protobuf name in existing text. Suppress duplicates across
  both spellings while allowing completion of the current property.
- Follow nested messages, array elements of repeated fields, and map values.
  Map keys are user data, so do not suggest message fields at the map-key level.
- Exclude other members of an already populated oneof without deleting user
  content. Ordinary JSON `null` leaves a field unset and must not exclude its
  siblings; honor the special null semantics of NullValue and Value. If a
  controlling value is incomplete or ambiguous, avoid guessing.
- Suggest quoted enum names and booleans. Insert shallow object/array/string
  snippets with a useful caret position; do not recursively generate a payload.
- Use ProtoJSON representations for suggestions: 64-bit integer values as decimal
  strings, bytes as base64 strings, and well-known types according to their JSON
  shape. Timestamp, Duration, FieldMask, and wrappers must not expose their
  internal descriptor fields; Struct, Value, and ListValue remain open JSON.
  In the first release, Any can suggest `@type` but does not expand its embedded
  message. State that limit in help text.

These naming and value rules follow the
[ProtoJSON specification](https://protobuf.dev/programming-guides/json/).
They guide completion without normalizing or serializing the user's document.
Retain existing JSON syntax diagnostics; full semantic protobuf validation and
send-time enforcement are deferred. Body environment placeholders remain literal
to completion, with no suggestions inside a `{{...}}` span. They continue to be
resolved by the existing request preparation path.

Enable automatic suggestions in relevant positions plus explicit Ctrl+Space.
Use arrows, Enter, and Escape for the list; retain Tab's normal focus behavior.
Preserve IME composition and Cmd/Ctrl+Enter Send. Each accepted completion is
one undoable local edit, handling existing quotes, colons, and values without
duplicating them.

Pass an optional resolved `protobufContext` from RequestEditor through BodyText
to TextEditor. Add a dedicated CodeMirror compartment for assistance so selecting
a message or replacing a catalog preserves editor identity, document, selection,
undo history, folds, and Find state, including cached inactive request editors.
Readonly responses and history inspectors do not activate completion.

## Persistence, interchange, and replay

Extend [`workspaceValidation.ts`](../src/workspaceValidation.ts) to normalize
missing `protobufSources` to `[]` in existing version-1 workspaces. Missing request
bindings stay absent. Validate shapes and identities without reading disk or
requiring a message to exist; unavailable assistance must not prevent loading or
autosaving a workspace. Copy nested bindings when duplicating requests/drafts.

Extend the portable collection format with a source manifest containing IDs and
names for referenced sources. Exclude local root/include paths and source files.
If a referenced source was removed, export its ID with a fallback label such as
**Unavailable protobuf source**, so its binding still round-trips.
Imports allocate fresh source IDs, remap bindings alongside request/folder IDs,
and create unlinked sources that the user can relink. Preserve older collection
files by defaulting the manifest to empty. An unresolved binding remains visible
and does not affect sending; never silently bind by display name. cURL continues
to represent only the prepared HTTP exchange.

Keep [`prepareRequest`](../src/prepareRequest.ts), `HttpRequest`, HTTP history
snapshots, and native HTTP execution independent of catalogs. Missing schemas,
reloads, and schema selection cannot affect the sent text. For this first release,
history remains a transport-only snapshot: opening a history item as a draft has
no protobuf binding, and the user may select one. Capturing historical completion
context can be added separately if needed.

One existing behavior needs a deliberate adjustment: App's `updateRequest`
currently clears a history draft's `capturedRequest` on every definition update.
Preserve that snapshot when the only change is the protobuf binding; ordinary
definition edits retain their current behavior. Compare the previous and next
definitions excluding protobuf metadata using a small pure helper. This prevents
an editing-assistance choice from changing exact replay or environment resolution.
Update the captured-input explanation and tests to describe this exception.

## Delivery steps and acceptance checks

1. **Contracts and restoration:** introduce source/binding types, workspace
   normalization, duplication, portable source manifests, remapping, and the
   captured-draft exception. Test old workspace/collection files and round trips
   through their public interfaces.
2. **Native loading:** add the folder picker, loader, and catalog conversion.
   Test small temporary projects covering imports, nested and recursive messages,
   enums, maps, oneofs, comments, JSON names, and standard types. Check actionable
   failures for invalid files, ambiguous imports, unavailable folders, and limits.
3. **Workspace and request UI:** add the manager and searchable message picker;
   wire runtime states through App. Verify saved requests and drafts restore their
   choices, missing selections remain visible, and reload races cannot overwrite
  newer state. Selecting/clearing a binding emits an immutable replacement and
  preserves body text and exact captured execution inputs; a subsequent body or
  header edit still exits captured-input mode.
4. **Editor completion:** implement pure context analysis and catalog lookup, then
   the CodeMirror adapter and compartment. Test unfinished JSON, precise ranges,
   aliases, nesting, arrays, maps, oneofs, enum values, well-known types, and
   environment placeholders. Exercise actual keyboard insertion and Undo through
   [`tests/editor.ts`](../tests/editor.ts), including quotes already present.
5. **Integrated verification and docs:** verify cache/tab switching, schema
   reload during editing, preserved folds/Find/undo, MIME overrides, readonly
   bodies, keyboard focus, Send shortcuts, and the bounded desktop layout. Assert
   identical prepared HTTP snapshots before/after binding changes. Run
   `pnpm test`, `pnpm build`, and `cargo test --manifest-path src-tauri/Cargo.toml`.
   Update architecture, editor, storage, interchange, and interface documentation;
   turn this plan into the protobuf subsystem documentation with final code links
   and a folder/message setup example.

The first usable release includes the full folder → message → completion flow.
Automatic watching, a language server, binary protobuf, gRPC, response models,
full semantic validation, and automatic complete-body generation remain outside
this scope.
