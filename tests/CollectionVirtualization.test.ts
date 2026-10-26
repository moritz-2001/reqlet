// Verifies bounded collection rendering through scroll, keyboard, editing, and sidebar lifetime interactions.
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import CollectionManager from "../src/components/CollectionManager.vue";
import type { CollectionChange, CollectionState } from "../src/collections";
import { createRequest } from "../src/request";

beforeEach(() => { vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] }); });
afterEach(() => {
  for (const manager of mounted.splice(0)) manager.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("bounds thousands of expanded and matching entries while retaining hierarchy and sibling context", async () => {
  const { manager, port } = await renderLargeCollection();
  expect(manager.findAll("[data-collection-row]").length).toBeLessThan(40);
  expect(manager.get('[data-collection-id="request-0"]').attributes()).toMatchObject({
    "aria-level": "2", "aria-posinset": "1", "aria-setsize": "3000",
  });
  await scroll(port, 38 * 1500);
  expect(manager.find('[data-collection-row="request-1500"]').exists()).toBe(true);
  expect(manager.find('[data-collection-row="request-0"]').exists()).toBe(false);
  expect(manager.findAll("[data-collection-row]").length).toBeLessThan(40);

  await manager.get('[aria-label="Search requests"]').setValue("Request");
  expect(manager.get('[role="status"]').text()).toBe("3000 matching requests");
  expect(manager.findAll("[data-collection-row]").length).toBeLessThan(40);
  await manager.get('[aria-label="Search requests"]').setValue("Request 2999");
  expect(manager.findAll(".request-row")).toHaveLength(1);
  expect(manager.get('.request-row').text()).toContain("Request 2999");
  await manager.get('[aria-label="Clear request search"]').trigger("click");
  await scroll(port, 0);
  expect(manager.get('.folder-row').attributes("aria-expanded")).toBe("true");
  expect(manager.findAll("[data-collection-row]").length).toBeLessThan(40);
});

it("collapses and reexpands a filtered virtual folder and resets query folds independently of normal expansion", async () => {
  const { manager } = await renderLargeCollection();
  manager.get<HTMLButtonElement>(".folder-row").element.focus();
  await manager.get(".folder-row").trigger("click");
  await flushPromises();
  expect(document.activeElement).toBe(manager.get(".folder-row").element);
  expect(manager.findAll(".request-row")).toHaveLength(0);
  const search = manager.get('[aria-label="Search requests"]');
  (search.element as HTMLInputElement).focus();
  await search.setValue("Request");
  expect(manager.find(".collection-tree-window").exists()).toBe(true);
  expect(manager.get(".folder-row").attributes("aria-expanded")).toBe("true");
  manager.get<HTMLButtonElement>(".folder-row").element.focus();
  await manager.get(".folder-row").trigger("click");
  await flushPromises();
  expect(document.activeElement).toBe(manager.get(".folder-row").element);
  expect(manager.get(".folder-row").attributes("aria-expanded")).toBe("false");
  expect(manager.findAll(".request-row")).toHaveLength(0);
  await manager.get(".folder-row").trigger("click");
  await flushPromises();
  expect(document.activeElement).toBe(manager.get(".folder-row").element);
  expect(manager.find(".collection-tree-window").exists()).toBe(true);
  expect(manager.findAll(".request-row").length).toBeGreaterThan(0);
  expect(manager.findAll("[data-collection-row]").length).toBeLessThan(40);

  await manager.get(".folder-row").trigger("click");
  await search.setValue("Request 2999");
  expect(manager.get(".folder-row").attributes("aria-expanded")).toBe("true");
  expect(manager.findAll(".request-row")).toHaveLength(1);
  await search.setValue("Request");
  expect(manager.find(".collection-tree-window").exists()).toBe(true);
  await manager.get(".folder-row").trigger("click");
  await manager.get('[aria-label="Clear request search"]').trigger("click");
  expect(manager.get(".folder-row").attributes("aria-expanded")).toBe("false");
  expect(manager.findAll(".request-row")).toHaveLength(0);
  await manager.get(".folder-row").trigger("click");
  expect(manager.find(".collection-tree-window").exists()).toBe(true);
});

it("reveals a request selected outside the tree even when its row was not mounted", async () => {
  const { manager, port } = await renderLargeCollection();
  await manager.setProps({ selectedRequestId: "request-2999" });
  await flushPromises();
  expect(manager.get('[data-collection-row="request-2999"] .tree-row').attributes("aria-current")).toBe("true");
  expect(port.scrollTop).toBeGreaterThan(38 * 2900);
  expect(manager.findAll("[data-collection-row]").length).toBeLessThan(40);
});

it("tabs to the next logical row beyond the viewport window and supports reverse traversal", async () => {
  const { manager } = await renderLargeCollection();
  const last = manager.findAll("[data-collection-index]").at(-1)!;
  const index = Number(last.attributes("data-collection-index"));
  const trigger = last.get<HTMLButtonElement>(".entry-menu-trigger");
  trigger.element.focus();
  await trigger.trigger("keydown", { key: "Tab" });
  await flushPromises();
  const next = manager.get(`[data-collection-index="${index + 1}"]`);
  expect(document.activeElement).toBe(next.get(".drag-handle").element);
  await next.get(".drag-handle").trigger("keydown", { key: "Tab", shiftKey: true });
  await flushPromises();
  expect(document.activeElement).toBe(manager.get(`[data-collection-index="${index}"] .entry-menu-trigger`).element);
  expect(manager.emitted("select-request")).toBeUndefined();
});

it("retains an inline edit while its row scrolls away and restores the renamed row on submission", async () => {
  const { manager, port } = await renderLargeCollection();
  await scroll(port, 38 * 1500);
  const row = manager.get<HTMLButtonElement>('[data-collection-row="request-1500"] .tree-row');
  row.element.focus();
  await row.trigger("keydown", { key: "F2" });
  await flushPromises();
  const input = manager.get<HTMLInputElement>('[aria-label="Collection entry name"]');
  await input.setValue("Renamed middle entry");
  await scroll(port, 38 * 2800);
  expect(manager.get('[aria-label="Collection entry name"]').element).toBe(input.element);
  expect(input.element.value).toBe("Renamed middle entry");
  expect(document.activeElement).toBe(input.element);
  expect(manager.findAll("[data-collection-row]").length).toBeLessThan(40);
  await manager.get(".inline-rename").trigger("submit");
  await flushPromises();
  expect(manager.props("requests")["request-1500"]!.name).toBe("Renamed middle entry");
  expect(document.activeElement).toBe(manager.get('[data-collection-row="request-1500"] .tree-row').element);
  expect(port.scrollTop).toBeLessThan(38 * 2000);
});

it("preserves keyboard sibling movement and focus as the moved entry crosses a window edge", async () => {
  const { manager, port } = await renderLargeCollection();
  await scroll(port, 38 * 1500);
  const row = manager.get<HTMLButtonElement>('[data-collection-row="request-1500"] .tree-row');
  row.element.focus();
  await row.trigger("keydown", { key: "ArrowUp", altKey: true, shiftKey: true });
  await flushPromises();
  const folder = manager.props("nodes")[0]!;
  expect(folder.kind === "folder" && folder.children[1499]!.id).toBe("request-1500");
  expect(document.activeElement).toBe(manager.get('[data-collection-row="request-1500"] .tree-row').element);
  expect(manager.emitted("select-request")).toBeUndefined();
});

it("retains the pointer capture owner across scrolling and releases it after cancellation", async () => {
  const { manager, port } = await renderLargeCollection();
  const handle = manager.get('[data-collection-row="request-0"] .drag-handle');
  handle.element.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), {
    pointerId: 7, pointerType: "mouse", button: 0, isPrimary: true, clientX: 10, clientY: 10,
  }));
  await nextTick();
  await scroll(port, 38 * 1500);
  expect(manager.get('[data-collection-row="request-0"] .drag-handle').element).toBe(handle.element);
  window.dispatchEvent(Object.assign(new Event("pointercancel"), { pointerId: 7 }));
  await nextTick();
  expect(manager.find('[data-collection-row="request-0"]').exists()).toBe(false);
});

