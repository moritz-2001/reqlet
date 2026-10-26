<!-- CollectionTreeEntry presents one saved entry and forwards its controlled editing and movement intents. -->
<script setup lang="ts">
import { ref, watch } from "vue";
import { collectionFolderExpanded } from "./collectionTree";
import type { CollectionNode, CollectionTreePresentation } from "./collectionTree";

const props = defineProps<CollectionTreePresentation & { node: CollectionNode }>();
const emit = defineEmits<{
  "select-request": [id: string];
  "toggle-folder": [id: string];
  "open-actions": [id: string, trigger: HTMLButtonElement];
  "entry-keydown": [id: string, event: KeyboardEvent];
  "update:renameValue": [value: string];
  "commit-rename": [];
  "cancel-rename": [restoreFocus: boolean];
  "start-drag": [event: PointerEvent, id: string];
}>();
const composing = ref(false);
watch(() => props.renamingId, () => { composing.value = false; });

function isExpanded(id: string): boolean {
  return collectionFolderExpanded(props, id);
}

function displayName(node: CollectionNode): string {
  return node.kind === "request" ? props.requests?.[node.id]?.name ?? node.name : node.name;
}

function renameKeydown(event: KeyboardEvent) {
  if (event.isComposing || composing.value) {
    if (event.key === "Enter") event.preventDefault();
    if (event.key === "Escape") event.stopPropagation();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("cancel-rename", true);
  }
}

function renameFocusout(event: FocusEvent) {
  if (!(event.relatedTarget instanceof Node) || !(event.currentTarget as HTMLElement).contains(event.relatedTarget)) {
    emit("cancel-rename", false);
  }
}
</script>

<template>
  <div class="collection-entry" :data-collection-row="node.id"
    :class="{ 'dragged-entry': draggedId === node.id, 'drop-inside': dropTarget?.id === node.id && dropTarget.position === 'inside' }"
    @keydown="emit('entry-keydown', node.id, $event)">
    <button v-if="reorderEnabled && renamingId !== node.id" type="button" class="drag-handle"
      :aria-label="`Drag ${displayName(node)}`" title="Drag to move; Alt+Shift+↑/↓ changes order"
      @pointerdown="emit('start-drag', $event, node.id)" @dragstart.prevent>⠿</button>
    <form v-if="renamingId === node.id" class="inline-rename" :aria-label="`Rename ${node.kind}`"
      @submit.prevent="!composing && emit('commit-rename')" @keydown="renameKeydown" @focusout="renameFocusout">
      <input class="ui-input ui-input--compact" :value="renameValue" aria-label="Collection entry name"
        :aria-invalid="!!renameError" :aria-describedby="renameError ? `rename-error-${node.id}` : undefined"
        @input="emit('update:renameValue', ($event.target as HTMLInputElement).value)"
        @compositionstart="composing = true" @compositionend="composing = false" />
      <div class="rename-actions">
        <button class="ui-button ui-button--compact" type="submit">Save</button>
        <button class="ui-button ui-button--compact" type="button" @click="emit('cancel-rename', true)">Cancel</button>
      </div>
      <p v-if="renameError" :id="`rename-error-${node.id}`" role="alert">{{ renameError }}</p>
    </form>
    <button v-else-if="node.kind === 'folder'" type="button" class="tree-row folder-row"
      :class="{ 'managed-folder': node.id === selectedFolderId }" :aria-expanded="isExpanded(node.id)"
      :title="node.name" @click="emit('toggle-folder', node.id)">
      <span class="folder-chevron" aria-hidden="true">{{ isExpanded(node.id) ? '▾' : '▸' }}</span>
      <span class="node-name">{{ node.name }}</span>
    </button>
    <button v-else type="button" class="tree-row request-row" :aria-current="node.id === selectedRequestId ? 'true' : undefined"
      :title="displayName(node)" @click="emit('select-request', node.id)">
      <span class="node-name">{{ displayName(node) }}</span>
      <span class="node-kind" :data-method="requests?.[node.id]?.method ?? node.requestType">{{ requests?.[node.id]?.method ?? node.requestType }}</span>
    </button>
    <button v-if="renamingId !== node.id" type="button" class="entry-menu-trigger"
      :aria-label="`Actions for ${displayName(node)}`" aria-haspopup="menu" :aria-expanded="actionMenuTargetId === node.id"
      @click="emit('open-actions', node.id, $event.currentTarget as HTMLButtonElement)">⋯</button>
  </div>
</template>

<style scoped>
.collection-entry { display: flex; align-items: center; gap: 2px; margin-bottom: 2px; border-radius: 6px; }
.tree-row { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; min-height: 36px; padding: 8px; font: inherit; font-size: 13px; color: inherit; text-align: left; background: transparent; border: 0; border-radius: 6px; cursor: pointer; }
.tree-row:hover, .entry-menu-trigger:hover { background: var(--color-hover); }
.tree-row[aria-current="true"], .managed-folder { background: var(--color-selected); }
.entry-menu-trigger, .drag-handle { flex-shrink: 0; padding: 3px 6px; color: var(--color-muted); background: transparent; border: 0; border-radius: 5px; cursor: pointer; }
.entry-menu-trigger { font-size: 18px; line-height: 1; }
.entry-menu-trigger[aria-expanded="true"] { background: var(--color-hover); }
.drag-handle { padding: 4px 2px; cursor: grab; touch-action: pan-y; user-select: none; }
.drag-handle:hover { color: var(--color-text); }
.dragged-entry { opacity: .5; }
.drop-inside { outline: 2px solid var(--color-focus); background: var(--color-hover); }
.folder-chevron { width: 9px; flex-shrink: 0; color: var(--color-muted); }
.node-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-kind { flex-shrink: 0; font-size: 10px; color: #88cda1; }
.node-kind[data-method="POST"] { color: #ecc87c; }
.node-kind[data-method="PUT"], .node-kind[data-method="PATCH"] { color: #9bb8ff; }
.node-kind[data-method="DELETE"] { color: #f29898; }
.inline-rename { flex: 1; min-width: 0; display: grid; gap: 6px; padding: 4px; }
.inline-rename input { min-width: 0; width: 100%; }
.rename-actions { display: flex; gap: 4px; }
.inline-rename p { margin: 0; color: var(--color-danger); font-size: 11px; }
</style>
