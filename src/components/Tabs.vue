<!-- Tabs owns open tabs, order, and selection; its caller renders the active panel elsewhere. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId } from "vue";
import type { TabExecution, TabItem, TabPresentation, TabsState } from "./tabs";
import { moveTab } from "./tabOrder";
import { useTabReordering } from "./useTabReordering";
import VirtualRows from "./VirtualRows.vue";

const props = withDefaults(defineProps<{
  /** Accessible name describing this group of tabs. */
  label: string;
  /** Document-unique ID of the caller's shared active panel, targeted by every tab. */
  panelId: string;
  /** Enables pointer and keyboard reordering; omitted or false keeps the opening order. */
  reorderable?: boolean;
  /** Restored descriptors read once when mounted; later operations use the exposed commands. */
  initialItems?: readonly TabItem[];
  /** Restored selection; omitted, null, or unknown identities select the first restored item. */
  initialActiveId?: string | null;
  /** Live execution and draft feedback keyed by tab identity; absent identities have no extra presentation. */
  presentation?: Readonly<Record<string, TabPresentation>>;
}>(), { reorderable: false });

const emit = defineEmits<{
  /** Reports a completed selection change; null means the last tab closed. */
  "active-change": [id: string | null];
  /** Complete order and selection after an open, close, rename, reorder, or selection. */
  "state-change": [state: TabsState];
}>();

// This is the only open list. Replace arrays and descriptors rather than retaining caller-owned objects.
const items = shallowRef<readonly TabItem[]>(
  [...new Map((props.initialItems ?? []).map(item => [item.id, { ...item }])).values()],
);
// Set when opening or selecting; closing selects a neighbor or clears it when the list becomes empty.
const activeId = ref<string | null>(
  items.value.find(item => item.id === props.initialActiveId)?.id ?? items.value[0]?.id ?? null,
);
const count = computed(() => items.value.length);
const virtualStrip = computed(() => count.value > 80);
// Large strips use one predictable width so offscreen drop targets need no DOM measurement.
const virtualTabWidth = 220;
const stripScroll = ref(0);
const stripWidth = ref(800);
const stripIndices = computed(() => {
  if (!virtualStrip.value) return items.value.map((_, index) => index);

  const first = Math.max(0, Math.floor(stripScroll.value / virtualTabWidth) - 3);
  const last = Math.min(count.value, Math.ceil((stripScroll.value + stripWidth.value) / virtualTabWidth) + 3);
  const result = Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index);
  // The selected tab remains the strip's entry point; capture keeps its source mounted while edge scrolling.
  for (const id of [activeId.value, draggedId.value]) {
    const index = items.value.findIndex(item => item.id === id);
    if (index >= 0 && !result.includes(index)) result.push(index);
  }
  return result.sort((left, right) => left - right);
});
// Feedback stays outside descriptors and state-change snapshots, so transport
// updates never reopen tabs, change selection, or enter persisted tab state.
const presentedTabs = computed(() => stripIndices.value.map(index => presentTab(items.value[index]!, index)));

const strip = ref<HTMLElement>();
const picker = ref<HTMLElement>();
const pickerTrigger = ref<HTMLButtonElement>();
const pickerMenu = ref<HTMLElement>();
const pickerRows = ref<{ reveal(index: number): Promise<void> | undefined }>();
let stripObserver: ResizeObserver | undefined;
// Only controls the transient menu. Its entries and checked item derive from the owned tab state above.
const pickerExpanded = ref(false);
const namespace = useId();
const instructionsId = `${namespace}-reorder-instructions`;
const pickerMenuId = `${namespace}-open-tabs`;
const announcement = ref("");
const reordering = useTabReordering({
  strip,
  enabled: computed(() => props.reorderable),
  items,
  commit: reorder,
  itemWidth: computed(() => virtualStrip.value ? virtualTabWidth : undefined),
  scrolled: updateStripViewport,
});
const { draggedId, marker } = reordering;

