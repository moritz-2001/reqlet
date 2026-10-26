<!-- App owns persisted workspace data and execution lifetimes; components expose controlled edits and intents. -->
<script setup lang="ts">
import { KeepAlive, computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, useTemplateRef, watch } from "vue";
import ProtobufManager from "./components/ProtobufManager.vue";
import { loadProtobufSource, type ProtobufSourceState } from "./protobuf";
import CollectionManager from "./components/CollectionManager.vue";
import EnvironmentManager from "./components/EnvironmentManager.vue";
import HistoryPanel from "./components/HistoryPanel.vue";
import HistoryInspector from "./components/HistoryInspector.vue";
import ImportExport from "./components/ImportExport.vue";
import RequestEditor from "./components/RequestEditor.vue";
import QuickOpen from "./components/QuickOpen.vue";
import SplitPane from "./components/SplitPane.vue";
import Tabs from "./components/Tabs.vue";
import WorkspaceTools from "./components/WorkspaceTools.vue";
import type { TabPresentation, TabsHandle, TabsState } from "./components/tabs";
import type { SplitSizes } from "./components/splitPane";
import { executeHttp } from "./http";
import { prepareNextRequest } from "./prepareRequest";
import { copyHttpRequest } from "./requestSnapshot";
import { appendHistory, HISTORY_LIMIT } from "./history";
import { loadWorkspace, saveWorkspace } from "./workspace";
import type { WorkspaceLoadResult, WorkspaceRepository } from "./workspaceRepository";
import { createRequest } from "./request";
import {
  collectionFolders, collectionParentId, findCollectionNode, restoreCollectionEdit, restoreCollectionNode,
  type CollectionChange, type CollectionDeletion, type CollectionEditRecovery,
} from "./collections";
import type { ExecutionState, HistoryEntry, HttpRequest, RequestData } from "./request";

// Persistent tab identities reference workspace-owned definitions. History tabs
// retain independent snapshots so clearing the history list cannot alter inspection.
type WorkspaceTab =
  | { kind: "request"; requestId: string }
  | { kind: "history"; entry: HistoryEntry }
  | { kind: "draft"; draftId: string };

const props = defineProps<{
  /** Production loads durable storage before mounting; omission keeps legacy embedding supported. */
  initialWorkspace?: WorkspaceLoadResult;
  /** Owns queued asynchronous saves; omission uses the synchronous legacy storage contract. */
  repository?: WorkspaceRepository;
}>();
const loaded = props.initialWorkspace ?? loadWorkspace();
const workspace = reactive(loaded.workspace);
const storageError = ref(loaded.error ?? "");
const storagePending = ref(false);
// Only the most recently requested save may update the visible persistence result.
let storageGeneration = 0;
const executions = reactive<Record<string, ExecutionState>>({});
// Controllers belong to operations, never editor instances. Switching/closing tabs leaves requests running.
const operations = new Map<string, AbortController>();
const tabs = useTemplateRef<TabsHandle>("requestTabs");
const environmentManager = useTemplateRef<InstanceType<typeof EnvironmentManager>>("environmentManager");
const importExport = useTemplateRef<InstanceType<typeof ImportExport>>("importExport");
// Recovery remains available until dismissed or another clear replaces it. New
// executions are merged on Undo rather than overwritten by the removed snapshot.
const clearedHistory = ref<HistoryEntry[] | null>(null);
// One deletion is recoverable for this app lifetime. Its detached definitions and
// layout merge into current state; tab selection is restored only before a later user choice.
const deletedCollection = ref<{
  /** Removed definitions and original hierarchy position, detached from retained editors. */
  deletion: CollectionDeletion;
  /** Original strip snapshot; only deleted request identities are reopened from it. */
  tabs: TabsState;
  /** Pane preferences removed with the definitions, merged only where no newer value exists. */
  layouts: Record<string, SplitSizes>;
  /** Previous feedback; running exchanges become cancelled because Undo never restarts work. */
  executions: Record<string, ExecutionState>;
  /** Selection revision after automatic cleanup, compared on Undo to preserve later choices. */
  selectionRevision: number;
} | null>(null);
const collectionRecoveryError = ref("");
// A targeted inverse for the latest rename/move merges into current definitions;
// it never retains a workspace snapshot that could overwrite later editor work.
const editedCollection = ref<{
  /** Previous name or sibling anchors, replaced by the next effective organization change. */
  recovery: CollectionEditRecovery;
  /** Committed name and destination at the time of the change, announced even if search hides the entry. */
  message: string;
} | null>(null);
const collectionEditRecoveryError = ref("");
const backgroundCompletion = ref<HistoryEntry | null>(null);
const latestClosedDraft = computed(() => workspace.drafts[workspace.closedDraftIds[0]]);
const requestPanelId = `${useId()}-request-panel`;
const navigationId = `${useId()}-workspace-navigation`;
const sidebarView = ref<"collections" | "history">("collections");
const navigation = useTemplateRef<HTMLElement>("navigation");
const navigationToggle = useTemplateRef<HTMLButtonElement>("navigationToggle");
const navigationMedia = window.matchMedia?.("(max-width: 600px)");
const narrowViewport = ref(navigationMedia?.matches ?? false);
// The narrow navigation overlay is presentation state; hiding it keeps each
// view's search, expansion, and scroll state mounted without changing saved splits.
const navigationOpen = ref(false);
// Quick-open state is transient; opening a result reuses the same saved-request tab operation as the tree.
const quickOpen = ref(false);
// History selection is transient; saved requests and drafts both restore after reload.
const activeTabId = ref(workspace.activeTabId);
const workspaceTabs = reactive<Record<string, WorkspaceTab>>(Object.fromEntries(
  workspace.openTabIds.map(id => [id, workspace.drafts[id]
    ? { kind: "draft", draftId: id } : { kind: "request", requestId: id }]),
));
const activeTab = computed(() => activeTabId.value === null ? undefined : workspaceTabs[activeTabId.value]);
const activeRequestId = computed(() => activeTab.value?.kind === "request" ? activeTab.value.requestId : undefined);
const activeRequest = computed(() => activeRequestId.value === undefined ? undefined : workspace.requests[activeRequestId.value]);
const activeHistory = computed(() => activeTab.value?.kind === "history" ? activeTab.value.entry : undefined);
const activeDraft = computed(() => activeTab.value?.kind === "draft" ? workspace.drafts[activeTab.value.draftId] : undefined);
const activeEditorId = computed(() => activeRequest.value || activeDraft.value ? activeTabId.value ?? undefined : undefined);
const activeEditorRequest = computed(() => activeRequest.value ?? activeDraft.value?.request);
const activeEditorLayout = computed(() => activeRequestId.value !== undefined
  ? workspace.layout.requests[activeRequestId.value] : activeDraft.value?.layout);
