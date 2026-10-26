# Measured row viewport

[VirtualRows.vue](../src/components/VirtualRows.vue) renders a bounded window over
parent-owned ordered records. It owns scroll position, measured row heights, and
the mounted window. Callers own data, validation, table/list semantics, and
keyboard navigation. It never copies or mutates the record collection.

```vue
<VirtualRows ref="rows" :items="headers" :estimated-height="32" :max-height="180">
  <template #default="{ item: header, index }">
    <div role="row" :aria-rowindex="index + 2">
      <span role="rowheader">{{ header.name }}</span>
      <span role="cell">{{ header.value }}</span>
    </div>
  </template>
</VirtualRows>
```

`items` accepts a readonly array. The slot receives the original `item` and
zero-based logical `index`. `estimatedHeight` supplies the initial height of an
unvisited row; `ResizeObserver` replaces it with the row's natural height,
including wrapping and inline errors. `maxHeight` bounds the scroll viewport
only while virtualization is active. `threshold` defaults to 80; smaller lists
keep all rows mounted in their normal document flow.

`rowKey(item, index)` optionally supplies a stable string or number for controls
whose native selection must follow a record through insertion or removal. It
defaults to the logical index. Keys must be unique within the list. A focused row
is retained by this key, so a shifted record keeps its own input rather than the
input that formerly occupied that index.

The exposed `reveal(index)` operation returns `undefined` for a small list or an
invalid index. Otherwise it returns a promise that resolves after the requested
row is mounted, measured, and scrolled into view. Await it before finding or
focusing an offscreen control. Merely revealing a row does not move focus.

The window includes four neighboring rows on each side to absorb ordinary
scrolling. A focused row remains mounted outside that window until focus leaves
it, preserving native input selection and completion state. Callers that offer
sequential keyboard navigation must use logical indices and reveal the target;
DOM traversal alone would skip unmounted rows. Native form validation also sees
only mounted controls, so editable callers provide a logical validation-and-reveal
operation. See [the key/value editor](key-value-editor.md) for that integration.

Height measurements carry both position and item identity. Changed or shifted
records discard their old estimates, and removed records do not accumulate in the
cache. Measuring a taller row preserves the visible row and its pixel inset;
revealing a target waits for the expanded spacer to reach the browser before
repositioning it, accounting for native scroll clamping.
The helper bounds mounted DOM and per-row reactive work; it retains an offset
array proportional to the logical row count. Browser Find can inspect mounted
text; complete-data search belongs to the caller's logical data model.