onMounted(() => {
  document.addEventListener("pointerdown", dismissPickerOutside);
  document.addEventListener("focusin", dismissPickerOutside);
  if (typeof ResizeObserver !== "undefined" && strip.value) {
    stripObserver = new ResizeObserver(updateStripViewport);
    stripObserver.observe(strip.value);
  }
  updateStripViewport();
  if (activeId.value) void revealActiveTab(activeId.value);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", dismissPickerOutside);
  document.removeEventListener("focusin", dismissPickerOutside);
  stripObserver?.disconnect();
});

defineExpose({ open, restore, close, updateLabel, count });

function open(item: TabItem) {
  reordering.cancel();
  const previousPickerFocus = pickerMenu.value?.contains(document.activeElement) ? document.activeElement : null;
  closePicker();
  announcement.value = "";
  const index = items.value.findIndex(tab => tab.id === item.id);
  const descriptor = { id: item.id, label: item.label, closable: item.closable };
  items.value = index === -1
    ? [...items.value, descriptor]
    : items.value.map((tab, position) => position === index ? descriptor : tab);
  select(item.id, false);
  reportState();
  void revealActiveTab(descriptor.id);
  if (previousPickerFocus) void retainFocus(descriptor.id, previousPickerFocus);
}

function restore(snapshot: TabsState, ids: readonly string[], restoreActiveId?: string) {
  const requested = new Set(ids);
  const restored = snapshot.items.filter(item => requested.has(item.id) && !items.value.some(current => current.id === item.id));
  if (!restored.length) return;

  reordering.cancel();
  const merged = [...items.value];
  for (const item of restored) {
    const originalIndex = snapshot.items.findIndex(candidate => candidate.id === item.id);
    const next = snapshot.items.slice(originalIndex + 1).find(candidate => merged.some(current => current.id === candidate.id));
    const previous = snapshot.items.slice(0, originalIndex).reverse().find(candidate => merged.some(current => current.id === candidate.id));
    const index = next ? merged.findIndex(current => current.id === next.id)
      : previous ? merged.findIndex(current => current.id === previous.id) + 1 : Math.min(originalIndex, merged.length);
    merged.splice(index, 0, { ...item });
  }
  items.value = merged;
  const selection = restoreActiveId && merged.some(item => item.id === restoreActiveId) ? restoreActiveId
    : activeId.value ?? restored[0].id;
  select(selection, false);
  reportState();
}

function select(id: string, report = true) {
  if (activeId.value === id) return;

  activeId.value = id;
  emit("active-change", id);
  if (report) reportState();
}

function close(id: string) {
  const index = items.value.findIndex(item => item.id === id);
  if (index === -1 || !items.value[index].closable) return;

  reordering.cancel();
  announcement.value = "";
  const entry = tabButton(id)?.parentElement;
  const previousFocus = entry?.contains(document.activeElement) ? document.activeElement : null;
  const previousPickerFocus = pickerButton(id) === document.activeElement ? document.activeElement : null;
  items.value = items.value.filter(item => item.id !== id);
  if (activeId.value === id) {
    activeId.value = items.value[index]?.id ?? items.value[index - 1]?.id ?? null;
    emit("active-change", activeId.value);
  }
  if (previousFocus) void retainFocus(activeId.value, previousFocus);
  if (items.value.length === 0) closePicker();
  if (previousPickerFocus) {
    const replacementId = items.value[index]?.id ?? items.value[index - 1]?.id ?? null;
    void retainPickerFocus(replacementId, previousPickerFocus);
  }
  reportState();
}

function updateLabel(id: string, label: string) {
  if (!items.value.some(item => item.id === id && item.label !== label)) return;

  items.value = items.value.map(item => item.id === id ? { ...item, label } : item);
  reportState();
}

