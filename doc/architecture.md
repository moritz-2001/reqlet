# Architecture

Reqlet is a Tauri 2 desktop HTTP client with a Vue 3/TypeScript interface.
The web frontend can also run alone with a browser fetch transport. The desktop
transport executes in Rust, outside the webview's CORS restrictions.

The desktop product and window names are defined in
[tauri.conf.json](../src-tauri/tauri.conf.json). The application identifier
`dev.apitool.app`, workspace storage name `api-tool.workspace` in
[workspace.ts](../src/workspace.ts) and
[workspaceRepository.ts](../src/workspaceRepository.ts), and portable collection
marker `api-tool-collection` in [interchange.ts](../src/interchange.ts) retain
their original values so the Reqlet rename preserves existing storage and
collection compatibility.

## Application flow and ownership

[App.vue](../src/App.vue) owns one versioned workspace containing saved requests,
collection hierarchy, environments, history, tab restoration, and pane sizes.
Components receive controlled values and emit replacements or user intents.
Runtime workspace tabs distinguish saved requests, editable unsaved drafts, and
read-only history snapshots. Saved requests and drafts enter persisted tab order
and selection; browsing an execution never creates a saved definition. Draft
content, captured-input mode, and divider preferences belong to
`WorkspaceData.drafts`, while runtime tab descriptors reference their identities.
Closing a draft moves its identity into the recoverable closed-draft order.
Transient execution state and AbortControllers belong to App rather than editors,
so switching or closing a tab does not interrupt an exchange. Deleting a request
or unmounting the application cancels its remaining work.

[request.ts](../src/request.ts) defines the shared boundary:

- `RequestData` is an editable persistent definition, containing ordered headers,
  query parameters, authentication, body, timeout, input mode, and redirect policy.
  Missing input mode retains template resolution; cURL imports explicitly use
  literal input mode. Missing redirect policy stops at the first response.
- `HttpRequest` is a resolved execution snapshot. Environment changes and later
  edits cannot alter an exchange already in flight or its history record.
- `ExecutionState` distinguishes idle, running, success, transport error, and
  cancellation. An HTTP 4xx or 5xx response is a completed transport result.
- `HttpResponse` contains status, final URL, ordered headers, text body, elapsed
  transport time, and received byte size.
- `HistoryEntry` retains the resolved request and final result for exact replay.

The interfaces and intended component usage are described in
[feature-interfaces.md](feature-interfaces.md).

## Sending and inspecting requests

1. [RequestEditor.vue](../src/components/RequestEditor.vue) composes the request
   definition controls, authentication, editable body, send/cancel actions,
   response inspector, and request/response divider. Method, URL, and Send stay
   together above compact settings tabs. Empty GET/HEAD bodies reduce to a
   settings strip until explicitly opened; idle responses reduce to a status row
   so the composer has room. These content-derived modes preserve saved divider
   preferences and mounted editors. Content type shares BodyText's toolbar with
   editor actions; protobuf setup lives in Advanced, with a direct link for a
   bound body. It emits user intent; transport work is owned by App.
2. [RequestFields.vue](../src/components/RequestFields.vue) edits method and URL,
   with an actions slot keeping Send beside the address. In constrained panes,
   the URL occupies its own full row below Method and execution controls.
   [MethodSelector.vue](../src/components/MethodSelector.vue) owns method suggestions,
   keyboard highlighting, and popup focus while the request owns the editable string.
   Its viewport-bounded popup leaves the editor's clipped panes and closes on
   outside interaction, viewport changes, or editor deactivation. RequestEditor groups
   body, headers, query parameters, authentication, and timeout into settings
   panels without discarding inactive editors. Ordered key/value rows preserve
   duplicate names and retain disabled entries without sending them.
   Accepted additions focus and reveal their new Name field; removing a focused
   row moves focus to a surviving row or Add. The controlled list remains the
   sole data source. [VirtualRows.vue](../src/components/VirtualRows.vue) bounds
   large tables with measured row heights while retaining focused input identity.
   Logical validation reveals an offscreen invalid field before Send reports it.
   See [key/value editing](key-value-editor.md) and [virtual rows](virtual-rows.md).
   [urlQuery.ts](../src/urlQuery.ts) projects literal URL parameters without
   resolving variables or rewriting the address. Parameters presents that source
   beside additional editable rows; editing URL parameters selects their original
   text in the address field. See [request parameters](request-parameters.md).
