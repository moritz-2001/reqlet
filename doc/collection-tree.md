# Collection tree

[CollectionTree.vue](../src/components/CollectionTree.vue) renders saved requests
and folders without owning collection data.
[CollectionManager.vue](../src/components/CollectionManager.vue) owns management
state and session expansion. Both rendering paths share the controlled buttons,
inline editor, and drag handles in
[CollectionTreeEntry.vue](../src/components/CollectionTreeEntry.vue).

[collectionRows.ts](../src/components/collectionRows.ts) projects expanded and
matching entries in depth-first order, retaining their node references, indentation,
sibling positions, and final visible subtree boundaries. Up to 200 projected rows
use native nested lists through
[CollectionTreeBranch.vue](../src/components/CollectionTreeBranch.vue). Larger
collections mount the sidebar viewport plus six rows of overscan on each side.
The full-height list preserves scrolling; rows retain their hierarchy through
`aria-level`, `aria-posinset`, and `aria-setsize`. Small and large collections keep
the same native button controls and management shortcuts.

A focused row, open inline editor, menu trigger, or pointer-capture source stays
mounted when it scrolls outside the window. Inline rename height is measured so
its controls and validation cannot overlap neighboring rows. Tab and Shift+Tab
address the next logical entry, mounting and revealing it before moving focus,
so keyboard traversal does not skip unmounted requests. `revealEntry(id)` performs
the same stable-ID mounting before the manager focuses a renamed or moved entry.
Sidebar activation and resizing remeasure the retained external scrollport. A
standalone large tree uses its own bounded scrollport when no scrolling ancestor
exists.
Collapsed and nonmatching descendants do not enter either rendering path.

## Interface and identity

`nodes: readonly CollectionNode[]` supplies ordered entries at one level.
[CollectionNode](../src/components/collectionTree.ts) distinguishes folders with
children from request references. IDs are unique across the collection and remain
stable through renaming and movement. The optional `requests` registry supplies
canonical names and methods; node metadata is a standalone rendering fallback.

`selectedRequestId` marks the active editor through `aria-current`.
`selectedFolderId` marks a management folder without changing that editor.
`select-request(id)` opens a request only when explicitly handled by its owner.
Folder buttons emit `toggle-folder(id)` for the manager to update expansion and
management selection. The rows expose full-name tooltips and stable
`data-collection-id` / `data-collection-row` identities for focus and geometry.

```vue
<CollectionTree
  :nodes="nodes"
  :requests="requests"
  :expanded-folder-ids="expandedFolderIds"
  :selected-request-id="activeRequestId"
  @toggle-folder="toggleFolder"
  @select-request="openRequest"
/>
```

`expandedFolderIds: ReadonlySet<string>` is required and shared through every
recursive branch. The manager replaces its Set when toggling or revealing
ancestors. Expansion follows folder identity across reparenting, so an expanded
nested folder stays expanded after its containing subtree moves. It is transient
presentation state, independent of saved nodes and persistence.

`matchingRequestIds` optionally limits rows to matching requests and their
ancestors. Omission restores normal visibility; an empty Set intentionally hides
all rows. Matching folders appear expanded independently of remembered expansion,
and folder toggles during search do not overwrite that memory. The optional
`searchCollapsedFolderIds` set overrides automatic expansion for folders manually
closed during the current query; omission retains automatic expansion for
standalone callers. The manager replaces this set on a toggle and clears it
whenever the query changes or is cleared. Nested search folds remain in effect
when their parent is closed and reopened for the same query. Empty expanded
folders show **No requests yet** and expose an explicit inside-drop identity.
`matchingFolderIds` optionally supplies the matching ancestors computed from the
shared search index. The manager supplies it to avoid rescanning descendants for
each folder; standalone callers may omit it and retain descendant-based matching.

## Editing and forwarded intent

One manager-owned menu receives `open-actions(id, trigger)` from any depth.
`actionMenuTargetId` controls the matching trigger's `aria-expanded` state.
`entry-keydown(id, event)` forwards scoped F2 and Alt+Shift+Up/Down handling from
the row and menu trigger; typing controls remain outside those commands.

`renamingId`, `renameValue`, and `renameError` control one inline form. The tree
emits `update:renameValue`, `commit-rename`, and `cancel-rename(restoreFocus)`.
Enter/Save commits, Escape/Cancel requests focus restoration, and leaving the
form cancels without moving focus back. Composition blocks submission and
shortcuts. Validation stays beside the input and does not mutate canonical data.

`reorderEnabled` exposes drag handles when positional movement is available.
`start-drag(event, id)` begins only from a handle; ordinary row selection and
editing controls do not start a gesture. `draggedId` and `dropTarget` are derived
feedback, not another copy of the hierarchy. Before/after lines belong to a
list entry's entire subtree; inside-folder feedback belongs to its row.

## Pointer lifetime

[useCollectionReordering.ts](../src/components/useCollectionReordering.ts) adapts
the current hierarchy and DOM geometry to `CollectionPlacement`. Its dependencies
are the root element, current nodes, availability, remembered expansion, and one
final `commit(id, placement)` callback. It owns pointer capture, threshold,
hover timers, scrolling frames, cancellation, and release-click suppression.

Mouse and pen movement crosses a small threshold before becoming a drag. Touch
keeps scrolling and uses the explicit menu controls. Visible row geometry and
indentation resolve before/inside/after; after an expanded folder means after
its complete subtree. Root and empty-folder targets append. Placement is
validated against current nodes while showing feedback and again on release;
invalid or ineffective placements have no marker or commit.

Pointer movement schedules at most one feedback update per animation frame. A
hierarchy index resolves identities, parents, and final visible descendants even
when an ancestor is outside the window. Measured row geometry is
reused until scrolling, expansion, resizing, or a hierarchy replacement invalidates
it. A child-list observer also invalidates geometry when the mounted window
changes without changing total list height. Repeated movement within the same
target reuses placement validation. Release
always remeasures and validates current data, including when a frame is pending.

Hover expands a collapsed folder temporarily. The manager combines these IDs
with remembered expansion for rendering, while cancellation clears temporary
IDs without changing expansion memory. Edge scrolling remeasures under a
stationary pointer. Leaving the hover/scroll target stops its pending resources.

Escape, invalid release, pointer cancellation/capture loss, blur, sidebar hiding,
source removal, starting another management action, and unmount cancel the
gesture. Every exit clears feedback, releases capture, and stops timers/frames.
Saved data changes only through the single final operation; the active editor
stays fixed. Successful organization reveals and restores focus by stable ID
when focus still belongs to that interaction.

## Verification

[collections.test.ts](../tests/collections.test.ts) verifies immutable placement
and recovery contracts. Component tests exercise canonical labels, inline input,
forwarded intents, controlled expansion, search, and management focus.
[CollectionVirtualization.test.ts](../tests/CollectionVirtualization.test.ts) covers
3,000 expanded/matching requests, scrolling, sibling context, keyboard traversal,
rename lifetime, pointer-source retention, stationary-pointer scrolling, offscreen
ancestor drop boundaries, and hidden-sidebar activation. Browser
checks must cover capture, expanded-subtree boundaries, hover expansion,
stationary-pointer scrolling, and narrow drawers. Native list/button semantics
remain in use; an ARIA tree keyboard-navigation redesign is outside this change.
See [collection management](collection-management.md) and
[navigation](navigation.md) for owner integration and shortcuts.
