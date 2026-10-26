<!-- ImportExport exposes validated paste/file imports and credential-aware portable exports from a compact header control. -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, useTemplateRef, watch } from "vue";
import type { CollectionNode } from "./collectionTree";
import type { Environment, HttpRequest, RequestData } from "../request";
import { exportCurl, importCollection, importCurl, remapCollection, serializeCollection, type CollectionImport } from "../interchange";
import { prepareNextRequest } from "../prepareRequest";
import type { OpenApiPreview } from "../openapi";

const props = defineProps<{
  /** Current saved definitions exported together with their collection references. */
  requests: Record<string, RequestData>;
  /** Local source labels for portable exports and identities reserved during import; paths are excluded. */
  protobufSources?: readonly import("../protobuf").ProtobufSource[];
  /** Current collection hierarchy; existing identities are reserved during import. */
  nodes: readonly CollectionNode[];
  /** Selected draft for cURL export; undefined disables that action. */
  activeRequest?: RequestData;
  /** Exact next-send inputs for an unedited active history draft; omitted prepares activeRequest. */
  capturedRequest?: HttpRequest;
  /** Selected environment resolved into the exported cURL snapshot; undefined means no scope. */
  environment?: Environment;
  /** Allows a shared workspace menu to call open() without a duplicate header button. */
  hideTrigger?: boolean;
}>();
const emit = defineEmits<{
  /** Fully validated definitions and hierarchy with fresh IDs, ready to merge into the workspace. */
  import: [collection: CollectionImport];
}>();

const id = useId();
const manager = useTemplateRef<HTMLElement>("manager");
const toggle = useTemplateRef<HTMLButtonElement>("toggle");
const paste = useTemplateRef<HTMLTextAreaElement>("paste");
const expanded = ref(false);
// The shared menu restores its stable trigger before calling open(), so Close can return there.
let opener: HTMLElement | undefined;
const source = ref("");
const exportText = ref("");
const includeCredentials = ref(false);
const error = ref("");
const status = ref("");
const readingFile = ref(false);
const loadingOpenApi = ref(false);
const format = ref<"auto" | "openapi">("auto");
const baseUrl = ref("");
// A preview is valid only for the current source and server override. Selection
// belongs to that preview and is discarded whenever either input changes.
const preview = shallowRef<OpenApiPreview>();
const selectedOperations = ref<string[]>([]);
let openApi: typeof import("../openapi") | undefined;
// Each pending module load owns a revision; input edits or closing the panel
// invalidate it so an older continuation cannot restore an obsolete preview.
let previewRevision = 0;

watch([source, baseUrl, format], () => {
  cancelPendingPreview();
  preview.value = undefined;
  selectedOperations.value = [];
}, { flush: "sync" });
watch(expanded, visible => { if (!visible) cancelPendingPreview(); }, { flush: "sync" });

onMounted(() => { document.addEventListener("pointerdown", closeOutside); });
onBeforeUnmount(() => {
  cancelPendingPreview();
  document.removeEventListener("pointerdown", closeOutside);
});

async function togglePanel() {
  if (expanded.value) closePanel();
  else await open();
}

/** Opens the paste/file workflow from either its own trigger or the shared workspace menu. */
async function open() {
  if (!expanded.value) opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement : toggle.value ?? undefined;
  expanded.value = true;
  await nextTick();
  paste.value?.focus();
}

defineExpose({ open });

function importSource() {
  error.value = "";
  status.value = "";
  try {
    const input = source.value.trim();
    if (!input) throw new Error("Paste a cURL command, collection JSON, or OpenAPI document first.");
    const occupied = existingIds();
    let imported: CollectionImport;
    if (format.value === "auto" && isPortableCollection(input)) {
      imported = importCollection(input, occupied);
    } else if (format.value === "auto" && /^curl(?:\s|$)/.test(input)) {
      const request = importCurl(input);
      const temporaryId = "imported-curl";
      imported = remapCollection({
        requests: { [temporaryId]: request },
        collection: [{ kind: "request", id: temporaryId, name: request.name, requestType: request.method }],
      }, occupied);
    } else {
      format.value = "openapi";
      void previewOpenApi(input, baseUrl.value.trim() || undefined);
      return;
    }
    emit("import", imported);
    status.value = `Imported ${Object.keys(imported.requests).length} request(s). Existing requests were preserved.`;
    source.value = "";
  } catch (cause) { error.value = message(cause); }
}