3. [prepareRequest.ts](../src/prepareRequest.ts) resolves the selected
   environment, applies authentication, validates inputs, and returns a concrete
   `HttpRequest` without mutating the definition. See
   [authentication and environments](authentication-environments.md).
   Its `prepareNextRequest` operation gives captured snapshots precedence and is
   shared by Send, complete validation, and active cURL export, including unsaved
   history drafts. `previewRequestTarget` shares metadata resolution without
   processing bodies; RequestTarget validates template bodies after 200 ms of
   quiet and cancels that work for inactive editors. Send/export always perform
   complete synchronous preparation. `previewRequestContentType` projects the same resolved
   header/authentication precedence without requiring a valid URL, query, or body.
   RequestEditor uses that MIME value for body tools and protobuf assistance.
   Template-mode JSON bodies use [json.ts](../src/json.ts) to mask complete
   comments before environment resolution and project the resolved body into
   strict JSON, replacing trailing commas with whitespace. Literal
   inputs and captured requests retain their exact body source; malformed JSON
   remains sendable. See [JSON comments](json-comments.md) for preparation rules.
   [requestSnapshot.ts](../src/requestSnapshot.ts) copies headers and credential
   metadata so execution, history, and editable drafts own independent arrays.
   [RequestTarget.vue](../src/components/RequestTarget.vue) previews the active
   scope and resolved destination near Send, labeling literal inputs when the
   selected environment is ignored.
   [VariableInput.vue](../src/components/VariableInput.vue) adds accessible variable
   name completion and field-local errors to URL, header, query, and auth fields.
   [requestVariables.ts](../src/requestVariables.ts) owns their shared pure resolver
   and completion ranges; `previewRequestField` in prepareRequest uses the same
   transport validation rules. Secret inputs suppress resolved previews. Field
   help emits `edit-environment` through RequestEditor to the manager's `open()`
   operation, without giving inputs ownership of environment selection.
4. [http.ts](../src/http.ts) selects native Tauri commands or browser fetch and
   exposes one abortable transport interface. The native implementation in
   [http.rs](../src-tauri/src/http.rs) validates inputs again and owns cancellable
   operations and timeouts. Its pooled HTTP client loads TLS roots on a blocking
   worker when first used, keeping initialization off the window startup path.
   Cancellation remains available while preparation runs; transport timeout and
   duration begin after preparation. [http_redirects.rs](../src-tauri/src/http_redirects.rs)
   inspects each redirect before transmission, removing credential headers on
   origin changes and blocking HTTPS downgrades. The request snapshot retains
   custom credential header names so replay applies the same policy.
   [http_body.rs](../src-tauri/src/http_body.rs) bounds received and content-decoded
   bytes before charset conversion while preserving encoded size and headers.
   See [HTTP execution](http-execution.md), [redirect policy](http-redirects.md),
   and [response decoding](http-response-bodies.md).
5. App commits the completed result to the request's execution state and history.
   [ResponseInspector.vue](../src/components/ResponseInspector.vue) displays
   metadata, ordered headers, and a MIME-aware readonly body. Server-provided HTML
   is shown as text. Its local presentation cache retains the last received
   response through retries, transport errors, and cancellation, with explicit
   previous-response feedback. Idle or unmount clears that cache; execution and
   history remain App-owned. See [response inspection](response-inspector.md).

## Collections, environments, history, and interchange

[CollectionManager.vue](../src/components/CollectionManager.vue) provides request
and folder creation, renaming, duplication, deletion, and movement around the
parent-owned [CollectionNode](../src/components/collectionTree.ts) hierarchy.
One `change(CollectionChange)` event atomically commits registry and hierarchy;
`select-request` is a separate opening intent. App captures deletion recovery
and cleans up removed requests before replacing definitions. Renaming, moving,
and sibling reordering preserve the active tab, editor cache, and exchanges.
[collections.ts](../src/collections.ts) owns pure validated placement through
`CollectionPlacement {parentId, beforeId}` and targeted edit recovery. App retains
the last rename/move Undo separately from deletion Undo; both merge into current
data. Deletion recovery additionally retains layouts and removed tabs without
restarting cancelled requests.