const environment = computed(() => workspace.environments.find(item => item.id === workspace.activeEnvironmentId));
const initialTabs = workspace.openTabIds
  .map(id => ({ id, label: workspace.requests[id]?.name ?? `${workspace.drafts[id].request.name} · Unsaved`, closable: true }));
const initialActiveId = workspace.activeTabId;
// Tabs owns live ordering. The latest emitted copy supplies sibling anchors for
// deletion recovery without making opening or restoring a second source of truth.
let latestTabs: TabsState = { items: initialTabs, activeId: initialActiveId };
let selectionRevision = 0;
const tabPresentation = computed<Record<string, TabPresentation>>(() => Object.fromEntries(
  Object.entries(workspaceTabs).map(([id, tab]) => {
    const execution = tab.kind === "history" ? tab.entry.result : executions[id];
    return [id, {
      unsaved: tab.kind === "draft",
      execution: execution?.status === "success"
        ? { status: "success", httpStatus: execution.response.status }
        : execution && execution.status !== "idle" ? { status: execution.status } : undefined,
    }];
  }),
));

watch(workspace, () => {
  if (props.repository) {
    const generation = ++storageGeneration;
    storagePending.value = true;
    void props.repository.save(workspace).then(
      result => {
        if (generation !== storageGeneration) return;
        storagePending.value = false;
        storageError.value = result.warning ?? "";
      },
      error => {
        if (generation !== storageGeneration) return;
        storagePending.value = false;
        storageError.value = `Could not save workspace: ${errorMessage(error)}`;
      },
    );
    return;
  }
  try {
    saveWorkspace(workspace);
    storageError.value = "";
  } catch (error) {
    storageError.value = `Could not save workspace: ${errorMessage(error)}`;
  }
}, { deep: true });

// Start deferred writes before the webview is suspended. IndexedDB commits remain
// asynchronous; a forced process termination can still interrupt the latest batch.
function flushWorkspace() {
  void props.repository?.flush().catch(error => { storageError.value = `Could not save workspace: ${errorMessage(error)}`; });
}
function flushHiddenWorkspace() { if (document.visibilityState === "hidden") flushWorkspace(); }
onMounted(() => {
  window.addEventListener("pagehide", flushWorkspace);
  document.addEventListener("visibilitychange", flushHiddenWorkspace);
});
onBeforeUnmount(() => {
  window.removeEventListener("pagehide", flushWorkspace);
  document.removeEventListener("visibilitychange", flushHiddenWorkspace);
  flushWorkspace();
});

watch(() => Object.entries(workspace.requests).map(([id, request]) => [id, request.name]), () => {
  for (const [id, tab] of Object.entries(workspaceTabs)) {
    if (tab.kind !== "request") continue;
    const request = workspace.requests[id];
    if (request) tabs.value?.updateLabel(id, request.name);
    else tabs.value?.close(id);
  }
});

// Capture the shortcut before editor keymaps (macOS Ctrl+K otherwise deletes to the line end).
onMounted(() => {
  document.addEventListener("keydown", handleNavigationShortcut, true);
  navigationMedia?.addEventListener("change", updateNavigationViewport);
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", handleNavigationShortcut, true);
  navigationMedia?.removeEventListener("change", updateNavigationViewport);
  for (const controller of operations.values()) controller.abort();
});

async function toggleNavigation() {
  if (navigationOpen.value) {
    closeNavigation();
    return;
  }

  navigationOpen.value = true;
  await nextTick();
  navigation.value?.querySelector<HTMLButtonElement>('.sidebar-switcher [aria-pressed="true"]')?.focus();
}

function closeNavigation(focus: "toggle" | "workspace" = "toggle") {
  if (!narrowViewport.value || !navigationOpen.value) return;

  navigationOpen.value = false;
  void nextTick(() => {
    if (focus === "workspace") document.getElementById(requestPanelId)?.focus();
    else navigationToggle.value?.focus();
  });
}

