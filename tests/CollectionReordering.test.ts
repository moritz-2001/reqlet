// Exercises collection gestures through rendered handles and placement feedback using a small controlled hierarchy.
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, defineComponent, h, nextTick, ref, shallowRef, watch, type PropType, type VNode } from "vue";
import { moveCollectionNode, type CollectionPlacement } from "../src/collections";
import type { CollectionNode } from "../src/components/collectionTree";
import { useCollectionReordering } from "../src/components/useCollectionReordering";

let clock: ReturnType<typeof animationClock>;
beforeEach(() => { clock = animationClock(); });

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("Collection pointer movement", () => {
  it("updates a stationary pointer's target after its scrollport moves", async () => {
    const wrapper = render({ expanded: ["folder", "nested"], viewportHeight: 112 });
    await press(wrapper, "first");
    await point(wrapper, "pointermove", 110, 90);
    expect(feedback(wrapper)).toBe("before:folder");
    const port = wrapper.get<HTMLElement>(".sidebar-view").element;
    port.scrollTop = 64;
    port.dispatchEvent(new Event("scroll"));
    await clock.tick(0);
    expect(feedback(wrapper)).toBe("before:leaf");
    await point(wrapper, "pointerup", 110, 90);
    expect(wrapper.emitted("move")).toEqual([["first", { parentId: "nested", beforeId: "leaf" }]]);
  });

  it("coalesces pointer bursts and commits current release geometry before a queued frame", async () => {
    const wrapper = render();
    await press(wrapper, "second");
    await dispatch(wrapper.element, "pointermove", { clientX: 110, clientY: 23 });
    await dispatch(wrapper.element, "pointermove", { clientX: 110, clientY: 25 });
    await dispatch(wrapper.element, "pointermove", { clientX: 110, clientY: 23 });
    expect(feedback(wrapper)).toBe("");
    expect(clock.pending()).toBe(1);
    await clock.tick(0);
    expect(feedback(wrapper)).toBe("before:first");
    expect(clock.pending()).toBe(0);
    await dispatch(wrapper.element, "pointermove", { clientX: 110, clientY: 25 });
    await point(wrapper, "pointerup", 150, 100);
    expect(wrapper.emitted("move")).toEqual([["second", { parentId: "folder", beforeId: null }]]);
    expect(clock.pending()).toBe(0);
  });

  it("previews precise sibling order and commits once without selecting the source", async () => {
    const wrapper = render();
    await press(wrapper, "second");
    await point(wrapper, "pointermove", 110, 23);
    expect(feedback(wrapper)).toBe("before:first");
    expect(order(wrapper)).toEqual(["first", "second", "folder", "empty"]);
    await point(wrapper, "pointerup", 110, 23);
    expect(order(wrapper)).toEqual(["second", "first", "folder", "empty"]);
    expect(wrapper.emitted("move")).toEqual([["second", { parentId: null, beforeId: "first" }]]);
    await point(wrapper, "pointerup", 110, 23);
    expect(wrapper.emitted("move")).toHaveLength(1);
    expect(feedback(wrapper)).toBe("");
    await click(handle(wrapper, "second"), 1);
    expect(wrapper.emitted("select")).toBeUndefined();
    await click(handle(wrapper, "second"), 0);
    expect(wrapper.emitted("select")).toEqual([["second"]]);
  });

  it("uses folder centers, explicit empty folders, and root append targets", async () => {
    const wrapper = render();
    await press(wrapper, "first");
    await point(wrapper, "pointermove", 150, 100);
    expect(feedback(wrapper)).toBe("inside:folder");
    await point(wrapper, "pointerup", 150, 100);
    expect(wrapper.emitted("move")?.at(-1)).toEqual(["first", { parentId: "folder", beforeId: null }]);

    await press(wrapper, "second");
    await point(wrapper, "pointermove", 150, 100);
    expect(feedback(wrapper)).toBe("inside:empty");
    await point(wrapper, "pointerup", 150, 100);
    expect(wrapper.emitted("move")?.at(-1)).toEqual(["second", { parentId: "empty", beforeId: null }]);

    await wrapper.setProps({ expanded: ["folder", "empty"] });
    await press(wrapper, "first");
    const rootDrop = wrapper.get<HTMLElement>("[data-collection-root-drop]").element.getBoundingClientRect();
    await point(wrapper, "pointermove", 120, rootDrop.top + 16);
    expect(feedback(wrapper)).toBe("root:");
    await point(wrapper, "pointerup", 120, rootDrop.top + 16);
    expect(wrapper.emitted("move")?.at(-1)).toEqual(["first", { parentId: null, beforeId: null }]);
  });

  it("places outdented boundaries after complete expanded subtrees", async () => {
    const wrapper = render({ expanded: ["folder", "nested"] });
    await press(wrapper, "first");
    const leaf = row(wrapper, "leaf").getBoundingClientRect();
    await point(wrapper, "pointermove", 105, leaf.bottom - 2);
    expect(feedback(wrapper)).toBe("after:folder");
    await point(wrapper, "pointerup", 105, leaf.bottom - 2);
    expect(wrapper.emitted("move")?.at(-1)).toEqual(["first", { parentId: null, beforeId: "empty" }]);
    expect(order(wrapper)).toEqual(["second", "folder", "nested", "leaf", "first", "empty"]);
  });

  it("uses current release geometry and ignores foreign pointer events", async () => {
    const wrapper = render();
    await press(wrapper, "first");
    await point(wrapper, "pointermove", 150, 100, { pointerId: 2 });
    expect(feedback(wrapper)).toBe("");
    await point(wrapper, "pointermove", 110, 80);
    expect(feedback(wrapper)).toBe("after:second");
    await point(wrapper, "pointerup", 150, 100);
    expect(wrapper.emitted("move")?.at(-1)).toEqual(["first", { parentId: "folder", beforeId: null }]);
  });

  it("suppresses ineffective drops, self placement, and folder cycles", async () => {
    const wrapper = render({ expanded: ["folder", "nested"] });
    await press(wrapper, "first");
    await point(wrapper, "pointermove", 110, 54);
    expect(feedback(wrapper)).toBe(""); // Already immediately before second.
    await point(wrapper, "pointerup", 110, 54);
    expect(wrapper.emitted("move")).toBeUndefined();

    await press(wrapper, "folder");
    const nested = row(wrapper, "nested").getBoundingClientRect();
    await point(wrapper, "pointermove", nested.left + 30, nested.top + 16);
    expect(feedback(wrapper)).toBe("");
    await point(wrapper, "pointerup", nested.left + 30, nested.top + 16);
    expect(wrapper.emitted("move")).toBeUndefined();
  });

  it.each([{ pointerType: "touch" }, { button: 2 }, { isPrimary: false }])(
    "keeps excluded pointer %j out of the gesture",
    async init => {
      const wrapper = render();
      await press(wrapper, "second", init);
      await point(wrapper, "pointermove", 110, 23);
      await point(wrapper, "pointerup", 110, 23);
      expect(wrapper.emitted("move")).toBeUndefined();
      expect(feedback(wrapper)).toBe("");
    },
  );

  it("keeps small movements clickable and suppresses captured outside releases", async () => {
    const wrapper = render();
    await press(wrapper, "second");
    const bounds = row(wrapper, "second").getBoundingClientRect();
    await point(wrapper, "pointermove", 112, bounds.top + 18);
    await point(wrapper, "pointerup", 112, bounds.top + 18);
    await click(handle(wrapper, "second"), 1);
    expect(wrapper.emitted("select")).toEqual([["second"]]);
    expect(wrapper.emitted("move")).toBeUndefined();

    await press(wrapper, "first");
    await point(wrapper, "pointerup", 20, 20);
    await click(handle(wrapper, "first"), 1);
    expect(wrapper.emitted("select")).toHaveLength(1);
  });

  it.each(["escape", "blur", "pointercancel", "lostpointercapture", "outside", "disable", "remove", "cancel"]) (
    "cancels on %s and releases the handle capture",
    async reason => {
      const wrapper = render();
      const source = handle(wrapper, "second");
      await press(wrapper, "second");
      await point(wrapper, "pointermove", 110, 23);
      expect(feedback(wrapper)).toBe("before:first");
      switch (reason) {
        case "escape": window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); break;
        case "blur": window.dispatchEvent(new Event("blur")); break;
        case "disable": await wrapper.setProps({ enabled: false }); break;
        case "remove": await wrapper.setProps({ nodes: initialNodes.filter(node => node.id !== "second") }); break;
        case "cancel": await wrapper.get("[data-cancel]").trigger("click"); break;
        case "outside": await point(wrapper, "pointerup", 10, 10); break;
        default: await dispatch(source, reason); break;
      }
      await nextTick();
      await point(wrapper, "pointerup", 110, 23);
      expect(wrapper.emitted("move")).toBeUndefined();
      expect(feedback(wrapper)).toBe("");
      expect(source.hasPointerCapture(1)).toBe(false);
    },
  );

  it("rejects a target removed after preview instead of committing a stale placement", async () => {
    const wrapper = render();
    await press(wrapper, "first");
    await point(wrapper, "pointermove", 150, 100);
    expect(feedback(wrapper)).toBe("inside:folder");
    await wrapper.setProps({ nodes: initialNodes.filter(node => node.id !== "folder" && node.id !== "empty") });
    await point(wrapper, "pointerup", 150, 350);
    expect(wrapper.emitted("move")).toBeUndefined();
  });

  it("consumes an active gesture's Escape before a containing drawer handles it", async () => {
    const wrapper = render();
    const dismissDrawer = vi.fn();
    wrapper.element.addEventListener("keydown", dismissDrawer);
    await press(wrapper, "second");
    await point(wrapper, "pointermove", 110, 23);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handle(wrapper, "second").dispatchEvent(escape);
    await nextTick();
    expect(escape.defaultPrevented).toBe(true);
    expect(dismissDrawer).not.toHaveBeenCalled();
    expect(feedback(wrapper)).toBe("");
    handle(wrapper, "second").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dismissDrawer).toHaveBeenCalledOnce();
  });

  it("temporarily expands a hovered folder and cancels delayed expansion when it is left", async () => {
    vi.useFakeTimers();
    const wrapper = render();
    await press(wrapper, "first");
    await point(wrapper, "pointermove", 150, 100);
    await vi.advanceTimersByTimeAsync(649);
    expect(wrapper.find('[data-collection-row="nested"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(wrapper.find('[data-collection-row="nested"]').exists()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    await nextTick();
    expect(wrapper.find('[data-collection-row="nested"]').exists()).toBe(false);

    await press(wrapper, "first");
    await point(wrapper, "pointermove", 150, 100);
    await point(wrapper, "pointermove", 110, 23);
    await vi.advanceTimersByTimeAsync(700);
    expect(wrapper.find('[data-collection-row="nested"]').exists()).toBe(false);
  });

  it("scrolls with a stationary pointer, recomputes placement, and stops all work on unmount", async () => {
    const wrapper = render({ expanded: ["folder", "nested"], viewportHeight: 112 });
    const port = wrapper.get<HTMLElement>(".sidebar-view").element;
    await press(wrapper, "first");
    await point(wrapper, "pointermove", 110, 130);
    expect(clock.pending()).toBe(1);
    await clock.tick(0);
    await clock.tick(64);
    await clock.tick(128);
    expect(port.scrollTop).toBeGreaterThan(60);
    expect(feedback(wrapper)).toBe("after:empty");
    await point(wrapper, "pointerup", 110, 130);
    expect(wrapper.emitted("move")?.at(-1)).toEqual(["first", { parentId: null, beforeId: null }]);
    expect(clock.pending()).toBe(0);

    await press(wrapper, "empty");
    await point(wrapper, "pointermove", 110, 22);
    expect(clock.pending()).toBe(1);
    mounted.splice(mounted.indexOf(wrapper), 1);
    wrapper.unmount();
    expect(clock.pending()).toBe(0);
  });
});

