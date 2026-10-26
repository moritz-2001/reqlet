# Request workspace interfaces

The workspace keeps saved definitions (`RequestData`), transient `ExecutionState`,
and completed `HttpResponse` values separate. Their shared contracts live in
[request.ts](../src/request.ts). Components emit complete replacements or user
intents; App owns application data and routes those intents.

Execution prepares a concrete `HttpRequest` from a saved request and selected
environment, then calls `executeHttp(request, signal)` from `src/http.ts`.
`prepareNextRequest(request, environment, capturedRequest)` in `src/prepareRequest.ts`
is the shared pure boundary for Send, destination preview, and active cURL export.
It copies an unchanged capture when supplied; otherwise it calls
`prepareRequest(request, environment)` and throws readable validation errors.
`previewRequestContentType` shares resolved header/authentication precedence for
body and protobuf tooling without requiring valid URL/query/body inputs. See
[request preparation](request-preparation.md) for contracts and examples.
Execution errors and cancellation are distinct
from valid HTTP responses, including 4xx and 5xx responses. History stores the
resolved snapshot so replay is independent of later draft/environment edits.

`RequestEditor` accepts `modelValue`, optional `execution: ExecutionState`,
`layout: SplitSizes`, `environment: Environment`, and `capturedRequest:
HttpRequest`. It emits `update:modelValue`, `send`, `cancel`, `update:layout`, and
`edit-environment` to open the workspace's environment manager from field help.
`RequestFields` owns URL/method controls and provides an `actions` slot for Send
and Cancel. RequestEditor keeps body, headers, parameters, authentication, and
timeout in accessible settings tabs, preserving inactive editor state. Its
`request-status` slot lets the application explain an unsaved draft and offer
explicit saving. See [request editor](request-editor.md) for usage examples.

`RequestTarget` receives `request`, optional `environment`, and optional
`capturedRequest`. It previews the concrete execution target using pure
preparation, or displays the unchanged captured destination, and emits
`edit-environment` for variable-resolution help. `AuthEditor` owns
authentication controls. `ResponseInspector` receives optional `execution` and
keeps status/timing above collapsible metadata and the response body.

`EnvironmentManager` accepts `environments` and `activeEnvironmentId`, emitting
`update:environments` and `update:activeEnvironmentId`. Its inspected environment
is local presentation state; creating or inspecting one never activates it.
Its exposed `open()` operation opens the active environment's variables from
request-field help while leaving activation explicit.
`CollectionManager` accepts `requests`, `nodes`, and optional `selectedRequestId`;
it emits `change(CollectionChange)` for one atomic registry/hierarchy replacement
and `select-request(id)` for explicit opening. `selectedId` in a change is only
the management target. App captures deletion recovery and cleans up
`deletedRequestIds` before replacing definitions; no separate cleanup events
are emitted. Rename and move preserve active tab/editor/execution lifetime.
It also exposes `focusSearch()` for hosts that focus collection search directly.
Its controlled `CollectionTree` receives the shared `expandedFolderIds` Set and
forwards editing, expansion, row-keyboard, and handle-pointer intents.

`moveCollectionNode(state, id, {parentId, beforeId})` in
[collections.ts](../src/collections.ts) is the shared pure operation for folder
movement, sibling actions, and pointer placement. Null parent means root; null
anchor appends after removing the source. Effective rename/move changes carry
`CollectionEditRecovery`; `restoreCollectionEdit(current, recovery)` restores
only that name/location while preserving newer content and unrelated entries.
No-ops retain registry/tree references and do not replace Undo.
`CollectionMoveDialog` owns destination search and emits `move(parentId)` or
`cancel`; the manager validates and commits against current data. The
`useCollectionReordering` composable owns capture, geometry, hover expansion,
scrolling, and cancellation, then invokes one placement callback. See
[collection management](collection-management.md) for examples and recovery rules.

`QuickOpen` accepts saved `requests` and `nodes`, emitting `select-request` and
`close`; App owns its global Cmd/Ctrl+K shortcut. See [navigation](navigation.md).
`HistoryPanel` accepts `entries` and optional `selectedEntryId`, emitting
`inspect(entry)` and `clear()`. `HistoryInspector` accepts a captured `entry` and
provides an `actions` slot for Open as draft and Send again. App handles `clear()`
by retaining an Undo snapshot, which merges with current history on recovery.
Collections and History remain mounted in separate scrollports, preserving local
search, filters, expansion, and scroll position across sidebar switches.
`ImportExport` accepts `requests`, `nodes`, optional `activeRequest`,
`capturedRequest`, and `environment`; it emits `import` with `{requests, collection}`.
The active request can be a saved definition or an unsaved editable history draft.
Its cURL export uses the same captured-first selection as manual Send.

App's runtime tab union distinguishes saved requests, read-only execution
snapshots, and unsaved editable drafts. Opening a draft never sends it; Send again
uses the exact captured `HttpRequest`. Until the first model edit, manual Send
also uses those captured inputs. History drafts start in literal input mode;
an edit clears captured mode and prepares the literal definition. Environment
substitution resumes only after explicitly selecting template mode in Advanced.
Save to Collections promotes a draft
under the same identity, preserving its editor and running operation. Draft
records autosave independently of Collections, survive reload, and remain
recoverable through **Reopen closed draft** after their tabs close. See
[history](history.md) for the user flow and lifetime guarantees.

Storage is a versioned local workspace document containing requests, collection,
environments, selected environment, history, draft records, recently closed draft
IDs, open saved-request/draft tab IDs and selection, and split preferences.
Read-only history tabs remain transient. Only explicit saving adds a draft to
Collections; its persistence does not depend on promotion.
`src/workspace.ts` defines `WorkspaceData`, `WorkspaceDraft`, `createWorkspace()`,
`loadWorkspace(storage?)`, `saveWorkspace(workspace, storage?)`; the optional
Storage-like dependency enables contract tests without browser globals.
`SplitSizes` is `{horizontal: number | `${number}%`, vertical: number | `${number}%`}`.
Tabs accepts initial items and active ID, emits a state-change snapshot, and
exposes close/update-label commands for collection operations.
Its optional `presentation` map supplies transient execution feedback and unsaved
markers by tab ID, separately from persisted descriptors. See [tabs](tabs.md) for
the `TabPresentation` contract and usage.
App derives this map from transient executions and draft identities. When a
request completes after its tab closes, a completion notice opens its captured
response on demand. These notices and history Undo recovery reset on reload.

Credentials and resolved history are local workspace data. Storage/export UI
must make their inclusion explicit. Portable exports use a versioned JSON schema;
imports validate everything before replacing or merging the current workspace.