function handleNavigationEscape(event: KeyboardEvent) {
  if (event.isComposing || !narrowViewport.value || !navigationOpen.value) return;

  event.preventDefault();
  event.stopPropagation();
  closeNavigation();
}

function updateNavigationViewport(event: MediaQueryListEvent) {
  const navigationFocused = navigation.value?.contains(document.activeElement);
  narrowViewport.value = event.matches;
  navigationOpen.value = false;
  if (event.matches && navigationFocused) void nextTick(() => navigationToggle.value?.focus());
}

function handleNavigationShortcut(event: KeyboardEvent) {
  if (event.isComposing || event.repeat || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
  if (event.key.toLowerCase() !== "k") return;

  event.preventDefault();
  event.stopPropagation();
  quickOpen.value = true;
}

function openWorkspaceTool(tool: "environments" | "protobuf" | "import-export") {
  if (tool === "environments") void environmentManager.value?.open();
  else if (tool === "protobuf") void protobufManager.value?.open();
  else void importExport.value?.open();
}

async function openQuickResult(id: string) {
  quickOpen.value = false;
  openRequest(id);
  await nextTick();
  document.getElementById(requestPanelId)?.focus();
}

function openRequest(id: string) {
  const request = workspace.requests[id];
  if (!request) return;

  workspaceTabs[id] = { kind: "request", requestId: id };
  tabs.value?.open({ id, label: request.name, closable: true });
  closeNavigation("workspace");
}

function inspectHistory(entry: HistoryEntry) {
  const existing = Object.entries(workspaceTabs).find(([, tab]) => tab.kind === "history" && tab.entry.id === entry.id);
  const id = existing?.[0] ?? `history-${crypto.randomUUID()}`;
  if (!existing) workspaceTabs[id] = { kind: "history", entry: captureHistory(entry) };
  tabs.value?.open({ id, label: `${entry.name} · History`, closable: true });
  closeNavigation("workspace");
}

function updateTabs(state: TabsState) {
  if (state.activeId !== latestTabs.activeId) selectionRevision += 1;
  latestTabs = state;
  activeTabId.value = state.activeId;
  const openIds = new Set(state.items.map(item => item.id));
  for (const id of Object.keys(workspaceTabs)) {
    if (!openIds.has(id)) {
      if (workspaceTabs[id]?.kind === "draft") {
        workspace.closedDraftIds = [id, ...workspace.closedDraftIds.filter(previous => previous !== id)];
      }
      delete workspaceTabs[id];
    }
  }

  workspace.openTabIds = state.items.flatMap(item => {
    const tab = workspaceTabs[item.id];
    return tab?.kind === "request" || tab?.kind === "draft" ? [item.id] : [];
  });
  // Inspecting history keeps the last persistent tab as the reload target.
  const persistentSelection = activeTabId.value !== null && workspace.openTabIds.includes(activeTabId.value)
    ? activeTabId.value : undefined;
  workspace.activeTabId = persistentSelection ?? (
    workspace.activeTabId !== null && workspace.openTabIds.includes(workspace.activeTabId)
      ? workspace.activeTabId
      : workspace.openTabIds[0] ?? null
  );
}

const protobufManager = useTemplateRef<InstanceType<typeof ProtobufManager>>("protobufManager");
const protobufStates = reactive<Record<string, ProtobufSourceState>>({});
const protobufGenerations = new Map<string, number>();
const protobufUsage = computed(() => {
  const counts: Record<string, number> = {};
  for (const request of [...Object.values(workspace.requests), ...Object.values(workspace.drafts).map(draft => draft.request)]) {
    if (request.protobuf) counts[request.protobuf.sourceId] = (counts[request.protobuf.sourceId] ?? 0) + 1;
  }
  return counts;
});
async function reloadProtobuf(id: string) {
  const source = workspace.protobufSources?.find(s => s.id === id);
  if (!source) return;
  const generation = (protobufGenerations.get(id) ?? 0) + 1;
  protobufGenerations.set(id, generation);
  const previous = protobufStates[id]?.catalog;
  protobufStates[id] = { loading: true, catalog: previous };
  try {
    const catalog = await loadProtobufSource(source);
    if (protobufGenerations.get(id) === generation) protobufStates[id] = { catalog, loading: false };
  } catch (error) {
    if (protobufGenerations.get(id) === generation) protobufStates[id] = { catalog: previous, loading: false, error: `${previous ? 'Using stale models. ' : ''}${String(error)}` };
  }
}
watch(() => workspace.protobufSources ?? [], (sources, old = []) => {
  for (const source of sources) {
    const before = old.find(s => s.id === source.id);
    if (!before || before.rootPath !== source.rootPath || JSON.stringify(before.includePaths) !== JSON.stringify(source.includePaths)) {
      delete protobufStates[source.id];
      void reloadProtobuf(source.id);
    }
  }
  for (const source of old) if (!sources.some(s => s.id === source.id)) {
    protobufGenerations.set(source.id, (protobufGenerations.get(source.id) ?? 0) + 1);
    delete protobufStates[source.id];
  }
}, { immediate: true });

function updateRequest(id: string, request: RequestData) {
  const draft = workspace.drafts[id];
  if (draft) {
    if (draft.capturedRequest) {
      const { protobuf: previousBinding, body: previousBody, ...previousInputs } = draft.request;
      const { protobuf: nextBinding, body: nextBody, ...nextInputs } = request;
      // Immutable body identity changes on a text edit. Comparing it separately
      // avoids serializing a large captured body merely to leave replay mode.
      if (previousBody !== nextBody || JSON.stringify(previousInputs) !== JSON.stringify(nextInputs)) delete draft.capturedRequest;
    }
    draft.request = request;
    tabs.value?.updateLabel(id, `${request.name} · Unsaved`);
  } else if (workspace.requests[id]) workspace.requests[id] = request;
}

function updateLayout(id: string, layout: SplitSizes) {
  const draft = workspace.drafts[id];
  if (draft) draft.layout = layout;
  else if (workspace.requests[id]) workspace.layout.requests[id] = layout;
}

function requestEditorEvents(id: string) {
  // Cached editors may finish an update after selection changes; capture their identity here.
  return {
    "update:modelValue": (request: RequestData) => updateRequest(id, request),
    "update:layout": (layout: SplitSizes) => updateLayout(id, layout),
    send: () => sendRequest(id),
    cancel: () => operations.get(id)?.abort(),
    "edit-environment": () => environmentManager.value?.open(),
  };
}

function deleteRequest(id: string) {
  operations.get(id)?.abort();
  tabs.value?.close(id);
  delete workspace.layout.requests[id];
  delete executions[id];
}

function captureCollectionDeletion(deletion: CollectionDeletion) {
  const ids = Object.keys(deletion.requests);
  const recovery = {
    deletion,
    tabs: latestTabs,
    layouts: Object.fromEntries(ids.filter(id => workspace.layout.requests[id]).map(id => [id, { ...workspace.layout.requests[id] }])),
    executions: Object.fromEntries(ids.filter(id => executions[id]).map(id => [id,
      executions[id].status === "running" ? { status: "cancelled" } as ExecutionState : executions[id],
    ])),
    selectionRevision,
  };
  // Capture the whole group before closing its first tab, while definitions and
  // the original tab strip are still available to deletion recovery.
  for (const id of ids) deleteRequest(id);
  recovery.selectionRevision = selectionRevision;
  deletedCollection.value = recovery;
  collectionRecoveryError.value = "";
}

function applyCollectionChange(change: CollectionChange) {
  if (change.deletion) captureCollectionDeletion(change.deletion);
  else for (const id of change.deletedRequestIds) deleteRequest(id);

  if (editedCollection.value && !findCollectionNode(change.nodes, editedCollection.value.recovery.id)) {
    dismissCollectionEditRecovery();
  }

  // A manager commit replaces hierarchy and canonical definitions in the same
  // owner operation; reactive consumers observe the complete change together.
  if (workspace.requests !== change.requests) workspace.requests = change.requests;
  if (workspace.collection !== change.nodes) workspace.collection = [...change.nodes];
  if (change.recovery) {
    const entry = findCollectionNode(change.nodes, change.recovery.id);
    const name = entry?.kind === "request" ? change.requests[entry.id]?.name ?? entry.name : entry?.name;
    const parentId = collectionParentId(change.nodes, change.recovery.id);
    const location = collectionFolders(change.nodes).find(folder => folder.id === parentId)?.path ?? "Collection root";
    editedCollection.value = {
      recovery: change.recovery,
      message: `${change.recovery.kind === "rename" ? "Renamed" : "Moved"} “${name}” · ${location}`,
    };
    collectionEditRecoveryError.value = "";
  }
}

function undoCollectionEdit() {
  const recovery = editedCollection.value?.recovery;
  if (!recovery) return;

  try {
    const restored = restoreCollectionEdit({ requests: workspace.requests, nodes: workspace.collection }, recovery);
    applyCollectionChange(restored);
    dismissCollectionEditRecovery();
  } catch (error) {
    collectionEditRecoveryError.value = `Undo is unavailable. ${errorMessage(error)}`;
  }
}

function dismissCollectionEditRecovery() {
  editedCollection.value = null;
  collectionEditRecoveryError.value = "";
}

function undoCollectionDeletion() {
  const recovery = deletedCollection.value;
  if (!recovery) return;

  try {
    const ids = Object.keys(recovery.deletion.requests);
    if (ids.some(id => workspace.drafts[id])) throw new Error("Cannot undo deletion because a recovered identity is already in use.");
    const restored = restoreCollectionNode({ requests: workspace.requests, nodes: workspace.collection }, recovery.deletion);
    workspace.requests = restored.requests;
    workspace.collection = [...restored.nodes];
    for (const [id, layout] of Object.entries(recovery.layouts)) {
      if (!workspace.layout.requests[id]) workspace.layout.requests[id] = layout;
    }
    for (const [id, execution] of Object.entries(recovery.executions)) {
      if (!executions[id]) executions[id] = execution;
    }
    const closedTabs = recovery.tabs.items.filter(item => ids.includes(item.id));
    for (const item of closedTabs) workspaceTabs[item.id] = { kind: "request", requestId: item.id };
    const previousActive = recovery.tabs.activeId;
    const restoreActive = recovery.selectionRevision === selectionRevision && previousActive !== null && ids.includes(previousActive)
      ? previousActive : undefined;
    tabs.value?.restore(recovery.tabs, closedTabs.map(item => item.id), restoreActive);
    deletedCollection.value = null;
    collectionRecoveryError.value = "";
  } catch (error) {
    collectionRecoveryError.value = errorMessage(error);
  }
}

function sendRequest(id: string) {
  if (operations.has(id)) return;

  try {
    const draft = workspace.drafts[id];
    const request = draft?.request ?? workspace.requests[id];
    if (!request) return;
    const prepared = prepareNextRequest(request, environment.value, draft?.capturedRequest);
    void runRequest(id, request.name, prepared);
  } catch (error) {
    executions[id] = { status: "error", error: errorMessage(error) };
  }
}

async function runRequest(id: string, name: string, prepared: HttpRequest) {
  if (operations.has(id)) return;

  // Capture resolved inputs now: later draft or environment edits cannot change this exchange or its history.
  const snapshot = copyHttpRequest(prepared);
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  operations.set(id, controller);
  executions[id] = { status: "running", startedAt };
  let result: HistoryEntry["result"];
  try {
    const response = await executeHttp(snapshot, controller.signal);
    result = controller.signal.aborted ? { status: "cancelled" } : { status: "success", response };
  } catch (error) {
    result = controller.signal.aborted || (error instanceof Error && error.name === "AbortError")
      ? { status: "cancelled" }
      : { status: "error", error: errorMessage(error) };
  } finally {
    operations.delete(id);
  }

  if (workspace.requests[id] || workspace.drafts[id]) executions[id] = result;
  const entry: HistoryEntry = { id: crypto.randomUUID(), requestId: id, name, startedAt, request: snapshot, result };
  workspace.history = appendHistory(workspace.history, entry);
  if (!workspaceTabs[id]) backgroundCompletion.value = entry;
}

function openHistoryDraft(entry: HistoryEntry): string {
  // Captured authentication already lives in headers and parameters in the URL.
  // Do not reapply either, or share mutable inputs with the read-only history tab.
  const id = crypto.randomUUID();
  const request: RequestData = {
    ...createRequest(entry.name), inputMode: "literal", method: entry.request.method, path: entry.request.url,
    body: entry.request.body, headers: entry.request.headers.map(header => ({ ...header, enabled: true })),
    contentType: entry.request.headers.find(header => header.name.toLowerCase() === "content-type")?.value ?? "text/plain",
    timeoutMs: entry.request.timeoutMs,
    ...(entry.request.redirectPolicy === undefined ? {} : { redirectPolicy: entry.request.redirectPolicy }),
    ...(entry.request.sensitiveHeaderNames === undefined ? {} : { sensitiveHeaderNames: [...entry.request.sensitiveHeaderNames] }),
  };
  workspace.drafts[id] = {
    request, capturedRequest: copyHttpRequest(entry.request),
  };
  workspaceTabs[id] = { kind: "draft", draftId: id };
  tabs.value?.open({ id, label: `${entry.name} · Unsaved`, closable: true });
  return id;
}

function replayHistory(entry: HistoryEntry) {
  const id = openHistoryDraft(entry);
  void runRequest(id, entry.name, entry.request);
}

function saveDraft(id: string) {
  const draft = workspace.drafts[id];
  if (!draft) return;

  // Keep this identity so cached editor state and any in-flight operation survive saving.
  const request = draft.request;
  workspace.requests[id] = request;
  workspace.collection = [...workspace.collection, { kind: "request", id, name: request.name, requestType: request.method }];
  if (draft.layout) workspace.layout.requests[id] = draft.layout;
  workspaceTabs[id] = { kind: "request", requestId: id };
  delete workspace.drafts[id];
  workspace.closedDraftIds = workspace.closedDraftIds.filter(closedId => closedId !== id);
  tabs.value?.open({ id, label: request.name, closable: true });
}

function reopenClosedDraft() {
  const id = workspace.closedDraftIds[0];
  const draft = workspace.drafts[id];
  if (!draft) return;

  workspace.closedDraftIds = workspace.closedDraftIds.filter(closedId => closedId !== id);
  workspaceTabs[id] = { kind: "draft", draftId: id };
  tabs.value?.open({ id, label: `${draft.request.name} · Unsaved`, closable: true });
  closeNavigation("workspace");
}

function clearHistory() {
  clearedHistory.value = workspace.history;
  workspace.history = [];
}

function undoClearHistory() {
  if (!clearedHistory.value) return;

  const entries = new Map(workspace.history.map(entry => [entry.id, entry]));
  for (const entry of clearedHistory.value) {
    if (!entries.has(entry.id)) entries.set(entry.id, entry);
  }
  workspace.history = [...entries.values()]
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, HISTORY_LIMIT);
  clearedHistory.value = null;
}

