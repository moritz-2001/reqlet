<!-- CollectionManager owns collection interaction state and emits atomic changes to its workspace owner. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, useTemplateRef, watch } from "vue";
import CollectionTree from "./CollectionTree.vue";
import CollectionMoveDialog from "./CollectionMoveDialog.vue";
import type { CollectionNode } from "./collectionTree";
import type { RequestData } from "../request";
import { filterCollectionRequests, indexCollectionRequests } from "../navigationSearch";
import { useCollectionReordering } from "./useCollectionReordering";
import {
  collectionFolders, collectionParentId, collectionRequestIds, collectionSiblingPlacement,
  createCollectionNode, deleteCollectionNode, duplicateCollectionNode, findCollectionNode,
  moveCollectionNode, renameCollectionNode, type CollectionChange, type CollectionPlacement,
} from "../collections";

const props = withDefaults(defineProps<{
  /** Canonical definitions; this component emits replacements instead of mutating them. */
  requests: Record<string, RequestData>;
  /** Parent-owned hierarchy in persisted sidebar order. */
  nodes: readonly CollectionNode[];
  /** Active editor identity, independent of the entry being managed. */
  selectedRequestId?: string | null;
  /** False while the navigation surface is hidden; cancels gestures and transient editors. */
  interactionEnabled?: boolean;
}>(), { interactionEnabled: true });
const emit = defineEmits<{
  /** One validated replacement; the owner performs deletion cleanup before committing both values. */
  change: [change: CollectionChange];
  /** Explicit request opening, including newly created/duplicated requests. */
  "select-request": [id: string];
}>();

type Action = "create-request" | "create-folder" | "rename" | "duplicate" | "move" | "delete";
const root = ref<HTMLElement>();
const tree = useTemplateRef<InstanceType<typeof CollectionTree>>("tree");
// One menu serves every recursive row, independently of the active editor.
const menu = shallowRef<{ targetId: string | null; trigger: HTMLElement; left: number; top: number } | null>(null);
const menuElement = useTemplateRef<HTMLElement>("menuElement");
// A captured ID prevents tab changes from retargeting an uncommitted edit.
const pending = ref<{ action: Action; targetId: string | null } | null>(null);
const managedId = ref<string | null>(props.selectedRequestId ?? null);
const name = ref("");
const parentId = ref("");
const error = ref("");
const announcement = ref("");
const formElement = useTemplateRef<HTMLFormElement>("formElement");
const nameInput = useTemplateRef<HTMLInputElement>("nameInput");
// Return to the initiating control when possible; cross-parent moves resolve its replacement by ID.
let formTrigger: HTMLElement | null = null;
const searchId = `${useId()}-collection-search`;
const search = ref("");
// Cleared with every query change; manual search folds never overwrite normal browsing choices.
const searchCollapsedFolderIds = ref<ReadonlySet<string>>(new Set());
watch(search, () => { searchCollapsedFolderIds.value = new Set(); }, { flush: "sync" });
const searchInput = useTemplateRef<HTMLInputElement>("searchInput");
// Shared by recursive branches so moving a folder preserves expansion below it.
const expandedFolderIds = ref<ReadonlySet<string>>(new Set());
const searchEntries = computed(() => indexCollectionRequests(props.nodes, props.requests));
const matchingEntries = computed(() => filterCollectionRequests(searchEntries.value, search.value));
const matchingIds = computed(() => matchingEntries.value.map(entry => entry.id));
const matchingRequestIds = computed(() => search.value.trim() ? new Set(matchingIds.value) : undefined);
const matchingFolderIds = computed(() => search.value.trim()
  ? new Set(matchingEntries.value.flatMap(entry => entry.ancestorFolderIds)) : undefined);
