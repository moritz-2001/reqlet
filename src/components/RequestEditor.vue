<!-- RequestEditor keeps execution controls visible above compact request settings and response inspection. -->
<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef, watch } from "vue";
import type { Environment, ExecutionState, HttpRequest, RequestData } from "../request";
import { previewRequestContentType, previewRequestField } from "../prepareRequest";
import { inspectUrlQuery } from "../urlQuery";
import type { SplitSizes } from "./splitPane";
import { resolveProtobufAssistance, type ProtobufSource, type ProtobufSourceState } from "../protobuf";
import ProtobufBindingPicker from "./ProtobufBindingPicker.vue";
import AuthEditor from "./AuthEditor.vue";
import BodyText from "./BodyText.vue";
import KeyValueEditor from "./KeyValueEditor.vue";
import RequestFields from "./RequestFields.vue";
import RequestTarget from "./RequestTarget.vue";
import ResponseInspector from "./ResponseInspector.vue";
import SplitPane from "./SplitPane.vue";
import VirtualRows from "./VirtualRows.vue";

const props = defineProps<{
  /** Current request data; edits emit replacements without mutating this object. */
  modelValue: Readonly<RequestData>;
  /** Workspace sources available for message selection. */
  protobufSources?: readonly ProtobufSource[];
  /** Shared runtime catalogs and recoverable loading failures. */
  protobufStates?: Record<string, ProtobufSourceState>;
  /** Parent-owned execution state; omitted means this request has not run. */
  execution?: ExecutionState;
  /** Saved orientation-specific pane preferences; omitted retains local preferences. */
  layout?: SplitSizes;
  /** Scope used for the next execution; omitted resolves only literal request values. */
  environment?: Environment;
  /** Exact replay snapshot until the draft is edited; omitted prepares the current definition and environment. */
  capturedRequest?: HttpRequest;
}>();

const emit = defineEmits<{
  /** Complete replacement after editing any part of the saved request. */
  "update:modelValue": [request: RequestData];
  /** Executes the current parent-owned definition. */
  send: [];
  /** Opens the workspace protobuf source manager. */
  "manage-protobuf": [];
  /** Cancels the running operation without changing the saved definition. */
  cancel: [];
  /** Updated pane preferences for the parent workspace to persist. */
  "update:layout": [sizes: SplitSizes];
  /** Opens the active environment manager from local placeholder feedback. */
  "edit-environment": [];
}>();

type SettingsTab = "body" | "headers" | "parameters" | "auth" | "advanced";

const editorId = useId();
const root = useTemplateRef<HTMLElement>("root");
const headersEditor = useTemplateRef<{ revealInvalid(): Promise<HTMLInputElement | undefined> | undefined }>("headersEditor");
const queryEditor = useTemplateRef<{ revealInvalid(): Promise<HTMLInputElement | undefined> | undefined }>("queryEditor");
const activeSettings = ref<SettingsTab>("body");
// Body visibility is presentation state; it never adds text to the saved definition.
const bodyRequested = ref(false);
// Incomplete/invalid timeout edits must survive tab switches without entering the
// saved definition, so Send can reveal the problem instead of using a stale value.
const timeoutDraft = ref(String(props.modelValue.timeoutMs));
// Standalone editors remember resize gestures too; controlled layouts remain parent-owned.
const localLayout = ref<SplitSizes>({ horizontal: "50%", vertical: "50%" });
const paneLayout = computed(() => props.layout ?? localLayout.value);
const running = computed(() => props.execution?.status === "running");
const showBodyEditor = computed(() => bodyRequested.value || props.modelValue.body.length > 0
  || !["GET", "HEAD"].includes(props.modelValue.method.trim().toUpperCase()));
// Compact presentation never changes divider preferences. Once both panes have
// useful content, SplitPane restores the last user-selected size in each direction.
const compactPane = computed(() => {
  if (activeSettings.value === "body" && !showBodyEditor.value) return "first";
  if (!props.execution || props.execution.status === "idle") return "second";
  return undefined;
});
const contentTypePreview = computed(() => previewRequestContentType(props.modelValue, props.environment, props.capturedRequest));
const contentTypeOverride = computed(() => ["header", "authentication", "captured"].includes(contentTypePreview.value.source ?? ""));
const contentTypeNote = computed(() => contentTypePreview.value.source === "authentication"
  ? "Set by the authentication Content-Type header."
  : contentTypePreview.value.source === "captured" ? "Set by the captured Content-Type header."
  : "Set by the enabled Content-Type header.");