const initialNodes: readonly CollectionNode[] = [
  request("first"), request("second"),
  { kind: "folder", id: "folder", name: "Folder", children: [
    { kind: "folder", id: "nested", name: "Nested", children: [request("leaf")] },
  ] },
  { kind: "folder", id: "empty", name: "Empty", children: [] },
];

const Host = defineComponent({
  props: {
    nodes: { type: Array as PropType<readonly CollectionNode[]>, default: () => initialNodes },
    enabled: { type: Boolean, default: true },
    expanded: { type: Array as PropType<readonly string[]>, default: () => [] },
  },
  emits: ["move", "select"],
  setup(props, { emit }) {
    const root = ref<HTMLElement>();
    const nodes = shallowRef(props.nodes);
    watch(() => props.nodes, value => { nodes.value = value; });
    const pointer = useCollectionReordering({
      root, nodes, enabled: computed(() => props.enabled),
      expandedFolderIds: computed(() => new Set(props.expanded)),
      commit(id: string, placement: CollectionPlacement) {
        nodes.value = moveCollectionNode({ requests: {}, nodes: nodes.value }, id, placement).nodes;
        emit("move", id, placement);
      },
    });
    const renderNodes = (entries: readonly CollectionNode[]): VNode => h("ul", entries.map(node => {
      const expanded = props.expanded.includes(node.id) || pointer.hoverExpandedIds.value.has(node.id);
      return h("li", { "data-collection-id": node.id }, [
        h("div", { "data-collection-row": node.id }, [
          h("button", {
            "data-handle": node.id,
            onPointerdown: (event: PointerEvent) => pointer.start(event, node.id),
            onClick: () => emit("select", node.id),
          }, node.name),
        ]),
        node.kind === "folder" && expanded ? node.children.length
          ? renderNodes(node.children)
          : h("p", { "data-collection-empty": node.id }, "Empty folder") : null,
      ]);
    }));
    return () => h("div", { class: "sidebar-view" }, [
      h("div", {
        ref: root,
        "data-root": "",
        onClickCapture: (event: MouseEvent) => pointer.suppressClick(event),
      }, [renderNodes(nodes.value), h("div", { "data-collection-root-drop": "" }, "Collection root")]),
      h("output", { role: "status" }, pointer.dropTarget.value
        ? `${pointer.dropTarget.value.position}:${pointer.dropTarget.value.id ?? ""}` : ""),
      h("button", { "data-cancel": "", onClick: pointer.cancel }, "Cancel"),
    ]);
  },
});

