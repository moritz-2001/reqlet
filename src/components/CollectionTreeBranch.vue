<!-- CollectionTreeBranch keeps native nested lists for collections small enough to render in full. -->
<script setup lang="ts">
import { computed } from "vue";
import CollectionTreeEntry from "./CollectionTreeEntry.vue";
import { collectionFolderExpanded } from "./collectionTree";
import type { CollectionNode, CollectionTreeProps } from "./collectionTree";

const props = defineProps<CollectionTreeProps>();
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
const presentation = computed(() => {
  const { nodes: _nodes, interactionEnabled: _enabled, ...value } = props;
  return value;
});
const visibleNodes = computed(() => props.nodes.filter(matchesSearch));
const forward = {
  "select-request": (id: string) => emit("select-request", id),
  "toggle-folder": (id: string) => emit("toggle-folder", id),
  "open-actions": (id: string, trigger: HTMLButtonElement) => emit("open-actions", id, trigger),
  "entry-keydown": (id: string, event: KeyboardEvent) => emit("entry-keydown", id, event),
  "update:renameValue": (value: string) => emit("update:renameValue", value),
  "commit-rename": () => emit("commit-rename"),
  "cancel-rename": (restore: boolean) => emit("cancel-rename", restore),
  "start-drag": (event: PointerEvent, id: string) => emit("start-drag", event, id),
};

function matchesSearch(node: CollectionNode): boolean {
  if (props.matchingRequestIds === undefined) return true;
  return node.kind === "request" ? props.matchingRequestIds.has(node.id)
    : props.matchingFolderIds?.has(node.id) ?? node.children.some(matchesSearch);
}

function isExpanded(id: string): boolean {
  return collectionFolderExpanded(props, id);
}
</script>

<template>
  <ul class="collection-tree">
    <li v-for="node in visibleNodes" :key="node.id" :data-collection-id="node.id"
      :class="{ 'drop-before': dropTarget?.id === node.id && dropTarget.position === 'before', 'drop-after': dropTarget?.id === node.id && dropTarget.position === 'after' }">
      <CollectionTreeEntry v-bind="presentation" :node="node" v-on="forward" />
      <div v-if="node.kind === 'folder' && isExpanded(node.id)">
        <CollectionTreeBranch v-if="node.children.length" :nodes="node.children" :expanded-folder-ids="expandedFolderIds"
          :selected-request-id="selectedRequestId" :selected-folder-id="selectedFolderId" :requests="requests"
          :matching-request-ids="matchingRequestIds" :matching-folder-ids="matchingFolderIds" :search-collapsed-folder-ids="searchCollapsedFolderIds" :action-menu-target-id="actionMenuTargetId"
          :renaming-id="renamingId" :rename-value="renameValue" :rename-error="renameError"
          :reorder-enabled="reorderEnabled" :dragged-id="draggedId" :drop-target="dropTarget"
          @select-request="emit('select-request', $event)" @toggle-folder="emit('toggle-folder', $event)"
          @open-actions="(id, trigger) => emit('open-actions', id, trigger)"
          @entry-keydown="(id, event) => emit('entry-keydown', id, event)"
          @update:rename-value="emit('update:renameValue', $event)" @commit-rename="emit('commit-rename')"
          @cancel-rename="emit('cancel-rename', $event)" @start-drag="(event, id) => emit('start-drag', event, id)" />
        <p v-else class="empty-folder" :data-collection-empty="node.id">No requests yet</p>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.collection-tree { margin: 0; padding: 0; list-style: none; }
.collection-tree .collection-tree { margin-left: 13px; padding-left: 8px; border-left: 1px solid var(--color-border); }
li { position: relative; }
.drop-before::before, .drop-after::after { content: ''; position: absolute; left: 0; right: 0; height: 2px; z-index: 1; background: var(--color-focus); pointer-events: none; }
.drop-before::before { top: -1px; }
.drop-after::after { bottom: -1px; }
.empty-folder { margin: 0 0 4px 20px; padding: 8px; color: var(--color-muted); font-size: 12px; }
</style>
