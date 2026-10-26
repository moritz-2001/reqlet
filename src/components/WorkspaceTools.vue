<!-- WorkspaceTools keeps occasional workspace actions in one keyboard-accessible header menu. -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef } from "vue";

const emit = defineEmits<{
  /** Opens a workspace manager after restoring focus to the menu's stable trigger. */
  select: [tool: "environments" | "protobuf" | "import-export"];
}>();

const id = useId();
const root = useTemplateRef<HTMLElement>("root");
const trigger = useTemplateRef<HTMLButtonElement>("trigger");
const menu = useTemplateRef<HTMLElement>("menu");
const expanded = ref(false);

onMounted(() => {
  document.addEventListener("pointerdown", closeOutside);
  document.addEventListener("focusin", closeOutside);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeOutside);
  document.removeEventListener("focusin", closeOutside);
});

async function open(last = false) {
  expanded.value = true;
  await nextTick();
  const items = menuItems();
  items[last ? items.length - 1 : 0]?.focus();
}

function close(restoreFocus = true) {
  expanded.value = false;
  if (restoreFocus) trigger.value?.focus();
}

function select(tool: "environments" | "protobuf" | "import-export") {
  close();
  emit("select", tool);
}

function navigate(event: KeyboardEvent) {
  if (event.key === "Tab") {
    close();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

  event.preventDefault();
  const items = menuItems();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

function closeOutside(event: PointerEvent | FocusEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target)) close(false);
}

function menuItems(): HTMLButtonElement[] {
  return [...menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []];
}
</script>

<template>
  <div ref="root" class="workspace-tools" @keydown.esc.stop.prevent="close()">
    <button ref="trigger" class="ui-button tools-trigger" type="button" aria-label="Workspace tools"
      aria-haspopup="menu" :aria-expanded="expanded" :aria-controls="`${id}-menu`"
      @click="expanded ? close() : open()" @keydown.down.prevent="open()" @keydown.up.prevent="open(true)">
      <span class="tools-label">Workspace tools</span><span class="compact-tools-label" aria-hidden="true">Tools</span>
      <span aria-hidden="true">⌄</span>
    </button>
    <div v-if="expanded" :id="`${id}-menu`" ref="menu" class="tools-menu" role="menu"
      aria-label="Workspace tools" @keydown="navigate">
      <button type="button" role="menuitem" tabindex="-1" @click="select('environments')">Manage environments</button>
      <button type="button" role="menuitem" tabindex="-1" @click="select('protobuf')">Protobuf models</button>
      <button type="button" role="menuitem" tabindex="-1" @click="select('import-export')">Import / Export</button>
    </div>
  </div>
</template>

<style scoped>
.workspace-tools { position: relative; flex-shrink: 0; }
.tools-trigger { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.compact-tools-label { display: none; }
.tools-menu { position: absolute; top: calc(100% + 8px); right: 0; z-index: 40; display: grid; min-width: 208px; padding: 5px; border: 1px solid var(--color-control-border); border-radius: 8px; background: #141d2a; box-shadow: 0 12px 30px #0008; }
.tools-menu button { border: 0; border-radius: 4px; padding: 10px 12px; background: transparent; color: var(--color-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.tools-menu button:hover, .tools-menu button:focus-visible { outline: none; background: #26364d; }
@media (max-width: 520px) { .tools-label { display: none; } .compact-tools-label { display: inline; } }
</style>
