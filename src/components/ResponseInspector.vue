<!-- ResponseInspector presents execution feedback and retains the last received body while this request retries. -->
<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import type { ExecutionState, HttpResponse } from "../request";
import BodyText from "./BodyText.vue";
import VirtualRows from "./VirtualRows.vue";

const props = defineProps<{
  /** Current operation; omitted means no request has been sent from this editor. */
  execution?: ExecutionState;
}>();

const state = computed<ExecutionState>(() => props.execution ?? { status: "idle" });
// App keys each editor by request identity. This presentation cache survives retries
// and KeepAlive tab switches, but idle or unmount clears the previous request's body.
// It never changes the parent-owned execution or creates a completed history entry.
const response = shallowRef<HttpResponse>();
watch(state, execution => {
  if (execution.status === "success") response.value = execution.response;
  else if (execution.status === "idle") response.value = undefined;
}, { immediate: true, flush: "sync" });

// Retain the user's choice even when idle or a first failed send has no body editor.
const presentation = ref<"pretty" | "raw">("pretty");
const showingPrevious = computed(() => response.value !== undefined && state.value.status !== "success");
const previousFeedback = computed(() => {
  switch (state.value.status) {
    case "running": return "Previous response · Sending…";
    case "error": return `Previous response · Request failed: ${state.value.error}`;
    case "cancelled": return "Previous response · Request cancelled.";
    default: return "";
  }
});
const contentType = computed(() => response.value?.headers
  .find(header => header.name.toLowerCase() === "content-type")?.value ?? "text/plain");
const statusTone = computed(() => {
  if (!response.value) return undefined;

  return response.value.status >= 400 ? "http-error" : response.value.status >= 300 ? "redirect" : "ok";
});
</script>

<template>
  <section class="response-inspector" aria-label="Response" :aria-busy="state.status === 'running'">
    <header class="response-heading">
      <h2>Response</h2>
      <span v-if="response" class="response-status" :data-tone="statusTone" :role="showingPrevious ? undefined : 'status'">
        {{ response.status }} {{ response.statusText }}
      </span>
      <span v-if="response" class="response-summary">
        {{ response.durationMs.toLocaleString(undefined, { maximumFractionDigits: 2 }) }} ms
        · {{ response.sizeBytes.toLocaleString() }} bytes
      </span>
    </header>

    <p v-if="showingPrevious" class="execution-feedback" :role="state.status === 'error' ? 'alert' : 'status'">
      {{ previousFeedback }}
    </p>

    <template v-if="response">
      <details class="response-details">
        <summary>Response details · {{ response.headers.length }} headers</summary>
        <div class="details-content">
          <dl class="response-metadata">
            <div class="response-url">
              <dt>URL</dt>
              <dd><code>{{ response.url }}</code></dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{{ response.durationMs.toLocaleString(undefined, { maximumFractionDigits: 2 }) }} ms</dd>
            </div>
            <div>
              <dt>Body size</dt>
              <dd>{{ response.sizeBytes.toLocaleString() }} bytes</dd>
            </div>
            <div class="response-content-type">
              <dt>Content type</dt>
              <dd><code>{{ contentType }}</code></dd>
            </div>
          </dl>

          <h3 class="headers-heading">Response headers ({{ response.headers.length }})</h3>
          <div v-if="response.headers.length > 80" class="virtual-headers" role="table"
            aria-label="Response headers" :aria-rowcount="response.headers.length + 1" aria-colcount="2">
            <div class="virtual-header-row" role="row" aria-rowindex="1">
              <span role="columnheader">Name</span><span role="columnheader">Value</span>
            </div>
            <VirtualRows :items="response.headers" :estimated-height="32" :max-height="180"
              role="rowgroup" tabindex="0" aria-label="Response header values">
              <template #default="{ item: header, index }">
                <div class="virtual-header-row" role="row" :aria-rowindex="index + 2">
                  <span role="rowheader">{{ header.name }}</span><span role="cell">{{ header.value }}</span>
                </div>
              </template>
            </VirtualRows>
          </div>
          <div v-else-if="response.headers.length" class="headers-scroll" tabindex="0" aria-label="Response header values">
            <table>
              <caption class="ui-visually-hidden">Response headers</caption>
              <thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
              <tbody>
                <tr v-for="(header, index) in response.headers" :key="index">
                  <th scope="row">{{ header.name }}</th>
                  <td>{{ header.value }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="empty-headers">No response headers.</p>
        </div>
      </details>

      <BodyText v-model:presentation="presentation" :model-value="response.body" :content-type="contentType"
        label="Response body" readonly compact />
    </template>

    <div v-else class="response-placeholder">
      <p v-if="state.status === 'running'" role="status">Sending request…</p>
      <template v-else-if="state.status === 'error'">
        <h3>Request failed</h3>
        <p role="alert">{{ state.error }}</p>
      </template>
      <p v-else-if="state.status === 'cancelled'" role="status">Request cancelled.</p>
      <p v-else role="status">Send a request to inspect its response.</p>
    </div>
  </section>
</template>

<style scoped>
.response-inspector {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--color-text);
  --body-editor-min-height: 0px;
  --body-editor-resize: none;
}

