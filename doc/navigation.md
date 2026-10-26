# Finding requests and executions

[CollectionManager.vue](../src/components/CollectionManager.vue) provides saved
request search. [HistoryPanel.vue](../src/components/HistoryPanel.vue) provides
captured execution search and result filtering. Both keep query/filter state
local and send selection intents to the application; neither changes saved
requests, execution snapshots, or the current workspace selection while typing.

## Switching sidebar views

Collections and History remain mounted while the sidebar switches which view is
visible. Each view has its own scrollport. Returning to Collections restores its
search, expanded folders, and scroll position; returning to History restores its
search, result filter, and scroll position. Inspecting an execution therefore
preserves the collection browsing context. These are transient presentation
preferences and reset when the application reloads.

Collection expansion before a search is retained separately from the branches
temporarily revealed by matching results. Clearing search after a sidebar switch
still returns to the expansion chosen before searching. The hidden view is
excluded from display and keyboard focus while its state is retained.

At window widths of 600px or less, **Navigation** opens these same mounted views
in a left drawer instead of reserving vertical editor space. Close, Escape, or
the backdrop dismisses it and restores focus to Navigation. Selecting a request,
history entry, or recovered draft closes it and focuses the workspace. The
workspace is inert while the drawer is open. The drawer's visibility is transient;
resizing back to desktop restores the normal sidebar and its saved split size.

## Request search and keyboard quick-open

Search requests by name, URL, method, or containing folder path. Matching ignores
case and requires every whitespace-separated word to appear somewhere across
those fields. For example, `team PUT` finds PUT requests inside a Team folder;
`people GET` finds GET requests whose name or URL contains people. Canonical
request metadata takes precedence over the tree's fallback labels.

**Cmd/Ctrl+K**, or the header's **Quick open** button, opens
[QuickOpen.vue](../src/components/QuickOpen.vue) from any workspace view. Its
modal search uses the same saved metadata and collection order. Arrow keys choose
a result, Enter opens it without sending, and Escape dismisses the dialog. The
sidebar view remains unchanged; dismissing restores focus to the opener, while
opening a request focuses the workspace panel.

Within collection search, **Enter** opens the first matching request without
sending it. **Escape** or **Clear** clears the query and leaves focus in search. A count
or no-match message describes the result. Search reveals matching descendants
even inside collapsed folders. Clearing it restores the prior expansion.

The manager also exposes `focusSearch(): void` for hosts that focus sidebar search.
Call it after the manager is mounted and its sidebar is visible:

```vue
<script setup lang="ts">
import { nextTick, ref, useTemplateRef } from "vue";
import CollectionManager from "./components/CollectionManager.vue";

const sidebar = ref("collections");
const collections = useTemplateRef<InstanceType<typeof CollectionManager>>("collections");

async function focusCollectionSearch() {
  sidebar.value = "collections";
  await nextTick();
  collections.value?.focusSearch();
}
</script>

<template>
  <CollectionManager
    v-show="sidebar === 'collections'"
    ref="collections"
    :requests="requests"
    :nodes="nodes"
    @change="applyCollectionChange"
    @select-request="openRequest"
  />
</template>
```

The application owns the global key event and prevents the browser's default
Cmd/Ctrl+K action when opening the modal. `focusSearch()` selects an existing query so the next typed
text replaces it; it does not clear search or select a request by itself.

## Organizing the focused collection entry

**F2** starts inline Rename for the focused row or its action trigger.
**Enter** / **Save** commits; **Escape** / **Cancel** discards. Leaving the form
cancels without reclaiming focus. **Alt+Shift+Up** / **Down** moves one sibling
position, matching the menu's **Move up** / **Move down** actions. These commands
are scoped to entry controls and ignore typing/editable content and composition.
Opening an Actions menu or organizing an inactive entry keeps the active request
and its running exchange unchanged.

During request filtering, Rename and **Move to** remain available. Positional
movement and drag handles are unavailable, with an explanation for hidden sibling
positions. The native Move to modal searches full paths across every folder,
including empty folders and folders hidden by request search. It shows the
current location and **Collection root**, disables the current parent, and
excludes cyclic destinations.

Successful organization reveals the affected entry and restores focus by stable
ID when focus still belongs to the action. If a rename or move hides the entry
from the current filter, the query remains, the result is announced, and focus
returns to search. The manager owns remembered expansion above recursive trees,
so moving an expanded subtree retains its nested expansion. Search and pointer
hover derive temporary expansion separately.

Mouse and pen drag handles provide before/after lines and inside-folder feedback;
touch retains scrolling and uses menu movement controls. Hiding the collection
view or closing the narrow drawer cancels gestures and temporary hover expansion.
The existing native list/button semantics remain; this change adds no ARIA tree
navigation model. See [collection management](collection-management.md) and
[collection tree](collection-tree.md) for ownership and Undo contracts.

## Execution search and result filters

History matches captured request names, resolved URLs, and methods with the same
word semantics. It preserves the supplied order and combines the query with one
result category:

- **All results** includes every retained exchange.
- **HTTP 1xx–3xx** includes received responses below status 400.
- **HTTP errors (4xx–5xx)** includes received error responses. These remain
  completed transport results in the shared execution model.
- **Transport errors** includes exchanges that failed without an HTTP response.
- **Cancelled** includes explicitly cancelled exchanges.

**Enter** in execution search inspects the first visible match in the main
workspace. **Escape** or **Clear filters** resets both filters and focuses
search. Enter and Escape remain with the input method while text composition
is active, matching collection search. Filtered counts/no-match messages update
without clearing history.
An open history tab remains selected even when its row is temporarily hidden by
filters. Execution actions live in the workspace inspector rather than in
sidebar rows.

The panel accepts `entries` and optional `selectedEntryId`. It emits
`inspect(entry)` to open the captured exchange and `clear()` to remove retained
history. Filtering and reset never emit either intent on their own.

[navigationSearch.ts](../src/navigationSearch.ts) contains the pure matching and
classification functions. It searches navigation metadata, not request bodies
or header values. [CollectionManager.test.ts](../tests/CollectionManager.test.ts)
and [HistoryPanel.test.ts](../tests/HistoryPanel.test.ts) verify the visible
search behavior, keyboard commands, selected rows, and completion categories.
[App.navigation.test.ts](../tests/App.navigation.test.ts) verifies that switching
views preserves their filters, folder expansion, selection, and separate scroll
nodes. Browser checks cover scroll geometry; jsdom verifies retained node
identity and assigned scroll positions.