async function previewOpenApi(input: string, serverOverride: string | undefined) {
  const revision = ++previewRevision;
  preview.value = undefined;
  selectedOperations.value = [];
  loadingOpenApi.value = true;
  status.value = "Loading OpenAPI support…";
  try {
    const parser = await import("../openapi");
    if (revision !== previewRevision) return;

    openApi = parser;
    const result = parser.parseOpenApi(input, { baseUrl: serverOverride });
    preview.value = result;
    selectedOperations.value = result.operations.map(operation => operation.id);
    status.value = `Preview ready: ${result.operations.length} operation(s). Choose the operations to import.`;
  } catch (cause) {
    if (revision !== previewRevision) return;
    status.value = "";
    error.value = message(cause);
  } finally {
    if (revision === previewRevision) loadingOpenApi.value = false;
  }
}

function importSelectedOperations() {
  error.value = "";
  status.value = "";
  if (!preview.value || !openApi) return;
  try {
    const occupied = existingIds();
    const imported = remapCollection(openApi.createOpenApiCollection(preview.value, selectedOperations.value), occupied);
    emit("import", imported);
    status.value = `Imported ${Object.keys(imported.requests).length} request(s). Existing requests were preserved.`;
    source.value = "";
  } catch (cause) { error.value = message(cause); }
}

async function readFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  // File reads finish asynchronously while the paste field remains editable.
  // Preserve later user input rather than replacing it with an older load.
  const previousSource = source.value;
  error.value = "";
  status.value = `Reading ${file.name}…`;
  readingFile.value = true;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("Import files must be 10 MiB or smaller.");
    const text = await file.text();
    if (source.value !== previousSource) {
      status.value = "The import text changed while the file was loading. Your edits were kept; choose the file again to replace them.";
      return;
    }
    source.value = text;
    status.value = `Loaded ${file.name}. Review the text, then choose Import.`;
  } catch (cause) {
    status.value = "";
    error.value = `Could not read the import file: ${message(cause)}`;
  } finally { readingFile.value = false; input.value = ""; }
}

async function copyCollection() {
  await copyExport(() => serializeCollection(props.requests, props.nodes, props.protobufSources), "Collection JSON copied.");
}

async function copyActiveCurl() {
  await copyExport(() => {
    if (!props.activeRequest) throw new Error("Select a request to export cURL.");
    return exportCurl(prepareNextRequest(props.activeRequest, props.environment, props.capturedRequest));
  }, "Resolved cURL command copied.");
}

async function copyExport(generate: () => string, success: string) {
  error.value = "";
  status.value = "";
  if (!includeCredentials.value) return;
  try {
    exportText.value = generate();
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable. Copy the export text below manually.");
    await navigator.clipboard.writeText(exportText.value);
    status.value = success;
  } catch (cause) { error.value = message(cause); }
}

function downloadCollection() {
  error.value = "";
  status.value = "";
  if (!includeCredentials.value) return;
  let url: string | undefined;
  let link: HTMLAnchorElement | undefined;
  try {
    exportText.value = serializeCollection(props.requests, props.nodes, props.protobufSources);
    url = URL.createObjectURL(new Blob([exportText.value], { type: "application/json" }));
    link = document.createElement("a");
    link.href = url;
    link.download = "reqlet-collection.json";
    document.body.append(link);
    link.click();
    status.value = "Collection download started.";
  } catch (cause) { error.value = `Could not download the collection: ${message(cause)}`; }
  finally {
    link?.remove();
    if (url) { const objectUrl = url; setTimeout(() => URL.revokeObjectURL(objectUrl), 0); }
  }
}

