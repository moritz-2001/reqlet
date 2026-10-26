<!-- CollectionTree bounds mounted rows in large expanded collections while keeping stable entry interactions. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import CollectionTreeBranch from "./CollectionTreeBranch.vue";
import CollectionTreeEntry from "./CollectionTreeEntry.vue";
import type { CollectionTreeProps } from "./collectionTree";
import { visibleCollectionRows } from "./collectionRows";

const props = withDefaults(defineProps<CollectionTreeProps>(), { interactionEnabled: true });
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
const root = ref<HTMLElement>();
const ownScrollport = ref(false);
const presentation = computed(() => {
  const { nodes: _nodes, interactionEnabled: _enabled, ...value } = props;
  return value;
});
const rows = computed(() => visibleCollectionRows(props));
const windowed = computed(() => rows.value.length > 200);
const viewport = shallowRef({ top: 0, height: 600 });
// Focus, rename, and capture owners must survive scrolling beyond the mounted window.
const focusedId = ref<string | null>(null);
const captureId = ref<string | null>(null);
const renameHeight = ref(86);
let port: HTMLElement | undefined;
let observer: ResizeObserver | undefined;
let measuredRename: HTMLElement | null = null;
let frame: number | undefined;
const forward = {
  "select-request": (id: string) => emit("select-request", id),
  "toggle-folder": (id: string) => emit("toggle-folder", id),
  "open-actions": (id: string, trigger: HTMLButtonElement) => emit("open-actions", id, trigger),
  "entry-keydown": (id: string, event: KeyboardEvent) => emit("entry-keydown", id, event),
  "update:renameValue": (value: string) => emit("update:renameValue", value),
  "commit-rename": () => emit("commit-rename"),
  "cancel-rename": (restore: boolean) => emit("cancel-rename", restore),
  "start-drag": (event: PointerEvent, id: string) => {
    captureId.value = id;
    emit("start-drag", event, id);
  },
};
const offsets = computed(() => {
  const result = [0];
  for (const row of rows.value) {
    const height = !row.empty && row.node.id === props.renamingId ? renameHeight.value : 38;
    result.push(result[result.length - 1]! + height);
  }
  return result;
});
const rowIndices = computed(() => new Map(rows.value.flatMap((row, index) => row.empty ? [] : [[row.node.id, index] as const])));
const renderedIndices = computed(() => {
  const start = indexAt(viewport.value.top - 228);
  const end = Math.min(rows.value.length, indexAt(viewport.value.top + viewport.value.height + 228) + 1);
  const indices = new Set<number>();
  for (let index = start; index < end; index++) indices.add(index);
  for (const id of [focusedId.value, captureId.value, props.renamingId, props.draggedId, props.actionMenuTargetId]) {
    const index = id ? rowIndices.value.get(id) : undefined;
    if (index !== undefined) indices.add(index);
  }
  return [...indices].sort((left, right) => left - right);
});
const afterIndex = computed(() => {
  if (props.dropTarget?.position !== "after" || !props.dropTarget.id) return undefined;
  const index = rowIndices.value.get(props.dropTarget.id);
  return index === undefined ? undefined : rows.value[index]?.subtreeEnd;
});

onMounted(() => {
  port = findScrollport(root.value!) ?? root.value;
  ownScrollport.value = port === root.value;
  port?.addEventListener("scroll", scheduleMeasure, { passive: true });
  window.addEventListener("resize", scheduleMeasure);
  window.addEventListener("pointerup", releaseCapture);
  window.addEventListener("pointercancel", releaseCapture);
  window.addEventListener("blur", releaseCapture);
  observer = new ResizeObserver(() => {
    const height = measuredRename?.getBoundingClientRect().height;
    if (height && height !== renameHeight.value) renameHeight.value = height;
    measure();
  });
  if (port) observer.observe(port);
  if (root.value) observer.observe(root.value);
  measure();
  if (props.selectedRequestId) void revealEntry(props.selectedRequestId);
});
onBeforeUnmount(() => {
  port?.removeEventListener("scroll", scheduleMeasure);
  window.removeEventListener("resize", scheduleMeasure);
  window.removeEventListener("pointerup", releaseCapture);
  window.removeEventListener("pointercancel", releaseCapture);
  window.removeEventListener("blur", releaseCapture);
  if (frame !== undefined) cancelAnimationFrame(frame);
  observer?.disconnect();
});
watch(() => [props.nodes, props.expandedFolderIds, props.matchingRequestIds, props.searchCollapsedFolderIds, props.interactionEnabled], () => { void nextTick(measure); });
watch(windowed, async () => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.value?.contains(active)) return;
  const id = active.closest<HTMLElement>("[data-collection-row]")?.dataset.collectionRow;
  const selector = active.classList.contains("tree-row") ? ".tree-row"
    : active.classList.contains("drag-handle") ? ".drag-handle"
    : active.classList.contains("entry-menu-trigger") ? ".entry-menu-trigger" : ".inline-rename input";
  await nextTick();
  // Switching renderer replaces row elements; retain the initiating control unless focus moved elsewhere.
  if (!id || (document.activeElement !== active && document.activeElement !== document.body)) return;
  const row = [...root.value?.querySelectorAll<HTMLElement>("[data-collection-row]") ?? []]
    .find(element => element.dataset.collectionRow === id);
  row?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
});
watch(() => props.selectedRequestId, id => { if (id) void revealEntry(id); });
watch(() => [props.renamingId, props.renameError], async () => {
  renameHeight.value = 86;
  await nextTick();
  if (measuredRename) observer?.unobserve(measuredRename);
  measuredRename = root.value?.querySelector<HTMLElement>(".inline-rename")?.closest(".collection-entry") ?? null;
  if (measuredRename) observer?.observe(measuredRename);
});
watch(() => props.interactionEnabled, enabled => { if (enabled === false) releaseCapture(); });