function reorder(id: string, beforeId: string | null) {
  const reordered = moveTab(items.value, id, beforeId);
  if (reordered === items.value) return;

  const button = tabButton(id);
  const previousFocus = document.activeElement === button ? button : null;
  items.value = reordered;
  const index = reordered.findIndex(item => item.id === id);
  announcement.value = `${reordered[index].label} moved to position ${index + 1} of ${reordered.length}`;
  if (previousFocus) void retainFocus(id, previousFocus);
  reportState();
}

function reportState() {
  emit("state-change", { items: items.value.map(item => ({ ...item })), activeId: activeId.value });
}

function handleClick(id: string) {
  reordering.cancel();
  select(id);
}

async function openPicker(position: "active" | "first" | "last" = "active") {
  if (items.value.length === 0) return;

  reordering.cancel();
  pickerExpanded.value = true;
  await nextTick();
  if (!pickerExpanded.value) return;

  const target = position === "first" ? items.value[0]?.id : position === "last" ? items.value[items.value.length - 1]?.id
    : activeId.value ?? items.value[0]?.id;
  if (target) void focusPicker(target);
}

function closePicker(restoreFocus = false) {
  if (!pickerExpanded.value) return;

  pickerExpanded.value = false;
  if (restoreFocus) pickerTrigger.value?.focus();
}

function chooseFromPicker(id: string) {
  const previousFocus = document.activeElement;
  closePicker();
  select(id);
  void revealActiveTab(id);
  if (previousFocus) void retainFocus(id, previousFocus);
}