type HostWrapper = ReturnType<typeof mount<typeof Host>>;
const mounted: HostWrapper[] = [];

function request(id: string): CollectionNode {
  return { kind: "request", id, name: id, requestType: "GET" };
}

function render(options: { expanded?: readonly string[]; viewportHeight?: number } = {}) {
  const wrapper = mount(Host, { attachTo: document.body, props: { expanded: options.expanded ?? [] } });
  mounted.push(wrapper);
  const port = wrapper.get<HTMLElement>(".sidebar-view").element;
  const root = wrapper.get<HTMLElement>("[data-root]").element;
  const height = options.viewportHeight ?? 400;
  Object.defineProperties(port, {
    clientHeight: { configurable: true, value: height },
    scrollHeight: { configurable: true, get: () => layout().length * 32 },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === port) return new DOMRect(100, 20, 260, height);
    if (this === root) return new DOMRect(100, 20 - port.scrollTop, 260, Math.max(height, layout().length * 32));
    const entries = layout();
    if (this.matches("[data-collection-row], [data-collection-empty], [data-collection-root-drop]")) {
      const depth = this.matches("[data-collection-root-drop]") ? 0 : ancestors(this) - 1;
      return new DOMRect(100 + depth * 22, 20 + entries.indexOf(this) * 32 - port.scrollTop, 260 - depth * 22, 32);
    }
    return new DOMRect();
  });
  for (const button of wrapper.findAll<HTMLElement>("[data-handle]")) {
    const captured = new Set<number>();
    Object.assign(button.element, {
      setPointerCapture: (id: number) => captured.add(id),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => captured.delete(id),
    });
  }
  function layout() {
    return [...root.querySelectorAll<HTMLElement>("[data-collection-row], [data-collection-empty], [data-collection-root-drop]")];
  }
  return wrapper;
}

