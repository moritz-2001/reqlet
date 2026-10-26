# Tabs

[Tabs.vue](../src/components/Tabs.vue) owns the open tabs, their order, active
selection, closing, and reordering. It renders the strip and an open-tabs picker. Its caller opens
items through a component reference and renders content elsewhere in response to
active-ID notifications. Request data and editor lifetime stay outside Tabs.

## Interface and ownership

| Interface | Contract |
| --- | --- |
| `label: string` | Accessible name of the tab group. |
| `panelId: string` | Document-unique ID of the caller's shared active panel, targeted by every tab's `aria-controls`. |
| `reorderable?: boolean` | Enables mouse/pen dragging and keyboard reordering. Defaults to false. |
| `initialItems?: readonly TabItem[]`, `initialActiveId?: string \| null` | Restored descriptors and selection, read once on mount. Unknown selection uses the first restored tab. |
| `presentation?: Readonly<Record<string, TabPresentation>>` | Caller-owned execution and unsaved feedback keyed by tab ID. Updates affect presentation only and never appear in state-change snapshots. |
| `state-change(state: TabsState)` | Complete copied order and selection after a user operation or exposed command; the parent may persist it. |
| `close(id: string)`, `updateLabel(id: string, label: string)` | Apply external deletion or renaming without reopening a request. |
| `open(item: TabItem)` | Appends and activates a new ID. An existing ID keeps its position, receives the supplied descriptor, and becomes active. |
| `restore(snapshot: TabsState, ids: readonly string[], activeId?: string)` | Reopens only missing requested IDs from an earlier snapshot, anchored to surviving siblings. Current descriptors, order, and selection are preserved; an explicit active ID can restore selection. |
| `readonly count: number` | Reactive number of open tabs, exposed for external status displays. |
| `active-change(id: string \| null)` | Reports a completed active-ID change. `null` means the last tab closed. Reordering and closing inactive tabs do not emit it. |

[TabItem and TabsHandle](../src/components/tabs.ts) define the public contract.
An item has a stable application `id`, visible `label`, and optional `closable`
flag. Omitted or false means it cannot close. Opening copies the descriptor;
changing the supplied object later does not change the strip. Opening an existing
ID refreshes its label and close capability without duplicating or moving it.

`restore` supports collection deletion Undo without replaying a stale complete
tab list. Its snapshot supplies original descriptors and sibling order, while
`ids` identifies the tabs removed by that deletion. Other tabs closed since the
snapshot stay closed. Current descriptors win for IDs that are already open.
An empty strip selects the first recovered tab; otherwise selection stays as it
is unless the caller supplies an explicit `activeId`. The caller decides when
restoring selection is appropriate. App supplies the former active request only
while no subsequent selection has occurred. For example:

```ts
// beforeDeletion is the last state-change snapshot, retained by the owner.
tabs.value?.restore(beforeDeletion, ["deleted-request-id"]);
```

Restoration copies descriptors, emits one complete `state-change`, and reports
`active-change` only if selection changes. Repeating restoration for already
open IDs has no effect. Snapshots are transient recovery data and need no new
persisted schema.

A new Tabs instance is empty unless restored descriptors are supplied. The caller
initializes its observed active ID to the restored selection or `null`; there is
no initial notification. Active selection is authoritative
inside Tabs, so the caller does not maintain an open list or apply selection
requests. Closing the active tab selects its right neighbor, then its left
neighbor, then no selection. Neighbor choice follows the current display order.
Tabs assigns stable button DOM IDs within Vue's application ID namespace.

## Execution and draft feedback

`TabPresentation` keeps changing execution feedback separate from the persisted
`TabItem` descriptor. `execution` is optional: omit it before the first send, or
supply `{status: "running"}`, `{status: "success", httpStatus: 200}`,
`{status: "error"}`, or `{status: "cancelled"}`. The success variant means a
completed HTTP exchange, including HTTP 4xx and 5xx responses. The strip shows a
spinner and **Sending…**, the HTTP code, **Failed**, or **Cancelled**, respectively.
Status is expressed in text and the tab's accessible name; color is additional
feedback. The spinner respects reduced-motion preferences.