// Authentication removes matching saved headers before transport header-value validation.
// Their placeholders still resolve, but syntax in a replaced value cannot invalidate the actual send.
const replacedAuthenticationHeader = computed(() => {
  const auth = props.modelValue.auth;
  if (auth.type === "bearer" || auth.type === "basic") return "Authorization";
  if (auth.type !== "api-key" || auth.location !== "header") return undefined;

  return previewRequestField(auth.name, "header-name", props.environment, props.modelValue.inputMode).value ?? undefined;
});
const requestContentType = computed(() => contentTypePreview.value.value ?? "");
const contentTypeSelection = computed(() => contentTypePreview.value.value ?? props.modelValue.contentType);
const protobufAssistance = computed(() => resolveProtobufAssistance(props.modelValue.protobuf, props.protobufSources ?? [], props.protobufStates ?? {}, requestContentType.value));
const urlQuery = computed(() => inspectUrlQuery(props.modelValue.path,
  props.capturedRequest ? "literal" : props.modelValue.inputMode));
const settingsTabs = computed<Array<{ id: SettingsTab; label: string }>>(() => [
  { id: "body", label: "Body" },
  { id: "headers", label: `Headers (${props.modelValue.headers.length})` },
  { id: "parameters", label: `Parameters (${(urlQuery.value?.parameters.length ?? 0) + props.modelValue.query.length})` },
  { id: "auth", label: "Auth" },
  { id: "advanced", label: "Advanced" },
]);

watch(() => props.modelValue.timeoutMs, timeoutMs => { timeoutDraft.value = String(timeoutMs); });

function updateRequest(changes: Partial<RequestData>) {
  emit("update:modelValue", { ...props.modelValue, ...changes });
}

async function openProtobufSettings() {
  activeSettings.value = "advanced";
  await nextTick();
  document.getElementById(`${editorId}-protobuf-heading`)?.focus();
}

function editUrlParameters() {
  const input = root.value?.querySelector<HTMLInputElement>('[aria-label="Request URL"]');
  const query = urlQuery.value;
  if (!input || !query) return;

  input.focus();
  input.setSelectionRange(query.start, query.end);
  input.scrollIntoView?.({ block: "nearest" });
}

async function sendRequest() {
  if (running.value) return;

  // Virtual tables can omit the invalid row from the DOM. Check their logical
  // values too, revealing that row before ordinary native validation/focus.
  let invalid = root.value?.querySelector<HTMLInputElement>("input:invalid");
  if (!invalid) {
    const pending = headersEditor.value?.revealInvalid();
    if (pending) invalid = await pending;
  }
  if (!invalid) {
    const pending = queryEditor.value?.revealInvalid();
    if (pending) invalid = await pending;
  }
  if (invalid) {
    const panel = invalid.closest<HTMLElement>("[data-settings-panel]");
    if (panel) activeSettings.value = panel.dataset.settingsPanel as SettingsTab;
    // Fields inside a collapsed disclosure must be visible before native
    // validation can announce the problem and focus its corrective input.
    for (let ancestor = invalid.parentElement; ancestor && ancestor !== root.value; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    }
    await nextTick();
    invalid.reportValidity();
    invalid.focus();
    return;
  }
  emit("send");
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return;

  event.preventDefault();
  void sendRequest();
}

async function navigateSettings(event: KeyboardEvent) {
  const tabs = settingsTabs.value;
  const current = tabs.findIndex(tab => tab.id === activeSettings.value);
  let next: number;
  switch (event.key) {
    case "ArrowRight": next = (current + 1) % tabs.length; break;
    case "ArrowLeft": next = (current + tabs.length - 1) % tabs.length; break;
    case "Home": next = 0; break;
    case "End": next = tabs.length - 1; break;
    default: return;
  }

  event.preventDefault();
  activeSettings.value = tabs[next].id;
  await nextTick();
  document.getElementById(`${editorId}-${tabs[next].id}-tab`)?.focus();
}

