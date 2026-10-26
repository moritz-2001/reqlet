# Easier collection movement and editing

Status: implemented, 23 October 2026. This document records the delivered scope
and acceptance criteria. Automated checks and browser verification are recorded
below, along with the remaining device/runtime checks.

The agreed scope is organizing requests and folders inside the existing
workspace. Make frequent actions available beside their targets, allow precise
ordering, and preserve the request the user is currently editing.

## Problems addressed

- [moveCollectionNode](../src/collections.ts) now supports exact sibling anchors
  as well as appending to another folder.
- [CollectionManager.vue](../src/components/CollectionManager.vue) places Rename
  beside its target and uses a searchable modal for movement. Create, Duplicate,
  and Delete retain their forms below the tree.
- Organization keeps the active editor fixed and restores management focus by
  stable identity after hierarchy changes.
- Shared expansion survives subtree reparenting, and folder menus provide
  contextual creation. Mouse/pen handles and keyboard/menu sibling actions use
  the same pure placement operation.

## Implemented interaction

| Action | Behavior |
| --- | --- |
| Rename | Menu → Rename or F2 on a focused row replaces its label with a selected name field. Enter or Save commits; Escape or Cancel discards. Empty names keep the field open with an error. Moving focus outside cancels the uncommitted edit without stealing focus back. Ignore shortcuts and submission during IME composition. |
| Move to another folder | Menu → Move to opens a viewport-bounded modal with destination search, full folder paths, the current location, and Collection root. Selecting a destination and pressing Move appends there. Moving to the current parent is disabled. Invalid destinations are excluded. |
| Change sibling order | Menu actions Move up / Move down and Alt+Shift+Up / Down on a focused row move one position within its parent. Boundary actions are disabled. These controls also provide ordering on touch devices. |
| Drag | A handle on a row starts a mouse/pen gesture. Show an insertion line before/after siblings or a folder highlight for a drop inside. Dropping inside appends. Provide explicit empty-folder and collection-root targets. |
| Create in a folder | Folder menus include New request here and New folder here. Keep the existing toolbar actions. |
| Recover | Show a short resulting name/location message with Undo for the last rename or move. Keep existing deletion recovery available. |

Rename and Move never open a request, change the active tab, reorder tabs, or
interrupt an exchange. Explicit request opening and creating/duplicating a
request retain their current opening behavior. Successful organization reveals
the affected entry and restores focus by stable ID when focus still belongs to
that interaction. Full names and destination paths remain available when labels
are truncated.

While request search is active, allow Rename and Move to, but disable positional
reordering: hidden siblings make insertion positions unclear. Explain this beside
the unavailable controls. The destination picker searches all folders, including
folders hidden by the request filter. If an edited or moved request no longer
matches, keep the query, announce the result, and return focus to search. Empty
folders remain available as move destinations even though request search hides
them.

Keep the current native nested-list/button semantics. Scoped shortcuts operate
on the focused entry, including its menu trigger, and never intercept typing in
an input or CodeMirror. A complete ARIA tree navigation redesign is a separate
change.

## Shared operation and ownership

The existing pure collection operation now provides the shared contract without
another collection store or a general drag-and-drop framework:

```ts
/** Stable destination shared by folder moves and precise sibling ordering. */
interface CollectionPlacement {
  /** Containing folder identity; null selects the collection root. */
  readonly parentId: string | null;
  /** Insert before this direct child; null appends after all remaining children. */
  readonly beforeId: string | null;
}

moveCollectionNode(
  state: CollectionState,
  id: string,
  placement: CollectionPlacement,
): CollectionChange;
```

For example, moving `people` before `invite` inside `team` uses
`{ parentId: "team", beforeId: "invite" }`; moving it to the root's end uses
`{ parentId: null, beforeId: null }`. Move-down and pointer after-target placement
resolve the following sibling as the anchor, or null at the end. Anchors refer to
the destination's children after removing the source, avoiding index adjustments
in callers.

Validate the source, destination folder, direct-child anchor, and cycle rules
against current state before committing. A self-anchor is a no-op only in the
source's current parent; using it with a different parent is invalid. Unchanged
placement and renaming to the same trimmed name are also no-ops. Unknown or stale
identities produce a readable error without a partial change. Preserve IDs,
request objects, and complete subtrees; effective no-ops retain the existing state
references and create no save or Undo notification. Callers use the explicit
placement contract.

| Owner | Responsibility |
| --- | --- |
| [collections.ts](../src/collections.ts) | Pure validated name/placement changes and targeted recovery operations. No DOM, focus, tabs, or persistence. |
| CollectionManager | One pending edit/picker, management target, session folder-expansion set, and user feedback. Convert menu and keyboard intents into pure operations. |
| CollectionTree | Render controlled hierarchy and expansion, inline edit controls, row identities, and placement feedback. Forward user intent through recursive branches. |
| [useCollectionReordering.ts](../src/components/useCollectionReordering.ts) | Pointer capture, threshold, hit testing, hover expansion, scrolling, cancellation, and one final move callback. No copy of the collection or request data. |
| App | Canonical workspace, atomic application of collection replacements, transient Undo, execution/deletion cleanup, and existing autosave. |

CollectionManager owns expansion and passes the same controlled set through the
recursive tree. Search expansion is derived separately. This preserves
expanded descendants when a folder changes parents and avoids a second mutable
copy of the hierarchy. Committed moves reveal the destination; temporary hover
expansion during a cancelled drag does not overwrite remembered expansion.

