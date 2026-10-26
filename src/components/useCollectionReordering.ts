// Owns collection pointer gestures and their resources; hierarchy changes remain in the collection owner.
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from "vue";
import { moveCollectionNode, type CollectionPlacement } from "../collections";
import type { CollectionNode } from "./collectionTree";

/** Dependencies of one rendered collection; the composable never retains a copy of its data. */
export interface CollectionReorderingOptions {
  /** Mounted collection containing row, subtree, empty-folder, and root-drop identities. */
  readonly root: Ref<HTMLElement | undefined>;
  /** Latest hierarchy, used again at release to reject stale or ineffective placements. */
  readonly nodes: Readonly<Ref<readonly CollectionNode[]>>;
  /** Whether organization is available; becoming false cancels pending and active gestures. */
  readonly enabled: Readonly<Ref<boolean>>;
  /** Remembered expansion, kept separate from temporary expansion during this gesture. */
  readonly expandedFolderIds: Readonly<Ref<ReadonlySet<string>>>;
  /** Commits exactly one effective placement after a valid pointer release. */
  readonly commit: (id: string, placement: CollectionPlacement) => void;
}

/** Visible feedback tied to an existing row, or to the explicit root-append target. */
export interface CollectionDropTarget {
  /** Row or empty-folder identity; null identifies the collection-root target. */
  readonly id: string | null;
  /** An after marker belongs below the target's entire subtree. */
  readonly position: "before" | "inside" | "after" | "root";
}

interface CollectionGesture {
  readonly pointerId: number;
  readonly id: string;
  /** Original handle owns capture even while the pointer is over another row. */
  readonly source: HTMLElement;
  readonly startX: number;
  readonly startY: number;
  readonly x: number;
  readonly y: number;
  /** Feedback and click suppression begin only after the movement threshold. */
  readonly dragging: boolean;
}

interface MeasuredRow {
  readonly id: string;
  readonly element: HTMLElement;
  readonly bounds: DOMRect;
}

interface IndexedNode {
  readonly node: CollectionNode;
  readonly parentId: string | null;
}

interface CollectionGeometry {
  readonly root: DOMRect;
  readonly port: DOMRect;
  readonly rows: readonly MeasuredRow[];
  readonly emptyFolders: readonly { id: string; bounds: DOMRect }[];
  readonly rootDrop: DOMRect | null;
}

interface Destination {
  readonly feedback: CollectionDropTarget;
  readonly placement: CollectionPlacement;
}

