# Resizable split panes

[SplitPane.vue](../src/components/SplitPane.vue) lays out two named slots with a
draggable, keyboard-accessible separator. It owns presentation state only and
does not read or update the data rendered inside either slot.

```vue
<SplitPane
  label="Resize request and response panes"
  initial-size="50%"
  :min-first="240"
  :min-second="240"
  :min-extent="560"
  :stack-at="800"
>
  <template #first><RequestBody /></template>
  <template #second><ResponseBody /></template>
</SplitPane>
```

Place the split in a parent with a bounded width and height. Its region wrappers
are flex columns; slotted content can use `flex: 1` and `min-height: 0` to fill
them. The component occupies the available space and scrolls if its minimum
extents exceed that space.

| Prop | Meaning |
| --- | --- |
| `label` | Required accessible name for the separator. |
| `initialSize` | Initial first-pane extent, as pixels (`:initial-size="248"`) or a percentage (`initial-size="50%"`, the default). Pixel preferences stay fixed as the container changes; percentages scale. This initializes local state rather than controlling it. |
| `sizes?: SplitSizes`, `update:sizes` | Optional controlled orientation preferences. The parent can persist emitted user changes; omitted sizes retain internal ownership. Measurement never emits or replaces preferences. |
| `compact?: "first" \| "second"` | Temporarily stacks the regions, giving the named pane its content height and the other all remaining height. Hides/disables the divider without changing either orientation's saved preference. Omission restores the normal responsive split. |
| `minFirst`, `minSecond` | Minimum pane extents in pixels along the active axis; each defaults to 240. |
| `maxFirst` | Optional pixel limit for the first pane, further constrained by the second pane's minimum. Omission means no extra limit. |
| `minExtent` | Optional minimum combined extent excluding the 8px divider. Defaults to zero, with both pane minima always enforced. A larger value leaves room to drag even when the container is too small and scrolls. |
| `stackAt` | Required container-width breakpoint. At or below this width, panes stack and the divider adjusts height; above it, it adjusts width. |

Dragging supports mouse, pen, and touch through pointer capture. Only the primary
pointer and primary button start a gesture. Movement updates a component-local
preview, including its accessible value, without emitting persisted preferences.
Release commits one `update:sizes` event. Cancellation, capture loss, a changed
orientation, compact presentation, or externally replaced preferences discards
the preview. Pointer moves from other pointers are ignored. Keyboard and reset
operations continue to emit immediately.

The divider highlights on hover, focus, and drag. Focus it with Tab, then use
Left/Right for columns or Up/Down for stacked rows. Arrows move 16px; Shift+Arrow
moves 48px. Home and End select the permitted extremes. Double-click restores
the current direction's initial split. The separator exposes its orientation,
percentage range, current percentage, controlled region, and pixel value to
assistive technology.

Horizontal and vertical preferences are independent. Layout clamping does not
overwrite them, and deactivated editors retain their previous measurements until
they become visible again. App caches editors across switching and closing, so
reopening a request restores its pane preferences too. App persists sidebar and
per-request preferences through `sizes` and `update:sizes`, restoring them across
reloads. Standalone consumers may omit `sizes` for component-local state. The
public [SplitSizes](../src/components/splitPane.ts) interface stores a horizontal
and vertical first-pane extent as pixels or percentages.

[RequestEditor](../src/components/RequestEditor.vue) compacts an empty GET/HEAD Body
panel into a settings strip, or an idle response into a status row. This is
derived presentation only: changing settings, adding a body, and sending restore
the remembered split when both panes need space. Both slots stay mounted.

```vue
<SplitPane
  label="Resize request and response panes"
  v-model:sizes="preferences"
  :compact="emptyRequestBody ? 'first' : idleResponse ? 'second' : undefined"
  :stack-at="800"
>
  <template #first><RequestSettings /></template>
  <template #second><ResponseInspector /></template>
</SplitPane>
```

The request editor defaults to 50% in either orientation, with 160px/140px pane
minima when editing a body, without additional `minExtent`. Its settings and
response metadata use bounded content areas. Compact-pane selection is consumer
layout policy; standalone SplitPane defaults remain unchanged.

Run `pnpm test` for separator interaction, limits, cancellation, responsive
geometry, and application lifecycle tests. Run `pnpm build` for frontend type
checking and bundling.
