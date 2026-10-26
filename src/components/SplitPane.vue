<!-- SplitPane sizes two slotted regions and owns their responsive, accessible drag divider. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from "vue";
import type { SplitSizes } from "./splitPane";

const props = withDefaults(defineProps<{
  /** Accessible name describing what the divider resizes. */
  label: string;
  /** Starting first-pane size: pixels stay fixed on resize; percentages scale. */
  initialSize?: number | `${number}%`;
  /** Restored preferences controlled with update:sizes; omitted keeps preferences inside this component. */
  sizes?: SplitSizes;
  /** Temporarily stacks one intrinsically sized pane above/below a filling pane, without changing resize preferences. */
  compact?: "first" | "second";
  /** Smallest usable first-pane extent in either direction, in pixels. */
  minFirst?: number;
  /** Smallest usable second-pane extent in either direction, in pixels. */
  minSecond?: number;
  /** Minimum combined pane extent, excluding the divider; adds resize room in scrollable layouts. */
  minExtent?: number;
  /** Optional upper bound for the first pane, in pixels; omitted means unbounded. */
  maxFirst?: number;
  /** Container width at or below which the regions stack vertically, in pixels. */
  stackAt: number;
}>(), {
  initialSize: "50%",
  minFirst: 240,
  minSecond: 240,
  minExtent: 0,
});

type Direction = "horizontal" | "vertical";

const emit = defineEmits<{
  /** Completed drags and keyboard/reset changes; previews and layout clamping never replace saved preferences. */
  "update:sizes": [sizes: SplitSizes];
}>();

const root = ref<HTMLElement>();
const firstId = useId();
const bounds = reactive({ width: 0, height: 0 });
// Each orientation remembers its own preference. Layout clamping never overwrites
// it, so shrinking a window or temporarily hiding a tab cannot lose the split.
const internalSizes = ref<SplitSizes>({
  horizontal: props.initialSize,
  vertical: props.initialSize,
});
const sizes = computed(() => props.sizes ?? internalSizes.value);
// Set on primary pointerdown; cleared on release, cancellation, or capture loss.
// The starting size/position anchor movement to the original gesture, not rerenders.
const drag = ref<{
  pointerId: number;
  position: number;
  size: number;
  direction: Direction;
  source: HTMLElement;
} | null>(null);
// Pointer movement stays local until release, so autosave observes one completed resize.
const previewSize = ref<number | null>(null);
let observer: ResizeObserver | undefined;

const direction = computed<Direction>(() => props.compact || bounds.width <= props.stackAt ? "vertical" : "horizontal");
const available = computed(() => Math.max(
  props.minFirst + props.minSecond,
  props.minExtent,
  (direction.value === "horizontal" ? bounds.width : bounds.height) - 8,
));
const maximum = computed(() => Math.max(
  props.minFirst, Math.min(props.maxFirst ?? Infinity, available.value - props.minSecond),
));
const firstSize = computed(() => {
  if (previewSize.value !== null && drag.value?.direction === direction.value) return clamp(previewSize.value);
  const size = sizes.value[direction.value];
  const pixels = typeof size === "number" ? size : parseFloat(size) / 100 * available.value;
  return clamp(pixels);
});
const tracks = computed(() => {
  if (props.compact === "first") return "auto minmax(0, 1fr)";
  if (props.compact === "second") return "minmax(0, 1fr) auto";
  return `${firstSize.value}px 8px ${available.value - firstSize.value}px`;
});

onMounted(() => {
  measure();
  observer = new ResizeObserver(measure);
  observer.observe(root.value!);
});

watch([direction, () => props.compact, () => props.sizes], () => finishDrag(false));
onBeforeUnmount(() => {
  finishDrag(false);
  observer?.disconnect();
});

function startDrag(event: PointerEvent) {
  if (props.compact || drag.value || event.button !== 0 || event.isPrimary === false) return;

  const divider = event.currentTarget as HTMLElement;
  event.preventDefault();
  divider.focus({ preventScroll: true });
  divider.setPointerCapture(event.pointerId);
  drag.value = {
    pointerId: event.pointerId,
    position: pointerPosition(event, direction.value),
    size: firstSize.value,
    direction: direction.value,
    source: divider,
  };
}

function moveDrag(event: PointerEvent) {
  const gesture = drag.value;
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  if (props.compact || gesture.direction !== direction.value) {
    finishDrag(false);
    return;
  }

  previewSize.value = clamp(gesture.size + pointerPosition(event, gesture.direction) - gesture.position);
}