[CollectionTree.vue](../src/components/CollectionTree.vue) renders controlled
expansion, inline rename, row identity, and placement feedback. Its pure
[collectionRows.ts](../src/components/collectionRows.ts) projection retains depth,
sibling position, and subtree boundaries independently of mounted rows. At most
200 visible rows use the recursive CollectionTreeBranch; larger projections use
a viewport window with overscan. CollectionTreeEntry shares the controls between
both paths. Focus, rename, and pointer capture pin their rows; stable-ID reveal
mounts offscreen targets before restoring focus. Request content
is stored separately by stable ID. Collapsed and nonmatching descendants do not
enter the DOM. CollectionManager owns the session expansion
Set shared by recursive branches, management selection, one action/menu flow,
and feedback. Expansion therefore survives reparenting. Search and drag-hover
expansion are derived separately from remembered folder choices.
Search initially opens matching folders; manual collapse/expand overrides last
for that query and reset when it changes, without changing normal expansion.
[CollectionMoveDialog.vue](../src/components/CollectionMoveDialog.vue) owns only
destination search and explicit folder selection. The manager validates and
commits it against current data. [useCollectionReordering.ts](../src/components/useCollectionReordering.ts)
owns mouse/pen capture, geometry, temporary hover expansion, scrolling, and
cancellation, then commits one placement through the same pure operation.
Pointer work is coalesced per animation frame. Cached row geometry and identity
lookup are invalidated by layout, hierarchy, expansion, or scroll changes, with
fresh validation on release.
Keyboard and menu sibling actions share that boundary.

See [collection management](collection-management.md),
[collection tree](collection-tree.md), and [navigation](navigation.md) for
operation examples, focus/shortcut rules, request search, and keyboard quick-open.
App keeps both sidebar views mounted in independent scrollports, hiding the
inactive one so filters, expansion, and scroll survive switching views. Hidden
sidebar/drawer state cancels pointer resources while preserving browsing state.

[navigationSearch.ts](../src/navigationSearch.ts) provides a pure metadata index
and all-word matching shared by the collection filter and
[QuickOpen.vue](../src/components/QuickOpen.vue). Normalized search text and ancestor identities are cached with indexed
metadata; QuickOpen renders pages of at most 50 results while keyboard navigation
addresses the complete result list. App owns the global ⌘/Ctrl+K
shortcut and routes picker selections through the same saved-request opening
operation as the tree. The native modal owns only its transient query, active
result, and focus restoration. See [search and quick navigation](search-navigation.md)
for component contracts and examples.

[EnvironmentManager.vue](../src/components/EnvironmentManager.vue) edits named
variable scopes using an independent inspected selection. Creating, inspecting,
or editing an environment does not activate it; the header selector and explicit
"Use this environment" action control the execution scope. Authentication remains
part of a request definition and is applied only during preparation. Deletion
retains one Undo snapshot with its original position and active-scope relationship.
A subsequent explicit scope choice revokes automatic reactivation. See
[environment recovery](environment-recovery.md).

[AuthEditor.vue](../src/components/AuthEditor.vue) remembers each authentication
type's last parent-accepted inputs in a local cache. Switching types emits the
remembered configuration; only the selected configuration enters the persisted
request. Inactive credentials survive keyed editor deactivation and are released
when the editor unmounts. External parent updates remain authoritative. See
[authentication and environments](authentication-environments.md).