const managedNode = computed(() => managedId.value ? findCollectionNode(props.nodes, managedId.value) : undefined);
const targetNode = computed(() => pending.value?.targetId ? findCollectionNode(props.nodes, pending.value.targetId) : undefined);
const targetName = computed(() => displayName(targetNode.value));
const affectedRequests = computed(() => targetNode.value ? collectionRequestIds(targetNode.value).length : 0);
const menuNode = computed(() => menu.value?.targetId ? findCollectionNode(props.nodes, menu.value.targetId) : undefined);
const folders = computed(() => collectionFolders(props.nodes).filter(folder => {
  const target = targetNode.value;
  return pending.value?.action !== "move" || !target || (
    folder.id !== target.id && (target.kind !== "folder" || !findCollectionNode(target.children, folder.id))
  );
}));
const actionTitle = computed(() => {
  const action = pending.value?.action;
  if (!action) return "";
  if (action === "create-request") return "Create request";
  if (action === "create-folder") return "Create folder";
  return `${action.charAt(0).toUpperCase()}${action.slice(1)} ${targetNode.value?.kind ?? "entry"}`;
});
const positionalMovesEnabled = computed(() => props.interactionEnabled && !search.value.trim());
const reordering = useCollectionReordering({
  root,
  nodes: computed(() => props.nodes),
  enabled: computed(() => positionalMovesEnabled.value && !pending.value && !menu.value),
  expandedFolderIds,
  commit: (id, placement) => moveEntry(id, placement),
});
const displayedExpansion = computed(() => new Set([...expandedFolderIds.value, ...reordering.hoverExpandedIds.value]));

watch(() => props.selectedRequestId, id => {
  if (id) {
    managedId.value = id;
    reveal(id);
  }
}, { immediate: true });
watch(() => props.nodes, () => {
  const target = pending.value?.targetId;
  if (target && !findCollectionNode(props.nodes, target)) {
    const ownedFocus = ownsFocus();
    pending.value = null;
    announcement.value = "This collection entry no longer exists.";
    if (ownedFocus) void nextTick(() => {
      if (document.activeElement === document.body) searchInput.value?.focus();
    });
  }
  if (menu.value?.targetId && !findCollectionNode(props.nodes, menu.value.targetId)) dismissMenu();
}, { flush: "sync" });
watch(() => props.interactionEnabled, enabled => {
  if (!enabled) {
    reordering.cancel();
    dismissMenu();
    pending.value = null;
  }
});

