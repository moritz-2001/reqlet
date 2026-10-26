# Workspace header

The header keeps the active sending environment visible beside Quick open and a
single **Workspace tools** menu. The menu groups **Manage environments**,
**Protobuf models**, and **Import / Export**. At widths up to 600px, the environment
selector gets its own row so long environment names cannot force the brand or
actions to overlap. The selected environment uses the same controlled workspace
value at every width. Its explicit accessible name remains **Environment** when
the visual label is hidden below 760px.

[WorkspaceTools.vue](../src/components/WorkspaceTools.vue) owns only transient
menu state. Clicking its trigger or pressing Arrow Down opens on the first action;
Arrow Up opens on the last. Arrow keys wrap, Home/End jump, and Escape dismisses
to the trigger. Tab dismisses and lets the browser continue its normal sequence.
Outside pointer input dismisses without moving focus from the clicked control.

Selecting a tool emits `select("environments" | "protobuf" | "import-export")`.
Before emitting, the menu restores focus to its stable trigger. This gives the
manager a connected element to return to when its Close or Escape action runs,
even though the selected menu item is removed.

[App.vue](../src/App.vue) maps those intents onto the managers' `open()` methods.
Each manager stays mounted and accepts `hide-trigger` when hosted by the shared
menu. Standalone consumers may omit that prop to retain the original local
trigger. For example:

```vue
<WorkspaceTools @select="tool => tool === 'environments' && environments?.open()" />
<EnvironmentManager
  ref="environments"
  hide-trigger
  :environments="workspace.environments"
  :active-environment-id="workspace.activeEnvironmentId"
  @update:environments="workspace.environments = $event"
  @update:active-environment-id="workspace.activeEnvironmentId = $event"
/>
```

`EnvironmentManager.open()` continues to select the active scope and focus its
variable fields when request-field help invokes it directly. Editing another
environment still does not activate it. Import/export and Protobuf management
retain their existing workspace events and saved data ownership. Nonmodal
management panels dismiss when pointer input or keyboard focus moves outside
them, preserving the user's chosen focus target.

[WorkspaceTools.test.ts](../tests/WorkspaceTools.test.ts) verifies menu actions,
keyboard navigation, dismissal, and focus restoration.
[App.header.test.ts](../tests/App.header.test.ts) verifies manager entry points,
the always-visible environment selection, and imports through the grouped menu.