function updateTimeout(event: Event) {
  const input = event.target as HTMLInputElement;
  timeoutDraft.value = input.value;
  const timeoutMs = input.valueAsNumber;
  if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647) {
    updateRequest({ timeoutMs });
  }
}

function updateLayout(sizes: SplitSizes) {
  localLayout.value = sizes;
  emit("update:layout", sizes);
}
</script>

<template>
  <div ref="root" class="request-editor" @keydown="handleKeydown">
    <h1 class="request-heading" :title="modelValue.name">{{ modelValue.name }}</h1>
    <button class="ui-button ui-button--link input-mode-summary" type="button" @click="activeSettings = 'advanced'">
      Inputs: {{ modelValue.inputMode === 'literal' ? 'Literal text' : 'Environment template' }}
    </button>
    <slot name="request-status" />
    <RequestFields :model-value="modelValue" :environment="environment" :captured="!!capturedRequest"
      @edit-environment="emit('edit-environment')" @update:model-value="emit('update:modelValue', $event)">
      <template #actions>
        <button v-if="running" type="button" class="ui-button cancel-button" @click="emit('cancel')">Cancel</button>
        <button type="button" class="ui-button ui-button--primary send-button" :disabled="running" title="Send request (⌘/Ctrl+Enter)" @click="sendRequest">
          {{ running ? 'Sending…' : 'Send' }}
        </button>
      </template>
    </RequestFields>
    <RequestTarget :request="modelValue" :environment="environment" :captured-request="capturedRequest"
      @edit-environment="emit('edit-environment')" />

    <SplitPane
      class="body-panels"
      label="Resize request and response panes"
      :sizes="paneLayout"
      :compact="compactPane"
      :stack-at="800"
      :min-first="160"
      :min-second="140"
      @update:sizes="updateLayout"
    >
      <template #first>
        <div class="settings-pane">
          <div class="settings-tabs" role="tablist" aria-label="Request settings" @keydown="navigateSettings">
            <button
              v-for="tab in settingsTabs"
              :id="`${editorId}-${tab.id}-tab`"
              :key="tab.id"
              role="tab"
              type="button"
              :aria-selected="activeSettings === tab.id"
              :aria-controls="`${editorId}-${tab.id}-panel`"
              :tabindex="activeSettings === tab.id ? 0 : -1"
              @click="activeSettings = tab.id"
            >{{ tab.label }}</button>
          </div>

          <section
            v-show="activeSettings === 'body'"
            :id="`${editorId}-body-panel`"
            role="tabpanel"
            :aria-labelledby="`${editorId}-body-tab`"
            data-settings-panel="body"
            class="settings-panel body-panel"
          >
            <div v-show="!showBodyEditor" class="empty-body">
              <button class="ui-button" type="button" @click="bodyRequested = true">Add body</button>
            </div>
            <div v-show="showBodyEditor" class="body-content">
              <div v-if="modelValue.protobuf && (!protobufAssistance.context || protobufAssistance.action === 'manage')" class="protobuf-status">
                <span role="status">{{ protobufAssistance.status }}</span>
                <button class="ui-button" v-if="protobufAssistance.action === 'manage'" type="button" @click="emit('manage-protobuf')">Fix source</button>
              </div>
              <BodyText
                :protobuf-context="protobufAssistance.context"
                :model-value="modelValue.body"
                :content-type="requestContentType"
                label="Request body"
                incremental
                compact
                @update:model-value="updateRequest({ body: $event })"
              >
                <template #toolbar>
                  <label class="ui-visually-hidden" :for="`${editorId}-content-type`">Content type</label>
                  <select class="ui-input content-type-select"
                    :id="`${editorId}-content-type`"
                    :value="contentTypeSelection"
                    :disabled="contentTypeOverride"
                    :aria-describedby="contentTypeOverride || contentTypePreview.error ? `${editorId}-content-type-note` : undefined"
                    :title="contentTypeOverride ? contentTypeNote : 'Request body content type'"
                    @change="updateRequest({ contentType: ($event.target as HTMLSelectElement).value })"
                  >
                    <option value="application/json">application/json</option>
                    <option value="text/plain">text/plain</option>
                    <option value="application/xml">application/xml</option>
                    <option value="application/x-www-form-urlencoded">application/x-www-form-urlencoded</option>
                    <option v-if="!['application/json', 'text/plain', 'application/xml', 'application/x-www-form-urlencoded'].includes(contentTypeSelection)" :value="contentTypeSelection">{{ contentTypeSelection || 'No Content-Type header' }}</option>
                  </select>
                  <span v-if="contentTypePreview.error" :id="`${editorId}-content-type-note`" class="content-type-note" role="status">Content-Type unavailable: {{ contentTypePreview.error }}</span>
                  <span v-else-if="contentTypeOverride" :id="`${editorId}-content-type-note`" class="content-type-note">{{ contentTypeNote }}</span>
                  <button v-if="modelValue.protobuf" class="ui-button ui-button--link protobuf-context" type="button"
                    :title="protobufAssistance.status" @click="openProtobufSettings">Protobuf: {{ protobufAssistance.label }}</button>
                </template>
              </BodyText>
            </div>
          </section>

          <section
            v-show="activeSettings === 'headers'"
            :id="`${editorId}-headers-panel`"
            role="tabpanel"
            :aria-labelledby="`${editorId}-headers-tab`"
            data-settings-panel="headers"
            class="settings-panel scrollable-settings"
          >
            <KeyValueEditor ref="headersEditor" :model-value="modelValue.headers" label="Headers" entry-label="header" headers resolve-variables
              :environment="environment" :captured="!!capturedRequest" :input-mode="modelValue.inputMode" :replaced-header="replacedAuthenticationHeader"
              @edit-environment="emit('edit-environment')" @update:model-value="updateRequest({ headers: $event })" />
          </section>

          <section
            v-show="activeSettings === 'parameters'"
            :id="`${editorId}-parameters-panel`"
            role="tabpanel"
            :aria-labelledby="`${editorId}-parameters-tab`"
            data-settings-panel="parameters"
            class="settings-panel scrollable-settings"
          >
            <section v-if="urlQuery?.parameters.length" class="url-parameters" aria-label="Parameters from URL">
              <div class="url-parameters-heading">
                <h3>From URL ({{ urlQuery.parameters.length }})</h3>
                <button class="ui-button" type="button" @click="editUrlParameters">Edit URL parameters</button>
              </div>
              <p class="parameter-note">Shown as written in the URL. Edit the URL above to change these values.</p>
              <div v-if="urlQuery.parameters.length > 80" class="url-parameter-table" role="table" aria-label="Parameters written in URL" :aria-rowcount="urlQuery.parameters.length + 1" aria-colcount="2">
                <div class="url-parameter-row" role="row" aria-rowindex="1"><span role="columnheader">Name</span><span role="columnheader">Value</span></div>
                <VirtualRows :items="urlQuery.parameters" :estimated-height="32" :max-height="240" role="rowgroup" tabindex="0" aria-label="Scroll URL parameters">
                  <template #default="{ item: parameter, index }">
                    <div class="url-parameter-row" role="row" :aria-rowindex="index + 2">
                      <div role="cell"><code v-if="parameter.name">{{ parameter.name }}</code><span v-else class="parameter-empty">Empty name</span></div>
                      <div role="cell"><code v-if="parameter.value">{{ parameter.value }}</code><span v-else class="parameter-empty">{{ parameter.value === undefined ? 'No equals sign' : 'Empty value' }}</span></div>
                    </div>
                  </template>
                </VirtualRows>
              </div>
              <table v-else>
                <thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
                <tbody>
                  <tr v-for="(parameter, index) in urlQuery.parameters" :key="index">
                    <td><code v-if="parameter.name">{{ parameter.name }}</code><span v-else class="parameter-empty">Empty name</span></td>
                    <td><code v-if="parameter.value">{{ parameter.value }}</code><span v-else class="parameter-empty">{{ parameter.value === undefined ? 'No equals sign' : 'Empty value' }}</span></td>
                  </tr>
                </tbody>
              </table>
            </section>
            <p class="parameter-note">Additional parameters are appended to the URL when sent. Disabled rows are excluded.</p>
            <KeyValueEditor ref="queryEditor" :model-value="modelValue.query" label="Additional query parameters" entry-label="query parameter" resolve-variables
              :environment="environment" :captured="!!capturedRequest" :input-mode="modelValue.inputMode" @edit-environment="emit('edit-environment')"
              @update:model-value="updateRequest({ query: $event })" />
          </section>

          <section
            v-show="activeSettings === 'auth'"
            :id="`${editorId}-auth-panel`"
            role="tabpanel"
            :aria-labelledby="`${editorId}-auth-tab`"
            data-settings-panel="auth"
            class="settings-panel scrollable-settings"
          >
            <AuthEditor open :model-value="modelValue.auth" :environment="environment" :captured="!!capturedRequest" :input-mode="modelValue.inputMode"
              @edit-environment="emit('edit-environment')" @update:model-value="updateRequest({ auth: $event })" />
          </section>

          <section
            v-show="activeSettings === 'advanced'"
            :id="`${editorId}-advanced-panel`"
            role="tabpanel"
            :aria-labelledby="`${editorId}-advanced-tab`"
            data-settings-panel="advanced"
            class="settings-panel scrollable-settings"
          >
            <label class="timeout-field" :for="`${editorId}-timeout`">
              <span>Timeout (ms)</span>
              <input class="ui-input" :id="`${editorId}-timeout`" :value="timeoutDraft" type="number" min="1"
                max="2147483647" step="1" required @input="updateTimeout" />
            </label>
            <label class="input-mode-field" :for="`${editorId}-input-mode`">
              <span>Input values</span>
              <select class="ui-input" :id="`${editorId}-input-mode`" :value="modelValue.inputMode ?? 'template'"
                @change="updateRequest({ inputMode: ($event.target as HTMLSelectElement).value as RequestData['inputMode'] })">
                <option value="template">Environment template</option>
                <option value="literal">Literal text</option>
              </select>
              <span class="content-type-note">Environment templates replace <code v-pre>{{variables}}</code> before sending. Literal text preserves them unchanged in every input.</span>
            </label>
            <section class="protobuf-settings" :aria-labelledby="`${editorId}-protobuf-heading`">
              <h3 :id="`${editorId}-protobuf-heading`" tabindex="-1">Protobuf completion</h3>
              <p class="parameter-note">Choose a message to complete JSON fields from a local protobuf schema.</p>
              <ProtobufBindingPicker :model-value="modelValue.protobuf" :sources="protobufSources ?? []" :states="protobufStates ?? {}" @update:model-value="updateRequest({ protobuf: $event })" />
              <p class="parameter-note" role="status">{{ protobufAssistance.status }}</p>
              <button class="ui-button" type="button" @click="emit('manage-protobuf')">Manage protobuf folders</button>
            </section>
            <label class="redirect-field" :for="`${editorId}-redirects`">
              <span>Redirects</span>
              <select class="ui-input" :id="`${editorId}-redirects`" :value="modelValue.redirectPolicy ?? 'never'"
                @change="updateRequest({ redirectPolicy: ($event.target as HTMLSelectElement).value as RequestData['redirectPolicy'] })">
                <option value="never">Do not follow (default)</option>
                <option value="same-origin">Follow within the same origin</option>
                <option value="follow">Follow across origins; remove credentials</option>
              </select>
              <span class="content-type-note">Following redirects never permits HTTPS to HTTP downgrades.</span>
            </label>
          </section>
        </div>
      </template>

      <template #second>
        <ResponseInspector :execution="execution" :class="{ 'compact-response': compactPane === 'second' }" />
      </template>
    </SplitPane>
  </div>