[HistoryPanel.vue](../src/components/HistoryPanel.vue) navigates completed
exchanges and emits inspection and clear intents.
[HistoryInspector.vue](../src/components/HistoryInspector.vue) renders an
execution's captured inputs and response in a read-only workspace tab. Open
snapshots survive clearing or pruning retained history until their tabs close.
Opening an editable draft does not send it. Explicit resend executes the stored
snapshot without re-resolving authentication or variables, and saving a draft to
Collections is a separate action. An unedited draft retains captured-input mode
for subsequent Send. Its first model edit prepares the editable definition;
history-derived definitions use literal input mode, and only an explicit switch
to template mode enables environment expansion. Saving that definition to
Collections preserves literal values and credential metadata. History clearing retains an Undo
snapshot in App; restoring merges it with newer executions before applying the
normal retention limit. Open snapshots remain independent of both the clear and
its Undo. See [history](history.md).

[ImportExport.vue](../src/components/ImportExport.vue) imports cURL, portable
collection JSON, and OpenAPI 3.0/3.1 JSON or YAML, exports collection JSON, and
exports prepared requests as cURL. [openapi.ts](../src/openapi.ts) separates pure
document parsing and operation preview from selection-to-collection conversion.
ImportExport loads this parser and its YAML dependency when a preview is first
requested; edits or closing invalidate pending previews without changing the
synchronous parser interface.
Default object form fields retain their names and use JSON values; explicit
serialization options reuse the query parameter mapping. Path substitution
replaces samples that would become normalizing dot segments and reports the
replacement in the preview. [openapiValues.ts](../src/openapiValues.ts) uses
separate object and schema resolution operations through `OpenApiValueContext`,
allowing boolean schema targets while retaining object-only checks elsewhere.
The component owns transient preview and selection, invalidates them when source
inputs change, and emits selected definitions only after explicit import.
[interchange.ts](../src/interchange.ts) remaps all imported identities before
App merges them, preserving existing definitions. OpenAPI and cURL inputs use
literal mode until the user chooses template expansion; importing never executes
requests. Credentials can be present in local storage, history, and exports; the
interface states this. See [import and export](import-export.md) and
[OpenAPI import](openapi-import.md) for contracts and supported mappings.

## Persistence and tab lifetime

[workspaceRepository.ts](../src/workspaceRepository.ts) is the production
asynchronous persistence boundary. [main.ts](../src/main.ts) restores it concurrently
with importing App, then mounts only after both finish. This keeps the first
editable workspace complete without serializing storage and UI module loading.
The IndexedDB adapter batches concurrent record reads into shared readonly
transactions while retaining the individual-read storage interface. The
version-2 IndexedDB envelope stores compact metadata and keys;
definitions, drafts, and history captures occupy independent records. Autosave
snapshots changed records without flattening unchanged body revisions, and commits
changed/deleted editable records atomically with metadata. Earlier envelopes
migrate after validation. Saves debounce for 200 ms with a one-second deadline
and serialize; backgrounding or unmounting flushes pending work immediately.
Capture restoration reads alongside editable records and validates each capture
through `parseHistoryEntry` without repeatedly validating definitions.
Persisted history is bounded
by 100 captures and 8 MiB. Capture quota failures preserve definition saves and
produce durable omission warnings while the live response remains inspectable.
[workspace.ts](../src/workspace.ts) retains the validated synchronous legacy
contract and initial examples. Migration preserves the original localStorage
bytes. Invalid saved data is preserved and surfaced as an error rather than
silently overwritten. App shows pending saves and storage failures without
discarding the working in-memory workspace. See
[workspace storage](workspace-storage.md). Drafts restore alongside saved
requests. Closed drafts remain autosaved and can be reopened from the sidebar,
including after reload. Earlier version-1 documents without draft recovery fields
normalize to empty draft storage during validation.

[Tabs.vue](../src/components/Tabs.vue) owns its open descriptors, order, active
selection, and close policy. Initial descriptors restore a workspace; state-change
snapshots persist opening, selection, closing, and ordering. App handles external
request renames/deletion through the documented tab command interface. Closing
an active tab selects right, then left, then null. Keyboard and pointer ordering
share the immutable [moveTab](../src/components/tabOrder.ts) operation;
[useTabReordering](../src/components/useTabReordering.ts) owns pointer gestures,
capture, insertion feedback, scrolling, and cleanup. An optional controlled
`TabPresentation` map derives sending/status badges and draft markers from App's
runtime state without changing persisted descriptors. Completing a closed-tab
exchange creates an inspectable completion notice; opening it uses the same
independent history-snapshot path.