onMounted(() => {
  document.addEventListener("pointerdown", dismissOutsideMenu);
  document.addEventListener("focusin", dismissOutsideMenu);
  window.addEventListener("resize", dismissMenu);
  window.addEventListener("scroll", dismissMenu, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", dismissOutsideMenu);
  document.removeEventListener("focusin", dismissOutsideMenu);
  window.removeEventListener("resize", dismissMenu);
  window.removeEventListener("scroll", dismissMenu, true);
});

/** Focuses the saved-request query for the application's global navigation command. */
function focusSearch() {
  searchInput.value?.focus();
  searchInput.value?.select();
}
defineExpose({ focusSearch });

function selectRequest(id: string) {
  reordering.cancel();
  managedId.value = id;
  reveal(id);
  emit("select-request", id);
}

function toggleFolder(id: string) {
  reordering.cancel();
  managedId.value = id;
  if (matchingRequestIds.value !== undefined) {
    const collapsed = new Set(searchCollapsedFolderIds.value);
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    searchCollapsedFolderIds.value = collapsed;
    return;
  }

  const expanded = new Set(expandedFolderIds.value);
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  expandedFolderIds.value = expanded;
}

async function begin(action: Action, targetId = managedId.value, trigger = menu.value?.trigger ?? null) {
  reordering.cancel();
  const node = targetId ? findCollectionNode(props.nodes, targetId) : undefined;
  if (!["create-request", "create-folder"].includes(action) && !node) return;

  formTrigger = trigger;
  dismissMenu();
  pending.value = { action, targetId: node?.id ?? null };
  error.value = "";
  name.value = action === "create-request" ? "New request"
    : action === "create-folder" ? "New folder"
    : action === "duplicate" ? `${displayName(node)} copy` : displayName(node);
  parentId.value = (action.startsWith("create") && node?.kind === "folder"
    ? node.id : node ? collectionParentId(props.nodes, node.id) : null) ?? "";
  if (node) reveal(node.id);

  await nextTick();
  if (action === "rename") {
    const revealed = tree.value?.revealEntry(node!.id);
    if (revealed instanceof Promise) await revealed;
    const input = root.value?.querySelector<HTMLInputElement>('.inline-rename input');
    input?.focus();
    input?.select();
  } else if (action !== "move") {
    (nameInput.value ?? formElement.value?.querySelector<HTMLElement>("select, button"))?.focus();
    nameInput.value?.select();
  }
}

function apply() {
  const form = pending.value;
  if (!form) return;

  try {
    const state = { requests: props.requests, nodes: props.nodes };
    let change: CollectionChange;
    if (form.action === "create-request" || form.action === "create-folder") {
      change = createCollectionNode(state, form.action === "create-request" ? "request" : "folder", name.value, parentId.value || null);
    } else {
      if (!form.targetId) throw new Error("This collection entry no longer exists.");
      if (form.action === "rename") change = renameCollectionNode(state, form.targetId, name.value);
      else if (form.action === "duplicate") change = duplicateCollectionNode(state, form.targetId, name.value, parentId.value || null);
      else if (form.action === "delete") change = deleteCollectionNode(state, form.targetId);
      else return;
    }

    void acceptChange(change, form.action.startsWith("create") || form.action === "duplicate");
  } catch (cause) {
    error.value = message(cause);
  }
}

function moveEntry(id: string, placement: CollectionPlacement) {
  try {
    const change = moveCollectionNode({ requests: props.requests, nodes: props.nodes }, id, placement);
    void acceptChange(change);
  } catch (cause) {
    if (pending.value) error.value = message(cause);
    else announcement.value = message(cause);
  }
}

async function acceptChange(change: CollectionChange, openRequest = false) {
  const restoreFocus = ownsFocus();
  const trigger = formTrigger;
  const changed = change.requests !== props.requests || change.nodes !== props.nodes;
  pending.value = null;
  error.value = "";
  managedId.value = change.selectedId;
  formTrigger = null;
  if (changed) emit("change", change);
  if (change.selectedId) reveal(change.selectedId, change.nodes);
  if (changed && change.selectedId) {
    const node = findCollectionNode(change.nodes, change.selectedId);
    const location = collectionFolders(change.nodes).find(folder => folder.id === collectionParentId(change.nodes, change.selectedId!))?.path ?? "Collection root";
    announcement.value = `${displayName(node, change.requests)} · ${location}`;
  }
  const node = change.selectedId ? findCollectionNode(change.nodes, change.selectedId) : undefined;
  if (openRequest && node?.kind === "request") emit("select-request", node.id);

  await nextTick();
  if (!restoreFocus) return;
  if (change.selectedId) focusEntry(change.selectedId, trigger);
  else searchInput.value?.focus();
}

async function finishForm(restoreFocus = true) {
  const id = pending.value?.targetId;
  const trigger = formTrigger;
  pending.value = null;
  formTrigger = null;
  error.value = "";
  await nextTick();
  if (!restoreFocus) return;
  if (id) focusEntry(id, trigger);
  else if (trigger?.isConnected) trigger.focus();
  else searchInput.value?.focus();
}

function reveal(id: string, nodes = props.nodes) {
  if (matchingRequestIds.value !== undefined) return;
  const ancestors: string[] = [];
  function find(entries: readonly CollectionNode[]): boolean {
    for (const node of entries) {
      if (node.id === id) return true;
      if (node.kind === "folder" && find(node.children)) {
        ancestors.push(node.id);
        return true;
      }
    }
    return false;
  }
  if (find(nodes)) expandedFolderIds.value = new Set([...expandedFolderIds.value, ...ancestors]);
}

async function focusEntry(id: string, trigger: HTMLElement | null = null) {
  const revealed = tree.value?.revealEntry(id);
  if (revealed instanceof Promise) await revealed;
  const row = Array.from(root.value?.querySelectorAll<HTMLElement>('[data-collection-row]') ?? [])
    .find(element => element.dataset.collectionRow === id);
  if (!row || !entryVisible(id)) {
    searchInput.value?.focus();
    return;
  }
  const control = trigger?.isConnected ? trigger
    : row.querySelector<HTMLElement>(trigger?.classList.contains("tree-row") ? '.tree-row' : '.entry-menu-trigger');
  control?.focus();
  row.scrollIntoView?.({ block: "nearest" });
}

function entryVisible(id: string): boolean {
  const filter = matchingRequestIds.value;
  if (filter === undefined) return true;
  const node = findCollectionNode(props.nodes, id);
  return !!node && (node.kind === "request" ? filter.has(id) : collectionRequestIds(node).some(requestId => filter.has(requestId)));
}

function ownsFocus(): boolean {
  const active = document.activeElement;
  return active === document.body || !!(active && (root.value?.contains(active) || menuElement.value?.contains(active)
    || document.querySelector('.move-dialog')?.contains(active)));
}

function entryKeydown(id: string, event: KeyboardEvent) {
  if (event.isComposing || (event.target as HTMLElement).closest('input, textarea, select, form, [contenteditable="true"]')) return;
  if (event.key === "F2" && !event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    event.stopPropagation();
    void begin("rename", id, event.target as HTMLElement);
  } else if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    moveSibling(id, event.key === "ArrowUp" ? -1 : 1, event.target as HTMLElement);
  }
}