it("keeps scrolling and refreshing targets while a stationary drag reaches rows outside the original window", async () => {
  const { manager, port } = await renderLargeCollection();
  provideGeometry(manager, port);
  const handle = manager.get('[data-collection-row="request-0"] .drag-handle').element;
  dispatchPointer(handle, "pointerdown", 30, 50);
  dispatchPointer(window, "pointermove", 40, 223);
  await vi.advanceTimersByTimeAsync(700);
  await nextTick();
  expect(port.scrollTop).toBeGreaterThan(200);
  expect(manager.find('[data-collection-row="request-0"]').exists()).toBe(true);
  dispatchPointer(window, "pointerup", 40, 223);
  await flushPromises();
  const folder = manager.props("nodes")[0]!;
  expect(folder.kind === "folder" && folder.children.findIndex(node => node.id === "request-0")).toBeGreaterThan(5);
  expect(manager.emitted("select-request")).toBeUndefined();
});

it("places an outdented drop after an expanded folder whose row is outside the viewport", async () => {
  const { manager, port } = await renderLargeCollection();
  provideGeometry(manager, port);
  dispatchPointer(manager.get('[data-collection-row="request-0"] .drag-handle').element, "pointerdown", 30, 50);
  await scroll(port, 38 * 3001 - port.clientHeight);
  dispatchPointer(window, "pointermove", 5, 223);
  await vi.advanceTimersByTimeAsync(17);
  await nextTick();
  expect(manager.get('[data-collection-id="request-2999"]').classes()).toContain("drop-after");
  dispatchPointer(window, "pointerup", 5, 223);
  await flushPromises();
  expect(manager.props("nodes").at(-1)!.id).toBe("request-0");
  expect(manager.emitted("select-request")).toBeUndefined();
});