function existingIds(): Set<string> {
  const ids = new Set(Object.keys(props.requests));
  for (const source of props.protobufSources ?? []) ids.add(source.id);
  // Missing bindings still own their identity; importing must not silently relink them.
  for (const request of Object.values(props.requests)) {
    if (request.protobuf) ids.add(request.protobuf.sourceId);
  }

  function visit(children: readonly CollectionNode[]) {
    for (const node of children) {
      ids.add(node.id);
      if (node.kind === "folder") visit(node.children);
    }
  }
  visit(props.nodes);
  return ids;
}

function isPortableCollection(input: string): boolean {
  // A flow-style YAML document can also start with a brace. Failed JSON
  // detection must leave it available to the OpenAPI YAML parser.
  try {
    const value: unknown = JSON.parse(input);
    return value !== null && typeof value === "object" && "kind" in value && value.kind === "api-tool-collection";
  } catch { return false; }
}

function cancelPendingPreview() {
  previewRevision += 1;
  if (loadingOpenApi.value) status.value = "";
  loadingOpenApi.value = false;
}

function closeOutside(event: PointerEvent) {
  if (event.target instanceof Node && !manager.value?.contains(event.target)) expanded.value = false;
}

function closeOnFocusOutside(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !manager.value?.contains(event.relatedTarget)) expanded.value = false;
}

