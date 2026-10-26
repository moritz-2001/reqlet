<!-- HistoryPanel navigates completed exchanges; workspace inspection belongs to its parent. -->
<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";
import type { HistoryEntry } from "../request";
import { filterHistoryEntries, historyResultCategory, type HistoryResultFilter } from "../navigationSearch";

const props = defineProps<{
  /** Completed snapshots in display order, normally newest start first. */
  entries: readonly HistoryEntry[];
  /** History entry open in the main workspace; omitted means no history tab is active. */
  selectedEntryId?: string;
}>();

// Filters are local presentation state and never change retained snapshots or workspace selection.
const search = ref("");
const resultFilter = ref<HistoryResultFilter>("all");
const searchInput = useTemplateRef<HTMLInputElement>("searchInput");
const visibleEntries = computed(() => filterHistoryEntries(props.entries, search.value, resultFilter.value));

const emit = defineEmits<{
  /** Open the captured exchange in the parent workspace without executing or editing it. */
  inspect: [entry: HistoryEntry];
  /** Explicit intent to remove all retained history, without changing saved requests. */
  clear: [];
}>();

function clearFilters() {
  search.value = "";
  resultFilter.value = "all";
  searchInput.value?.focus();
}

function inspectFirstMatch(event: KeyboardEvent) {
  if (event.isComposing) return;

  event.preventDefault();
  const entry = visibleEntries.value[0];
  if (entry) emit("inspect", entry);
}

function clearFiltersOnEscape(event: KeyboardEvent) {
  if (event.isComposing) return;

  event.preventDefault();
  event.stopPropagation();
  clearFilters();
}

function resultLabel(entry: HistoryEntry): string {
  if (entry.result.status === "success") {
    return `${entry.result.response.status} ${entry.result.response.statusText}`.trim();
  }

  return entry.result.status === "error" ? "Failed" : "Cancelled";
}

function displayTime(startedAt: string): string {
  return new Date(startedAt).toLocaleString();
}
</script>

<template>
  <section class="history-panel" aria-label="Execution history">
    <header class="history-heading">
      <h2>History <span>({{ entries.length }})</span></h2>
      <button class="ui-button ui-button--compact" type="button" :disabled="!entries.length" @click="emit('clear')">Clear history</button>
    </header>
    <p class="history-note">Last 100 executions saved locally, including credentials. Select an execution to inspect it in the workspace.</p>

    <div class="history-filters">
      <label for="history-search">Search executions</label>
      <input class="ui-input ui-input--compact"
        id="history-search"
        ref="searchInput"
        v-model="search"
        type="search"
        aria-label="Search executions"
        placeholder="Name, URL or method"
        @keydown.enter="inspectFirstMatch"
        @keydown.esc="clearFiltersOnEscape"
      />
      <label for="history-result-filter">Result</label>
      <select class="ui-input ui-input--compact" id="history-result-filter" v-model="resultFilter" aria-label="Filter execution results">
        <option value="all">All results</option>
        <option value="http-success">HTTP 1xx–3xx</option>
        <option value="http-error">HTTP errors (4xx–5xx)</option>
        <option value="transport-error">Transport errors</option>
        <option value="cancelled">Cancelled</option>
      </select>
      <button v-if="search || resultFilter !== 'all'" type="button" class="ui-button ui-button--compact clear-filters" @click="clearFilters">Clear filters</button>
    </div>

    <p v-if="!entries.length" class="history-empty" role="status">No executions yet. Send a request to start your history.</p>

    <template v-else>
      <p class="history-count" role="status">
        {{ visibleEntries.length ? `Showing ${visibleEntries.length} of ${entries.length} executions` : 'No executions match your filters.' }}
      </p>
      <ol v-if="visibleEntries.length" class="history-list" aria-label="Completed executions">
        <li v-for="entry in visibleEntries" :key="entry.id" :data-selected="selectedEntryId === entry.id">
          <button
            type="button"
            class="history-select"
            :aria-label="`Inspect ${entry.name}, ${entry.request.method} ${entry.request.url}`"
            :aria-pressed="selectedEntryId === entry.id"
            @click="emit('inspect', entry)"
          >
            <span class="history-name">{{ entry.name }}</span>
            <span class="history-route"><strong>{{ entry.request.method }}</strong> {{ entry.request.url }}</span>
            <span class="history-execution">
              <time :datetime="entry.startedAt">{{ displayTime(entry.startedAt) }}</time>
              <span class="history-result" :data-result="historyResultCategory(entry)">{{ resultLabel(entry) }}</span>
            </span>
          </button>
        </li>
      </ol>
    </template>
  </section>
</template>

<style scoped>
.history-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  padding: 12px;
  color: var(--color-text);
  overflow: auto;
}

.history-heading, .history-execution {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.history-heading h2 { margin: 0; font-size: 12px; }
.history-heading h2 span { color: var(--color-muted); font-weight: 400; }
.history-heading, .history-note, .history-empty, .history-filters, .history-count { flex-shrink: 0; }
.history-note, .history-empty, .history-count { margin: 0; color: var(--color-muted); font-size: 11px; line-height: 1.5; }
.history-empty { padding: 24px 8px; text-align: center; }
.history-filters { display: grid; gap: 6px; }
.history-filters label { color: #c5d1e3; font-size: 11px; }
.history-filters input, .history-filters select { width: 100%; }
.clear-filters { justify-self: start; }

.history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  margin: 0;
  padding: 2px;
  overflow: auto;
  list-style: none;
}

.history-list li { padding: 4px; border: 1px solid var(--color-border); border-radius: 6px; }
.history-list li[data-selected="true"] { border-color: var(--color-focus); background: #8baaff0a; }
.history-select {
  padding: 6px 8px;
  color: inherit;
  background: transparent;
  font: inherit;
  font-size: var(--control-compact-font-size);
  border-radius: var(--control-compact-radius);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  border: 0;
  text-align: left;
}

.history-select:hover { background: var(--color-hover); }
.history-select:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

.history-name { font-weight: 600; overflow-wrap: anywhere; }
.history-route { color: #b2bfd1; overflow-wrap: anywhere; }
.history-route strong { color: #9fe3bc; font-size: 10px; }
.history-execution { width: 100%; color: var(--color-muted); font-size: 10px; }
.history-result { color: #9fe3bc; }
.history-result[data-result="http-error"], .history-result[data-result="transport-error"] { color: #f2a7a7; }
.history-result[data-result="cancelled"] { color: #eec78f; }
</style>