</template>

<style scoped>
.request-editor {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 18px;
  --body-editor-min-height: 0px;
  --body-editor-resize: none;
}

.request-heading {
  flex-shrink: 0;
  overflow: hidden;
  margin: 0 0 10px;
  font-size: 18px;
  font-weight: 550;
  letter-spacing: -.3px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.input-mode-summary { align-self: flex-start; margin: -4px 0 6px; font-size: 11px; }
.send-button { min-width: 64px; }

.send-button:disabled { cursor: wait; opacity: .65; }
.body-panels { flex: 1; min-height: 0; margin-top: 6px; }

.settings-pane, .settings-panel, .body-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.settings-pane { overflow: hidden; }
.settings-panel { padding: 8px 0 0; }
.scrollable-settings { overflow: auto; padding-right: 4px; }
.url-parameters { flex-shrink: 0; margin-bottom: 14px; min-width: 0; }
.url-parameters-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.url-parameters h3 { margin: 0; color: #b2bfd1; font-size: 12px; font-weight: 600; }
.parameter-note { flex-shrink: 0; margin: 6px 0 8px; color: var(--color-muted); font-size: 12px; line-height: 1.4; }
.url-parameters table { width: 100%; border-collapse: collapse; table-layout: fixed; text-align: left; font-size: 12px; }
.url-parameters th { color: var(--color-muted); font-weight: 500; }
.url-parameters th, .url-parameters td { padding: 6px 8px; vertical-align: top; overflow-wrap: anywhere; border-bottom: 1px solid var(--color-control-border); }
.url-parameters th:first-child { width: 38%; }
.url-parameter-table { min-width: 0; font-size: 12px; }
.url-parameter-row { display: grid; grid-template-columns: 38% minmax(0, 1fr); }
.url-parameter-row > * { min-width: 0; padding: 6px 8px; overflow-wrap: anywhere; border-bottom: 1px solid var(--color-control-border); }
.url-parameter-row > [role="columnheader"] { color: var(--color-muted); font-weight: 500; }
.parameter-empty { color: var(--color-muted); font-style: italic; }
.protobuf-settings { flex-shrink: 0; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--color-border); font-size: 12px; }
.protobuf-settings h3 { margin: 0; font-size: 14px; font-weight: 600; }
.protobuf-settings h3:focus { outline: 2px solid var(--color-focus); outline-offset: 3px; }
.protobuf-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; flex-shrink: 0; font-size: 12px; color: var(--color-muted); padding: 0 0 8px; overflow-wrap: anywhere; }
.protobuf-context { max-width: 100%; overflow-wrap: anywhere; text-align: left; font-size: 12px; }
.body-content { overflow: auto; }
.body-content > .body-text { flex: 1; min-height: 0; }

