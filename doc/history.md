# Execution history and replay

[HistoryEntry](../src/request.ts) captures a completed execution independently of
its saved request definition: execution identity, name, start time, resolved
`HttpRequest`, and success, failure, or cancellation result. Idle and running
states are excluded. Headers, body, URL parameters, authentication, and environment
variables have already been resolved in the request snapshot.

[appendHistory](../src/history.ts) is a pure insertion operation. It sorts by
execution start time descending and retains the newest 100 executions. Reusing an
execution ID replaces its previous record; equal start times put the supplied
record first. It copies request headers and response headers for all retained
records, so later mutations of either inputs or returned history cannot change
the other snapshot. Error and cancellation results are copied too.

```ts
history = appendHistory(history, {
  id: crypto.randomUUID(),
  requestId,
  name: requestName,
  startedAt,
  request: resolvedRequest,
  result: { status: "success", response },
});
```

[HistoryPanel](../src/components/HistoryPanel.vue) is a navigation list of
parent-owned `entries`. Clicking an execution emits `inspect(entry)`; it never
sends a request or modifies saved definitions. `selectedEntryId` highlights the
execution currently open in the workspace, and omitting it leaves the list
unselected. Each row shows its name, method, destination, time, and final result.

[HistoryInspector](../src/components/HistoryInspector.vue) displays the selected
exchange in a clearly labeled read-only workspace tab. Its `entry` prop contains
captured inputs and the completed result. It shows the original method, URL,
timeout, start time, ordered headers, and body, and reuses
[ResponseInspector](../src/components/ResponseInspector.vue) for the response.
The named `actions` slot lets the workspace provide execution or draft actions
without giving the inspector ownership of saved data or transport work.
The captured request's body editor mounts only when its disclosure is first
opened. Later closes retain that editor's search and selection; changing the
captured identity starts with a fresh closed disclosure.

```vue
<HistoryPanel
  :entries="history"
  :selected-entry-id="activeHistory?.id"
  @inspect="inspectHistory"
  @clear="clearHistory"
/>
<HistoryInspector v-if="activeHistory" :entry="activeHistory">
  <template #actions>
    <button @click="openHistoryDraft(activeHistory)">Open as draft</button>
    <button @click="replayHistory(activeHistory)">Send again</button>
  </template>
</HistoryInspector>
```

[App](../src/App.vue) distinguishes saved request tabs from runtime history tabs.
Opening the same execution again selects its existing tab. A history tab owns an
independent snapshot until closed, so clearing history or pruning old records
leaves an already open exchange available for inspection. Closing follows the
shared tab policy and returns to the neighboring request or execution. Clearing
history does not close those snapshots; close their tabs to dismiss them.
Saved request and editable draft tab order and selection are persisted. While
history is active, reload restores the last selected saved request or draft still
open, or the first remaining persistent tab. History-only sessions reload with an
empty workspace panel, and history records remain available in navigation unless
explicitly cleared.
Cached request editors retain their draft and presentation state across history
inspection; an exchange in flight continues independently of the selected tab.
Collections and History also retain their own search, filters, folder expansion,
and scroll position while switching sidebar views. This navigation state resets
on reload; see [navigation](navigation.md).

The inspector provides two distinct actions. **Open as draft** creates an
editable, unsaved tab without making a network request. **Send again** opens the
same kind of tab and immediately executes `entry.request` directly, without
resolving the current environment or using the current saved definition. It
retains the original credentials, ordered headers, literal body text, and URL.
Neither action adds to Collections. Clearing emits `clear()` and removes retained
execution records; saved definitions, editable drafts, and open snapshots remain
available. App keeps the removed records in a recovery notice until it is
dismissed or another clear replaces it. **Undo clear history** merges them with
executions completed since the clear, deduplicates execution IDs, sorts by start
time descending, and applies the 100-record limit. Current records take precedence
over restored records, including when start times tie. This recovery notice is
transient and does not survive reload.

A draft owns its `RequestData` and optional divider preferences in the persisted
`WorkspaceDraft` record in [workspace.ts](../src/workspace.ts). Runtime tabs refer
to that record by ID. Captured authentication is represented as concrete headers
and query parameters already embedded in the URL; it is not reapplied as a second
authentication configuration. A separate `capturedRequest` owns the unchanged
transport snapshot. Until the first edit, even manual Send uses this snapshot,
so literal `{{...}}` in previously resolved values cannot be expanded again.
[RequestTarget](../src/components/RequestTarget.vue) labels this mode **Captured
inputs** and previews the exact destination. The editable definition reconstructed
from those concrete values uses literal input mode. The first request edit removes
the exact snapshot mode; preview and Send then prepare that literal definition.
Only explicitly choosing environment template mode enables variable expansion.
Changing pane size does not count as a request edit.

The draft banner explains this mode and that drafts autosave locally before they
are added to Collections. Reload restores open drafts, including their unchanged
captured inputs and divider preferences. Closing a draft retains its definition
in `workspace.drafts` and records its ID in `closedDraftIds`, newest first.
**Reopen closed draft** in the sidebar restores the latest closed draft; repeating
the action recovers earlier drafts. Reopening does not execute a request or add
it to Collections.

**Save to Collections** promotes the current definition under the same identity
and removes its draft/recovery entries. Saving preserves its cached editor,
divider preferences, result, and any running operation. Subsequent sends use
normal preparation in the definition's selected input mode, as indicated by the
execution-target preview. Promoting an unedited capture keeps its values literal.
Closing a
running draft leaves the operation alive; its final result still enters history.
Live execution state is transient and does not resume after reload.

The tab strip receives caller-owned execution feedback separately from persisted
tab descriptors. It displays **Sending…**, a completed HTTP code, **Failed**, or
**Cancelled**, including on inactive tabs. Drafts also have an unsaved marker.
When an exchange finishes after its tab closes, App shows a completion notice;
**Show response** opens the captured result in a history tab without sending it
again. The notice remains available until dismissed or replaced by another
closed-tab completion, and does not survive reload. See [tabs](tabs.md).

The asynchronous [workspace repository](../src/workspaceRepository.ts) persists
complete captures in records separate from editable definitions and drafts.
[historyForStorage](../src/history.ts) selects recent captures within both the
100-record and 8 MiB UTF-8 storage budgets. Captures omitted by that budget or a
quota failure remain available in the current session; a durable notice explains
that they will not return after reload. Saving a definition does not depend on
successfully storing a response body. See [workspace storage](workspace-storage.md)
for migration, errors, and the asynchronous save lifetime.

Captured authorization headers, request bodies, and response bodies can contain
secrets; the panel states that credentials are included in local history.
Redirect policy and custom credential-header metadata belong to the resolved
request snapshot, so replay retains its destination and credential boundaries.

[History unit tests](../tests/history.test.ts) cover retention, ordering, duplicate
identity, and ownership. [Panel tests](../tests/HistoryPanel.test.ts) cover
navigation and emitted inspect/clear intents through the component
interface. [Inspector tests](../tests/HistoryInspector.test.ts) verify captured
inputs and completed results are read-only. [Application execution tests](../tests/App.execution.test.ts)
cover inspection, exact snapshot sending, draft ownership, explicit saving,
cancellation and close lifetimes, history clearing, and persistent tab restoration.
[Recovery tests](../tests/App.recovery.test.ts) cover draft reload/reopening,
background tab feedback and completion notices, and merging history Undo with new
executions.
