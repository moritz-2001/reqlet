# Request editor

[RequestEditor.vue](../src/components/RequestEditor.vue) composes a controlled
request definition, execution actions, compact settings, pane preferences, and a
response inspector. The parent owns the definition and execution; the editor emits
complete replacements and send/cancel intents without starting transport.

```vue
<RequestEditor
  v-model="request"
  v-model:layout="paneSizes"
  :environment="activeEnvironment"
  :execution="execution"
  @send="sendRequest"
  @cancel="cancelRequest"
  @edit-environment="openEnvironmentManager"
/>
```

Its `modelValue: Readonly<RequestData>` is required. `execution?: ExecutionState`
defaults to idle; `environment?: Environment` supplies the next execution's scope;
`layout?: SplitSizes` optionally controls saved orientation preferences. The
`request-status` slot lets the parent put compact draft status/actions immediately
below the request name. `capturedRequest?: HttpRequest` supplies an exact replay
snapshot to the destination preview until the parent clears it after an edit.
The parent continues to own whether Send uses that snapshot or prepares a draft.
While `capturedRequest` is present, field assistance also treats every value as
literal, including text that looks like `{{variables}}`. The parent clears that
prop on the first definition edit; switching tabs or environments does not clear it.
App reconstructs history drafts with literal input mode, so clearing the capture
or saving to Collections preserves placeholder-looking text. Users explicitly
select Environment template in Advanced when they want substitutions again.
Send, destination preview, and active cURL export share `prepareNextRequest`;
see [request preparation](request-preparation.md) for the pure boundary.

Body actions and protobuf assistance use `previewRequestContentType`, including
resolved header names/values, authentication overrides, and default MIME values.
The projection ignores unrelated incomplete URL/query/body inputs. Captures use
their actual Content-Type header, and literal mode ignores the environment.

## Address and settings

[RequestFields.vue](../src/components/RequestFields.vue) keeps method, URL, and its
`actions` slot on one row. Method suggestions include GET, POST, PUT, PATCH,
DELETE, HEAD, and OPTIONS; custom names remain allowed. URL text preserves
`{{variable}}` references.
In address panes at most 420px wide, the URL takes a full row below Method and
the execution actions, so Cancel and Sending cannot squeeze the editable address.
[RequestTarget.vue](../src/components/RequestTarget.vue) shows the execution scope
and prepared destination below the address, using the same
pure preparation as Send rather than changing the editable definition. Hovering
the URL input previews its resolved text while the input retains its placeholders.

[MethodSelector.vue](../src/components/MethodSelector.vue) is a controlled editable
combobox with `modelValue: string`, `update:modelValue`, and optional `literal`
validation bypass for unchanged captured replay. Clicking the method or its arrow
offers all seven standard choices with descriptions and distinct colors. Typing
filters by prefix without replacing the draft or changing its case. Arrow keys
highlight choices; Enter chooses one; Escape, Tab, blur, and outside interaction
dismiss without committing a suggestion. Cmd/Ctrl+Enter continues to send the
current draft. Local native validity uses `previewRequestField`; preparation owns
normalization. The popup renders outside the editor's clipped panes, fits the
available viewport space, and closes when its anchor scrolls, the window resizes,
or its cached request editor deactivates.

The request pane groups settings into Body, Headers, Parameters, Auth, and Advanced
tabs. Arrow keys cycle the tabs; Home/End select the first/last tab. Only the active
tab is in the Tab sequence, and each tab names its corresponding panel. Panels
remain mounted while hidden, preserving CodeMirror selection, folds, undo history,
and incomplete input across settings changes. App's KeepAlive cache extends that
presentation lifetime across request switching.

An empty GET or HEAD initially shows only an **Add body** action below the
settings tabs. The request section takes its content height, leaving the response
the rest of the workspace. Opening the body editor changes presentation only;
it does not invent a payload or alter the request. Requests with existing body
text and other methods show their body editor immediately. Selecting Headers,
Parameters, Auth, or Advanced also restores a full settings pane.

Headers and Parameters use [KeyValueEditor.vue](../src/components/KeyValueEditor.vue),
a controlled editor for ordered `readonly KeyValueEntry[]` values. The `label` and
singular `entryLabel` identify each group and its accessible row controls. Add,
remove, enable, and edit operations emit replacement arrays; duplicate names and
disabled row values remain intact. Request rows pass `resolveVariables`, the
active `environment`, and `headers` for transport header rules; environment
variable definitions omit `resolveVariables` and remain plain editable text.
Accepted additions reveal and focus the new Name input. Removing a focused row
hands focus to its next surviving neighbor, previous neighbor, or Add. See
[key/value editing](key-value-editor.md) for controlled update and focus behavior.

