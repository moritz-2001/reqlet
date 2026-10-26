// Owns a tab strip's pointer gesture and scrolling resources; useTabReordering commits through Tabs' move operation.
import { computed, onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from "vue";
import { moveTab } from "./tabOrder";
import type { TabItem } from "./tabs";

/** Dependencies of a single strip's pointer interaction; tab state remains in Tabs. */
interface TabReorderingOptions {
  /** Mounted scroll container, also used to measure candidate entries and draw the insertion marker. */
  readonly strip: Ref<HTMLElement | undefined>;
  /** Current capability; turning it off cancels any pending or active gesture. */
  readonly enabled: Readonly<Ref<boolean>>;
  /** Current ordered descriptors, read for ineffective-move detection without mutating them. */
  readonly items: Readonly<Ref<readonly TabItem[]>>;
  /** Commits one effective move after release; null appends the source to the strip. */
  readonly commit: (id: string, beforeId: string | null) => void;
  /** Large virtual strips supply a uniform width so destinations include unmounted descriptors. */
  readonly itemWidth?: Readonly<Ref<number | undefined>>;
  /** Refreshes the caller's rendered window after this gesture moves its scroll position. */
  readonly scrolled?: () => void;
}

/** Owns pointer capture from press until release or cancellation. */
interface TabGesture {
  /** Pointer accepted on primary press; other pointers cannot update or finish this gesture. */
  readonly pointerId: number;
  /** Application identity of the source; kept separate from measured DOM entries. */
  readonly id: string;
  /** Original button that owns capture and must release it during every cleanup path. */
  readonly source: HTMLElement;
  /** Horizontal press position; crossing six CSS pixels transitions pending to dragging. */
  readonly startX: number;
  /** Latest viewport coordinates, updated on movement and reused when scrolling without movement. */
  readonly x: number;
  /** Latest vertical viewport coordinate; positions outside the strip cannot drop or scroll. */
  readonly y: number;
  /** False while a click is still possible; once true, the corresponding click is suppressed. */
  readonly dragging: boolean;
}

/** Adds mouse/pen reordering without owning tab membership, selection, or editor content. */
export function useTabReordering(options: TabReorderingOptions) {
  // Null means idle. Capture starts on press; only crossing the threshold enables feedback and scrolling.
  const gesture = shallowRef<TabGesture | null>(null);
  // Content-space marker coordinate, recomputed from live geometry. Null hides it outside valid, effective targets.
  const marker = shallowRef<number | null>(null);
  // Persists after cancellation until the gesture's click or next primary press; keyboard clicks remain usable.
  let suppressedPointer: number | null = null;
  // One outstanding animation frame and its preceding timestamp; both reset whenever edge scrolling stops.
  let frame: number | null = null;
  let previousTime: number | null = null;

  const draggedId = computed(() => gesture.value?.dragging ? gesture.value.id : null);

  onMounted(() => {
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", handleEscape);
  });
  onBeforeUnmount(() => {
    cancel();
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", handleEscape);
  });
  watch(options.enabled, enabled => { if (!enabled) cancel(); }, { flush: "sync" });

  function start(event: PointerEvent, id: string) {
    if (!options.enabled.value || gesture.value || event.button !== 0 || event.isPrimary === false) return;
    if (event.pointerType === "touch") return;

    const source = event.currentTarget as HTMLElement;
    gesture.value = {
      pointerId: event.pointerId,
      id,
      source,
      startX: event.clientX,
      x: event.clientX,
      y: event.clientY,
      dragging: false,
    };
    source.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent) {
    const current = gesture.value;
    if (!current || event.pointerId !== current.pointerId) return;

    const dragging = current.dragging || Math.abs(event.clientX - current.startX) >= 6;
    gesture.value = { ...current, x: event.clientX, y: event.clientY, dragging };
    if (!dragging) return;

    suppressedPointer = current.pointerId;
    event.preventDefault();
    refresh();
  }

  function end(event: PointerEvent) {
    const current = gesture.value;
    if (!current || event.pointerId !== current.pointerId) return;

    gesture.value = { ...current, x: event.clientX, y: event.clientY };
    const target = current.dragging ? destination() : null;
    const strip = options.strip.value;
    // Capture also retargets the eventual click. A release outside must not activate
    // the captured button, even when horizontal movement never crossed the threshold.
    if (current.dragging || !strip || !inside(gesture.value, strip.getBoundingClientRect())) {
      suppressedPointer = current.pointerId;
    }
    clearGesture();
    if (target) options.commit(current.id, target.beforeId);
  }

  function cancel() {
    if (gesture.value) suppressedPointer = gesture.value.pointerId;
    clearGesture();
  }

  function clearGesture() {
    const current = gesture.value;
    gesture.value = null;
    marker.value = null;
    stopScrolling();
    if (current?.source.hasPointerCapture(current.pointerId)) {
      current.source.releasePointerCapture(current.pointerId);
    }
  }

  function captureLost(event: PointerEvent) {
    if (event.pointerId === gesture.value?.pointerId) cancel();
  }

  function prepareClick(event: PointerEvent) {
    if (!gesture.value && event.button === 0 && event.isPrimary !== false) suppressedPointer = null;
  }

  function suppressClick(event: MouseEvent) {
    if (suppressedPointer === null || event.detail === 0) return;
    if ("pointerId" in event && event.pointerId !== suppressedPointer) return;

    suppressedPointer = null;
    event.preventDefault();
    event.stopPropagation();
  }

  function refresh() {
    marker.value = destination()?.position ?? null;
    if (scrollVelocity() === 0) stopScrolling();
    else if (frame === null) frame = requestAnimationFrame(scroll);
  }

  function destination() {
    const current = gesture.value;
    const strip = options.strip.value;
    if (!current?.dragging || !strip || !inside(current, strip.getBoundingClientRect())) return null;

    const width = options.itemWidth?.value;
    if (width) {
      const bounds = strip.getBoundingClientRect();
      const index = Math.max(0, Math.min(options.items.value.length,
        Math.floor((current.x - bounds.left + strip.scrollLeft + width / 2) / width)));
      const sourceIndex = options.items.value.findIndex(item => item.id === current.id);
      if (sourceIndex < 0 || index === sourceIndex || index === sourceIndex + 1) return null;

      const edge = bounds.left + index * width - strip.scrollLeft;
      return {
        beforeId: options.items.value[index]?.id ?? null,
        position: Math.max(bounds.left + 1, Math.min(bounds.right - 2, edge)) - bounds.left + strip.scrollLeft,
      };
    }

    const entries = [...strip.querySelectorAll<HTMLElement>("[data-tab-id]")]
      .filter(entry => entry.dataset.tabId !== current.id)
      .map(entry => ({ id: entry.dataset.tabId!, bounds: entry.getBoundingClientRect() }));
    const before = entries.find(entry => current.x < entry.bounds.left + entry.bounds.width / 2);
    const beforeId = before?.id ?? null;
    if (moveTab(options.items.value, current.id, beforeId) === options.items.value) return null;

    const bounds = strip.getBoundingClientRect();
    const edge = before?.bounds.left ?? entries[entries.length - 1]?.bounds.right ?? bounds.left;
    const visibleEdge = Math.max(bounds.left + 1, Math.min(bounds.right - 2, edge));
    return { beforeId, position: visibleEdge - bounds.left + strip.scrollLeft };
  }

  function scrollVelocity() {
    const current = gesture.value;
    const strip = options.strip.value;
    if (!current?.dragging || !strip) return 0;

    const bounds = strip.getBoundingClientRect();
    if (!inside(current, bounds)) return 0;

    const zone = Math.min(32, bounds.width / 2);
    if (current.x < bounds.left + zone && strip.scrollLeft > 0) {
      return -600 * (1 - (current.x - bounds.left) / zone);
    }
    if (current.x > bounds.right - zone && strip.scrollLeft < strip.scrollWidth - strip.clientWidth) {
      return 600 * (1 - (bounds.right - current.x) / zone);
    }
    return 0;
  }

  function scroll(time: number) {
    frame = null;
    const strip = options.strip.value;
    const velocity = scrollVelocity();
    if (!strip || velocity === 0) {
      stopScrolling();
      return;
    }

    const elapsed = previousTime === null ? 0 : Math.min(64, time - previousTime);
    previousTime = time;
    strip.scrollLeft = Math.max(0, Math.min(
      strip.scrollWidth - strip.clientWidth, strip.scrollLeft + velocity * elapsed / 1000,
    ));
    options.scrolled?.();
    marker.value = destination()?.position ?? null;
    if (scrollVelocity() === 0) stopScrolling();
    else frame = requestAnimationFrame(scroll);
  }

  function stopScrolling() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    previousTime = null;
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key === "Escape" && gesture.value) {
      event.preventDefault();
      cancel();
    }
  }

  return { draggedId, marker, start, move, end, cancel, captureLost, prepareClick, suppressClick, refresh };
}

function inside(point: TabGesture, bounds: DOMRect) {
  return point.x >= bounds.left && point.x <= bounds.right
    && point.y >= bounds.top && point.y <= bounds.bottom;
}
