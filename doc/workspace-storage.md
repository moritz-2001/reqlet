# Local workspace storage

[WorkspaceData](../src/workspace.ts) is the complete version 1 application model.
App owns it, while [WorkspaceRepository](../src/workspaceRepository.ts) owns
production persistence. [main.ts](../src/main.ts) loads the repository before
mounting App and supplies its `initialWorkspace` and `repository` props. The
repository stores each saved definition and draft in its own IndexedDB record,
in the `requests` and `drafts` stores. A compact document contains their ordered
identities, collection structure, environments, preferences, and history references.
Complete history captures, including resolved requests and response bodies, occupy
separate records in the `history` store. These stores contain credentials and
should be handled as private local data.

```ts
const repository = createWorkspaceRepository(createIndexedDbWorkspaceStorage());
const { workspace, error } = await repository.load();
if (error) showStorageError(error);

// Returns immediately; snapshots after 200 ms without edits, within 1 second of
// the first queued edit when no earlier write is still running.
// Coalesced calls share the latest state and completion result.
const saved = repository.save(workspace);
const { warning } = await saved;
if (warning) showStorageError(warning);

await repository.flush(); // Start pending work now and wait for queued commits.
```

Saves debounce across typing events: 200 ms of quiet starts a batch, with a
one-second deadline measured from its first queued edit. Edits received during
an active write wait for it and form another debounced batch. `flush()` bypasses
these delays and drains queued work. Writes serialize, so an older write cannot
overwrite a newer edit. A save promise rejects if editable definitions
cannot be committed; a resolved promise with a warning means definitions and
drafts were saved but some history could not be retained. App displays **Saving
workspace…** while the latest save is pending and reports its final warning or
failure. It flushes pending work on `pagehide`, when the document becomes hidden,
and on unmount. Commits remain asynchronous; forced process termination can
interrupt the newest batch.

Each batch compares saved definitions and drafts with detached snapshots of the
last successful commit. It copies changed mutable containers while retaining
immutable strings and live [body revisions](../src/bodyDocument.ts). Nested edits
are detected even when a caller keeps the same request object. Only changed
records are materialized and written; changing a tab, divider, or environment
does not serialize, clone into IndexedDB, or reread unrelated request bodies.
Flattening an edited body is deferred until that record needs persistence.
The complete workspace is still validated before a commit, including references.

The repository uses storage-envelope version **2**, independently of the logical
`WorkspaceData.version` (**1**). Metadata and changed/deleted request and draft
records commit in one IndexedDB transaction. Promoting a draft therefore cannot
save its collection reference while losing its definition, or remove the draft
before the saved definition exists. Final history status updates write metadata
only. Snapshots advance after the editable transaction commits, so a failed save
retries every outstanding record change. Ordinary saves reread compact metadata
to preserve malformed/newer documents; a changed external document is restored
and validated before replacement. Every editable transaction gives the envelope
a new commit identity, including changes confined to a body record. Another
window's changes therefore invalidate cached record snapshots even when its
collection and preferences are unchanged. Saving a complete workspace preserves
the existing last-write-wins behavior across windows. Earlier version-2 envelopes
without a commit identity rewrite complete editable records on their next save.
Editable delta transactions also check their baseline's commit identity atomically;
an intervening write refreshes the baseline and recomputes the captured batch's
delta. Three consecutive conflicts reject with a readable error so a save cannot
remain pending indefinitely. History-only
completion writes check that identity inside their transaction; an older completion
cannot overwrite a newer window's metadata and hide its editable commit.

Persisted history is bounded by **100 captures and 8 MiB of UTF-8 JSON**. The
repository selects recent complete captures that fit both limits; an oversized
capture does not prevent a smaller capture from being retained. Live history and
open response inspectors keep their complete session snapshots. A quota failure
writing a capture cannot roll back saved definitions. Under quota pressure,
older capture records may be evicted to make room for editable work. Captures
that cannot be stored are omitted as whole exchanges, with a warning that they
will not be restored after reload; empty bodies are never substituted. The
warning is saved in the definitions document and shown on reload. An interrupted
save also leaves a durable warning, and missing/corrupt capture records do not
hide valid definitions. Explicit history clearing/pruning removes payload records.

