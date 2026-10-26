<!-- VirtualRows bounds mounted rows while measuring their natural heights; callers retain data and focus semantics. -->
<script setup lang="ts" generic="T">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

const props = withDefaults(defineProps<{
  /** Parent-owned ordered records, never copied or mutated by the viewport. */
  items: readonly T[];
  /** Initial height for rows whose natural layout has not yet been measured. */
  estimatedHeight: number;
  /** Small lists keep their original natural layout and complete DOM. */
  threshold?: number;
  /** Bounded scroll viewport used only above the threshold. */
  maxHeight?: number;
  /** Stable presentation identity; omitted uses positions for records without identity-sensitive controls. */
  rowKey?: (item: T, index: number) => string | number;
}>(), { threshold: 80, maxHeight: 320 });

const viewport = ref<HTMLElement>();
const count = computed(() => props.items.length);
const virtual = computed(() => count.value > props.threshold);
// Measurements carry their record identity so a replacement cannot inherit another record's cached height.
const heights = shallowRef<ReadonlyMap<number, { item: T; height: number }>>(new Map());
const scrollTop = ref(0);
const viewportHeight = ref(props.maxHeight);
// Keep the actively edited row mounted if the user scrolls away from it; blur releases this one extra row.
const focusedKey = shallowRef<string | number>();
const keys = computed(() => props.items.map((item, index) => props.rowKey?.(item, index) ?? index));
const offsets = computed(() => {
  const result = [0];
  for (let index = 0; index < count.value; index++) {
    const cached = heights.value.get(index);
    const height = cached && Object.is(cached.item, props.items[index]) ? cached.height : props.estimatedHeight;
    result.push(result[index]! + height);
  }
  return result;
});
const indices = computed(() => {
  if (!virtual.value) return Array.from({ length: count.value }, (_, index) => index);

  const positions = offsets.value;
  const first = Math.max(0, rowAtOffset(positions, scrollTop.value) - 4);
  const last = Math.min(count.value, rowAtOffset(positions, scrollTop.value + viewportHeight.value) + 5);
  const visible = Array.from({ length: last - first }, (_, index) => first + index);
  const focusedIndex = focusedKey.value === undefined ? -1 : keys.value.indexOf(focusedKey.value);
  if (focusedIndex >= 0 && !visible.includes(focusedIndex)) {
    visible.push(focusedIndex);
    visible.sort((left, right) => left - right);
  }
  return visible;
});
let observer: ResizeObserver | undefined;
// Coalesce measurements until the spacer reaches the DOM, retaining the visible row and its pixel inset.
let pendingAnchor: { index: number; inset: number } | undefined;
let revealRevision = 0;

onMounted(() => {
  if (typeof ResizeObserver !== "undefined") observer = new ResizeObserver(measure);
  observeRows();
});
onBeforeUnmount(() => observer?.disconnect());
watch([indices, virtual], () => { void nextTick(observeRows); });
watch(() => props.items, items => {
  const retained = new Map([...heights.value].filter(([index, cached]) => index < items.length && Object.is(cached.item, items[index])));
  if (retained.size !== heights.value.size) heights.value = retained;
});
watch(count, count => {
  if (scrollTop.value > (offsets.value[count] ?? 0)) setScroll(Math.max(0, (offsets.value[count] ?? 0) - viewportHeight.value));
});

defineExpose({ reveal });

function reveal(index: number): Promise<void> | undefined {
  if (!virtual.value || index < 0 || index >= count.value) return;

  return settleReveal(index, ++revealRevision);
}

async function settleReveal(index: number, revision: number) {
  // A first reveal measures the destination; a second settles newly exposed overscan rows.
  // Further passes accommodate unusually tall rows without trusting estimated scroll geometry.
  for (let attempt = 0; attempt < 4 && revision === revealRevision; attempt++) {
    revealPosition(index);
    await nextTick();
    measure();
    await nextTick();
  }
  if (revision !== revealRevision) return;

  revealPosition(index);
  await nextTick();
}

function revealPosition(index: number) {
  const top = offsets.value[index]!;
  const bottom = offsets.value[index + 1]!;
  if (top < scrollTop.value) setScroll(top);
  else if (bottom > scrollTop.value + viewportHeight.value) setScroll(bottom - viewportHeight.value);
}

function setScroll(top: number) {
  const requested = Math.max(0, top);
  if (viewport.value) viewport.value.scrollTop = requested;
  scrollTop.value = viewport.value?.scrollTop ?? requested;
}

function scrolled() {
  scrollTop.value = viewport.value?.scrollTop ?? 0;
  viewportHeight.value = viewport.value?.clientHeight || props.maxHeight;
}

function observeRows() {
  observer?.disconnect();
  if (!virtual.value || !viewport.value) return;

  observer?.observe(viewport.value);
  for (const row of viewport.value.querySelectorAll<HTMLElement>("[data-virtual-row]")) observer?.observe(row);
  measure();
}

function measure() {
  if (!virtual.value || !viewport.value) return;

  viewportHeight.value = viewport.value.clientHeight || props.maxHeight;
  const updated = new Map(heights.value);
  const anchorIndex = rowAtOffset(offsets.value, scrollTop.value);
  const anchor = pendingAnchor ?? { index: anchorIndex, inset: scrollTop.value - offsets.value[anchorIndex]! };
  let changed = false;
  for (const row of viewport.value.querySelectorAll<HTMLElement>("[data-virtual-row]")) {
    const height = row.getBoundingClientRect().height;
    const index = Number(row.dataset.virtualRow);
    const cached = updated.get(index);
    const item = props.items[index]!;
    if (height > 0 && (height !== cached?.height || !Object.is(item, cached.item))) {
      updated.set(index, { item, height });
      changed = true;
    }
  }
  if (!changed) return;

  heights.value = updated;
  if (pendingAnchor) return;

  pendingAnchor = anchor;
  void nextTick(() => {
    pendingAnchor = undefined;
    if (anchor.index >= count.value) return;

    setScroll(offsets.value[anchor.index]! + anchor.inset);
  });
}

function focusChanged(event: FocusEvent) {
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-virtual-row]");
  focusedKey.value = row ? keys.value[Number(row.dataset.virtualRow)] : undefined;
}

function focusLeft(event: FocusEvent) {
  if (!(event.relatedTarget instanceof Node) || !viewport.value?.contains(event.relatedTarget)) focusedKey.value = undefined;
}

function rowAtOffset(positions: readonly number[], offset: number) {
  let lower = 0;
  let upper = positions.length - 1;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (positions[middle]! <= offset) lower = middle;
    else upper = middle - 1;
  }
  return Math.min(lower, Math.max(0, positions.length - 2));
}
</script>

<template>
  <div ref="viewport" class="virtual-rows" :class="{ 'is-virtual': virtual }"
    :style="virtual ? { maxHeight: `${maxHeight}px` } : undefined"
    @scroll.passive="scrolled" @focusin="focusChanged" @focusout="focusLeft">
    <div class="virtual-content" :style="virtual ? { height: `${offsets[count]}px`, position: 'relative' } : undefined">
      <div v-for="index in indices" :key="keys[index]" :data-virtual-row="index"
        :style="virtual ? { position: 'absolute', top: `${offsets[index]}px`, left: 0, right: 0 } : undefined">
        <slot :index="index" :item="items[index]!" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.virtual-rows { min-width: 0; }
.is-virtual { overflow: auto; overflow-anchor: none; }
</style>
