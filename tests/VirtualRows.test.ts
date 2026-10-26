// Verifies bounded rendering adapts to natural row height changes without clipping or losing the focused control.
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { h } from "vue";
import VirtualRows from "../src/components/VirtualRows.vue";

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("measures expanded error content and narrows the rendered window to the available viewport", async () => {
  let resized: (() => void) | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect() {}
  });
  let expandedHeight = 120;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 300, this.dataset.virtualRow === "0" ? expandedHeight : 40);
  });
  const viewport = mount(VirtualRows, {
    attachTo: document.body,
    props: { items: Array.from({ length: 2_000 }, (_, index) => index), estimatedHeight: 40, maxHeight: 160 },
    slots: { default: ({ item }: { item: number }) => h("button", `Row ${item + 1}`) },
  });
  mounted.push(viewport);
  await flushPromises();
  expect(viewport.get('[data-virtual-row="1"]').attributes("style")).toContain("top: 120px");
  expect(viewport.findAll("button").length).toBeLessThan(20);

  expandedHeight = 200;
  resized?.();
  await flushPromises();
  expect(viewport.get('[data-virtual-row="1"]').attributes("style")).toContain("top: 200px");
  const focused = viewport.get("button");
  focused.element.focus();
  viewport.element.scrollTop = 40_000;
  await viewport.trigger("scroll");
  expect(document.activeElement).toBe(focused.element);
  expect(viewport.findAll("button").length).toBeLessThan(20);
});

it("reveals the final row after measurements expand the scroll range beyond its original estimate", async () => {
  const viewport = mount(VirtualRows, {
    props: { items: Array.from({ length: 1_000 }, (_, index) => index), estimatedHeight: 32, maxHeight: 320 },
    slots: { default: ({ item }: { item: number }) => h("div", `Row ${item + 1}`) },
  });
  mounted.push(viewport);
  const element = viewport.element;
  Object.defineProperty(element, "clientHeight", { value: 320 });
  // Browsers clamp scrolling to the spacer's currently rendered height, before Vue's next DOM patch.
  let physicalScrollTop = 0;
  Object.defineProperty(element, "scrollTop", {
    get: () => physicalScrollTop,
    set: requested => {
      const renderedHeight = parseFloat(viewport.get<HTMLElement>(".virtual-content").element.style.height);
      physicalScrollTop = Math.max(0, Math.min(requested, renderedHeight - 320));
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 300, this.hasAttribute("data-virtual-row") ? 1_000 : 320);
  });

  await (viewport.vm as unknown as { reveal(index: number): Promise<void> }).reveal(999);
  await flushPromises();
  const target = viewport.get<HTMLElement>('[data-virtual-row="999"]');
  const top = parseFloat(target.element.style.top);
  expect(top).toBeLessThanOrEqual(element.scrollTop + element.clientHeight);
  expect(top + 1_000).toBeGreaterThanOrEqual(element.scrollTop);
});

it("discards measurements belonging to records replaced at the same positions", async () => {
  let resized: (() => void) | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect() {}
  });
  let height = 200;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 300, height));
  const viewport = mount(VirtualRows, {
    props: { items: Array.from({ length: 1_000 }, (_, index) => ({ label: `Old ${index}` })), estimatedHeight: 40 },
    slots: { default: ({ item }: { item: { label: string } }) => h("div", item.label) },
  });
  mounted.push(viewport);
  await flushPromises();
  await (viewport.vm as unknown as { reveal(index: number): Promise<void> }).reveal(500);
  await flushPromises();
  height = 40;
  await viewport.setProps({ items: Array.from({ length: 1_000 }, (_, index) => ({ label: `New ${index}` })) });
  resized?.();
  await flushPromises();
  expect(viewport.get<HTMLElement>(".virtual-content").element.style.height).toBe("40000px");
});

const mounted: Array<{ unmount(): void }> = [];