/** Adds precise mouse/pen movement while leaving selection, expansion memory, and saved data with the owner. */
export function useCollectionReordering(options: CollectionReorderingOptions) {
  const indexedNodes = computed(() => indexNodes(options.nodes.value));
  const gesture = shallowRef<CollectionGesture | null>(null);
  const dropTarget = shallowRef<CollectionDropTarget | null>(null);
  // Temporary IDs survive pointer movement into expanded descendants, then clear on every gesture exit.
  const hoverExpandedIds = shallowRef<ReadonlySet<string>>(new Set());
  const draggedId = computed(() => gesture.value?.dragging ? gesture.value.id : null);
  // A capture-retargeted release click must stay suppressed after the gesture itself has been cleared.
  let suppressedPointer: number | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverId: string | null = null;
  let frame: number | null = null;
  let previousTime: number | null = null;
  // Geometry survives pointer-only movement; scrolling, expansion, resize, and node changes invalidate it.
  let geometry: CollectionGeometry | null = null;
  let resizeObserver: ResizeObserver | undefined;
  // Windowed rows can change without changing the collection's total dimensions.
  let rowObserver: MutationObserver | undefined;
  // Repeated movement within one target need not construct the same candidate tree again.
  let validated: { nodes: readonly CollectionNode[]; target: CollectionDropTarget; result: Destination | null } | null = null;

  onMounted(() => {
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("pointerdown", prepareClick, true);
    // Cancel before a containing drawer or dialog handles the same Escape key.
    window.addEventListener("keydown", handleEscape, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("resize", invalidateGeometry);
    document.addEventListener("scroll", invalidateGeometry, true);
    resizeObserver = new ResizeObserver(invalidateGeometry);
    rowObserver = new MutationObserver(invalidateGeometry);
    if (options.root.value) {
      resizeObserver.observe(options.root.value);
      rowObserver.observe(options.root.value, { childList: true, subtree: true });
    }
  });
  onBeforeUnmount(() => {
    cancel();
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", pointerCancel);
    window.removeEventListener("pointerdown", prepareClick, true);
    window.removeEventListener("keydown", handleEscape, true);
    window.removeEventListener("blur", cancel);
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("resize", invalidateGeometry);
    document.removeEventListener("scroll", invalidateGeometry, true);
    resizeObserver?.disconnect();
    rowObserver?.disconnect();
  });
  watch(options.enabled, enabled => { if (!enabled) cancel(); }, { flush: "sync" });
  watch(options.nodes, () => {
    if (gesture.value && !indexedNodes.value.has(gesture.value.id)) cancel();
    else void nextTick(invalidateGeometry);
  }, { flush: "sync" });
  watch(options.expandedFolderIds, () => { void nextTick(invalidateGeometry); });
  watch(options.root, (root, previous) => {
    if (previous) resizeObserver?.unobserve(previous);
    rowObserver?.disconnect();
    if (root) {
      resizeObserver?.observe(root);
      rowObserver?.observe(root, { childList: true, subtree: true });
    } else cancel();
    invalidateGeometry();
  }, { flush: "sync" });

  function start(event: PointerEvent, id: string) {
    if (!options.enabled.value || gesture.value || event.button !== 0 || event.isPrimary === false) return;
    if (event.pointerType === "touch" || !indexedNodes.value.has(id)) return;
    const source = event.currentTarget;
    if (!(source instanceof HTMLElement) || !options.root.value?.contains(source)) return;

    suppressedPointer = null;
    gesture.value = {
      pointerId: event.pointerId, id, source,
      startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, dragging: false,
    };
    source.addEventListener("lostpointercapture", captureLost);
    // Window listeners also support environments without pointer capture and a handle removed by its owner.
    try { source.setPointerCapture?.(event.pointerId); } catch { /* A released pointer cannot be captured. */ }
  }

  function cancel() {
    if (gesture.value) suppressedPointer = gesture.value.pointerId;
    clearGesture();
  }

  function suppressClick(event: MouseEvent): boolean {
    if (suppressedPointer === null || event.detail === 0) return false;
    if ("pointerId" in event && event.pointerId !== suppressedPointer) return false;

    suppressedPointer = null;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function move(event: PointerEvent) {
    const current = gesture.value;
    if (!current || event.pointerId !== current.pointerId) return;

    const dragging = current.dragging || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= 6;
    gesture.value = { ...current, x: event.clientX, y: event.clientY, dragging };
    if (!dragging) return;

    suppressedPointer = current.pointerId;
    event.preventDefault();
    scheduleRefresh();
  }

  function end(event: PointerEvent) {
    const current = gesture.value;
    if (!current || event.pointerId !== current.pointerId) return;

    gesture.value = { ...current, x: event.clientX, y: event.clientY };
    // Release always uses current layout and validates against current owner data, even before the next frame.
    geometry = null;
    validated = null;
    const target = current.dragging ? destination() : null;
    if (current.dragging || !withinCollection(gesture.value)) suppressedPointer = current.pointerId;
    clearGesture();
    if (target) options.commit(current.id, target.placement);
  }

  function clearGesture() {
    const current = gesture.value;
    gesture.value = null;
    dropTarget.value = null;
    hoverExpandedIds.value = new Set();
    stopHover();
    stopScrolling();
    geometry = null;
    validated = null;
    current?.source.removeEventListener("lostpointercapture", captureLost);
    if (current?.source.hasPointerCapture?.(current.pointerId)) {
      current.source.releasePointerCapture(current.pointerId);
    }
  }

  function refresh() {
    const target = destination();
    const feedback = target?.feedback ?? null;
    if (!sameTarget(dropTarget.value, feedback)) dropTarget.value = feedback;
    updateHover(target?.feedback ?? null);
  }

  function destination(): Destination | null {
    const current = gesture.value;
    const root = options.root.value;
    if (!current?.dragging || !root || !withinCollection(current)) return null;

    const nodes = options.nodes.value;
    const expansion = new Set([...options.expandedFolderIds.value, ...hoverExpandedIds.value]);
    const feedback = hitTarget(currentGeometry()!, indexedNodes.value, expansion, current);
    if (!feedback) return null;
    if (validated?.nodes === nodes && sameTarget(validated.target, feedback)) return validated.result;
    const placement = placementFor(nodes, indexedNodes.value, feedback, current.id);
    if (!placement) return null;

    let result: Destination | null = null;
    try {
      if (moveCollectionNode({ requests: {}, nodes }, current.id, placement).nodes !== nodes) result = { feedback, placement };
    } catch {
      // Stale rows, cycles, and removed anchors are invalid feedback as well as invalid commits.
    }
    validated = { nodes, target: feedback, result };
    return result;
  }

  function withinCollection(point: { x: number; y: number }): boolean {
    const measured = currentGeometry();
    return measured !== null && inside(point, measured.root) && inside(point, measured.port);
  }

  function updateHover(target: CollectionDropTarget | null) {
    const id = target?.position === "inside" ? target.id : null;
    if (!id || options.expandedFolderIds.value.has(id) || hoverExpandedIds.value.has(id)) {
      stopHover();
      return;
    }
    if (hoverId === id) return;

    stopHover();
    hoverId = id;
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      hoverId = null;
      if (!gesture.value?.dragging) return;
      hoverExpandedIds.value = new Set([...hoverExpandedIds.value, id]);
      void nextTick(invalidateGeometry);
    }, 650);
  }

  function stopHover() {
    if (hoverTimer !== null) clearTimeout(hoverTimer);
    hoverTimer = null;
    hoverId = null;
  }

  function scrollVelocity(): number {
    const current = gesture.value;
    const root = options.root.value;
    if (!current?.dragging || !root || !withinCollection(current)) return 0;
    const port = scrollport(root);
    const bounds = currentGeometry()!.port;
    const zone = Math.min(36, bounds.height / 2);
    if (zone === 0) return 0;
    if (current.y < bounds.top + zone && port.scrollTop > 0) {
      return -600 * (1 - (current.y - bounds.top) / zone);
    }
    if (current.y > bounds.bottom - zone && port.scrollTop < port.scrollHeight - port.clientHeight) {
      return 600 * (1 - (bounds.bottom - current.y) / zone);
    }
    return 0;
  }

  function scheduleRefresh() {
    if (gesture.value?.dragging && frame === null) frame = requestAnimationFrame(refreshFrame);
  }

  function invalidateGeometry() {
    geometry = null;
    scheduleRefresh();
  }

  function currentGeometry(): CollectionGeometry | null {
    const root = options.root.value;
    if (!root) return null;
    geometry ??= measureGeometry(root, indexedNodes.value);
    return geometry;
  }

  function refreshFrame(time: number) {
    frame = null;
    const root = options.root.value;
    const velocity = scrollVelocity();
    if (!root || !gesture.value?.dragging) return;

    if (velocity !== 0) {
      const port = scrollport(root);
      const elapsed = previousTime === null ? 0 : Math.min(64, time - previousTime);
      previousTime = time;
      port.scrollTop = Math.max(0, Math.min(port.scrollHeight - port.clientHeight, port.scrollTop + velocity * elapsed / 1000));
      geometry = null;
    } else previousTime = null;
    refresh();
    if (scrollVelocity() !== 0) scheduleRefresh();
  }

  function stopScrolling() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    previousTime = null;
  }

  function prepareClick(event: PointerEvent) {
    if (!gesture.value && event.button === 0 && event.isPrimary !== false) suppressedPointer = null;
  }

  function captureLost(event: PointerEvent) {
    if (event.pointerId === gesture.value?.pointerId) cancel();
  }

  function pointerCancel(event: PointerEvent) {
    if (event.pointerId === gesture.value?.pointerId) cancel();
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key === "Escape" && gesture.value) {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  }

  function visibilityChanged() {
    if (document.hidden) cancel();
  }

  return { start, cancel, suppressClick, draggedId, dropTarget, hoverExpandedIds };
}