On first load, a missing IndexedDB document imports valid legacy
`localStorage["api-tool.workspace"]`. The original localStorage bytes remain
untouched as a backup; later loads prefer IndexedDB. Invalid legacy data blocks
migration and autosave instead of replacing it with examples. Invalid/newer
IndexedDB documents are also preserved and block autosave. If IndexedDB cannot
be opened, valid legacy work remains visible in memory with a storage error;
new edits are not reported as saved. After migration, localStorage is a backup,
not the current workspace. Back up the IndexedDB `api-tool.workspace` database
before manually removing any of its `documents`, `requests`, `drafts`, or `history`
records for recovery. Earlier version-1 IndexedDB documents load without rewriting
their bytes. Their next successful save moves definitions and drafts to independent
records in the same atomic commit as the version-2 metadata. Database schema
upgrades create the new stores while preserving existing documents and history.

`WorkspaceRepositoryStorage` is the injectable asynchronous boundary. All
definition, draft, and capture reads start together during restoration, retaining
stored order even when reads finish out of order. The IndexedDB adapter batches
record reads started in the same synchronous wave into one readonly transaction.
After reading compact metadata, a saved version-2 workspace therefore needs just
one more transaction for all referenced records, rather than one transaction per
definition, draft, or capture. No bulk-read method is required from injected
adapters. An intervening storage operation ends the pending batch, preserving
read/write order even while the database is opening. Every batch queues its gets
before yielding and resolves callers after transaction completion; later waves
use a new transaction. Definitions are validated once, while
`parseHistoryEntry` validates each independent capture. Missing, corrupt, and
mismatched identities still produce omission warnings. Its
`readRequest(id)` and `readDraft(id)` hydrate independent editable records on load;
missing or corrupt editable records preserve the saved data and block autosave.
`writeDocument(document, changes?, expectedCommitId?)` atomically commits metadata
with a `WorkspaceRecordChanges` batch. Omit `changes` and provide the editable
commit identity for guarded metadata-only history completion. An adapter must
check the expected identity inside the same transaction and throw
`WorkspaceCommitConflict` on a mismatch so the repository can retry editable
deltas. For editable updates:

```ts
await storage.writeDocument(metadata, {
  requests: { [requestId]: updatedDefinition },
  drafts: {},
  removedRequestIds: [],
  removedDraftIds: [promotedDraftId],
});
```

Its history operations read/write/delete independent captures. The IndexedDB adapter resolves
writes on transaction completion, after quota checks, rather than request
success. [Repository tests](../tests/workspaceRepository.test.ts) exercise that
adapter with `fake-indexeddb`, changed-record commits, transaction rollback,
bounded startup transaction counts, read/write ordering while opening storage,
lazy body materialization, migration, corruption, quota resilience, byte retention,
and queued-save ordering. [Application storage tests](../tests/App.storage.test.ts)
cover deferred edits, background flushing, live response ownership, and later
definition edits after capture storage fails.

The synchronous `loadWorkspace`/`saveWorkspace` API remains available for legacy
embedding and validation tests. App uses it only when no repository is supplied:

```ts
const { workspace, error } = loadWorkspace();
if (error) showStorageError(error);

try {
  saveWorkspace(workspace);
} catch (error) {
  showStorageError(error);
}
```

Both legacy operations accept an optional `WorkspaceStorage` argument exposing
`getItem(key)` and `setItem(key, value)`. This keeps browser storage behind a
small boundary and allows reload, quota, and access-error tests without a live
browser. The key is exported as `WORKSPACE_STORAGE_KEY` (`api-tool.workspace`).

