# Search and quick navigation

## Using search

The collection sidebar's **Search requests** field filters by request name,
HTTP method, saved URL, and ancestor folder path. Matching ignores case and
requires every whitespace-separated word to match somewhere across those fields.
For example, `team post users` finds POST requests under a Team folder whose
name or URL includes `users`. Enter opens the first match; Escape or Clear resets
the filter. Matching branches open temporarily, preserving normal folder expansion.

**Quick open**, or **⌘/Ctrl+K** from any workspace view, opens a modal request
picker. It shows each match's current name, method, URL, and folder path in
collection order. Use Up/Down to choose, Enter to open, or click a result.
At most 50 results are rendered at once. Previous/Next requests changes pages;
arrow navigation crosses page boundaries and wraps through the complete result
list. Result counts and accessible option positions describe the complete list.
Escape, the close button, or the backdrop dismisses the picker and restores focus
to its opener. Opening a result focuses the workspace and reuses its existing
tab and draft; it does not send the request. The native dialog keeps keyboard
focus inside the picker while open. Query and selection are transient and reset
each time the picker opens.

For a response body, choose **Find**, or focus its text and press **⌘/Ctrl+F**.
Matches are literal and case-insensitive, with highlights and a result count.
Next/Previous or Enter/Shift+Enter navigate with wrapping and reveal matching
text inside folded JSON. Escape closes Find. The same commands work in editable
request bodies. Find searches the displayed raw/pretty text without changing
the original body; Copy body continues copying the original source. See
[body text](body-text.md) for editor lifetime and presentation details.

## Shared interface and ownership

[`navigationSearch.ts`](../src/navigationSearch.ts) shares pure matching between
the collection sidebar and other saved-request navigation.
`searchCollectionRequests(nodes, requests, query)` returns matching saved IDs in
collection order. Every whitespace-separated query word must match the current
request name, method, saved URL or ancestor folder path, ignoring case. Words may
match different fields; `team post users` can find a POST request whose URL
contains `users` inside a Team folder.

Call `indexCollectionRequests(nodes, requests)` to obtain canonical `id`, `name`,
`method`, `url` and `folderPath` metadata in collection order, then
`filterCollectionRequests(entries, query)` when displaying richer results.
`folderPath` joins ancestor names with ` / ` and is empty for root requests.
The index also includes immutable `ancestorFolderIds` and normalized `searchText`.
Keep a computed index while metadata is unchanged and filter it for successive
queries; rebuilding is needed when definitions, folder paths, or ordering change.
The sidebar uses ancestor identities to reveal matching branches in one pass.
URLs retain environment placeholders; navigation does not prepare or execute
requests. Missing definitions are omitted because they cannot be opened.

```ts
const entries = indexCollectionRequests(nodes, requests);
const matches = filterCollectionRequests(entries, "team post users");
const firstRequestId = matches[0]?.id;
```

The sidebar expands matching ancestors temporarily without changing remembered
folder expansion. This remains true after selecting a match: clearing the query
restores the previous browsing expansion. Enter opens the first match; Escape
clears the query and retains input focus. Matching and metadata are covered by
[navigationSearch.test.ts](../tests/navigationSearch.test.ts); visible expansion
and keyboard behavior are covered by
[CollectionManager.test.ts](../tests/CollectionManager.test.ts).

[QuickOpen.vue](../src/components/QuickOpen.vue) receives `nodes` and `requests`,
owns its query, active result, and modal focus lifetime, and emits
`select-request(id)` or `close()`. [App.vue](../src/App.vue) owns the global
shortcut, mounts the picker, and routes selections through `openRequest` so the
collection tree and picker share tab identity. These presentation states are
independent of persisted workspace data and request execution.

[bodySearch.ts](../src/components/bodySearch.ts) configures CodeMirror's search
state and panel, including literal matching, highlights, navigation, and fold
reveal. `TextEditorHandle.findText()` opens and focuses that panel without
exposing the editor's state. CodeMirror retains the query and open panel across
raw/pretty or incoming-body replacement; a read-only search emits no content
change. Each editor instance owns its own query.

## Verification

[QuickOpen.test.ts](../tests/QuickOpen.test.ts) covers matching, empty states,
keyboard/pointer selection, composition input, and opener focus restoration.
[App.navigation.test.ts](../tests/App.navigation.test.ts) verifies global
shortcuts, opening from history, tab reuse, preserved drafts, and cleanup.
[BodyText.test.ts](../tests/BodyText.test.ts) covers literal matching, wrapped
navigation, fold reveal, raw/pretty transitions, and read-only behavior.