Parameters also shows literal query text already written in the URL separately
from additional rows. **Edit URL parameters** selects that source text in the URL
input without rewriting it. The tab count includes both sources. See
[request parameters](request-parameters.md) for encoding and placeholder semantics.

URL, header, query, and authentication fields share
[VariableInput.vue](../src/components/VariableInput.vue). Typing `{{` offers enabled
names from the selected environment. Arrow keys select a name, Enter or Tab
inserts its complete placeholder, Escape dismisses the list, and mouse selection
works without losing the caret. Completion replaces only the current placeholder,
preserving surrounding text. Suggestions show names rather than values, and
masked authentication inputs never get resolved-value tooltips.

Each participating input reports missing references, cycles, or invalid transport
values beside the affected field and connects that message using `aria-describedby`.
Variable problems offer **Edit environment**. This emits `edit-environment` through
the editor; the workspace owns opening the manager and keeps environment selection
separate from execution. Pristine empty inputs and active completion menus suppress visible error text,
while retaining native validity and `aria-invalid`. Leaving a field or validating
with Send reveals its empty-field message. Native custom validity also lets Send
reveal and focus an invalid input in another settings tab. It also opens enclosing
disclosures, including collapsed authentication settings, before reporting the
error. Disabled rows and unchanged captured replay
values do not participate in this resolution or validation. Authentication header
replacement follows preparation semantics: a saved header value that will be
replaced still resolves its placeholders, but its unused header-value syntax does
not block execution. `replacedHeader` supplies that resolved header name to the row
editor; matching is case-insensitive.

[AuthEditor.vue](../src/components/AuthEditor.vue) edits credentials in the Auth
tab, separately from an already prepared snapshot. See
[authentication and environments](authentication-environments.md).

The Body tab's single toolbar groups content type with formatting and body actions.
Actions that do not fit the body pane remain available in More. The content type
selector follows an enabled explicit Content-Type
header and is disabled while that header is authoritative. Body highlighting
uses the same value. Removing/disabling the header restores the definition's
default content type, avoiding conflicting settings.

Protobuf source/message setup lives in Advanced beneath the timeout. With a
binding, a toolbar link opens Advanced and focuses its Protobuf completion
heading. Invalid, inactive, or stale bindings keep recovery feedback beside the
body; opening configuration preserves the mounted text editor and its selection.

## Execution and bounded layout

Send stays beside the address; Cmd/Ctrl+Enter sends from any editor field. While
running, Send is disabled and Cancel becomes available. Editing remains possible
so the next definition can change without altering an exchange in flight.

Advanced contains the timeout in milliseconds. Only integers from 1 through
2,147,483,647 enter the saved definition. Incomplete or invalid input stays in a
local draft so changing tabs cannot silently revert it to the previous valid
value. Sending with invalid input reveals Advanced, focuses the input, and
reports native validation feedback instead of executing with a stale timeout.

The request/response layout derives compact presentation from content rather
than writing temporary sizes into the workspace. Empty GET/HEAD Body panels use
`SplitPane`'s `compact="first"`; otherwise an idle response uses
`compact="second"`, appearing as a quiet status row below the composer. Both
panes stay mounted, preserving editor selection, folds, and undo history.

When neither pane is compact, the divider becomes available and restores its
saved preference. The default is an equal split: columns above 800px of workspace
width, stacked rows at or below that width. An expanded body uses 160px/140px
minima. There is no forced combined extent. Automatic compact/expanded changes
emit no layout updates; only user resizing changes persisted preferences.
Request settings scroll within their selected panel when needed, leaving
execution actions and response status visible.

[ResponseInspector.vue](../src/components/ResponseInspector.vue) keeps HTTP status,
duration, and body size visible above its body. URL, MIME information, and ordered
headers live in a collapsed Response details disclosure. Body text owns its
scrolling viewport rather than pushing the result below the outer editor. Saved
pane preferences and accessible divider interaction retain the
[SplitPane](split-pane.md) contract.

During retries, the response inspector keeps its last received body mounted and
labels it **Previous response** with the latest attempt's sending, failure, or
cancellation feedback. A new received response replaces that view; resetting to
idle clears it. This cache follows the keyed editor's lifetime and does not
change execution or history ownership.

[RequestEditor tests](../tests/RequestEditor.test.ts) exercise controlled edits,
duplicate row behavior, timeout validation across tabs, keyboard navigation,
editor identity, body disclosure, and execution intents. Browser verification
checks actual 800×600 and larger workspace geometry; jsdom does not supply layout.