The strip caps visible label widths while retaining full-name tooltips and
unshrunk status/close controls. Its open-tabs picker reads the same descriptor
list, so saved requests, drafts, and history share selection without an extra
application-owned index. Menu navigation and dismissal preserve keyboard focus.
More than 80 open tabs use a horizontal window with predictable 220px entries;
selection and capture pin their descriptors while keyboard and pointer movement
address the complete order. The picker uses the measured VirtualRows viewport.
Response headers and literal URL parameters also use bounded, keyboard-focusable
table scrollports for large datasets; their ARIA positions refer to logical rows.

App renders one external tab panel with a request-ID-keyed KeepAlive cache,
bounded to 30 editors. Body drafts live in the workspace; selection, folds, undo
history, and scroll position live in cached CodeMirror editors. Closing/reopening
preserves cached presentation within that bound. Reload restores definitions,
tabs, and split preferences rather than CodeMirror's transient undo state.
See [tabs](tabs.md) and [tab reordering](tab-drag-and-drop.md).

## Text editing subsystem

[BodyText.vue](../src/components/BodyText.vue) receives body source through
`modelValue` and emits complete source revisions. RequestEditor opts into
incremental publication: [bodyDocument.ts](../src/bodyDocument.ts) wraps immutable
text roots shared with CodeMirror, while the workspace owns the current revision.
Send, copy, export, and changed-record persistence explicitly materialize strings.
Ordinary model updates never flatten a body. See [body documents](body-document.md)
for the interface and examples. BodyText owns MIME detection, wrapping,
action feedback, explicit formatting, and readonly previews. Formatting, Find,
and Copy remain visible in wide panes and move into More as the pane narrows;
valid readonly JSON defaults to Pretty with an explicit
Pretty/Raw choice. ResponseInspector retains that choice while execution
states change; a previous response keeps its body editor mounted during retries.
Copy always uses the captured original text.
Wrapping and folding live in a More disclosure that escapes pane clipping.
The optional `toolbar` slot accepts caller-owned context controls without giving
BodyText ownership of request definitions. Container queries own toolbar density;
opening More reads the hidden actions once so its teleported menu exposes the
same commands. HTTP metadata stays outside it.
[TextEditor.vue](../src/components/TextEditor.vue) adapts this
controlled model to CodeMirror's transactions, selection, history, viewport, and
fold state. Equal parent echoes reuse the emitted source revision, and simultaneous
document/language replacements create one editor state.
[jsonLanguage.ts](../src/components/jsonLanguage.ts) supplies an
incremental JSON language with line/block comments and trailing commas, syntax
highlighting, and bracket matching. Its generated parser comes from
[grammar.grammar](../src/json/grammar.grammar). [jsonLint.ts](../src/components/jsonLint.ts)
uses the shared complete-source validation in [json.ts](../src/json.ts), retaining
CodeMirror's standard diagnostic presentation.

[jsonFolding.ts](../src/components/jsonFolding.ts) supplies source/tree-based
folding without a duplicate collapsed-ID store or flattened editor-string copies.
[jsonIndentation.ts](../src/components/jsonIndentation.ts) infers local newline
indentation from the same parser, indexing line boundaries once to avoid repeated
backward scans through long minified lines. [textEditor.ts](../src/components/textEditor.ts)
provides presentation extensions and the small toolbar command interface.
[bodySearch.ts](../src/components/bodySearch.ts) adds editor-local literal Find,
highlights, match navigation, and fold reveal using CodeMirror search state.
The query and panel survive text/preview replacements without creating a second
Vue search-state store; read-only search cannot mutate response content.
Exact count and sparse numeric match checkpoints are refreshed only for document
or query changes; selection feedback examines at most one 128-match block.
[formatJson.ts](../src/components/formatJson.ts) indents original tokens without
serializing parsed values, preserving numeric notation, escapes, duplicate keys,
comments, and trailing commas. Formatting is undoable; a readonly pretty preview
preserves original text.
Read-only sources above 64 Ki units use a cancellable
[formatting worker](../src/components/jsonPreview.worker.ts), owned through
[jsonPreview.ts](../src/components/jsonPreview.ts), while original text appears
immediately. The worker computes with the dependency-free Rust
[JSONC formatter](../crates/json-formatter/src/lib.rs), compiled through a thin
[Wasm adapter](../crates/json-formatter-wasm/src/lib.rs). Its UTF-16 interface
preserves source units and existing budgets without a second parsed-value model.
See [JSON formatting computation](wasm-json-formatting.md) for ownership,
interfaces, builds, and verification. Small previews and explicit editor
formatting retain the TypeScript implementation.
Raw preferences skip formatting, inactive editors suspend unfinished
work, and interaction with original text holds automatic Pretty replacement until
the user chooses it. Preview output is bounded to 512 Ki units independently of
input size, preventing excessive whitespace expansion from deep nesting.

