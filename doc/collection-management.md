# Collection management

[CollectionManager.vue](../src/components/CollectionManager.vue) organizes requests
and folders while [App.vue](../src/App.vue) owns their canonical definitions and
hierarchy. The management target is independent of the active editor. Renaming,
moving, and reordering an inactive request preserve the active tab, tab order,
editor state, and running exchange. Explicit selection and creating or duplicating
a request still open that request.

## Editing and movement

Every row has an **Actions** menu. **Rename**, or **F2** on a focused row or its
menu trigger, replaces the label with a selected input. **Enter** or **Save**
commits a trimmed nonempty name; empty names retain the input and show an error.
**Escape** or **Cancel** discards the edit. Leaving the inline form cancels without
moving focus back. Composition input does not submit or activate shortcuts.
Full labels remain available in tooltips when the sidebar truncates them.

**Move to** opens [CollectionMoveDialog.vue](../src/components/CollectionMoveDialog.vue),
a viewport-bounded native modal with destination search, full folder paths,
current location, and **Collection root**. Choosing a destination appends there;
the current parent is disabled and cyclic destinations are excluded. Its search
uses every folder, including empty folders and folders hidden by request search.

**Move up** / **Move down**, or **Alt+Shift+Up** / **Down** on a focused entry,
move one sibling position. Boundary actions are disabled. During request search,
positional actions and drag handles are unavailable because hidden siblings
make insertion ambiguous; Rename and Move to remain available. Shortcuts ignore
inputs and editable content. After organization, the manager reveals and focuses
the affected entry by stable ID. If filtering hides it, search keeps its query
and receives focus with a result announcement.

Mouse and pen users can drag the row's handle. Insertion lines identify precise
before/after positions; an inside-folder highlight means append. Empty folders
and the collection root have explicit drop targets. Touch uses the menu movement
controls while preserving scrolling. See [collection-tree.md](collection-tree.md)
for expansion and gesture ownership.

**New request** remains the primary toolbar action; its adjacent dropdown offers
**New folder**. Folder menus add **New request here** and **New folder here**.
Creation defaults to the management folder or the selected request's containing
folder. Creation, duplication, and deletion confirmation use the forms below the
tree. Actions capture their target ID, so later editor selection cannot retarget
an open form or picker.

Large expanded/filter results render a viewport window while retaining the
focused, edited, and dragged entries. Keyboard traversal and focus restoration
mount logical destinations before focusing them; scrolling does not discard an
inline edit. See [collection-tree.md](collection-tree.md) for projection and
scrollport ownership.

The manager owns one teleported action menu for every rendered row. Menu opening
does not open a request or toggle a folder. Arrow keys and Home/End navigate;
Escape returns to the originating control. Outside interaction, scrolling, or
resizing dismisses the menu. Completed and cancelled interactions restore focus
by entry identity where appropriate, including after reparenting replaces DOM.

## Commit contract

The manager accepts `requests`, `nodes`, and optional `selectedRequestId`. It
emits one `change(CollectionChange)` for an effective operation; the owner applies
the request registry and hierarchy together. `select-request(id)` is a separate
explicit opening intent. `CollectionChange.selectedId` identifies only the
management target. There are no separate registry/tree update or deletion
cleanup events.

[collections.ts](../src/collections.ts) provides immutable operations on
`CollectionState`. A change contains replacement `requests` and `nodes`, the
management target, `deletedRequestIds`, and optional deletion or edit recovery.
App captures deletion recovery and cleans up affected requests before replacing
definitions, so cleanup runs once. Ordinary organization does not invoke that
deletion lifecycle. Its existing autosave persists resulting names and order
without a workspace schema change.

`CollectionPlacement` uses stable identities rather than array indices:

```ts
const folder = createCollectionNode(state, "folder", "Team API");
const request = createCollectionNode(folder, "request", "List people", folder.selectedId);
const moved = moveCollectionNode(request, request.selectedId!, {
  parentId: null, // Collection root; a folder ID selects its direct children.
  beforeId: folder.selectedId, // null would append after the remaining children.
});
const renamed = renameCollectionNode(moved, moved.selectedId!, "All people");
```

Anchors refer to destination children after removing the source. Operations
validate source, folder, direct-child anchor, and cycles before returning.
Unknown or stale IDs throw readable errors without a partial change. A
self-anchor is unchanged only in the current parent. Same effective placement
and the same trimmed canonical name preserve both state references and produce
no recovery or save notification. `collectionSiblingPlacement(nodes, id, -1 | 1)`
resolves the shared operation's placement, returning null at a boundary or for
an absent entry.

Moves preserve IDs, request objects, and complete subtrees. Renames update the
canonical request name and its tree fallback label. Duplication creates fresh
IDs throughout a subtree and independently copies editable request fields.
The injectable ID factory supports deterministic callers and tests.

## Targeted edit recovery

App retains the last effective rename or move as `CollectionEditRecovery` and
offers Undo beside a resulting name/location message. A later effective edit
replaces it; dismissal, reload, or target deletion clears it. Rename recovery
stores the previous and committed name; move recovery stores the original parent
and sibling identities. `restoreCollectionEdit` merges into current state and
returns no new recovery:

```ts
const moved = moveCollectionNode(state, "people", { parentId: "archive", beforeId: null });
const current = renameCollectionNode(moved, "another-request", "Later change");
const restored = restoreCollectionEdit(current, moved.recovery!);
```

Later request-body edits and unrelated entries survive. Surviving original next
neighbors anchor movement recovery, then previous neighbors, then append. A
missing original parent, removed target, or new cycle prevents recovery and
leaves current data untouched. Rename recovery also refuses to overwrite a newer
name. Recovery restores only its recorded edit, never an old workspace snapshot.

## Deletion recovery

Deletion confirmation reports affected requests, including nested descendants.
`deleteCollectionNode` returns their IDs and a detached `CollectionDeletion`.
App retains one deletion until Undo, dismissal, replacement by another deletion,
or reload. `restoreCollectionNode` preserves IDs and merges definitions and the
subtree into current data, anchored by surviving original siblings. If its former
parent disappeared it restores at root; reused IDs cause a visible error.

App separately retains removed pane preferences, completed execution feedback,
and tab positions. Undo restores removed tabs without replacing later tab edits.
It restores the former active request only if no later selection revoked that
choice. Deleted exchanges are cancelled and never restarted. History remains
independent, and editor caches retain their existing bounded lifetime.

## Search and verification

The persistent request filter matches canonical names, URLs, methods, and folder
paths. Every query word must match, ignoring case. Matching requests appear with
temporarily expanded ancestors. Folders can be collapsed and reopened while
filtering; these choices last only for the current query. Changing the query
auto-expands its matches again, and clearing search restores remembered browsing
expansion.
Enter opens the first match, Escape clears, and counts/no-match messages are
announced. `focusSearch()` focuses and selects the current query. See
[navigation.md](navigation.md) for keyboard integration.

Pure placement and targeted recovery are covered by
[collections.test.ts](../tests/collections.test.ts). Visible editing and navigation
contracts are covered by [CollectionManager.test.ts](../tests/CollectionManager.test.ts).
[CollectionReordering.test.ts](../tests/CollectionReordering.test.ts) covers pointer
lifetimes; [App.collection-editing.test.ts](../tests/App.collection-editing.test.ts)
and [App.collection-recovery.test.ts](../tests/App.collection-recovery.test.ts)
cover organization, persistence, execution, and deletion/tab recovery.
Run focused tests, `pnpm test`, and `pnpm build`; browser/Tauri checks establish
capture, clipping, scrolling, drawer lifetime, and real geometry. The
[delivery plan](collection-editing-plan.md) retains the complete acceptance scope.