function handlePickerKeydown(event: KeyboardEvent) {
  if (event.key === "Tab") {
    // Restore the stable trigger before the browser advances through the normal Tab order.
    closePicker(true);
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

  event.preventDefault();
  const id = (document.activeElement as HTMLElement)?.dataset.pickerTabId;
  const current = items.value.findIndex(item => item.id === id);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.value.length - 1
    : (current + (event.key === "ArrowDown" ? 1 : -1) + items.value.length) % items.value.length;
  const target = items.value[next];
  if (target) void focusPicker(target.id);
}

function dismissPickerOutside(event: Event) {
  if (event.target instanceof Node && !picker.value?.contains(event.target)) closePicker();
}

async function retainPickerFocus(id: string | null, previousFocus: Element) {
  await nextTick();
  if (document.activeElement !== previousFocus && document.activeElement !== document.body) return;

  if (id === null) focusTab(null);
  else void focusPicker(id);
}

async function focusPicker(id: string) {
  const index = items.value.findIndex(item => item.id === id);
  const pending = pickerRows.value?.reveal(index);
  if (pending) await pending;
  if (!pickerExpanded.value) return;

  const target = pickerButton(id);
  target?.focus({ preventScroll: true });
  target?.scrollIntoView?.({ block: "nearest" });
}

function pickerButton(id: string | null) {
  return [...pickerMenu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []]
    .find(button => button.dataset.pickerTabId === id);
}

function handleKeydown(event: KeyboardEvent, id: string) {
  const index = items.value.findIndex(item => item.id === id);
  if (index === -1 || event.ctrlKey || event.metaKey) return;

  if (props.reorderable && event.altKey && event.shiftKey
    && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    reordering.cancel();
    const targetIndex = index + (event.key === "ArrowLeft" ? -1 : 1);
    if (targetIndex < 0 || targetIndex >= items.value.length) return;

    const beforeId = event.key === "ArrowLeft"
      ? items.value[targetIndex].id
      : items.value[targetIndex + 1]?.id ?? null;
    reorder(id, beforeId);
    return;
  }
  if (event.altKey || event.shiftKey) return;

  if (event.key === "Delete" && items.value[index].closable) {
    event.preventDefault();
    close(id);
    return;
  }

  let nextIndex: number;
  switch (event.key) {
    case "ArrowLeft":
      nextIndex = (index - 1 + items.value.length) % items.value.length;
      break;
    case "ArrowRight":
      nextIndex = (index + 1) % items.value.length;
      break;
    case "Home":
      nextIndex = 0;
      break;
    case "End":
      nextIndex = items.value.length - 1;
      break;
    default:
      return;
  }

  event.preventDefault();
  reordering.cancel();
  const nextId = items.value[nextIndex].id;
  select(nextId);
  focusTab(nextId);
}

async function retainFocus(id: string | null, previousFocus: Element) {
  await nextTick();
  if (document.activeElement === previousFocus || document.activeElement === document.body) focusTab(id);
}

async function revealActiveTab(id: string) {
  revealStripPosition(id);
  await nextTick();
  if (activeId.value === id) tabButton(id)?.parentElement?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function focusTab(id: string | null) {
  if (id !== null && virtualStrip.value) {
    revealStripPosition(id);
    void nextTick(() => focusRenderedTab(id));
    return;
  }
  focusRenderedTab(id);
}

function focusRenderedTab(id: string | null) {
  const target = id === null ? strip.value : tabButton(id);
  target?.focus({ preventScroll: true });
  const entry = id === null ? target : target?.parentElement;
  entry?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function tabButton(id: string) {
  return [...strip.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []]
    .find(button => button.parentElement?.dataset.tabId === id);
}

function updateStripViewport() {
  stripScroll.value = strip.value?.scrollLeft ?? 0;
  stripWidth.value = strip.value?.clientWidth || 800;
}

function handleStripScroll() {
  updateStripViewport();
  reordering.refresh();
}

function revealStripPosition(id: string) {
  if (!virtualStrip.value || !strip.value) return;

  const index = items.value.findIndex(item => item.id === id);
  if (index < 0) return;

  const left = index * virtualTabWidth;
  const right = left + virtualTabWidth;
  const width = strip.value.clientWidth || stripWidth.value;
  if (left < strip.value.scrollLeft) strip.value.scrollLeft = left;
  else if (right > strip.value.scrollLeft + width) strip.value.scrollLeft = right - width;
  updateStripViewport();
}

function tabDomId(id: string) {
  return `${namespace}-tab-${encodeURIComponent(id)}`;
}

function presentTab(item: TabItem, index: number) {
  const presentation = props.presentation?.[item.id];
  const execution = presentation?.execution;
  const statusLabel = executionLabel(execution);
  return {
    ...item,
    index,
    unsaved: presentation?.unsaved ?? false,
    executionStatus: execution?.status,
    statusLabel,
    failed: execution?.status === "error" || (execution?.status === "success" && execution.httpStatus >= 400),
    accessibleLabel: [item.label, presentation?.unsaved ? "Unsaved draft" : "",
      execution?.status === "success" ? `HTTP ${execution.httpStatus}` : statusLabel].filter(Boolean).join(", "),
  };
}

function executionLabel(execution?: TabExecution): string {
  switch (execution?.status) {
    case "running": return "Sending…";
    case "success": return String(execution.httpStatus);
    case "error": return "Failed";
    case "cancelled": return "Cancelled";
    default: return "";
  }
}
</script>

<template>
  <div class="tabs">
    <div
      ref="strip"
      class="tab-list"
      role="tablist"
      :aria-label="label"
      :aria-describedby="reorderable ? instructionsId : undefined"
      :tabindex="items.length === 0 ? 0 : -1"
      :class="{ 'is-reorderable': reorderable, 'is-dragging': draggedId !== null, 'virtual-strip': virtualStrip }"
      @pointerdown.capture="reordering.prepareClick"
      @pointermove="reordering.move"
      @pointerup="reordering.end"
      @pointercancel="reordering.captureLost"
      @lostpointercapture="reordering.captureLost"
      @click.capture="reordering.suppressClick"
      @scroll.passive="handleStripScroll"
    >
      <div v-if="virtualStrip" class="tab-spacer" :style="{ width: `${count * virtualTabWidth}px` }" aria-hidden="true" />
      <div
        v-for="item in presentedTabs"
        :key="item.id"
        class="tab-entry"
        role="presentation"
        :data-tab-id="item.id"
        :class="{ 'drag-source': draggedId === item.id }"
        :style="virtualStrip ? { position: 'absolute', left: `${item.index * virtualTabWidth}px`, width: `${virtualTabWidth}px`, top: 0, bottom: 0 } : undefined"
      >
        <button
          :id="tabDomId(item.id)"
          type="button"
          role="tab"
          class="tab-button"
          :title="item.label"
          :aria-label="item.accessibleLabel"
          :aria-selected="item.id === activeId"
          :aria-controls="panelId"
          :aria-posinset="virtualStrip ? item.index + 1 : undefined"
          :aria-setsize="virtualStrip ? count : undefined"
          :aria-keyshortcuts="reorderable ? 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight' : undefined"
          :tabindex="item.id === activeId ? 0 : -1"
          :draggable="false"
          @pointerdown="reordering.start($event, item.id)"
          @dragstart.prevent
          @click="handleClick(item.id)"
          @keydown="handleKeydown($event, item.id)"
        >
          <span v-if="item.unsaved" class="unsaved-marker" title="Unsaved draft" aria-hidden="true">●</span>
          <span class="tab-label">{{ item.label }}</span>
          <span v-if="item.statusLabel" class="tab-execution" :class="{ failed: item.failed }"
            :data-status="item.executionStatus" aria-hidden="true">
            <span v-if="item.executionStatus === 'running'" class="execution-spinner" />
            {{ item.statusLabel }}
          </span>
        </button>
        <button
          v-if="item.closable"
          type="button"
          class="close-button"
          :aria-label="`Close ${item.label}`"
          title="Close tab (Delete when tab is focused)"
          tabindex="-1"
          @click="close(item.id)"
        ><span aria-hidden="true">×</span></button>
      </div>
      <span v-if="marker !== null" class="insertion-marker" :style="{ left: `${marker}px` }" aria-hidden="true" />
    </div>
    <div ref="picker" class="tab-picker" @keydown.esc.stop.prevent="closePicker(true)">
      <button ref="pickerTrigger" type="button" class="picker-trigger"
        :aria-label="`Open tabs (${count})`" title="Open tabs" aria-haspopup="menu"
        :aria-expanded="pickerExpanded" :aria-controls="pickerMenuId" :disabled="count === 0"
        @click="pickerExpanded ? closePicker(true) : openPicker()"
        @keydown.down.prevent="openPicker('first')" @keydown.up.prevent="openPicker('last')">
        <span aria-hidden="true">{{ count }} <span class="picker-chevron">⌄</span></span>
      </button>
      <div v-if="pickerExpanded" :id="pickerMenuId" ref="pickerMenu" class="picker-menu" role="menu"
        :aria-label="`${label}: open tabs`" @keydown="handlePickerKeydown">
        <VirtualRows ref="pickerRows" :items="items" :row-key="item => item.id" :estimated-height="40" :max-height="310">
          <template #default="{ item: descriptor, index }">
            <button v-for="item in [presentTab(descriptor, index)]" :key="item.id" type="button" role="menuitemradio"
              class="picker-item" tabindex="-1" :data-picker-tab-id="item.id"
              :aria-checked="item.id === activeId" :aria-label="item.accessibleLabel"
              :aria-posinset="index + 1" :aria-setsize="count"
              @click="chooseFromPicker(item.id)">
              <span class="picker-current" aria-hidden="true">{{ item.id === activeId ? '✓' : '' }}</span>
              <span class="picker-label">{{ item.label }}</span>
              <span v-if="item.unsaved" class="unsaved-marker" title="Unsaved draft" aria-hidden="true">●</span>
              <span v-if="item.statusLabel" class="tab-execution" :class="{ failed: item.failed }"
                :data-status="item.executionStatus" aria-hidden="true">{{ item.statusLabel }}</span>
            </button>
          </template>
        </VirtualRows>
      </div>
    </div>
    <span v-if="reorderable" :id="instructionsId" class="ui-visually-hidden">
      Reorder tabs with Alt+Shift+Left or Alt+Shift+Right, or drag with a mouse or pen. Escape cancels dragging.
    </span>
    <span class="ui-visually-hidden" role="status" aria-live="polite" aria-atomic="true">{{ announcement }}</span>
  </div>
</template>

<style scoped>
.tabs {
  position: relative;
  z-index: 1;
  display: flex;
  min-width: 0;
  min-height: 0;
}

.tab-list {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 44px;
  overflow-x: auto;
  background: #0e151f;
  border-bottom: 1px solid var(--color-border);
}

.tab-entry {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  border-right: 1px solid var(--color-border);
  border-bottom: 2px solid transparent;
}

.tab-spacer { flex: 0 0 auto; height: 44px; }
.virtual-strip .tab-entry { box-sizing: border-box; }
.virtual-strip .tab-button { flex: 1; min-width: 0; padding-right: 8px; padding-left: 10px; }
.virtual-strip .tab-label { flex: 1; min-width: 0; }

.tab-entry:has([aria-selected="true"]) {
  background: var(--color-selected);
  border-bottom-color: var(--color-selected-border);
}

.tab-button, .close-button {
  color: #b2bfd1;
  font: inherit;
  font-size: 13px;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.tab-button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  white-space: nowrap;
}

.tab-label { max-width: 20ch; overflow: hidden; text-overflow: ellipsis; }
.unsaved-marker, .tab-execution, .close-button { flex-shrink: 0; }

.tab-picker { display: flex; flex-shrink: 0; border-left: 1px solid var(--color-border); border-bottom: 1px solid var(--color-border); background: #0e151f; }
.picker-trigger { min-width: 56px; padding: 0 12px; border: 0; color: var(--color-text); background: transparent; font: inherit; font-size: 13px; cursor: pointer; }
.picker-trigger:hover, .picker-trigger[aria-expanded="true"] { background: var(--color-hover); }
.picker-trigger:disabled { color: var(--color-muted); cursor: default; }
.picker-chevron { margin-left: 4px; }
.picker-menu { position: absolute; top: 100%; right: 0; z-index: 1; display: grid; width: min(360px, 100%); max-height: min(320px, calc(100vh - 140px)); overflow-y: auto; box-sizing: border-box; padding: 5px; border: 1px solid var(--color-border); border-radius: 0 0 8px 8px; background: var(--color-panel); box-shadow: 0 12px 30px #0008; }
.picker-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--color-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.picker-item:hover, .picker-item:focus-visible { background: var(--color-selected); }
.picker-current { flex-shrink: 0; width: 14px; color: var(--color-focus); }
.picker-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }

.unsaved-marker { color: #eec78f; font-size: 9px; }
.tab-execution { display: inline-flex; align-items: center; gap: 5px; padding: 2px 5px; border-radius: 4px; color: #9fe3bc; background: #9fe3bc12; font-size: 11px; }
.tab-execution[data-status="running"] { color: #b7cbff; background: #8baaff16; }
.tab-execution[data-status="cancelled"] { color: #eec78f; background: #eec78f12; }
.tab-execution.failed { color: var(--color-danger); background: #ffb4b412; }
.execution-spinner { width: 10px; height: 10px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: execution-spin .8s linear infinite; }
@keyframes execution-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .execution-spinner { animation: none; } }

.tab-button[aria-selected="true"] {
  color: var(--color-text);
}

.close-button {
  margin-right: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 18px;
}

.tab-button:hover, .close-button:hover {
  background: var(--color-hover);
}

button:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: -2px;
}

.is-reorderable .tab-button {
  user-select: none;
  -webkit-user-select: none;
}

.is-dragging, .is-dragging .tab-button, .is-dragging .close-button {
  cursor: grabbing;
}

.drag-source {
  opacity: .5;
}

.insertion-marker {
  position: absolute;
  top: 3px;
  bottom: 3px;
  width: 2px;
  background: var(--color-focus);
  pointer-events: none;
}

</style>
