<!-- HistoryInspector presents one captured exchange in a read-only workspace panel. -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { HistoryEntry } from "../request";
import BodyText from "./BodyText.vue";
import ResponseInspector from "./ResponseInspector.vue";

const props = defineProps<{
  /** Stable captured exchange owned by its runtime tab, independent of history retention. */
  entry: HistoryEntry;
}>();

const requestContentType = computed(() => props.entry.request.headers
  .find(header => header.name.toLowerCase() === "content-type")?.value ?? "text/plain");
// The disclosure owns this editor's first mount; later closes retain its view,
// selection, and search. A different captured identity starts unopened again.
const requestInspected = ref(false);
watch(() => props.entry.id, () => { requestInspected.value = false; });

function inspectRequest(event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open) requestInspected.value = true;
}

function displayTime(startedAt: string): string {
  return new Date(startedAt).toLocaleString();
}
</script>

<template>
  <section class="history-inspection" aria-label="Captured execution">
    <header class="history-inspector-heading">
      <div><h1>{{ entry.name }}</h1><p>History · Read-only execution snapshot</p></div>
      <slot name="actions" :entry="entry" />
    </header>
    <dl class="history-request-metadata">
      <div><dt>Started</dt><dd><time :datetime="entry.startedAt">{{ displayTime(entry.startedAt) }}</time></dd></div>
      <div><dt>Method</dt><dd><code>{{ entry.request.method }}</code></dd></div>
      <div><dt>Timeout</dt><dd>{{ entry.request.timeoutMs.toLocaleString() }} ms</dd></div>
      <div class="history-url"><dt>URL</dt><dd><code>{{ entry.request.url }}</code></dd></div>
    </dl>

    <!-- A captured exchange has its own identity; another entry must never inherit its retained response. -->
    <ResponseInspector :key="entry.id" :execution="entry.result" />

    <details :key="entry.id" class="history-request-details" @toggle="inspectRequest">
      <summary>Captured request headers and body</summary>
      <div v-if="entry.request.headers.length" class="history-headers-scroll" tabindex="0" aria-label="Captured request header values">
        <table>
          <caption>Request headers ({{ entry.request.headers.length }})</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
          <tbody>
            <tr v-for="(header, index) in entry.request.headers" :key="index">
              <th scope="row">{{ header.name }}</th><td>{{ header.value }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="history-note">No request headers.</p>
      <BodyText v-if="requestInspected" :model-value="entry.request.body" :content-type="requestContentType" label="Captured request body" readonly />
    </details>
  </section>
</template>

<style scoped>
.history-inspection { display: flex; flex: 1; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; padding: 16px; overflow: auto; }
.history-inspector-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; flex-shrink: 0; }
.history-inspector-heading h1 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
.history-inspector-heading p { margin: 5px 0 0; color: var(--color-muted); font-size: 11px; }
.history-request-metadata { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); flex-shrink: 0; gap: 9px; margin: 0; padding: 10px; border: 1px solid var(--color-control-border); border-radius: 6px; font-size: 11px; }
.history-request-metadata dt { margin-bottom: 3px; color: var(--color-muted); }
.history-request-metadata dd { margin: 0; overflow-wrap: anywhere; }
.history-request-metadata code { font-size: inherit; }
.history-request-details { font-size: 11px; }
.history-request-details summary { margin-bottom: 10px; color: #b2bfd1; cursor: pointer; }
.history-request-details > .body-text { height: 260px; margin-top: 10px; }
.history-inspection > .response-inspector { min-height: 300px; }
.history-inspection :deep(.response-inspector > .body-text) { min-height: 260px; }
.history-headers-scroll { max-height: 180px; overflow: auto; border: 1px solid var(--color-control-border); border-radius: 6px; }
table { width: 100%; border-collapse: collapse; text-align: left; }
caption { padding: 8px; text-align: left; color: var(--color-muted); }
th, td { padding: 7px; vertical-align: top; overflow-wrap: anywhere; border-bottom: 1px solid var(--color-control-border); }
thead th { color: var(--color-muted); }
tbody th { font-weight: 500; }
tbody tr:last-child > * { border-bottom: 0; }

.history-request-metadata .history-url { grid-column: 1 / -1; }
.history-note { color: var(--color-muted); }
.history-request-details { flex-shrink: 0; }
summary:focus-visible, .history-headers-scroll:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
</style>
