<!-- QuickOpen searches saved request metadata and emits selection; App owns tabs and request content. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch } from "vue";
import type { RequestData } from "../request";
import { filterCollectionRequests, indexCollectionRequests } from "../navigationSearch";
import type { CollectionNode } from "./collectionTree";

const props = defineProps<{
  /** Saved hierarchy used to preserve collection order and show each request's ancestor folders. */
  nodes: readonly CollectionNode[];
  /** Canonical request metadata; edits are reflected without changing the saved definitions. */
  requests: Readonly<Record<string, RequestData>>;
}>();

const emit = defineEmits<{
  /** Opens the selected saved request through the application's existing tab operation. */
  "select-request": [id: string];
  /** Dismisses the transient dialog without changing the active request. */
  close: [];
}>();

const id = useId();
const dialog = useTemplateRef<HTMLDialogElement>("dialog");
const input = useTemplateRef<HTMLInputElement>("input");
const query = ref("");
const entries = computed(() => indexCollectionRequests(props.nodes, props.requests));
const results = computed(() => filterCollectionRequests(entries.value, query.value));
const selectedIndex = ref(0);
// Only this page enters the DOM. Selection still addresses the complete result list.
const pageSize = 50;
const pageStart = computed(() => Math.floor(selectedIndex.value / pageSize) * pageSize);
const visibleResults = computed(() => results.value.slice(pageStart.value, pageStart.value + pageSize)
  .map((request, index) => ({ request, index: pageStart.value + index })));
const selected = computed(() => results.value[selectedIndex.value]);
const selectedOptionId = computed(() => selected.value ? `${id}-option-${selectedIndex.value}` : undefined);
const resultMessage = computed(() => {
  const count = results.value.length;
  if (count) {
    const total = `${count} request${count === 1 ? "" : "s"}`;
    return count > pageSize
      ? `${total} · Showing ${pageStart.value + 1}–${Math.min(pageStart.value + pageSize, count)}` : total;
  }

  return entries.value.length ? "No requests match your search." : "No saved requests yet.";
});
// Capture the opener once; dismissing returns focus to it if it still belongs to the document.
let opener: HTMLElement | undefined;

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  dialog.value?.showModal();
  input.value?.focus();
});

onBeforeUnmount(() => {
  dialog.value?.close();
  if (opener?.isConnected) opener.focus();
});

watch(results, () => { selectedIndex.value = 0; });
watch(selectedOptionId, async optionId => {
  await nextTick();
  if (optionId) document.getElementById(optionId)?.scrollIntoView?.({ block: "nearest" });
});

function selectRequest(index = selectedIndex.value) {
  const request = results.value[index];
  if (request) emit("select-request", request.id);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!results.value.length) return;

    const direction = event.key === "ArrowDown" ? 1 : -1;
    selectedIndex.value = (selectedIndex.value + direction + results.value.length) % results.value.length;
  } else if (event.key === "Enter") {
    event.preventDefault();
    selectRequest();
  }
}

function handleDismissKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing) return;

  event.preventDefault();
  event.stopPropagation();
  emit("close");
}
</script>

<template>
  <dialog
    ref="dialog"
    class="quick-open"
    :aria-labelledby="`${id}-heading`"
    :aria-describedby="`${id}-hint`"
    @cancel.prevent="emit('close')"
    @keydown="handleDismissKey"
    @click.self="emit('close')"
  >
    <section class="quick-open-content">
      <header>
        <h2 :id="`${id}-heading`">Quick open</h2>
        <button class="ui-button ui-button--compact" type="button" aria-label="Close quick open" @click="emit('close')">Esc</button>
      </header>
      <label :for="`${id}-query`">Search requests</label>
      <input class="ui-input"
        :id="`${id}-query`"
        ref="input"
        v-model="query"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        :aria-controls="`${id}-results`"
        :aria-activedescendant="selectedOptionId"
        placeholder="Name, method, URL or folder"
        autocomplete="off"
        spellcheck="false"
        @keydown="handleKeydown"
      />
      <p class="result-count" role="status">{{ resultMessage }}</p>
      <ul :id="`${id}-results`" class="quick-open-results" role="listbox" aria-label="Matching requests">
        <li
          v-for="{ request, index } in visibleResults"
          :id="`${id}-option-${index}`"
          :key="request.id"
          role="option"
          :aria-selected="index === selectedIndex"
          :aria-posinset="index + 1"
          :aria-setsize="results.length"
          @pointermove="selectedIndex = index"
          @mousedown.prevent
          @click="selectRequest(index)"
        >
          <div class="result-heading">
            <strong>{{ request.name }}</strong>
            <span class="method">{{ request.method }}</span>
          </div>
          <span class="result-url">{{ request.url }}</span>
          <span class="result-folder">{{ request.folderPath || 'Collection root' }}</span>
        </li>
      </ul>
      <nav v-if="results.length > pageSize" class="result-pages" aria-label="Request result pages">
        <button class="ui-button ui-button--compact" type="button" :disabled="pageStart === 0"
          @click="selectedIndex = Math.max(0, pageStart - pageSize)">Previous requests</button>
        <button class="ui-button ui-button--compact" type="button" :disabled="pageStart + pageSize >= results.length"
          @click="selectedIndex = Math.min(results.length - 1, pageStart + pageSize)">Next requests</button>
      </nav>
      <p :id="`${id}-hint`" class="quick-open-hint">↑↓ to choose · Enter to open · Esc to close</p>
    </section>
  </dialog>
</template>

<style scoped>
.result-pages { display: flex; justify-content: space-between; gap: 8px; }
.quick-open {
  width: min(620px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  margin: 8dvh auto auto;
  padding: 0;
  overflow: hidden;
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid #3c4d68;
  border-radius: 10px;
  box-shadow: 0 20px 80px #0009;
}
.quick-open::backdrop { background: #060b14b8; }
.quick-open-content { display: flex; flex-direction: column; max-height: calc(84dvh - 48px); padding: 16px; }
header, .result-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
header { margin-bottom: 16px; }
h2 { margin: 0; font-size: 15px; }
label { margin-bottom: 6px; font-size: 12px; color: #b2bfd1; }

input { flex-shrink: 0; width: 100%; padding: 10px; }

.result-count, .quick-open-hint { flex-shrink: 0; margin: 10px 0; color: var(--color-muted); font-size: 11px; }
.quick-open-hint { margin-bottom: 0; }
.quick-open-results { min-height: 0; margin: 0; padding: 2px; overflow: auto; list-style: none; }
[role="option"] { display: flex; flex-direction: column; gap: 5px; padding: 10px; border-radius: 6px; cursor: pointer; }
[role="option"][aria-selected="true"] { background: #8baaff1c; outline: 1px solid #8baaff70; }
.result-heading strong { font-size: 12px; overflow-wrap: anywhere; }
.method { flex-shrink: 0; color: #9fe3bc; font-size: 10px; }
.result-url, .result-folder { font-size: 11px; overflow-wrap: anywhere; }
.result-url { color: #b2bfd1; }
.result-folder { color: var(--color-muted); }
</style>