Set `unsaved: true` for a draft awaiting explicit saving to Collections. Drafts
already autosave locally; this marker describes collection membership. The dot
has an **Unsaved draft** tooltip and the tab's accessible name includes that state.
Omitting either the property or the tab's presentation clears its feedback.
Feedback follows the stable ID when tabs move and does not open, select, close,
or rename tabs. Callers own announcements for executions completing in the
background, including executions whose tabs have already closed.

```vue
<Tabs
  label="Open requests"
  panel-id="request-panel"
  :presentation="{
    savedRequestId: { execution: { status: 'success', httpStatus: 200 } },
    draftId: { unsaved: true, execution: { status: 'running' } },
  }"
/>
```

## Example

```vue
<script setup lang="ts">
import { ref, useId, useTemplateRef } from "vue";
import Tabs from "../src/components/Tabs.vue";
import type { TabsHandle } from "../src/components/tabs";

const tabs = useTemplateRef<TabsHandle>("tabs");
const activeId = ref<string | null>(null);
const panelId = `${useId()}-panel`;
</script>

<template>
  <button @click="tabs?.open({ id: 'first', label: 'First request', closable: true })">
    Open first request
  </button>
  <Tabs
    ref="tabs"
    label="Open requests"
    :panel-id="panelId"
    reorderable
    @active-change="activeId = $event"
  />

  <!-- Content can live elsewhere in the caller's layout. -->
  <section
    :id="panelId"
    role="tabpanel"
    aria-label="Request content"
    :hidden="activeId === null"
    tabindex="0"
  >
    <p v-if="activeId !== null">Content for {{ activeId }}</p>
  </section>
  <span>{{ tabs?.count ?? 0 }} open</span>
</template>
```

Imports assume an example beside this guide. The caller supplies the panel's
accessible name, role, visibility, and unique ID. Tabs has no panel elements or
slots. See [App.vue](../src/App.vue) for the production integration.

## External editor lifetime

App observes the active request ID and renders one RequestEditor in a shared
external panel. A `KeepAlive` cache keyed by request ID preserves each editor's
BodyText wrapping, previews, pane sizes, and other presentation state while
switching. Inactive editors are deactivated and detached from the visible DOM.
Reordering leaves the active ID and editor instance unchanged.

Closing a tab does not evict its cached editor: reopening restores presentation
state as well as its draft. App bounds this cache to 30 editors. Request text and
content type live separately in the persisted workspace. Reloading restores
drafts, tab order/selection, and pane preferences; CodeMirror undo/fold/selection
state remains transient.

The application also opens transient history snapshots and editable request
drafts in the same strip. Saved requests and drafts both enter persisted tab
order and selection. History opens read-only; its **Open as draft** and **Send
again** actions create independent definitions in `workspace.drafts`. Drafts
autosave locally, including their captured inputs and divider preferences, before
they are added to Collections.

Closing a draft keeps its definition and records its ID in `closedDraftIds`.
**Reopen closed draft** restores the most recently closed draft, including after
reload, without sending it or adding it to Collections. **Save to Collections**
promotes the draft under the same identity and removes its draft/recovery
entries, preserving the cached editor, current result, and any running exchange.
Closing a running request or draft leaves its exchange alive; a completion notice
can open the captured result after its tab closes. Live execution state and
completion notices reset on reload. See [history](history.md) for captured-input
execution semantics and recovery behavior.

Another caller can choose a different mounting or caching policy. Tabs knows
nothing about content lifetime. Its state-change snapshot reports open identities
without imposing a content caching policy. Adding eviction
on close would require a separate notification and a caller-owned cache policy.

## Keyboard and focus