function moveSibling(id: string, direction: -1 | 1, trigger: HTMLElement | null = menu.value?.trigger ?? null) {
  reordering.cancel();
  const placement = positionalMovesEnabled.value ? collectionSiblingPlacement(props.nodes, id, direction) : null;
  if (!placement) return;
  formTrigger = trigger;
  dismissMenu();
  moveEntry(id, placement);
}

function canMoveSibling(direction: -1 | 1): boolean {
  const id = menu.value?.targetId;
  return !!(positionalMovesEnabled.value && id && collectionSiblingPlacement(props.nodes, id, direction));
}

function captureClick(event: MouseEvent) {
  if (reordering.suppressClick(event)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function openFirstMatch(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  const id = matchingIds.value[0];
  if (id) selectRequest(id);
}

function clearSearch() {
  search.value = "";
  searchInput.value?.focus();
}

function clearSearchOnEscape(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  clearSearch();
}

async function openMenu(targetId: string | null, trigger: HTMLElement) {
  reordering.cancel();
  if (menu.value?.trigger === trigger) {
    dismissMenu();
    return;
  }
  const bounds = trigger.getBoundingClientRect();
  menu.value = { targetId, trigger, left: bounds.left, top: bounds.bottom + 4 };
  await nextTick();
  const element = menuElement.value;
  if (!menu.value || menu.value.trigger !== trigger || !element) return;

  const size = element.getBoundingClientRect();
  menu.value = {
    ...menu.value,
    left: Math.max(8, Math.min(bounds.right - size.width, window.innerWidth - size.width - 8)),
    top: bounds.bottom + size.height + 12 <= window.innerHeight
      ? bounds.bottom + 4 : Math.max(8, bounds.top - size.height - 4),
  };
  element.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
}

function dismissMenu() { menu.value = null; }

function dismissOutsideMenu(event: Event) {
  if (!(event.target instanceof Node) || !menu.value) return;
  if (!menuElement.value?.contains(event.target) && !menu.value.trigger.contains(event.target)) dismissMenu();
}

function menuKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Escape" || event.key === "Tab") {
    if (event.key === "Escape" || event.shiftKey) event.preventDefault();
    if (event.key === "Escape") event.stopPropagation();
    const trigger = menu.value?.trigger;
    dismissMenu();
    trigger?.focus();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const items = Array.from(menuElement.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[index]?.focus();
}

function displayName(node?: CollectionNode, requests = props.requests): string {
  if (!node) return "";
  return node.kind === "request" ? requests[node.id]?.name ?? node.name : node.name;
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
</script>

<template>
  <section ref="root" class="collection-manager" aria-label="Collections" @click.capture="captureClick">
    <div class="collection-search">
      <label :for="searchId" class="ui-visually-hidden">Search requests</label>
      <div class="search-controls">
        <div class="search-input">
          <input :id="searchId" ref="searchInput" v-model="search" class="ui-input ui-input--compact" type="search"
            aria-label="Search requests" :aria-describedby="`${searchId}-hint`" placeholder="Search requests"
            @keydown.enter="openFirstMatch" @keydown.esc="clearSearchOnEscape" />
          <kbd aria-hidden="true" title="Quick open (⌘/Ctrl+K)">⌘/Ctrl K</kbd>
        </div>
        <button v-if="search" class="ui-button ui-button--compact" type="button" aria-label="Clear request search" @click="clearSearch">Clear</button>
      </div>
      <span :id="`${searchId}-hint`" class="ui-visually-hidden">Search by name, URL, method or folder. ⌘/Ctrl+K opens the request picker. Enter opens the first match.</span>
      <p v-if="search.trim()" class="search-status" role="status">{{ matchingIds.length ? `${matchingIds.length} matching request${matchingIds.length === 1 ? '' : 's'}` : 'No requests match your search.' }}</p>
      <p v-if="search.trim()" class="collection-hint">Clear search to reorder entries. Move to remains available.</p>
    </div>
    <div class="collection-toolbar" role="group" aria-label="Create collection entries">
      <button class="ui-button ui-button--compact" type="button" @click="begin('create-request', managedId, $event.currentTarget as HTMLElement)">+ New request</button>
      <button type="button" class="ui-button ui-button--compact create-menu-trigger" aria-label="More creation options"
        aria-haspopup="menu" :aria-expanded="menu !== null && menu.targetId === null"
        @click="openMenu(null, $event.currentTarget as HTMLElement)">▾</button>
    </div>
    <CollectionTree ref="tree" :interaction-enabled="interactionEnabled" :nodes="nodes" :requests="requests" :expanded-folder-ids="displayedExpansion"
      :selected-request-id="selectedRequestId" :selected-folder-id="managedNode?.kind === 'folder' ? managedNode.id : null"
      :matching-request-ids="matchingRequestIds" :matching-folder-ids="matchingFolderIds" :search-collapsed-folder-ids="searchCollapsedFolderIds" :action-menu-target-id="menu?.targetId"
      :renaming-id="pending?.action === 'rename' ? pending.targetId : null" :rename-value="name" :rename-error="error"
      :reorder-enabled="positionalMovesEnabled" :dragged-id="reordering.draggedId.value" :drop-target="reordering.dropTarget.value"
      @select-request="selectRequest" @toggle-folder="toggleFolder" @open-actions="openMenu"
      @entry-keydown="entryKeydown" @update:rename-value="name = $event" @commit-rename="apply"
      @cancel-rename="finishForm" @start-drag="reordering.start" />
    <div v-show="reordering.draggedId.value" data-collection-root-drop class="root-drop"
      :class="{ 'root-drop-active': reordering.dropTarget.value?.position === 'root' }">Move to collection root</div>
    <p v-if="!nodes.length" class="collection-hint">Create a request or folder to start your collection.</p>
    <p v-if="announcement" class="collection-hint" aria-live="polite">{{ announcement }}</p>
    <form v-if="pending && !['rename', 'move'].includes(pending.action)" ref="formElement" class="collection-form"
      :aria-label="actionTitle" @submit.prevent="apply" @keydown.esc.stop.prevent="finishForm()">
      <h3>{{ actionTitle }}</h3>
      <p v-if="pending.action === 'delete'" class="collection-hint">Delete “{{ targetName }}”{{ targetNode?.kind === 'folder' ? ' and all requests and folders inside it' : '' }}?
        {{ affectedRequests }} {{ affectedRequests === 1 ? 'request' : 'requests' }} will be removed. You can undo this deletion.</p>
      <label v-if="pending.action !== 'delete'">Name
        <input ref="nameInput" v-model="name" class="ui-input ui-input--compact" aria-label="Collection entry name" required />
      </label>
      <label v-if="pending.action !== 'delete'">Destination
        <select v-model="parentId" class="ui-input ui-input--compact" aria-label="Collection destination">
          <option value="">Collection root</option>
          <option v-for="folder in folders" :key="folder.id" :value="folder.id">{{ folder.path }}</option>
        </select>
      </label>
      <p v-if="error" role="alert">{{ error }}</p>
      <div class="form-actions">
        <button class="ui-button ui-button--compact" type="submit" :class="{ 'ui-button--danger': pending.action === 'delete' }">{{ actionTitle }}</button>
        <button class="ui-button ui-button--compact" type="button" @click="finishForm()">Cancel</button>
      </div>
    </form>
    <Teleport to="body">
      <CollectionMoveDialog v-if="pending?.action === 'move' && targetNode" :name="targetName" :kind="targetNode.kind"
        :current-parent-id="collectionParentId(nodes, targetNode.id)" :folders="folders" :error="error"
        @move="moveEntry(targetNode.id, { parentId: $event, beforeId: null })" @cancel="finishForm()" />
      <div v-if="menu" ref="menuElement" class="collection-menu" role="menu"
        :aria-label="menu.targetId ? `Actions for ${displayName(menuNode)}` : 'Create collection entry'"
        :style="{ left: `${menu.left}px`, top: `${menu.top}px` }" @keydown="menuKeydown">
        <template v-if="menu.targetId">
          <button type="button" role="menuitem" tabindex="-1" @click="begin('rename', menu.targetId)">Rename</button>
          <button type="button" role="menuitem" tabindex="-1" @click="begin('duplicate', menu.targetId)">Duplicate</button>
          <button type="button" role="menuitem" tabindex="-1" @click="begin('move', menu.targetId)">Move to</button>
          <button type="button" role="menuitem" tabindex="-1" :disabled="!canMoveSibling(-1)" @click="moveSibling(menu.targetId!, -1)">Move up</button>
          <button type="button" role="menuitem" tabindex="-1" :disabled="!canMoveSibling(1)" @click="moveSibling(menu.targetId!, 1)">Move down</button>
          <template v-if="menuNode?.kind === 'folder'">
            <button type="button" role="menuitem" tabindex="-1" @click="begin('create-request', menu.targetId)">New request here</button>
            <button type="button" role="menuitem" tabindex="-1" @click="begin('create-folder', menu.targetId)">New folder here</button>
          </template>
          <button type="button" role="menuitem" tabindex="-1" class="danger" @click="begin('delete', menu.targetId)">Delete</button>
        </template>
        <button v-else type="button" role="menuitem" tabindex="-1" @click="begin('create-folder')">+ New folder</button>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.collection-manager { padding: 14px 12px; container-type: inline-size; }
h3 { margin: 0; font-size: 12px; font-weight: 650; }
.collection-hint { color: var(--color-muted); font-size: 11px; line-height: 1.5; }
.collection-toolbar, .form-actions { display: flex; gap: 6px; }
.collection-toolbar { margin-bottom: 12px; gap: 0; }
.collection-toolbar > button:first-child { flex: 1; border-radius: 5px 0 0 5px; }
.create-menu-trigger { border-left: 0; border-radius: 0 5px 5px 0; }
.collection-search { display: grid; gap: 6px; margin-bottom: 12px; }
.search-controls { display: flex; gap: 6px; }
.search-input { position: relative; flex: 1; min-width: 0; }
.search-input input { padding-right: 65px; }
.search-input kbd { position: absolute; right: 7px; top: 50%; transform: translateY(-50%); color: var(--color-muted); font: inherit; font-size: 10px; pointer-events: none; }
.search-input input:not(:placeholder-shown) { padding-right: 7px; }
.search-input input:not(:placeholder-shown) + kbd { display: none; }
.collection-search p { margin: 0; }
.search-status { color: #c5d1e3; font-size: 11px; line-height: 1.5; }

.collection-form { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--color-border); }
.collection-form { display: grid; gap: 12px; }
.collection-form label { display: grid; gap: 5px; color: var(--color-muted); font-size: 11px; }
input, select { width: 100%; }
.collection-form p { margin: 0; }
[role="alert"] { color: var(--color-danger); }
.root-drop { margin: 8px 0; padding: 12px 8px; border: 1px dashed var(--color-control-border); border-radius: 6px; color: var(--color-muted); font-size: 12px; }
.root-drop-active { outline: 2px solid var(--color-focus); background: var(--color-hover); color: var(--color-text); }
.collection-menu { position: fixed; z-index: 60; display: grid; min-width: 160px; max-width: calc(100vw - 16px); max-height: calc(100dvh - 16px); overflow: auto; padding: 4px; background: #171f2c; border: 1px solid #334155; border-radius: 7px; box-shadow: 0 8px 24px #0006; }
.collection-menu button {
  color: var(--color-text);
  background: transparent;
  font: inherit;
  font-size: var(--control-compact-font-size);
  border-radius: var(--control-compact-radius);
  cursor: pointer;
  text-align: left;
  border: 0;
  padding: 8px 10px;
}

.collection-menu button:hover:not(:disabled) { background: var(--color-hover); }
.collection-menu button:disabled { opacity: .45; cursor: default; }
.collection-menu .danger { color: var(--color-danger); }

.collection-menu button:focus { outline: none; background: #263247; }
@container (max-width: 190px) {
  .search-input kbd { display: none; }
  .search-input input { padding-right: 7px; }
}
</style>