function hitTarget(
  geometry: CollectionGeometry,
  indexedNodes: ReadonlyMap<string, IndexedNode>,
  expandedIds: ReadonlySet<string>,
  point: { x: number; y: number },
): CollectionDropTarget | null {
  for (const empty of geometry.emptyFolders) {
    if (inside(point, empty.bounds)) return { id: empty.id, position: "inside" };
  }
  if (geometry.rootDrop && inside(point, geometry.rootDrop)) {
    return { id: null, position: "root" };
  }
  const rows = geometry.rows;
  const row = rows.find(candidate => point.y >= candidate.bounds.top && point.y <= candidate.bounds.bottom)
    ?? rows.find(candidate => Math.min(Math.abs(point.y - candidate.bounds.top), Math.abs(point.y - candidate.bounds.bottom)) <= 6);
  if (!row) return null;

  const portion = (point.y - row.bounds.top) / row.bounds.height;
  const folder = indexedNodes.get(row.id)?.node.kind === "folder";
  if (folder && portion >= 0.25 && portion <= 0.75 && point.x >= row.bounds.left + 16) {
    return { id: row.id, position: "inside" };
  }
  if (portion < 0.5) return { id: row.id, position: "before" };

  // Hierarchy identities, rather than DOM ancestry, also cover virtualized ancestors.
  // Only an ancestor whose final visible descendant is this row owns this boundary.
  let boundaryId = row.id;
  let boundaryLeft = row.bounds.left;
  let parentId = indexedNodes.get(row.id)?.parentId;
  while (parentId) {
    const parent = indexedNodes.get(parentId);
    if (!parent || lastVisibleId(parent.node, expandedIds) !== row.id) break;
    const measuredParent = rows.find(candidate => candidate.id === parentId);
    const parentLeft = measuredParent?.bounds.left ?? boundaryLeft - 21;
    if (point.x >= boundaryLeft - 8) break;
    boundaryId = parentId;
    boundaryLeft = parentLeft;
    parentId = parent.parentId;
  }
  return { id: boundaryId, position: "after" };
}