function closePanel() {
  expanded.value = false;
  if (opener?.isConnected) opener.focus();
  else toggle.value?.focus();
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
</script>

<template>
  <div ref="manager" class="import-export" @keydown.esc.stop="closePanel" @focusout="closeOnFocusOutside">
    <button v-if="!hideTrigger" class="ui-button" ref="toggle" type="button" :aria-expanded="expanded" :aria-controls="`${id}-panel`" @click="togglePanel">Import / Export</button>
    <section v-if="expanded" :id="`${id}-panel`" role="dialog" :aria-labelledby="`${id}-heading`" class="panel">
      <div class="heading">
        <h2 :id="`${id}-heading`">Import / Export</h2>
        <button class="ui-button" type="button" aria-label="Close import and export" @click="closePanel">Close</button>
      </div>
      <label :for="`${id}-format`">Import format</label>
      <select class="ui-input" :id="`${id}-format`" v-model="format">
        <option value="auto">Detect automatically (cURL, collection JSON, OpenAPI)</option>
        <option value="openapi">OpenAPI 3.0 / 3.1 (JSON or YAML)</option>
      </select>
      <label :for="`${id}-source`">Paste a cURL command, collection JSON, or OpenAPI document</label>
      <textarea class="ui-input" ref="paste" :id="`${id}-source`" v-model="source" spellcheck="false" rows="6" placeholder="curl 'https://example.com/api'" />
      <template v-if="format === 'openapi'">
        <label :for="`${id}-server`">Server URL override (optional)</label>
        <input class="ui-input" :id="`${id}-server`" v-model="baseUrl" type="url" placeholder="https://api.example.com/v1" />
        <p class="hint">Use an absolute HTTP(S) URL when the document has relative servers or to target another server. This replaces the server URL for every imported operation.</p>
      </template>
      <div class="actions">
        <button class="ui-button" type="button" :disabled="!source.trim() || readingFile || loadingOpenApi" @click="importSource">{{ format === 'openapi' ? 'Preview OpenAPI' : 'Import' }}</button>
        <label class="ui-button file-label" :for="`${id}-file`">Load file</label>
        <input :id="`${id}-file`" class="file" type="file" accept=".json,.yaml,.yml,.txt,.curl,application/json,application/yaml,text/yaml,text/plain" :disabled="readingFile" @change="readFile" />
      </div>
      <section v-if="preview" class="openapi-preview" :aria-labelledby="`${id}-preview`">
        <h3 :id="`${id}-preview`">{{ preview.title }} · {{ selectedOperations.length }} of {{ preview.operations.length }} selected</h3>
        <div class="actions">
          <button class="ui-button ui-button--primary" type="button" :disabled="!selectedOperations.length || readingFile" @click="importSelectedOperations">Import selected operations</button>
          <button class="ui-button" type="button" @click="selectedOperations = preview.operations.map(operation => operation.id)">Select all</button>
          <button class="ui-button" type="button" @click="selectedOperations = []">Select none</button>
        </div>
        <ul class="operation-list" aria-label="OpenAPI operations">
          <li v-for="operation in preview.operations" :key="operation.id">
            <label class="operation">
              <input v-model="selectedOperations" type="checkbox" :value="operation.id" />
              <span><strong>{{ operation.method }} {{ operation.path }}</strong><small>{{ operation.tag }} · {{ operation.name }}</small><small class="destination">{{ operation.request.path }}</small></span>
            </label>
          </li>
        </ul>
        <details v-if="preview.warnings.length" class="import-warnings" open>
          <summary>Review {{ preview.warnings.length }} import note(s)</summary>
          <ul><li v-for="(warning, index) in preview.warnings" :key="index">{{ warning }}</li></ul>
        </details>
      </section>
      <p class="hint">Imports add copies with new identities. Requests and credentials are saved locally. Shell commands are parsed as text and never executed.</p>
      <div class="exports">
        <label class="consent"><input v-model="includeCredentials" type="checkbox" />Include credentials and request data in exports</label>
        <p class="hint">Collection JSON includes saved authentication, headers, URLs, and bodies. cURL includes the active editor's next-send inputs, including credentials and captured history values.</p>
        <div class="actions">
          <button class="ui-button" type="button" :disabled="!includeCredentials" @click="downloadCollection">Download collection JSON</button>
          <button class="ui-button" type="button" :disabled="!includeCredentials" @click="copyCollection">Copy collection JSON</button>
          <button class="ui-button" type="button" :disabled="!includeCredentials || !activeRequest" @click="copyActiveCurl">Copy active cURL</button>
        </div>
        <label v-if="exportText" :for="`${id}-export`">Export text</label>
        <textarea class="ui-input" v-if="exportText" :id="`${id}-export`" :value="exportText" readonly spellcheck="false" rows="5" />
      </div>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="status" role="status" class="status">{{ status }}</p>
    </section>
  </div>
</template>

<style scoped>
.import-export { position: relative; }
button, .file-label { white-space: nowrap; }

.panel { position: fixed; top: 56px; right: 16px; z-index: 40; width: min(620px, calc(100vw - 32px)); max-height: calc(100dvh - 100px); overflow: auto; padding: 16px; border: 1px solid #34435a; border-radius: 10px; color: var(--color-text); background: #101823; box-shadow: 0 18px 48px #0008; }
.heading, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.heading { justify-content: space-between; margin-bottom: 14px; }
h2 { margin: 0; font-size: 14px; }
label { display: block; margin-bottom: 6px; font-size: 12px; }
textarea { display: block; width: 100%; resize: vertical; font: 12px/1.5 monospace; }
select, input[type="url"] { width: 100%; margin-bottom: 12px; }
textarea + label { margin-top: 12px; }
.actions { margin-top: 9px; }
.file-label { display: inline-block; margin: 0; }
.file { max-width: 215px; font-size: 11px; }
.hint { color: var(--color-muted); font-size: 12px; line-height: 1.5; }
.exports { padding-top: 14px; border-top: 1px solid var(--color-control-border); }
.openapi-preview { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--color-control-border); }
h3 { margin: 0; font-size: 13px; }
.operation-list { max-height: 250px; overflow: auto; padding: 0; list-style: none; }
.operation { display: flex; gap: 8px; padding: 8px; margin: 0; cursor: pointer; }
.operation span { min-width: 0; }
.operation strong, .operation small { display: block; overflow-wrap: anywhere; }
.operation small { margin-top: 3px; color: var(--color-muted); }
.destination { font-family: monospace; }
.import-warnings { margin-bottom: 12px; font-size: 12px; line-height: 1.5; }
.import-warnings ul { padding-left: 20px; }
.consent { display: flex; align-items: center; gap: 7px; }
.exports > label:not(.consent) { margin-top: 12px; }
.error, .status { margin-bottom: 0; font-size: 12px; line-height: 1.5; }
.error { color: var(--color-danger); }
.status { color: #9cddb8; }
input[type="file"]:focus-visible, input[type="checkbox"]:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }
@media (max-width: 600px) { .panel { top: 92px; max-height: calc(100dvh - 108px); } }
</style>