function inspectBackgroundCompletion() {
  if (!backgroundCompletion.value) return;
  inspectHistory(backgroundCompletion.value);
  backgroundCompletion.value = null;
}

function executionLabel(entry: HistoryEntry): string {
  return entry.result.status === "success"
    ? `${entry.result.response.status} ${entry.result.response.statusText}`.trim()
    : entry.result.status === "error" ? "Failed" : "Cancelled";
}

function importCollection(imported: import("./interchange").CollectionImport) {
  // ImportExport remaps IDs before emitting, so importing never overwrites existing definitions.
  workspace.requests = { ...workspace.requests, ...imported.requests };
  workspace.collection = [...workspace.collection, ...imported.collection];
  if (imported.protobufSources) workspace.protobufSources = [...(workspace.protobufSources ?? []), ...imported.protobufSources];
  const firstId = Object.keys(imported.requests)[0];
  if (firstId) openRequest(firstId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function captureHistory(entry: HistoryEntry): HistoryEntry {
  return {
    ...entry,
    request: copyHttpRequest(entry.request),
    result: entry.result.status === "success"
      ? { ...entry.result, response: { ...entry.result.response, headers: entry.result.response.headers.map(header => ({ ...header })) } }
      : { ...entry.result },
  };
}
</script>

<template>
  <main class="layout">
    <header class="app-header">
      <div class="app-brand"><span class="brand-mark" aria-hidden="true">↗</span><span class="app-brand-name">Reqlet</span></div>
      <button v-if="narrowViewport" ref="navigationToggle" type="button" class="ui-button navigation-toggle"
        :aria-controls="navigationId" :aria-expanded="navigationOpen" @click="toggleNavigation">Navigation</button>
      <button type="button" class="ui-button quick-open-button" title="Quick open (⌘/Ctrl+K)" @click="quickOpen = true">Quick open <kbd>⌘/Ctrl K</kbd></button>
      <EnvironmentManager
        ref="environmentManager"
        hide-trigger
        :environments="workspace.environments"
        :active-environment-id="workspace.activeEnvironmentId"
        @update:environments="workspace.environments = $event"
        @update:active-environment-id="workspace.activeEnvironmentId = $event"
      />
      <WorkspaceTools @select="openWorkspaceTool" />
    </header>

    <SplitPane
      class="app-content"
      :class="{ 'navigation-open': navigationOpen }"
      label="Resize collections sidebar"
      :initial-size="248"
      :min-first="160"
      :max-first="480"
      :min-second="320"
      :stack-at="600"
      :sizes="workspace.layout.sidebar"
      @update:sizes="workspace.layout.sidebar = $event"
    >
      <template #first>
        <aside v-show="!narrowViewport || navigationOpen" :id="navigationId" ref="navigation" class="collection-sidebar"
          aria-label="Workspace navigation" @keydown.esc="handleNavigationEscape">
          <div v-if="narrowViewport" class="navigation-heading">
            <strong>Workspace</strong>
            <button class="ui-button ui-button--subtle" type="button" aria-label="Close navigation" @click="closeNavigation()">×</button>
          </div>
          <div class="sidebar-switcher" role="group" aria-label="Sidebar view">
            <button class="ui-button" type="button" :aria-pressed="sidebarView === 'collections'" @click="sidebarView = 'collections'">Collections</button>
            <button class="ui-button" type="button" :aria-pressed="sidebarView === 'history'" @click="sidebarView = 'history'">History</button>
          </div>
          <button v-if="latestClosedDraft" type="button" class="ui-button reopen-draft"
            :title="`Reopen ${latestClosedDraft.request.name} (${workspace.closedDraftIds.length} recoverable drafts)`"
            @click="reopenClosedDraft">Reopen closed draft</button>
          <div v-show="sidebarView === 'collections'" class="sidebar-view">
            <CollectionManager
              :requests="workspace.requests"
              :nodes="workspace.collection"
              :selected-request-id="activeRequestId ?? null"
              :interaction-enabled="sidebarView === 'collections' && (!narrowViewport || navigationOpen)"
              @change="applyCollectionChange"
              @select-request="openRequest"
            />
          </div>
          <div v-show="sidebarView === 'history'" class="sidebar-view">
            <HistoryPanel
              :entries="workspace.history"
              :selected-entry-id="activeHistory?.id"
              @inspect="inspectHistory"
              @clear="clearHistory"
            />
          </div>
        </aside>
      </template>

      <template #second>
        <button v-if="narrowViewport && navigationOpen" class="navigation-backdrop" type="button" tabindex="-1"
          aria-label="Dismiss navigation" @click="closeNavigation()" />
        <section class="workspace" aria-label="Request workspace" :inert="narrowViewport && navigationOpen ? true : undefined">
          <Tabs
            ref="requestTabs"
            label="Open workspace tabs"
            :panel-id="requestPanelId"
            :presentation="tabPresentation"
            :initial-items="initialTabs"
            :initial-active-id="initialActiveId"
            reorderable
            @active-change="activeTabId = $event"
            @state-change="updateTabs"
          />
          <section
            :id="requestPanelId"
            class="request-panel"
            role="tabpanel"
            :aria-label="activeHistory ? `${activeHistory.name} · History` : activeEditorRequest?.name ?? 'Request editor'"
            :hidden="!activeEditorRequest && !activeHistory"
            tabindex="0"
          >
            <KeepAlive :max="30">
              <RequestEditor
                v-if="activeEditorRequest && activeEditorId !== undefined"
                :key="activeEditorId"
                :model-value="activeEditorRequest"
                :environment="environment"
                :protobuf-sources="workspace.protobufSources ?? []"
                :protobuf-states="protobufStates"
                @manage-protobuf="protobufManager?.open()"
                :captured-request="activeDraft?.capturedRequest"
                :execution="executions[activeEditorId]"
                :layout="activeEditorLayout"
                v-on="requestEditorEvents(activeEditorId)"
              >
                <template #request-status>
                  <div v-if="activeDraft && activeEditorId !== undefined" class="draft-status">
                    <span><strong>Unsaved draft</strong> · Autosaved locally. Recoverable after closing or reload.
                      {{ activeDraft.capturedRequest ? 'Captured inputs; environment is not applied.' : activeDraft.request.inputMode === 'literal' ? 'Literal inputs; select Environment template in Advanced to use variables.' : 'Edits use the active environment.' }}
                    </span>
                    <button class="ui-button" type="button" @click="saveDraft(activeEditorId)">Save to Collections</button>
                  </div>
                </template>
              </RequestEditor>
            </KeepAlive>
            <HistoryInspector v-if="activeHistory" :key="activeHistory.id" :entry="activeHistory">
              <template #actions>
                <div class="history-actions">
                  <button class="ui-button" type="button" title="Edit a copy without sending it" @click="openHistoryDraft(activeHistory)">Open as draft</button>
                  <button class="ui-button" type="button" title="Send the captured request and credentials immediately" @click="replayHistory(activeHistory)">Send again</button>
                </div>
              </template>
            </HistoryInspector>
          </section>
          <div v-if="!activeEditorRequest && !activeHistory" class="empty-workspace" role="status">
            <span class="empty-icon" aria-hidden="true">{ }</span>
            <h1>A little space to build.</h1>
            <p>Select a request from Collections to open a tab.</p>
            <span class="empty-hint">Create a request, choose an environment, and send.</span>
          </div>
        </section>
      </template>
    </SplitPane>

    <div class="workspace-notices" aria-label="Workspace notifications">
      <div v-if="editedCollection" class="workspace-notice" role="status">
        <span>{{ editedCollection.message }}</span>
        <button class="ui-button" type="button" @click="undoCollectionEdit">Undo collection edit</button>
        <button class="ui-button" type="button" aria-label="Dismiss collection edit recovery" @click="dismissCollectionEditRecovery">×</button>
        <span v-if="collectionEditRecoveryError" role="alert">{{ collectionEditRecoveryError }}</span>
      </div>
      <div v-if="deletedCollection" class="workspace-notice" role="status">
        <span>Deleted “{{ deletedCollection.deletion.node.kind === 'request' ? deletedCollection.deletion.requests[deletedCollection.deletion.node.id]?.name : deletedCollection.deletion.node.name }}” ·
          {{ Object.keys(deletedCollection.deletion.requests).length }} {{ Object.keys(deletedCollection.deletion.requests).length === 1 ? 'request' : 'requests' }} removed.</span>
        <button class="ui-button" type="button" @click="undoCollectionDeletion">Undo collection deletion</button>
        <button class="ui-button" type="button" aria-label="Dismiss collection recovery" @click="deletedCollection = null">×</button>
        <span v-if="collectionRecoveryError" role="alert">{{ collectionRecoveryError }}</span>
      </div>
      <div v-if="clearedHistory" class="workspace-notice" role="status">
        <span>Cleared {{ clearedHistory.length }} executions.</span>
        <button class="ui-button" type="button" @click="undoClearHistory">Undo clear history</button>
        <button class="ui-button" type="button" aria-label="Dismiss history recovery" @click="clearedHistory = null">×</button>
      </div>
      <div v-if="backgroundCompletion" class="workspace-notice" role="status">
        <span>{{ backgroundCompletion.name }} · {{ executionLabel(backgroundCompletion) }}</span>
        <button class="ui-button" type="button" @click="inspectBackgroundCompletion">Show response</button>
        <button class="ui-button" type="button" aria-label="Dismiss completed request" @click="backgroundCompletion = null">×</button>
      </div>
    </div>
    <footer class="app-status">
      <span role="status" :class="{ 'storage-error': storageError }">{{ storageError || (storagePending ? 'Saving workspace…' : 'Workspace saved locally · Credentials and history included') }}</span>
      <span>{{ tabs?.count ?? 0 }} {{ tabs?.count === 1 ? 'tab' : 'tabs' }} open</span>
    </footer>
  </main>
  <ProtobufManager ref="protobufManager" hide-trigger :sources="workspace.protobufSources ?? []" :states="protobufStates" :usage="protobufUsage" @update:sources="workspace.protobufSources = $event" @reload="reloadProtobuf" />
  <ImportExport
    ref="importExport"
    hide-trigger
    :protobuf-sources="workspace.protobufSources ?? []"
    :requests="workspace.requests"
    :nodes="workspace.collection"
    :active-request="activeEditorRequest"
    :captured-request="activeDraft?.capturedRequest"
    :environment="environment"
    @import="importCollection"
  />
  <QuickOpen
    v-if="quickOpen"
    :nodes="workspace.collection"
    :requests="workspace.requests"
    @select-request="openQuickResult"
    @close="quickOpen = false"
  />
</template>

<style>
.layout {
  --app-header-height: 52px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: var(--app-header-height) minmax(0, 1fr) 30px;
  grid-template-areas: "header" "content" "status";
  width: 100%;
  height: 100dvh;
  overflow: hidden;
}

.app-content {
  grid-area: content;
  /* Drawer layers stay inside the content area, below header menus and managers. */
  position: relative;
  z-index: 0;
}

.app-header {
  grid-area: header;
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  min-width: 0;
  position: relative;
  z-index: 10;
  border-bottom: 1px solid var(--color-border);
  background: #101620;
}

.app-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -.3px;
  white-space: nowrap;
}

.app-header > .environment-manager { justify-self: end; max-width: 100%; }

.quick-open-button { white-space: nowrap; }
.quick-open-button kbd { margin-left: 8px; color: var(--color-muted); font: inherit; font-size: 10px; }

@media (max-width: 800px) { .quick-open-button kbd { display: none; } }

.brand-mark {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid #8baaff40;
  border-radius: 7px;
  color: #b5c9ff;
  background: #8baaff12;
  font-size: 20px;
}

.workspace-label {
  padding-left: 24px;
  border-left: 1px solid var(--color-border);
  color: var(--color-muted);
  font-size: 12px;
}

.preview-badge {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  color: #b2bfd1;
  font-size: 11px;
}

.status-dot {
  display: inline-block;
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #9fe3bc;
}

.collection-sidebar {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  background: #0e151f;
  overflow: hidden;
}

/* Each mounted view owns its scrollport, so hiding its sibling retains both
   position and local search/expansion state without duplicating navigation data. */
.sidebar-view { flex: 1; min-height: 0; overflow: auto; }
.sidebar-view > .history-panel { height: 100%; }
.sidebar-switcher { flex-shrink: 0; }
.reopen-draft { flex-shrink: 0; margin: 8px 12px 0; }
.navigation-heading { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px 0; font-size: 13px; }
.navigation-heading button { padding: 3px 9px; font-size: 20px; line-height: 1; }

.sidebar-switcher {
  display: flex;
  gap: 6px;
  padding: 10px;
  border-bottom: 1px solid var(--color-border);
}

.sidebar-switcher button { flex: 1; color: var(--color-muted); background: transparent; }

.sidebar-switcher button[aria-pressed="true"] {
  color: var(--color-text);
  background: var(--color-selected);
  border-color: var(--color-selected-border);
}

.storage-error { color: var(--color-danger); }

.draft-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--color-muted);
  font-size: 11px;
  line-height: 1.4;
}