- Tab enters at the selected tab, or at the empty strip when there are no tabs.
- A compact **Open tabs (N)** button stays outside the horizontally scrolling
  strip. It lists every open descriptor in display order, including application
  request, draft, and history entries, without keeping a second open-tab list.
  It is disabled when empty. Each strip label is capped at 20 characters of
  visual width with an ellipsis; its tooltip, accessible name, and picker entry
  retain the complete label. Execution badges, draft markers, and close buttons
  stay visible beside the shortened label.
- Left and Right select and focus a tab, wrapping at either end.
- Home and End select and focus the first and last tabs.
- Enter and Space activate the focused native button.
- Delete closes a focused closable tab. Close buttons have accessible names and
  stay outside the Tab sequence; Delete supplies their keyboard equivalent.
- Alt+Shift+Left and Alt+Shift+Right reorder the focused tab by one position when
  enabled. They stop at the ends and preserve selection and button identity.
- Closing a focused tab moves focus to the selected replacement, or to the empty
  strip. Opening from the collection and closing an unfocused tab preserve
  outside focus. Deferred focus restoration never replaces focus on another
  external control.

Opening the picker by clicking focuses its checked, currently selected item.
Down and Up on its trigger open at the first and last items. Within the menu,
Up/Down wrap through entries and Home/End reach either end; navigation does not
change selection. Enter or Space activates the focused native button, selecting
and revealing that tab and returning focus to it. Escape dismisses to the stable
trigger. Tab dismisses before normal focus traversal, while an outside pointer
or focus change dismisses without stealing focus. The menu shows the same live
execution and unsaved feedback as the strip, using each descriptor's stable ID.
Opening or dismissing the picker does not emit tab-state notifications.

Above 80 open tabs, the strip renders a window of 220-pixel entries with three
neighbors on either side. This predictable width lets scrolling and drag targets
address every logical tab without measuring or mounting all of them. Small strips
keep their existing variable-width entries. The selected tab and an active drag
source stay mounted outside the window when needed; selection, closing, keyboard
navigation, restoration, and state-change snapshots still use the complete list.
`aria-posinset` and `aria-setsize` report each visible tab's logical position.

The picker uses [VirtualRows.vue](../src/components/VirtualRows.vue) above the same
threshold, measuring natural heights so long names remain readable. Its Up/Down,
Home/End, current-selection reveal, and focus recovery navigate the complete
descriptor list before mounting and focusing their target. The logical index and
total are also exposed on menu items. Scroll rendering creates no second list of
open descriptors and emits no state changes.

Opening, navigation, and focused reordering scroll the button into view. Accessible
instructions describe the reorder shortcuts, and a polite live region announces
completed moves. See [the drag and drop design](tab-drag-and-drop.md) for pointer
thresholds, insertion feedback, edge scrolling, click suppression, and cleanup.

## Verification

`pnpm test` exercises execution feedback, draft markers, opening, deduplication,
notifications, closing, focus, picker navigation and dismissal, keyboard and pointer ordering, cancellation, and
edge scrolling through rendered controls and the public interface.
[Tabs tests](../tests/Tabs.test.ts) cover the strip,
[order tests](../tests/tabOrder.test.ts) cover immutable transformations,
[App tests](../tests/App.test.ts) cover external content and caching, and
[recovery tests](../tests/App.recovery.test.ts) cover draft restoration and
closed-tab completion feedback.
`pnpm build` checks Vue/TypeScript and builds the frontend.

Browser verification covers actual capture and click delivery, dragging inactive
tabs, dropping over close controls, release outside, keyboard moves, and cached
state after closing and reopening. Edge scrolling uses controlled geometry and
animation clocks in jsdom tests. Native Tauri webview verification remains a
manual check. Touch keeps native horizontal scrolling and does not reorder tabs.
App persists saved-request and draft IDs and selection through state-change
snapshots; labels are rebuilt from their definitions when restoring the strip.
There is no cross-window transfer or unsaved-change prompt. Saved definitions
and drafts autosave independently of closing tabs. Only **Save to Collections**
promotes a draft to a collection definition. See
[workspace storage](workspace-storage.md).