/** Mounts and reveals an entry by identity before its owner restores focus after a move or rename. */
function revealEntry(id: string): boolean | Promise<boolean> {
  const index = rowIndices.value.get(id);
  if (index === undefined) return false;
  if (!windowed.value || !port) return true;

  measure();
  const top = offsets.value[index]!;
  const bottom = offsets.value[index + 1]!;
  const viewportTop = viewport.value.top;
  const target = top < viewportTop ? top : bottom > viewportTop + viewport.value.height ? bottom - viewport.value.height : viewportTop;
  if (target !== viewportTop) {
    port.scrollTop += target - viewportTop;
    measure();
  }
  return nextTick(() => true);
}
defineExpose({ revealEntry });

function indexAt(offset: number): number {
  let low = 0;
  let high = rows.value.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets.value[middle + 1]! <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, Math.max(0, rows.value.length - 1));
}

function measure() {
  if (!port || !root.value || props.interactionEnabled === false) return;
  const portBounds = port.getBoundingClientRect();
  const bounds = root.value.getBoundingClientRect();
  // A zero-size scrollport is temporarily hidden (or has no layout in a test).
  // Keep a bounded initial window until a resize or sidebar activation supplies geometry.
  const top = port === root.value || !bounds.height ? port.scrollTop : Math.max(0, portBounds.top - bounds.top);
  const height = port.clientHeight
    ? Math.max(1, port.clientHeight - Math.max(0, bounds.top - portBounds.top)) : 600;
  if (viewport.value.top !== top || viewport.value.height !== height) viewport.value = { top, height };
}

function scheduleMeasure() {
  if (frame !== undefined) return;
  frame = requestAnimationFrame(() => { frame = undefined; measure(); });
}

function releaseCapture() { captureId.value = null; }

function focusIn(event: FocusEvent) {
  focusedId.value = (event.target as HTMLElement).closest<HTMLElement>("[data-collection-row]")?.dataset.collectionRow ?? null;
}

async function focusOut() {
  await nextTick();
  if (!root.value?.contains(document.activeElement)) focusedId.value = null;
}

async function navigateTab(event: KeyboardEvent) {
  if (!windowed.value || event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target as HTMLElement;
  if (target.closest("form")) return;
  const row = target.closest<HTMLElement>("[data-collection-row]");
  const id = row?.dataset.collectionRow;
  const index = id ? rowIndices.value.get(id) : undefined;
  if (index === undefined || !row) return;
  const controls = [...row.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
  if (target !== controls[event.shiftKey ? 0 : controls.length - 1]) return;

  let next = index + (event.shiftKey ? -1 : 1);
  while (rows.value[next]?.empty) next += event.shiftKey ? -1 : 1;
  const nextRow = rows.value[next];
  if (!nextRow) return;
  event.preventDefault();
  await revealEntry(nextRow.node.id);
  const element = root.value?.querySelector<HTMLElement>(`[data-collection-index="${next}"]`);
  const nextControls = [...element?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []];
  nextControls[event.shiftKey ? nextControls.length - 1 : 0]?.focus();
}

function findScrollport(element: HTMLElement): HTMLElement | undefined {
  const sidebar = element.closest<HTMLElement>(".sidebar-view");
  if (sidebar) return sidebar;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(ancestor).overflowY)) return ancestor;
  }
  return undefined;
}
</script>

<template>
  <div ref="root" class="collection-tree-surface" :class="{ 'collection-tree-scrollport': ownScrollport && windowed }" @focusin="focusIn" @focusout="focusOut" @keydown="navigateTab">
    <CollectionTreeBranch v-if="!windowed" v-bind="props" v-on="forward" />
    <ul v-else class="collection-tree collection-tree-window" :style="{ height: `${offsets[offsets.length - 1]}px` }"
      aria-label="Collection entries">
      <li v-for="index in renderedIndices" :key="`${rows[index]!.empty ? 'empty-' : ''}${rows[index]!.node.id}`"
        :data-collection-id="rows[index]!.empty ? undefined : rows[index]!.node.id" :data-collection-index="index"
        :role="rows[index]!.empty ? 'presentation' : undefined"
        :aria-level="rows[index]!.empty ? undefined : rows[index]!.depth + 1"
        :aria-posinset="rows[index]!.empty ? undefined : rows[index]!.position"
        :aria-setsize="rows[index]!.empty ? undefined : rows[index]!.siblingCount"
        :style="{ top: `${offsets[index]}px`, left: `${rows[index]!.depth * 21}px` }"
        :class="{ 'drop-before': !rows[index]!.empty && dropTarget?.id === rows[index]!.node.id && dropTarget.position === 'before', 'drop-after': afterIndex === index }">
        <p v-if="rows[index]!.empty" class="empty-folder" :data-collection-empty="rows[index]!.node.id">No requests yet</p>
        <CollectionTreeEntry v-else v-bind="presentation" :node="rows[index]!.node" v-on="forward" />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.collection-tree-scrollport { max-height: min(600px, 70vh); overflow-y: auto; }
.collection-tree { margin: 0; padding: 0; list-style: none; }
.collection-tree-window { position: relative; }
.collection-tree-window > li { position: absolute; right: 0; min-height: 38px; }
.collection-tree-window :deep(.collection-entry:not(:has(.inline-rename))) { height: 36px; }
.empty-folder { margin: 0; padding: 8px; color: var(--color-muted); font-size: 12px; }
.drop-before::before, .drop-after::after { content: ''; position: absolute; left: 0; right: 0; height: 2px; z-index: 1; background: var(--color-focus); pointer-events: none; }
.drop-before::before { top: -1px; }
.drop-after::after { bottom: -1px; }
</style>
