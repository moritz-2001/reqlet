# Tab state and drag and drop

[Tabs.vue](../src/components/Tabs.vue) owns open descriptors, display order,
selection, and closing. App calls `open(item)` and observes `active-change(id)`
while rendering the active editor elsewhere. Pointer and keyboard reordering
commit through the same immutable internal operation. This implements the
revised strip-only ownership design; see [the Tabs guide](tabs.md) for the public
interface and a usage example.

## State and module boundaries

| Module | Responsibility |
| --- | --- |
| [tabs.ts](../src/components/tabs.ts) | `TabItem` descriptors and the `TabsHandle` command/status interface. It exposes no mutable list or order operation. |
| [Tabs.vue](../src/components/Tabs.vue) | The authoritative open list and active ID, open/close/select transitions, keyboard controls, focus, and announcements. |
| [tabOrder.ts](../src/components/tabOrder.ts) | Pure `moveTab(items, id, beforeId)` array transformation, shared by both reorder controls. |
| [useTabReordering.ts](../src/components/useTabReordering.ts) | A single strip's pointer capture, pending/dragging state, live geometry, insertion marker, click suppression, and animation resource. It commits through a callback into Tabs. |
| [App.vue](../src/App.vue) | Request data, collection selection forwarding, the external active panel, and its `KeepAlive` cache. |

The open list is replaced on opening, closing, metadata refresh, or reordering.
The active ID changes on opening, selection, or closing the active tab. Only
actual selection changes notify App. Closing uses current display order to choose
its right neighbor, then its left neighbor, then null. Descriptors are copied on
open so callers cannot mutate internal state through an argument.

App does not maintain another open list. Its observed active ID chooses the
request and collection highlight; read-only `count` drives the existing status
bar. Panel placement and lifetime are independent of strip membership. Cached
editors survive closing and reopening until App's cache is destroyed.
Editor update listeners capture the request ID when bound. A delayed event from
a deactivated editor therefore updates its own draft rather than whichever
request is currently active.

## Internal move semantics

`moveTab` removes an existing source, then inserts it before another existing ID
in the remaining sequence. A null destination appends. For `[a, b, c]`, moving
`a` before `c` produces `[b, a, c]`. A move retains the descriptor objects and
returns a new array only when order changes. Missing IDs, self destinations,
and ineffective moves return the original array. Unique IDs are enforced by
Tabs' deduplicating `open` operation.

This ID-based move contract stays internal. App handles neither insertion
indices nor reorder events. Reordering never changes selection or request data.

## Pointer flow

1. A primary mouse/pen pointer and primary button press on a tab arms a gesture
   and captures the pointer on that button. Close buttons cannot initiate it.
   Touch retains native horizontal scrolling.
2. Horizontal movement of at least six CSS pixels transitions to dragging.
   The source dims and the strip shows a grabbing cursor. Selection stays fixed,
   including when dragging an inactive tab.
3. Live entry rectangles, including close-button widths, determine insertion.
   Exclude the source and find the first remaining midpoint to the right of the
   pointer; that entry becomes `beforeId`. Otherwise append. A marker shows the
   boundary, clamped inside the visible strip, without changing layout widths.
   Ineffective and outside destinations have no marker.
4. On release inside the visible strip, recompute the destination and commit one
   effective move. Release outside cancels. A press below the movement threshold
   retains ordinary click activation when released inside.
5. Suppress the pointer click following a drag or cancellation, including an
   armed press released outside. Keyboard clicks remain usable. A new primary
   press clears suppression, so subsequent ordinary clicks behave normally.

The marker's coordinate is measured in scroll-content space. DOM entries are
queried when needed; there is no persistent registry or position cache. Pointer
capture retargets events, so hit testing uses coordinates rather than the event
target. Native label dragging and text selection are disabled for reorderable
tabs.

The [Pointer Events specification](https://www.w3.org/TR/pointerevents3/#pointer-capture)
defines capture. Its [click dispatch rules](https://www.w3.org/TR/pointerevents3/#the-click-auxclick-and-contextmenu-events)
explain why capture and pointer `preventDefault()` alone do not prevent the
activation following a drag.

## Overflow and resource lifetime

A stationary pointer inside a 32px strip-edge zone scrolls horizontally using
one `requestAnimationFrame` loop. Smaller strips use half their width per zone.
Speed increases toward the edge, up to 600 CSS pixels per second. Elapsed time
is capped at 64ms per frame to avoid jumps after delayed frames. Recompute the
marker after scrolling even when the pointer has not moved. Scrolling stops
outside the strip, outside an edge zone, or at the scroll boundary.

The nullable gesture record contains the accepted pointer ID, source ID and
capture owner, starting horizontal coordinate, latest viewport coordinates, and
pending/dragging phase. Null means idle. The marker is separate derived feedback;
a null marker means no effective visible destination. The frame handle and last
timestamp exist only while edge scrolling is scheduled.

Escape, pointer cancellation, unexpected capture loss, window blur, disabling
reordering, and unmount cancel. Open, close, navigation, and keyboard reorder
operations cancel any preceding pointer gesture directly. Other pointer IDs
cannot update or end the gesture. A normal drop clears gesture state before
committing the move, so cleanup cannot mistake the new order for a pending drag.

All end paths hide feedback, stop the animation frame, and release owned capture.
Cleanup tolerates capture already being lost. A cancelled gesture's pointer ID
remains solely for suppressing its eventual click, until that click or the next
primary press; it is not another active gesture.

## Keyboard and focus

Alt+Shift+Left and Alt+Shift+Right use the same move operation and stop at strip
boundaries. Unmodified navigation retains wrapping, Home/End behavior, and one
selected tab stop. Moves preserve focus by ID after Vue updates the keyed DOM,
provided focus has not moved to another control. Closing a focused tab similarly
focuses the selected replacement or empty strip. A polite live region announces
only effective moves.

## Verification and limits

[Tabs.test.ts](../tests/Tabs.test.ts) tests commands, notifications, counts,
stable IDs, focus, keyboard moves, pointer threshold and capture cancellation,
post-drag clicks, variable entry widths, and stationary-pointer scrolling through
rendered controls. jsdom fixtures supply measured rectangles and pointer capture;
controlled animation callbacks verify scrolling and cleanup without real time.
[tabOrder.test.ts](../tests/tabOrder.test.ts) tests the pure operation's input
immutability, identity preservation, invalid IDs, boundaries, and no-op results.
[App.test.ts](../tests/App.test.ts) verifies active content, drafts, collection
highlighting, external panel links, status count, editor reuse, and neighbor
selection after reordering.

`pnpm test` and `pnpm build` pass. Browser checks exercised actual pointer capture,
keyboard reordering, release outside, dropping over a close control, and retained
Wrap state after closing and reopening. Native Tauri verification and pen-device
verification remain manual checks. Touch dragging, cross-pane/window transfer,
collection drops, persistence, cache eviction, and unsaved-change prompts are
outside this implementation.