.draft-status strong { color: #edcf91; }

.history-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.draft-status button, .history-actions button, .reopen-draft, .workspace-notice button { flex-shrink: 0; }

.workspace-notices {
  position: fixed;
  right: 18px;
  bottom: 44px;
  z-index: 40;
  display: grid;
  gap: 8px;
  max-width: min(520px, calc(100vw - 36px));
}
.workspace-notice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #445875;
  border-radius: 8px;
  background: #182334;
  box-shadow: 0 4px 20px #0006;
  font-size: 12px;
}
.workspace-notice span { flex: 1; overflow-wrap: anywhere; }

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 48px;
  padding: 0 18px;
}

.sidebar-heading {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}

.sidebar-caption {
  color: var(--color-muted);
  font-size: 10px;
}

.collection-navigation {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 10px 16px;
}

.sidebar-note {
  margin: 0;
  padding: 16px 18px;
  border-top: 1px solid var(--color-border);
  color: var(--color-muted);
  font-size: 11px;
}

.workspace {
  display: grid;
  flex: 1;
  grid-template-rows: 44px minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.request-panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* The empty shared panel remains hidden while KeepAlive retains deactivated editors. */
.request-panel:not([hidden]) {
  display: flex;
}

.request-panel:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: -2px;
}

.empty-workspace {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 0;
  overflow: auto;
  padding: 24px;
  text-align: center;
  color: var(--color-muted);
  line-height: 1.6;
}

