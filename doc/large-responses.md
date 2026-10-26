# Large response viewer

The supported per-response transport limit is 64 MiB, including encoded receipt
and each native content-decoding stage. Both transports still return one complete
`HttpResponse.body`. Display avoids creating a complete formatted copy, syntax
tree, fold index, or CodeMirror document for large read-only bodies.

## Display and ownership

[BodyText.vue](../src/components/BodyText.vue) chooses the large-response path
when a read-only body exceeds `LARGE_BODY_THRESHOLD` (512 × 1024 UTF-16 code
units). This constant-time decision precedes `formatJson`. Small responses retain
the existing Pretty/Raw, highlighting, folding, and search-count behavior;
editable request bodies retain their existing editor.

[LargeBodyViewer.vue](../src/components/LargeBodyViewer.vue) borrows the original
immutable string through `modelValue`. It owns the current page, transient match
window, Find query, cancellation controller, and temporary download URLs.
`TextEditor` receives at most `LARGE_BODY_PAGE_SIZE` (64 × 1024 units) of plain
read-only text. Previous/Next page traverse fixed contiguous slices; concatenating
them reproduces the original body. Boundaries preserve CRLF and Unicode surrogate
pairs. A cross-page search result temporarily shifts the window so the full match
can be selected; page navigation returns to fixed slices.

Positions count UTF-16 source units and use half-open ranges. The editor normalizes
line endings to LF; match selection translates original positions within the
bounded page. Copy body uses the entire original source, including CRLF. Download
body exports the entire decoded source as UTF-8; it does not recreate compressed
wire bytes or the original charset encoding. Temporary Blob URLs are released
after the download starts or when the viewer unmounts.

## Search and editor boundary

[largeBody.ts](../src/components/largeBody.ts) provides pure page/range operations
and the cooperative JavaScript `findLargeBodyMatch` fallback. The viewer uses
[createLargeBodySearch](../src/components/largeBodySearch.ts) to retain the response
in a Wasm worker while Find is open; see
[large response search computation](wasm-response-search.md) for interfaces,
ownership, Unicode folding, and benchmarks. Search treats the query literally,
ignores case, and wraps once. It examines bounded chunks and yields between them,
so navigation and cancellation can run during a full scan.
Search terms are limited to 4,096 UTF-16 units to bound cross-chunk overlap.
There is no full-response match count. Find reports the selected source range or
that the complete scan found no match.

```ts
const controller = new AbortController();
const search = createLargeBodySearch(body);
const match = await search.find("request-id", 0, 1, controller.signal);
// Next begins at match.to; Previous begins at match.from.
controller.abort(); // Rejects pending work with AbortError.
search.dispose(); // Releases the worker and retained source when Find closes.
```

Query changes, response replacement, closing Find, deactivation, and unmounting
cancel pending work. A cancelled scan cannot replace the current result or
selection. The viewer retains its query through tab switches; reactivation
restarts search. Ctrl/Cmd+F, Enter/Shift+Enter, Next/Previous, F3/Shift+F3, and
Ctrl/Cmd+G share this search operation.

[TextEditorHandle](../src/components/textEditor.ts) is the selection boundary:
`revealRange(from, to)` clamps page-local displayed-text positions, selects the
range, and scrolls it into view without editing or taking focus. The viewer
implements BodyText's existing Find command; large-mode JSON commands are not
offered.

## Storage and resource limits

The UI never silently truncates the received body. The transport rejects a body
above 64 MiB with `response-limit`; it does not report a partial response as
complete. Full transport buffering, native IPC, and charset conversion still
consume memory proportional to the response size. This is a bounded in-memory
viewer, not a disk-backed streaming client or a guarantee about unlimited
concurrent responses.

Find adds one worker-owned UTF-16 source copy only after its first valid query.
Subsequent queries reuse it. Closing Find, hiding its cached editor, replacing
the response, or unmounting releases that memory; merely changing pages or
cancelling a query preserves it for the open session.

History persistence retains its separate 8 MiB/100-capture budget. An oversized
response remains inspectable in the current session and displays the existing
storage omission warning; it will not be restored after reload. The repository
caches detached, bounded retained captures and exact serialized sizes, checking
for changes before reuse, so later ordinary edits do not repeatedly serialize
unchanged retained response bodies.
Durable capture IDs identify immutable records: missing keys and local mutations
are detected, while an external replacement under the same existing ID is
rechecked on reload.

## Verification

[LargeBodyViewer.test.ts](../tests/LargeBodyViewer.test.ts) exercises exact page
reconstruction, Unicode/CRLF boundaries, full-response literal search and
cancellation, cross-page selection, original Copy/Download, wrapping, and
transition back to small-response presentation. [TextEditor.test.ts](../tests/TextEditor.test.ts)
verifies selection/focus behavior. Browser/native transport tests cover the exact
64 MiB boundary, oversize rejection, and cancellation. Real browser results and
the reproduction harness are recorded in [UI performance](ui-performance.md).
