# Environment recovery and request-field help

[EnvironmentManager.vue](../src/components/EnvironmentManager.vue) keeps its
editing scope independent from the scope used when sending requests. Deleting an
environment shows its name and **Undo deletion** inside the management panel.
Deleting the active environment explicitly reports that sending has switched to
**No environment**.

Undo restores the most recently deleted environment at its original list position,
including variable order, duplicate names, and disabled rows. It preserves edits
to surviving environments. The deleted environment becomes the inspected scope,
with keyboard focus returned to its name. If it was previously active, Undo also
restores that active scope unless the user has since chosen a sending scope,
including explicitly choosing No environment. Undo for an inactive environment
does not activate it. Closing and reopening the panel retains the latest recovery
action; another deletion replaces it, and a reload ends this temporary recovery.

The parent may open environment management from a request-field help link through
the component's exposed `open(): Promise<void>` operation:

```vue
<script setup lang="ts">
import { useTemplateRef } from "vue";
import EnvironmentManager from "../src/components/EnvironmentManager.vue";

const manager = useTemplateRef<InstanceType<typeof EnvironmentManager>>("manager");
</script>

<template>
  <EnvironmentManager ref="manager" :environments="environments"
    :active-environment-id="activeEnvironmentId" />
  <button type="button" @click="manager?.open()">Edit environment</button>
</template>
```

`open()` selects the active environment for inspection without activating another
scope. It focuses the first variable name, Add variable when the selected scope
is empty, or New environment name when no environments exist. The ordinary
Manage environments button retains the previously inspected scope instead.

[EnvironmentManager tests](../tests/EnvironmentManager.test.ts) exercise deletion
feedback, recovery with later edits and scope choices, and the public opening and
keyboard-focus behavior.