.empty-icon {
  margin-bottom: 16px;
  color: var(--color-focus);
  font: 28px "SFMono-Regular", Consolas, monospace;
}

.empty-workspace h1 {
  margin: 0 0 8px;
  color: var(--color-text);
  font-size: 20px;
  font-weight: 550;
  letter-spacing: -.4px;
}

.empty-workspace p {
  margin: 0;
}

.empty-hint {
  max-width: 300px;
  margin-top: 14px;
  font-size: 11px;
}

.app-status {
  grid-area: status;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px;
  border-top: 1px solid var(--color-border);
  background: #101620;
  color: var(--color-muted);
  font-size: 10px;
}

.app-status > span:first-child {
  display: flex;
  align-items: center;
  gap: 7px;
}

@media (max-width: 600px) {
  .layout { --app-header-height: 88px; }
  .app-header {
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    grid-template-rows: 30px 30px;
    gap: 8px;
    padding: 8px 12px;
  }

  .app-header > .environment-manager {
    grid-column: 1 / -1;
    grid-row: 2;
    justify-self: stretch;
  }

  .layout > .app-content.split-pane { position: relative; display: block; overflow: hidden; }
  .layout > .app-content > .split-divider { display: none; }
  .app-content > .split-region:first-child {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 21;
    display: none;
    width: min(320px, calc(100% - 48px));
    border-right: 1px solid var(--color-border);
    box-shadow: 8px 0 24px #0006;
  }
  .app-content.navigation-open > .split-region:first-child { display: flex; }
  .app-content > .split-region:last-child { height: 100%; }
  .navigation-backdrop {
    position: absolute;
    inset: 0;
    z-index: 20;
    padding: 0;
    border: 0;
    background: #0008;
    cursor: pointer;
  }

  .workspace-label, .sidebar-note { display: none; }

  .sidebar-header {
    min-height: 36px;
  }

  .collection-navigation {
    padding-bottom: 8px;
  }

  .app-status {
    padding: 0 10px;
  }
}

@media (max-width: 400px) {
  .app-header { column-gap: 6px; padding-inline: 10px; }
  .app-brand-name { display: none; }
}
</style>