For read-only bodies above 512 Ki UTF-16 units, BodyText selects
[LargeBodyViewer.vue](../src/components/LargeBodyViewer.vue) before any JSON
formatting or parser construction. The original response remains parent-owned;
only one plain-text page of at most 64 Ki units enters TextEditor. The viewer owns
page selection and cancellable whole-response Find, while
[largeBody.ts](../src/components/largeBody.ts) supplies source ranges and the
cooperative JavaScript search fallback. [largeBodySearch.ts](../src/components/largeBodySearch.ts)
owns a lazy worker session retaining the response in the
[Rust search core](../crates/body-search/src/lib.rs) through its
[Wasm adapter](../crates/body-search-wasm/src/lib.rs). Queries exchange only
positions and literal text; bounded scans remain cancellable between worker tasks.
Closing Find, deactivation, replacement, and unmount release its source copy.
See [response search computation](wasm-response-search.md) for interfaces,
Unicode semantics, ownership, and measurements.
TextEditor's `revealRange` command selects a page-local result
without exposing its view. Full original-text Copy and UTF-8 Download remain
available. See [large responses](large-responses.md) for these interfaces,
resource limits, and [performance measurements](ui-performance.md).

See [body-text.md](body-text.md), [JSON editor architecture](json-highlighting.md),
[JSON comments](json-comments.md), [JSON folding](json-folding.md), and
[automatic indentation](json-auto-indentation.md).

## Layout and desktop entry points

[WorkspaceTools.vue](../src/components/WorkspaceTools.vue) groups occasional
management actions in the header while EnvironmentManager's active scope
selector stays visible. App routes tool selections through each manager's
`open()` operation. Optional `hideTrigger` props suppress duplicate buttons in
this composition while standalone managers retain their own triggers. Managers
restore focus to the entry control that opened them. See
[workspace header](workspace-header.md) for the menu and responsive layout.

[SplitPane.vue](../src/components/SplitPane.vue) sizes the sidebar/workspace and
request/response panes with accessible pointer and keyboard controls. Each
orientation retains its own pixel or percentage preference. Responsive clamping
and temporary compact-pane presentation do not overwrite the saved preference.
Compact panes stack at their content height while the other region fills the
remaining space; the divider is available again when normal splitting resumes.
Body panes retain a usable minimum
viewport and scroll when metadata or expanded controls exceed the window.
`sizes`/`update:sizes` lets App persist
layout while standalone consumers can retain internal ownership. Pointer resizing
uses local preview state and emits once on release; cancellation restores the
saved preference. Keyboard/reset changes remain immediate. See
[split-pane.md](split-pane.md).

[src-tauri/src/main.rs](../src-tauri/src/main.rs) calls `run` in
[src-tauri/src/lib.rs](../src-tauri/src/lib.rs), which registers the HTTP commands
and shared native operation registry. Each
[HttpOperations](../src-tauri/src/http.rs) instance also owns one fallibly
initialized reqwest client. Request builders share its connection pool while
headers, bodies, cancellation, timeouts, and redirect state remain per execution;
the client has no cookie jar or default credentials. Automatic redirects stay
disabled so every hop passes through the explicit policy.
[main.ts](../src/main.ts) loads the asynchronous workspace and then mounts App.
[vite.config.ts](../vite.config.ts) configures the Vue development server at 1420.
[tauri.conf.json](../src-tauri/tauri.conf.json) defines the desktop window and
packaging; [capabilities/default.json](../src-tauri/capabilities/default.json)
defines webview permissions. Template icons and the initial bundle identifier
remain distribution work.

