# Ordered key/value editing

[KeyValueEditor.vue](../src/components/KeyValueEditor.vue) renders the same
controlled row interface for request headers, additional query parameters, and
environment variables. The parent owns `modelValue`; every edit emits a complete
`update:modelValue` replacement. Duplicate names, disabled entries, and row order
remain intact.

```vue
<KeyValueEditor
  v-model="request.headers"
  label="Headers"
  entry-label="header"
  headers
  resolve-variables
  :environment="activeEnvironment"
/>
```

Adding a row focuses its Name input and scrolls it into view after the parent
accepts the emitted rows. The component recognizes those row objects through Vue
reactive proxies and copied arrays. Replacing them with different objects cancels
the handoff so an unrelated row at the same index does not receive focus. A parent
that rejects an operation can leave its model unchanged; no speculative row is
displayed or focused. The first later model replacement consumes the pending
handoff, and a user who has moved focus elsewhere keeps it there.

Removing the focused row moves focus to the next surviving Name, then the previous
Name when removing the last row. Removing the only row returns focus to Add. These
handoffs also wait for accepted rows and reveal their target with nearest-edge
scrolling. Removing another row does not interrupt the field currently being
edited. DOM focus remains a local presentation concern; callers need no mutable
accessor or imperative component API.

[KeyValueEditor.test.ts](../tests/KeyValueEditor.test.ts) exercises acceptance,
rejection, delayed acceptance, visibility requests, and keyboard focus recovery
through the rendered controls.

## Large row sets

Above 80 entries, the editor renders a measured window inside a 360-pixel scroll
viewport through [VirtualRows.vue](../src/components/VirtualRows.vue). It mounts
the visible rows, four neighboring rows on each side, and at most one focused
row outside that window. Duplicate names and original row indices remain intact.
Natural row heights include wrapped validation messages and the two-line mobile
layout; `ResizeObserver` refines the initial height estimates as rows appear.

Tab and Shift+Tab cross window boundaries in logical row order. Adding or removing
the focused row first reveals the accepted target and then applies the existing
focus handoff. Scrolling away keeps the focused input, its selection, and variable
completion mounted until focus leaves that row.

Virtualization removes offscreen inputs from native form validation. A parent
with a Send action first checks mounted invalid inputs, then calls
`revealInvalid()`. It returns `undefined` synchronously when no deferred work is
needed, or a promise of the newly mounted invalid input. The parent reveals the
containing settings panel and reports native validity on that input. Validation
uses the same placeholder and header rules as the visible `VariableInput`,
including disabled rows and authentication-replaced headers.

```ts
const pending = headers.value?.revealInvalid();
const offscreenInvalid = pending ? await pending : undefined;
if (offscreenInvalid) {
  // Reveal the containing settings panel before reporting native validity.
  offscreenInvalid.reportValidity();
  offscreenInvalid.focus();
}
```

The controlled model still emits an ordered replacement array for a row edit.
Windowing bounds input components and validation previews, rather than changing
the parent's row storage contract.