it("remeasures the retained scrollport when a hidden sidebar is activated", async () => {
  const { manager, port } = await renderLargeCollection();
  await manager.setProps({ interactionEnabled: false });
  await scroll(port, 38 * 2000);
  expect(manager.find('[data-collection-row="request-2000"]').exists()).toBe(false);
  await manager.setProps({ interactionEnabled: true });
  await flushPromises();
  expect(manager.find('[data-collection-row="request-2000"]').exists()).toBe(true);
  expect(manager.findAll("[data-collection-row]").length).toBeLessThan(40);
});

type ManagerWrapper = ReturnType<typeof mount<typeof CollectionManager>>;
const mounted: ManagerWrapper[] = [];

async function renderLargeCollection() {
  const requests = Object.fromEntries(Array.from({ length: 3000 }, (_, index) => [`request-${index}`, createRequest(`Request ${index}`)]));
  const state: CollectionState = {
    requests,
    nodes: [{ kind: "folder", id: "archive", name: "Archive", children: Object.keys(requests).map(id => ({
      kind: "request", id, name: requests[id]!.name, requestType: "GET",
    })) }],
  };
  const port = document.createElement("div");
  port.className = "sidebar-view";
  Object.defineProperty(port, "clientHeight", { value: 228 });
  document.body.append(port);
  const manager = mount(CollectionManager, { attachTo: port, props: state });
  mounted.push(manager);
  await manager.setProps({ onChange: (change: CollectionChange) => {
    void manager.setProps({ requests: change.requests, nodes: change.nodes });
  } });
  await manager.get(".folder-row").trigger("click");
  await flushPromises();
  return { manager, port };
}

async function scroll(port: HTMLElement, top: number) {
  port.scrollTop = top;
  port.dispatchEvent(new Event("scroll"));
  await vi.advanceTimersByTimeAsync(17);
  await nextTick();
}

function provideGeometry(manager: ManagerWrapper, port: HTMLElement) {
  const totalHeight = () => parseFloat(manager.get<HTMLElement>(".collection-tree-window").element.style.height);
  let scrollTop = port.scrollTop;
  Object.defineProperty(port, "scrollTop", {
    configurable: true, get: () => scrollTop,
    set: value => { scrollTop = value; port.dispatchEvent(new Event("scroll")); },
  });
  Object.defineProperty(port, "scrollHeight", { configurable: true, get: totalHeight });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === port) return new DOMRect(0, 0, 300, port.clientHeight);
    if (this.matches(".collection-manager, .collection-tree-surface")) return new DOMRect(0, -port.scrollTop, 300, totalHeight());
    if (this.matches("[data-collection-row]")) {
      const item = this.closest<HTMLElement>("[data-collection-index]")!;
      const left = parseFloat(item.style.left);
      return new DOMRect(left, Number(item.dataset.collectionIndex) * 38 - port.scrollTop, 300 - left, 36);
    }
    return new DOMRect();
  });
}

function dispatchPointer(target: EventTarget, type: string, x: number, y: number) {
  target.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    pointerId: 7, pointerType: "mouse", button: 0, isPrimary: true, clientX: x, clientY: y,
  }));
}
