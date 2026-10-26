// Exercises SplitPane through its separator, slotted content, and browser geometry changes.
import { mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import SplitPane from "../src/components/SplitPane.vue";

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("drags the sidebar in pixels, clamps both limits, and stops on release", async () => {
  const { divider, resize } = await renderSplit({ initialSize: 248, minFirst: 160, minSecond: 320, maxFirst: 480 });
  expect(divider.attributes("aria-orientation")).toBe("vertical");
  expect(divider.attributes("aria-valuetext")).toBe("248 pixels");
  expect(document.getElementById(divider.attributes("aria-controls")!)?.textContent).toBe("First pane");

  await pointer(divider, "pointerdown", { button: 0, pointerId: 1, clientX: 248 });
  await pointer(divider, "pointermove", { pointerId: 1, clientX: 340 });
  expect(divider.attributes("aria-valuetext")).toBe("340 pixels");
  await pointer(divider, "pointermove", { pointerId: 1, clientX: 2000 });
  expect(divider.attributes("aria-valuetext")).toBe("480 pixels");
  await pointer(divider, "pointermove", { pointerId: 1, clientX: -1000 });
  expect(divider.attributes("aria-valuetext")).toBe("160 pixels");
  await pointer(divider, "pointerup", { pointerId: 1 });
  await pointer(divider, "pointermove", { pointerId: 1, clientX: 500 });
  expect(divider.attributes("aria-valuetext")).toBe("160 pixels");
  await divider.trigger("dblclick");
  await resize(1400, 700);
  expect(divider.attributes("aria-valuetext")).toBe("248 pixels");
});

it("rescales percentage splits, retains preferences after clamping, and resets", async () => {
  const { divider, resize } = await renderSplit();
  await pointer(divider, "pointerdown", { button: 0, pointerId: 2, clientX: 596 });
  await pointer(divider, "pointermove", { pointerId: 2, clientX: 696 });
  await pointer(divider, "pointerup", { pointerId: 2 });
  expect(divider.attributes("aria-valuetext")).toBe("696 pixels");

  await resize(1600, 700);
  expect(divider.attributes("aria-valuetext")).toBe("930 pixels");
  await resize(900, 700);
  await divider.trigger("keydown", { key: "End" });
  expect(divider.attributes("aria-valuetext")).toBe("652 pixels");
  await resize(810, 700);
  expect(divider.attributes("aria-valuetext")).toBe("562 pixels");
  await resize(900, 700);
  expect(divider.attributes("aria-valuetext")).toBe("652 pixels");
  await divider.trigger("dblclick");
  expect(divider.attributes("aria-valuenow")).toBe("50");
});

it("uses the correct drag axis and keyboard controls when stacked and remembers each direction", async () => {
  const { divider, resize } = await renderSplit();
  await divider.trigger("keydown", { key: "ArrowRight" });
  expect(divider.attributes("aria-valuetext")).toBe("612 pixels");
  await resize(700, 700);
  expect(divider.attributes("aria-orientation")).toBe("horizontal");
  expect(divider.attributes("aria-valuetext")).toBe("346 pixels");
  await pointer(divider, "pointerdown", { button: 0, pointerId: 3, clientY: 346 });
  await pointer(divider, "pointermove", { pointerId: 3, clientY: 406, clientX: 999 });
  await pointer(divider, "pointerup", { pointerId: 3 });
  expect(divider.attributes("aria-valuetext")).toBe("406 pixels");

  await divider.trigger("keydown", { key: "ArrowLeft" });
  expect(divider.attributes("aria-valuetext")).toBe("406 pixels");
  await divider.trigger("keydown", { key: "ArrowUp", shiftKey: true });
  expect(divider.attributes("aria-valuetext")).toBe("358 pixels");
  await divider.trigger("keydown", { key: "Home" });
  expect(divider.attributes("aria-valuetext")).toBe("240 pixels");
  await divider.trigger("keydown", { key: "End" });
  expect(divider.attributes("aria-valuetext")).toBe("452 pixels");
  await resize(1200, 600);
  expect(divider.attributes("aria-valuetext")).toBe("612 pixels");
});

it("ignores other pointers and secondary buttons and stops cancelled or lost gestures", async () => {
  const { divider, resize } = await renderSplit();
  await pointer(divider, "pointerdown", { button: 2, pointerId: 1, clientX: 0 });
  await pointer(divider, "pointermove", { pointerId: 1, clientX: 200 });
  expect(divider.attributes("aria-valuenow")).toBe("50");

  for (const end of ["pointercancel", "lostpointercapture"]) {
    await pointer(divider, "pointerdown", { button: 0, pointerId: 1, clientX: 596 });
    await pointer(divider, "pointerdown", { button: 0, pointerId: 2, clientX: 596 });
    await pointer(divider, "pointermove", { pointerId: 2, clientX: 750 });
    expect(divider.attributes("aria-valuenow")).toBe("50");
    await pointer(divider, end, { pointerId: 1 });
    await pointer(divider, "pointermove", { pointerId: 1, clientX: 750 });
    expect(divider.attributes("aria-valuenow")).toBe("50");
  }

  await pointer(divider, "pointerdown", { button: 0, pointerId: 1, clientX: 596 });
  await resize(700, 600);
  await pointer(divider, "pointermove", { pointerId: 1, clientY: 500 });
  expect(divider.attributes("aria-valuenow")).toBe("50");
});

it("keeps resize room in a compact scrolling layout", async () => {
  const { divider, resize } = await renderSplit({ minExtent: 560 });
  await resize(390, 300);
  expect(divider.attributes("aria-valuetext")).toBe("280 pixels");
  await pointer(divider, "pointerdown", { button: 0, pointerId: 1, clientY: 280 });
  await pointer(divider, "pointermove", { pointerId: 1, clientY: 310 });
  await pointer(divider, "pointerup", { pointerId: 1 });
  expect(divider.attributes("aria-valuetext")).toBe("310 pixels");
  await divider.trigger("keydown", { key: "Home" });
  expect(divider.attributes("aria-valuetext")).toBe("240 pixels");
});

it("restores controlled preferences without emitting layout clamping and accepts replacement values", async () => {
  const preferences = { horizontal: 1000, vertical: "40%" as const };
  const { wrapper, divider, resize } = await renderSplit({ sizes: preferences });
  expect(divider.attributes("aria-valuetext")).toBe("952 pixels");
  expect(wrapper.emitted("update:sizes")).toBeUndefined();
  await resize(1600, 800);
  expect(divider.attributes("aria-valuetext")).toBe("1000 pixels");
  expect(preferences.horizontal).toBe(1000);
  await resize(700, 1000);
  expect(divider.attributes("aria-valuetext")).toBe("397 pixels");
  await wrapper.setProps({ sizes: { horizontal: 360, vertical: "55%" } });
  expect(divider.attributes("aria-valuetext")).toBe("546 pixels");
  await resize(1600, 800);
  expect(divider.attributes("aria-valuetext")).toBe("360 pixels");
  expect(wrapper.emitted("update:sizes")).toBeUndefined();
});

it("emits complete preferences for user resizing and reset without mutating the supplied object", async () => {
  const preferences = { horizontal: 360, vertical: "40%" as const };
  const { wrapper, divider } = await renderSplit({ initialSize: 248, sizes: preferences });
  await divider.trigger("keydown", { key: "ArrowRight" });
  expect(wrapper.emitted("update:sizes")?.at(-1)).toEqual([{ horizontal: 376, vertical: "40%" }]);
  expect(preferences).toEqual({ horizontal: 360, vertical: "40%" });
  await wrapper.setProps({ sizes: { horizontal: 376, vertical: "40%" } });
  expect(divider.attributes("aria-valuetext")).toBe("376 pixels");
  await divider.trigger("dblclick");
  expect(wrapper.emitted("update:sizes")?.at(-1)).toEqual([{ horizontal: 248, vertical: "40%" }]);
});

it("previews controlled drags locally and emits one completed preference on release", async () => {
  const preferences = { horizontal: 360, vertical: "40%" as const };
  const { wrapper, divider } = await renderSplit({ initialSize: 248, sizes: preferences });
  await pointer(divider, "pointerdown", { button: 0, pointerId: 1, clientX: 360 });
  await pointer(divider, "pointermove", { pointerId: 1, clientX: 400 });
  await pointer(divider, "pointermove", { pointerId: 1, clientX: 450 });
  expect(divider.attributes("aria-valuetext")).toBe("450 pixels");
  expect(wrapper.emitted("update:sizes")).toBeUndefined();
  expect(preferences.horizontal).toBe(360);
  await pointer(divider, "pointerup", { pointerId: 1 });
  expect(wrapper.emitted("update:sizes")).toEqual([[{ horizontal: 450, vertical: "40%" }]]);
  await wrapper.setProps({ sizes: { horizontal: 450, vertical: "40%" } });
  expect(divider.attributes("aria-valuetext")).toBe("450 pixels");
});

it.each(["pointercancel", "lostpointercapture"])("discards an uncommitted preview after %s", async end => {
  const { wrapper, divider } = await renderSplit({ initialSize: 248 });
  await pointer(divider, "pointerdown", { button: 0, pointerId: 1, clientX: 248 });
  await pointer(divider, "pointermove", { pointerId: 1, clientX: 400 });
  expect(divider.attributes("aria-valuetext")).toBe("400 pixels");
  await pointer(divider, end, { pointerId: 1 });
  expect(divider.attributes("aria-valuetext")).toBe("248 pixels");
  expect(wrapper.emitted("update:sizes")).toBeUndefined();
});

it("compacts either pane without changing the saved split and restores each orientation", async () => {
  const preferences = { horizontal: 360, vertical: "40%" as const };
  const { wrapper, divider, resize } = await renderSplit({ sizes: preferences });
  expect(divider.isVisible()).toBe(true);
  expect(divider.attributes("aria-valuetext")).toBe("360 pixels");

  for (const compact of ["first", "second"] as const) {
    await wrapper.setProps({ compact });
    expect(divider.isVisible()).toBe(false);
    expect(wrapper.text()).toContain("First pane");
    expect(wrapper.text()).toContain("Second pane");
    await divider.trigger("keydown", { key: "ArrowDown" });
    await divider.trigger("dblclick");
    expect(wrapper.emitted("update:sizes")).toBeUndefined();
    await wrapper.setProps({ compact: undefined });
    expect(divider.isVisible()).toBe(true);
    expect(divider.attributes("aria-valuetext")).toBe("360 pixels");
  }

  await wrapper.setProps({ compact: "first" });
  await resize(700, 1000);
  await wrapper.setProps({ compact: undefined });
  expect(divider.attributes("aria-valuetext")).toBe("397 pixels");
  expect(preferences).toEqual({ horizontal: 360, vertical: "40%" });
  expect(wrapper.emitted("update:sizes")).toBeUndefined();
});

type SplitWrapper = ReturnType<typeof mount<typeof SplitPane>>;
const mounted: SplitWrapper[] = [];

async function renderSplit(props: Partial<InstanceType<typeof SplitPane>["$props"]> = {}) {
  let bounds = new DOMRect(0, 0, 1200, 600);
  let notify: ResizeObserverCallback;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => bounds);
  vi.spyOn(globalThis, "ResizeObserver").mockImplementation(class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { notify = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  });

  const wrapper = mount(SplitPane, {
    attachTo: document.body,
    props: { label: "Resize panes", stackAt: 800, ...props },
    slots: { first: "First pane", second: "Second pane" },
  });
  mounted.push(wrapper);
  const divider = wrapper.get('[role="separator"]');
  Object.assign(divider.element, {
    setPointerCapture: () => {},
    hasPointerCapture: () => true,
    releasePointerCapture: () => {},
  });

  await nextTick();

  return {
    wrapper,
    divider,
    async resize(width: number, height: number) {
      bounds = new DOMRect(0, 0, width, height);
      notify([], {} as ResizeObserver);
      await nextTick();
    },
  };
}

async function pointer(
  divider: { element: Element },
  type: string,
  init: MouseEventInit & { pointerId: number },
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  divider.element.dispatchEvent(event);
  await nextTick();
}