function endDrag(event: PointerEvent) {
  if (drag.value?.pointerId !== event.pointerId) return;

  finishDrag(event.type === "pointerup");
}

function finishDrag(commit: boolean) {
  const gesture = drag.value;
  if (!gesture) return;

  const preview = previewSize.value;
  drag.value = null;
  previewSize.value = null;
  if (gesture.source.hasPointerCapture(gesture.pointerId)) gesture.source.releasePointerCapture(gesture.pointerId);
  if (commit && preview !== null && preview !== gesture.size) setSize(preview);
}

function handleKeydown(event: KeyboardEvent) {
  if (props.compact || event.altKey || event.ctrlKey || event.metaKey) return;

  const decrease = direction.value === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const increase = direction.value === "horizontal" ? "ArrowRight" : "ArrowDown";
  const step = event.shiftKey ? 48 : 16;
  switch (event.key) {
    case decrease:
      setSize(firstSize.value - step);
      break;
    case increase:
      setSize(firstSize.value + step);
      break;
    case "Home":
      setSize(props.minFirst);
      break;
    case "End":
      setSize(maximum.value);
      break;
    default:
      return;
  }

  event.preventDefault();
}

function resetSize() {
  if (props.compact) return;
  updateSize(props.initialSize);
}

function setSize(pixels: number) {
  const size = clamp(pixels);
  updateSize(typeof props.initialSize === "number"
    ? size
    : `${size / available.value * 100}%`);
}

function updateSize(size: number | `${number}%`) {
  const updated = { ...sizes.value, [direction.value]: size };
  internalSizes.value = updated;
  emit("update:sizes", { ...updated });
}

function measure() {
  const rect = root.value!.getBoundingClientRect();
  // Hidden tab panels have no geometry; keep their last visible measurements.
  if (rect.width === 0 || rect.height === 0) return;

  bounds.width = rect.width;
  bounds.height = rect.height;
}

function clamp(size: number) {
  return Math.max(props.minFirst, Math.min(maximum.value, size));
}

function pointerPosition(event: PointerEvent, axis: Direction) {
  return axis === "horizontal" ? event.clientX : event.clientY;
}
</script>

<template>
  <div
    ref="root"
    class="split-pane"
    :class="{ 'is-dragging': drag !== null }"
    :data-direction="direction"
    :style="direction === 'horizontal' ? { gridTemplateColumns: tracks } : { gridTemplateRows: tracks }"
  >
    <div :id="firstId" class="split-region"><slot name="first" /></div>
    <div
      v-show="!compact"
      class="split-divider"
      role="separator"
      tabindex="0"
      :aria-label="label"
      :aria-controls="firstId"
      :aria-orientation="direction === 'horizontal' ? 'vertical' : 'horizontal'"
      :aria-valuemin="Math.round(minFirst / available * 100)"
      :aria-valuemax="Math.round(maximum / available * 100)"
      :aria-valuenow="Math.round(firstSize / available * 100)"
      :aria-valuetext="`${Math.round(firstSize)} pixels`"
      title="Drag to resize. Use arrow keys, or double-click to reset."
      @pointerdown="startDrag"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @lostpointercapture="endDrag"
      @keydown="handleKeydown"
      @dblclick="resetSize"
    ><span aria-hidden="true" /></div>
    <div class="split-region"><slot name="second" /></div>
  </div>
</template>

<style scoped>
.split-pane {
  display: grid;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.split-pane[data-direction="horizontal"] {
  grid-template-rows: minmax(0, 1fr);
}

.split-pane[data-direction="vertical"] {
  grid-template-columns: minmax(0, 1fr);
}

.split-region {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.split-divider {
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  user-select: none;
  cursor: col-resize;
  outline: none;
}

.split-divider > span {
  width: 1px;
  height: 100%;
  background: var(--color-border);
  transition: background .12s;
}

.split-pane[data-direction="vertical"] > .split-divider {
  cursor: row-resize;
}

.split-pane[data-direction="vertical"] > .split-divider > span {
  width: 100%;
  height: 1px;
}

.split-divider:hover, .split-divider:focus-visible, .is-dragging > .split-divider {
  background: #8baaff14;
}

.split-divider:hover > span, .split-divider:focus-visible > span, .is-dragging > .split-divider > span {
  background: var(--color-focus);
}

.is-dragging {
  user-select: none;
}
</style>