Loading missing data produces independent starter definitions, the Local
environment, and an empty history and tab strip. Loading malformed JSON, an
unsupported schema version, invalid fields, or broken references returns an
unsaved starter workspace plus an error. It does not change the saved bytes.
Saving checks the existing document before replacing it, so subsequent autosave
cannot accidentally replace unreadable user data with those starter examples.
Storage access and quota failures are reported to the caller.

To recover from an unreadable legacy document before migration, first back up the value of
`localStorage["api-tool.workspace"]`, then remove that entry and reload the app.
This is an explicit recovery action; loading and autosave never perform it.
Unsupported newer versions can instead be opened with a compatible app.

[workspaceValidation.ts](../src/workspaceValidation.ts) is the runtime boundary
shared with portable imports. `parseWorkspace(value)` validates a full document;
`parseCollection(value)` validates `{ requests, collection }`;
`validateRequestsAndCollection(requests, collection)` validates those fields
when they are already extracted. Errors identify the invalid field. Saved
draft URLs may be incomplete because URL validation belongs to sending a
request; stored execution snapshots require resolved HTTP(S) URLs. Collection
references are unique and every saved definition has a collection reference.
History may refer to definitions that were subsequently deleted.

The version-1 document also stores `drafts: Record<string, WorkspaceDraft>` and
`closedDraftIds: string[]`. A `WorkspaceDraft` contains its editable `request`,
optional unchanged `capturedRequest`, and optional divider `layout`. Every draft
must either appear in `openTabIds` or in `closedDraftIds`, which lists closed
drafts newest first. A draft cannot also be a saved request, and a closed draft
cannot also be open. Documents written before these additive fields existed
normalize their absence to empty containers; malformed draft data still fails
validation and preserves the saved bytes.

The version-1 IndexedDB document decoder retains the normalized workspace returned by
`parseWorkspace`, just as the legacy loader does. Loading an earlier version-1
document therefore supplies usable draft recovery containers before App restores
open tabs, without rewriting the stored document until the next save.

[Tabs](../src/components/Tabs.vue) owns its live strip. `initialItems` and
`initialActiveId` restore it once when mounted, without generating selection
events. Its `state-change` event emits independent descriptor copies containing
the complete order and active identity after user operations or commands. App
persists IDs and selection; labels are rebuilt from current definitions.
The exposed `close(id)` and `updateLabel(id, label)` commands support collection
edits while keeping ownership of tab state inside Tabs.

The application persists saved-request and draft tab order/selection while
excluding read-only history tabs. Inspecting an execution leaves the last
selected open saved request or draft as the reload target; without one, reload
opens an empty workspace. Draft edits and pane preferences autosave independently
of Collections. Closing a draft retains it for **Reopen closed draft**, including
after reload. Saving it to Collections transfers its current definition and pane
preferences under the same identity, then removes its draft/recovery entries.
Sending a draft adds a completed exchange to history without promoting it to
Collections. History `requestId` values therefore need not identify a saved
collection definition. See [history](history.md).

Execution progress, results attached to editable tabs, and tab status badges are
transient; completed snapshots persist in history. Reload does not resume running
exchanges. History Undo snapshots and closed-tab completion notices are also
transient. Undo merges removed records with new history before applying the
retention limit, without replacing executions completed since clearing. Sidebar
search, filters, folder expansion, and scroll position survive view switches
within the session, but reset on reload; see [navigation](navigation.md).

[SplitPane](../src/components/SplitPane.vue) accepts optional `sizes` and emits
`update:sizes` for user resizing and reset. `SplitSizes` holds separate
horizontal and vertical preferences, each as pixels or a percentage. Temporary
minimum-size clamping, window resize, and hidden panels never change these
preferences or emit saved changes. With no `sizes` prop, SplitPane retains its
own preferences. A parent can persist controlled values with `v-model:sizes`.