The manager emits one `change(CollectionChange)` event. App applies both values
together. Its handler captures deletion recovery and cleans up removed requests
before replacing definitions, preserving the existing deletion contract.
Separate `update:requests`, `update:nodes`, `delete-entry`, and `delete-request`
notifications have been removed so cleanup has one owner and runs once.
`select-request` remains a separate explicit opening intent;
`CollectionChange.selectedId` identifies the management target only.

For rename/move Undo, a small typed recovery record accompanies the change:
previous name for rename; original parent and sibling identities for movement.
Apply Undo to current data, preserving later request edits and unrelated entries.
Invalidate the record if its target is deleted; replace it on the next effective
rename/move, and clear it on dismissal or reload. If a former sibling disappears,
use surviving original neighbors, then append. If the original parent disappears
or recovery would form a cycle, report that Undo is unavailable and preserve the
current placement. Never restore an entire workspace snapshot. Existing deletion
Undo keeps its current lifecycle and tab/execution recovery.

## Pointer behavior

The implementation uses the resource-lifetime patterns in
[useTabReordering.ts](../src/components/useTabReordering.ts), with a dedicated
collection adapter for nested placement. Begin dragging after a small movement
threshold, keep the active editor fixed, and suppress the release click after a
drag. Controls and rename inputs cannot start gestures. Touch retains scrolling
and uses the explicit movement controls.

Resolve before/inside/after from visible row geometry and indentation. Below an
expanded subtree, the insertion boundary belongs after that subtree; it must not
accidentally target its last descendant. Use current data and geometry after
scrolling or hover expansion. Delayed folder expansion and sidebar-edge scrolling
must stop when their target is left. Validate again at release and commit once.

Escape, release outside valid targets, pointer cancellation/capture loss, window
blur, hiding the sidebar, starting another action, source removal, and unmount
cancel without changing saved data. Every exit releases capture, clears feedback,
and stops timers/animation frames. Invalid and ineffective drops show no commit
marker. Restore focus by entry identity after reparenting when appropriate.

## Delivered implementation

1. **Placement and commits:** explicit `CollectionPlacement`, immutable validation,
   one manager change event, and a single App cleanup/application handler.
2. **Local editing:** inline Rename and F2, contextual creation, stable-ID focus,
   and one expansion owner above recursive tree instances.
3. **Accessible movement:** searchable Move to modal, sibling menu actions and
   Alt+Shift+Up/Down, filter-aware feedback, and targeted rename/move Undo.
4. **Direct movement:** mouse/pen handles, precise insertion/inside feedback,
   root/empty-folder targets, temporary hover expansion, edge scrolling, and
   cancellation cleanup through `useCollectionReordering`.
5. **Interface documentation:** [collection management](collection-management.md),
   [collection tree](collection-tree.md), [navigation](navigation.md),
   [feature interfaces](feature-interfaces.md), and [architecture](architecture.md)
   describe the final boundaries and operation examples.

Optional follow-ups are renaming from the request heading, choosing a folder while saving
a draft, and bulk selection/movement. Multiple named workspaces and portable
workspace transfer are outside the agreed scope.

## Acceptance and verification

- Reorder first/middle/last entries, mixed request/folder siblings, and nested
  subtrees; move between folders, into an empty folder, and back to the root.
  Reject self/descendant destinations and anchors outside the selected parent.
- Rename/move an inactive request while another request is being edited or sent.
  Preserve active tab, open-tab order, request body, cached editor state, divider
  preferences, and running exchange. Organization itself never sends a request.
- Address duplicate display names by ID; retain trimmed nonempty names and
  existing duplicate-name behavior. Cancellation and ineffective moves make no
  model changes or recovery notices.
- Preserve nested expansion across reparenting. Filtering, moving a result out
  of the filter, renaming a folder used in a path query, and clearing search retain
  the intended query/expansion state. If a folder rename hides its descendant
  results, announce the outcome and return focus to search.
- Undo after unrelated edits retains those edits; existing deletion Undo still
  restores definitions, tabs, and layouts under its documented rules.
- Reload restores the resulting names, hierarchy order, tab selection, and labels
  through the existing workspace repository; no schema change is required.
- Exercise mouse/pen cancellation, post-drag clicks, stationary-pointer scrolling,
  collapsed-folder hover, narrow drawer visibility, clipping, keyboard focus, and
  IME input in the real browser/Tauri interface.

[collections.test.ts](../tests/collections.test.ts) covers immutable placement and
targeted recovery. [CollectionManager.test.ts](../tests/CollectionManager.test.ts)
covers visible editing, destination search, focus, expansion, and keyboard flows.
[CollectionReordering.test.ts](../tests/CollectionReordering.test.ts) exercises
rendered pointer gestures, cancellation, capture cleanup, hover expansion,
scrolling, and click suppression. [App.collection-editing.test.ts](../tests/App.collection-editing.test.ts)
verifies editor/execution lifetime, targeted Undo, deletion recovery, repository
reload, narrow navigation, and composition handling. Assertions target public
behavior rather than internal refs or helper call sequences.

`pnpm test` passes: 7 Node tests and 729 Vitest tests across 47 files.
`pnpm build` also passes. No native Rust changes were needed.

Browser verification on an isolated local origin covered sibling insertion,
collapsed-folder and empty-folder drops, collection-root placement, complete
expanded-subtree boundaries, retained active request/body, outside-release
cancellation, a 390px navigation drawer, and actual edge scrolling at 390×420.
Inline F2 rename, Escape/Save focus recovery, and the searchable native Move
modal were also verified at 390×420, including viewport bounds, disabled current
destination, scrolling, full-path results, and focus after committing a move.
Physical pen/touch behavior and the packaged Tauri webview remain manual checks.
Mid-gesture Escape, hover dwell, and capture loss are covered by rendered DOM
tests; the browser automation surface does not expose those intermediate states
during its native drag action.