function lastVisibleId(node: CollectionNode, expandedIds: ReadonlySet<string>): string {
  if (node.kind !== "folder" || !expandedIds.has(node.id) || !node.children.length) return node.id;
  return lastVisibleId(node.children[node.children.length - 1]!, expandedIds);
}

function placementFor(
  nodes: readonly CollectionNode[], indexedNodes: ReadonlyMap<string, IndexedNode>,
  target: CollectionDropTarget, sourceId: string,
): CollectionPlacement | null {
  if (target.position === "root") return { parentId: null, beforeId: null };
  const entry = target.id ? indexedNodes.get(target.id) : undefined;
  if (!entry) return null;
  if (target.position === "inside") return { parentId: target.id, beforeId: null };

  const parentId = entry.parentId;
  if (target.position === "before") return { parentId, beforeId: target.id };
  const parent = parentId === null ? undefined : indexedNodes.get(parentId)?.node;
  const siblings = (parent?.kind === "folder" ? parent.children : nodes).filter(node => node.id !== sourceId);
  const position = siblings.findIndex(node => node.id === target.id);
  if (position === -1) return null;
  return { parentId, beforeId: siblings[position + 1]?.id ?? null };
}

function indexNodes(nodes: readonly CollectionNode[]): ReadonlyMap<string, IndexedNode> {
  const indexed = new Map<string, IndexedNode>();
  function visit(entries: readonly CollectionNode[], parentId: string | null) {
    for (const node of entries) {
      indexed.set(node.id, { node, parentId });
      if (node.kind === "folder") visit(node.children, node.id);
    }
  }
  visit(nodes, null);
  return indexed;
}

function measureGeometry(root: HTMLElement, indexedNodes: ReadonlyMap<string, IndexedNode>): CollectionGeometry {
  const rows: MeasuredRow[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("[data-collection-row]")) {
    const id = element.dataset.collectionRow!;
    const bounds = indexedNodes.has(id) ? visibleBounds(element) : null;
    if (bounds) rows.push({ id, element, bounds });
  }
  const emptyFolders: { id: string; bounds: DOMRect }[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("[data-collection-empty]")) {
    const bounds = visibleBounds(element);
    if (bounds) emptyFolders.push({ id: element.dataset.collectionEmpty!, bounds });
  }
  const rootDrop = root.querySelector<HTMLElement>("[data-collection-root-drop]");
  return {
    root: root.getBoundingClientRect(), port: scrollport(root).getBoundingClientRect(), rows, emptyFolders,
    rootDrop: rootDrop ? visibleBounds(rootDrop) : null,
  };
}

function visibleBounds(element: HTMLElement): DOMRect | null {
  const bounds = element.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hidden || ancestor.style.display === "none") return null;
  }
  return bounds;
}

function sameTarget(left: CollectionDropTarget | null, right: CollectionDropTarget | null): boolean {
  return left === right || (left !== null && right !== null && left.id === right.id && left.position === right.position);
}

function scrollport(root: HTMLElement): HTMLElement {
  const sidebar = root.closest<HTMLElement>(".sidebar-view");
  if (sidebar) return sidebar;
  for (let ancestor: HTMLElement | null = root; ancestor; ancestor = ancestor.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(ancestor).overflowY)) return ancestor;
  }
  return root;
}

function inside(point: { x: number; y: number }, bounds: DOMRect): boolean {
  return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
}