.settings-tabs {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  overflow-x: auto;
  padding: 2px 2px 4px;
  border-bottom: 1px solid var(--color-border);
}

.settings-tabs button {
  font-family: inherit;
  border-style: solid;
  border-width: 1px;
  cursor: pointer;
  flex-shrink: 0;
  padding: 8px 10px;
  color: var(--color-muted);
  background: transparent;
  border-color: transparent;
  border-radius: 4px;
  font-size: 13px;
}

.settings-tabs button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }


.settings-tabs [aria-selected="true"] {
  color: var(--color-text);
  background: var(--color-selected);
  box-shadow: inset 0 -2px var(--color-selected-border);
}

.empty-body {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--color-muted);
  font-size: 12px;
  padding-bottom: 8px;
}

/* Before the first send, the response is a quiet status row and the request
   editor uses the remaining height. The response expands for running/results. */
.compact-response { flex-direction: row; align-items: center; gap: 12px; padding-top: 8px; }
.compact-response :deep(.response-heading) { min-height: 0; padding: 0; }
.compact-response :deep(.response-placeholder) { align-items: flex-start; padding: 0; border: 0; text-align: left; }
.compact-response :deep(.response-placeholder p) { font-size: 12px; }

.content-type-select { width: 220px; max-width: 100%; padding: 5px 7px; font-size: 12px; }
.content-type-note { color: var(--color-muted); font-size: 12px; }
.timeout-field { display: flex; flex-direction: column; gap: 6px; max-width: 200px; font-size: 12px; }
.timeout-field input { min-width: 0; }
.input-mode-field { display: flex; flex-direction: column; gap: 6px; max-width: 420px; margin-top: 16px; font-size: 12px; }
.redirect-field { display: flex; flex-direction: column; gap: 6px; max-width: 370px; margin-top: 16px; font-size: 12px; }

@media (max-width: 600px), (max-height: 800px) {
  .request-editor { padding: 10px; }
  .request-heading { margin-bottom: 6px; font-size: 16px; }
}
</style>