function ancestors(element: HTMLElement) {
  let depth = 0;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.matches("[data-collection-id]")) depth++;
  }
  return depth;
}

function row(wrapper: HostWrapper, id: string) {
  return wrapper.get<HTMLElement>(`[data-collection-row="${id}"]`).element;
}

function handle(wrapper: HostWrapper, id: string) {
  return wrapper.get<HTMLElement>(`[data-handle="${id}"]`).element;
}

function feedback(wrapper: HostWrapper) {
  return wrapper.get('[role="status"]').text();
}

function order(wrapper: HostWrapper) {
  return wrapper.findAll("[data-collection-row]").map(row => row.attributes("data-collection-row"));
}

async function press(wrapper: HostWrapper, id: string, init = {}) {
  const bounds = row(wrapper, id).getBoundingClientRect();
  await dispatch(handle(wrapper, id), "pointerdown", { clientX: bounds.left + 10, clientY: bounds.top + 16, ...init });
}

async function point(wrapper: HostWrapper, type: string, clientX: number, clientY: number, init = {}) {
  await dispatch(wrapper.element, type, { clientX, clientY, ...init });
  if (type === "pointermove") await clock.tick(0);
}

async function click(target: Element, detail: number) {
  await dispatch(target, "click", { detail });
}

async function dispatch(
  target: Element,
  type: string,
  init: MouseEventInit & { pointerId?: number; pointerType?: string; isPrimary?: boolean } = {},
) {
  const { pointerId = 1, pointerType = "mouse", isPrimary = true, ...mouse } = init;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 110, clientY: 30, ...mouse });
  Object.defineProperties(event, {
    pointerId: { value: pointerId }, pointerType: { value: pointerType }, isPrimary: { value: isPrimary },
  });
  Object.assign(event, { _vts: Date.now() + 1 });
  target.dispatchEvent(event);
  await nextTick();
}

function animationClock() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  return {
    pending: () => frames.size,
    async tick(time: number) {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(time);
      await nextTick();
    },
  };
}