.response-heading {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 8px;
  min-height: 34px;
  padding: 2px 0 6px;
}

.response-heading h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.response-status {
  padding: 4px 7px;
  border: 1px solid currentColor;
  border-radius: 5px;
  color: #9fe3bc;
  font-size: 12px;
  font-weight: 600;
}

.response-status[data-tone="http-error"] { color: #f2a7a7; }
.response-status[data-tone="redirect"] { color: #eec78f; }
.response-summary { color: var(--color-muted); font-size: 12px; margin-left: auto; }

.execution-feedback {
  flex-shrink: 0;
  margin: 0 0 8px;
  padding: 7px 9px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: #eec78f;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.execution-feedback[role="alert"] { color: #f2a7a7; }

.response-metadata {
  display: grid;
  flex-shrink: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 12px;
  margin: 0;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-panel);
  font-size: 12px;
}

.response-metadata dt {
  margin-bottom: 4px;
  color: var(--color-muted);
  font-size: 12px;
}

.response-metadata dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.response-url { grid-column: 1 / -1; }
.response-metadata code { font-size: inherit; }

.response-details {
  flex-shrink: 0;
  min-height: 0;
  max-height: 40%;
  overflow: auto;
  margin: 0 0 8px;
  font-size: 12px;
}

.response-details summary {
  width: fit-content;
  color: #b2bfd1;
  cursor: pointer;
}

.details-content { padding: 8px 0; }
.headers-heading { margin: 12px 0 6px; color: #b2bfd1; font-size: 12px; font-weight: 500; }

.headers-scroll {
  max-height: 180px;
  margin-top: 8px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

.virtual-headers { margin-top: 8px; border: 1px solid var(--color-border); border-radius: 6px; }
.virtual-header-row { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(120px, 2fr); }
.virtual-header-row > span { padding: 7px 9px; overflow-wrap: anywhere; border-bottom: 1px solid var(--color-border); }
.virtual-header-row [role="columnheader"] { color: var(--color-muted); font-weight: 600; }
.virtual-header-row [role="rowheader"] { font-weight: 500; }
.virtual-headers :deep(.virtual-rows:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: 3px; }

table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}

th, td {
  padding: 7px 9px;
  vertical-align: top;
  overflow-wrap: anywhere;
  border-bottom: 1px solid var(--color-border);
}

thead th { color: var(--color-muted); }
tbody th { font-weight: 500; }
tbody tr:last-child > * { border-bottom: 0; }
.empty-headers { color: var(--color-muted); }

/* Only the body text scrolls by default; execution status remains above the bounded viewport. */
.response-inspector > .body-text { flex: 1; min-height: 0; }

.response-placeholder {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  min-height: 0;
  padding: 16px;
  border: 1px dashed var(--color-border);
  border-radius: 8px;
  color: var(--color-muted);
  text-align: center;
}

.response-placeholder h3, .response-placeholder p {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
}

.response-placeholder [role="alert"] { color: #f2a7a7; }

summary:focus-visible, .headers-scroll:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 3px;
}

</style>