The `build:linux` command in [package.json](../package.json) selects Tauri's Debian
bundler on a Linux build host. It uses the same frontend/Wasm build and native
entry point as other desktop packages. Tauri generates package dependencies,
icons, and the application-menu entry; bundle metadata lives in
[tauri.conf.json](../src-tauri/tauri.conf.json). See
[Linux installation](linux-installation.md) for host requirements, package paths,
and the installation and verification procedure.

## Protobuf completion

[Protobuf completion](protobuf.md) describes shared local model sources, per-request
message bindings, native catalog loading, and schema-aware JSON completion.
App owns source lifetimes; editors consume immutable catalogs without changing
HTTP preparation or captured execution snapshots.
The reusable [`protobuf-catalog` crate](../crates/protobuf-catalog/src/lib.rs)
owns the protobuf descriptor graph, captured source snapshot, declaration handles,
reverse references, and JSON representation views. Its optional compiler loads
local projects; descriptor-only construction needs no filesystem or Tauri runtime.
[`CatalogSnapshot`](../crates/protobuf-catalog/src/snapshot.rs) projects that graph
to the existing completion payload plus additive rich metadata.
[`protobuf.rs`](../src-tauri/src/protobuf.rs) is the blocking-task/serialization
adapter. See [catalog architecture and usage](protobuf-catalog.md) for the public
interface and snapshot lifetime contract.
[ProtobufBindingPicker.vue](../src/components/ProtobufBindingPicker.vue) owns transient
message searches and commits controlled bindings only on selection. The pure
[resolveProtobufAssistance](../src/protobuf.ts) derives MIME-aware context, status,
and recovery intent. Advanced contains source/message setup, while a bound body
links to that configuration and surfaces recovery feedback beside the editor.
[ProtobufManager.vue](../src/components/ProtobufManager.vue) provides
a focus-managed modal, browsable dependency rows, diagnostics, and one removal
Undo snapshot retaining stable source identity. Native catalogs include relative
message filenames for search and disambiguation.
[protobufCompletion.ts](../src/components/protobufCompletion.ts) derives both the
message path and current value token from the JSON tree, so array elements and
map values receive local, undoable replacements. Portable imports in
[interchange.ts](../src/interchange.ts) reserve original source identities and
allocate replacements alongside collection nodes; each request binding is remapped
once through that shared source-identity map.

The proposed [message inspector](protobuf-message-inspector-design.md) adds a
read-only field tree and exact source view backed by the same runtime catalog.
It separates model resolution from completion's MIME gate and keeps inspection
state in the request editor. The catalog now supplies rich metadata and captured
source; the inspector UI and frontend model resolver are not implemented yet.

## Shared presentation

[styles/index.css](../src/styles/index.css) loads semantic theme tokens, document
defaults, and opt-in native button/input classes independently of App. The entry
point is imported by main.ts and the component test setup. Components own layout
and behavior; ordinary controls share appearance, compact density, and interaction
states. Specialized tabs, tree/history rows, menus, and CodeMirror retain their
own presentation using common palette tokens. Canvas, panel, and control surfaces
have separate roles; interactive outlines and selected accents are distinct from
decorative separators. Below 600px, App keeps navigation mounted in a transient
drawer while the workspace fills the content area; desktop split preferences
remain unchanged. Existing BodyText theme variables
remain supported through shared-token fallbacks. See [shared styles](shared-styles.md)
for the class contract, examples, and local override boundaries.

## Verification

`pnpm test` runs pure contracts and component interfaces; `pnpm build` checks
Vue/TypeScript and creates the frontend bundle. `cargo test --manifest-path
src-tauri/Cargo.toml` verifies native execution against local HTTP fixtures.
Application tests exercise tab/editor lifetime, execution state, exact replay,
and workspace reload through the integrated interface.
