<!-- CollectionMoveDialog selects a destination; CollectionManager validates and commits the actual move. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import type { CollectionFolder } from "../collections";

const props = defineProps<{
  /** Stable target's current name, displayed without changing workspace selection. */
  name: string;
  /** Target kind used to name the modal accessibly. */
  kind: "request" | "folder";
  /** Containing folder; null means root and disables moving to root again. */
  currentParentId: string | null;
  /** Full-path destinations with cyclic folders already excluded. */
  folders: readonly CollectionFolder[];
  /** Validation failure from the current commit attempt; empty means no error. */
  error: string;
}>();
const emit = defineEmits<{
  /** Explicit destination choice; null appends at the collection root. */
  move: [parentId: string | null];
  /** Dismisses without committing a move. */
  cancel: [];
}>();
const dialog = useTemplateRef<HTMLDialogElement>("dialog");
const input = useTemplateRef<HTMLInputElement>("input");
const query = ref("");
// Null is an unchosen destination; the empty string explicitly identifies root.
const destination = ref<string | null>(props.currentParentId ?? "");
const composing = ref(false);
const currentPath = computed(() => props.folders.find(folder => folder.id === props.currentParentId)?.path ?? "Collection root");
const destinations = computed(() => {
  const words = query.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return [{ id: "", path: "Collection root" }, ...props.folders]
    .filter(folder => words.every(word => folder.path.toLocaleLowerCase().includes(word)));
});
const canMove = computed(() => destination.value !== null
  && destination.value !== (props.currentParentId ?? "")
  && destinations.value.some(folder => folder.id === destination.value));

watch(destinations, folders => {
  if (!folders.some(folder => folder.id === destination.value)) destination.value = null;
});
onMounted(() => {
  dialog.value?.showModal();
  input.value?.focus();
});
onBeforeUnmount(() => dialog.value?.close());

function submit() {
  if (!composing.value && canMove.value) emit("move", destination.value || null);
}

function keydown(event: KeyboardEvent) {
  if (event.isComposing || composing.value) {
    if (event.key === "Enter") event.preventDefault();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("cancel");
  }
}
</script>

<template>
  <dialog ref="dialog" class="move-dialog" :aria-label="`Move ${kind}`" @cancel.prevent="!composing && emit('cancel')"
    @keydown="keydown" @click.self="emit('cancel')">
    <form class="move-content" @submit.prevent="submit">
      <h2>Move “{{ name }}”</h2>
      <p class="current-location">Current location: <strong>{{ currentPath }}</strong></p>
      <label>Search destination folders
        <input ref="input" v-model="query" class="ui-input" type="search" aria-label="Search destination folders"
          placeholder="Folder name or path" @compositionstart="composing = true" @compositionend="composing = false" />
      </label>
      <label>Destination
        <select v-model="destination" class="ui-input destination-list" aria-label="Collection destination" size="8">
          <option v-if="destination === null" :value="null" disabled>Choose a destination</option>
          <option v-for="folder in destinations" :key="folder.id" :value="folder.id" :title="folder.path"
            :disabled="folder.id === (currentParentId ?? '')">{{ folder.path }}{{ folder.id === (currentParentId ?? '') ? ' (current)' : '' }}</option>
        </select>
      </label>
      <p v-if="!destinations.length" class="hint" role="status">No destination folders match.</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <div class="move-actions">
        <button class="ui-button ui-button--primary" type="submit" :disabled="!canMove">Move</button>
        <button class="ui-button" type="button" @click="emit('cancel')">Cancel</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.move-dialog { width: min(500px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; color: var(--color-text); background: var(--color-surface); border: 1px solid var(--color-control-border); border-radius: 10px; box-shadow: 0 20px 80px #0009; }
.move-dialog::backdrop { background: #060b14b8; }
.move-content { display: flex; flex-direction: column; gap: 14px; max-height: calc(100dvh - 34px); padding: 16px; overflow: auto; }
h2 { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
p { margin: 0; font-size: 12px; }
.current-location, .hint, label { color: var(--color-muted); }
label { display: grid; gap: 6px; font-size: 12px; min-height: 0; }
input, select { width: 100%; }
.destination-list { min-height: 100px; max-height: 34dvh; }
option { padding: 8px; }
.move-actions { display: flex; gap: 8px; }
[role="alert"] { color: var(--color-danger); }
</style>
