// Exercises the stateful strip through its exposed commands, rendered controls, notifications, and pointer gestures.
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import Tabs from "../src/components/Tabs.vue";
import type { TabExecution, TabItem, TabsHandle } from "../src/components/tabs";

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("Tabs ownership", () => {
  it("restores only removed identities at former sibling positions while preserving current descriptors and selection", async () => {
    const wrapper = await renderTabs(false, items.map(item => ({ ...item, closable: true })));
    const snapshot = { items: items.map(item => ({ ...item, closable: true })), activeId: "first" };
    api(wrapper).close("second");
    api(wrapper).close("third");
    api(wrapper).open({ id: "new", label: "Opened later", closable: true });
    api(wrapper).updateLabel("first", "Edited later");
    api(wrapper).restore(snapshot, ["second"]);
    await nextTick();

    expect(order(wrapper)).toEqual(["first", "second", "new"]);
    expect(selected(wrapper)).toBe("new");
    expect(tab(wrapper, "first").text()).toBe("Edited later");
    expect(wrapper.find('[aria-label="Close Third"]').exists()).toBe(false);
    expect(wrapper.emitted("state-change")?.at(-1)?.[0]).toMatchObject({ activeId: "new" });
    const events = wrapper.emitted("state-change")!.length;
    api(wrapper).restore(snapshot, ["second"]);
    expect(wrapper.emitted("state-change")).toHaveLength(events);
  });

  it("restores an explicitly requested selection and chooses a recovered tab for an empty strip", async () => {
    const wrapper = await renderTabs(false, []);
    const snapshot = { items: [items[0], items[1]], activeId: "second" };
    api(wrapper).restore(snapshot, ["first", "second"], "second");
    await nextTick();
    expect(order(wrapper)).toEqual(["first", "second"]);
    expect(selected(wrapper)).toBe("second");
    snapshot.items[0] = { ...items[0], label: "Outside mutation" };
    expect(tab(wrapper, "first").text()).toBe("First");
  });

  it("restores descriptors and selection without emitting a fresh selection", async () => {
    const descriptor = { ...items[0] };
    const wrapper = mount(Tabs, {
      props: { label: "Restored tabs", panelId: "restored-panel", initialItems: [descriptor, items[1]], initialActiveId: "second" },
    });
    mounted.push(wrapper);
    descriptor.label = "Outside mutation";
    await nextTick();

    expect(order(wrapper)).toEqual(["first", "second"]);
    expect(tab(wrapper, "first").text()).toBe("First");
    expect(selected(wrapper)).toBe("second");
    expect(wrapper.emitted("active-change")).toBeUndefined();
    expect(wrapper.emitted("state-change")).toBeUndefined();
    await wrapper.setProps({ initialItems: [items[2]], initialActiveId: "third" });
    expect(order(wrapper)).toEqual(["first", "second"]);
    expect(selected(wrapper)).toBe("second");
  });

  it("reports complete copied state after commands, selection, ordering, and closing", async () => {
    const wrapper = await renderTabs(true, []);
    api(wrapper).open(items[0]);
    api(wrapper).open(items[1]);
    await nextTick();
    expect(wrapper.emitted("state-change")?.at(-1)).toEqual([{
      items: [items[0], items[1]], activeId: "second",
    }]);

    api(wrapper).updateLabel("first", "Renamed");
    await nextTick();
    expect(tab(wrapper, "first").text()).toBe("Renamed");
    expect(selected(wrapper)).toBe("second");
    await tab(wrapper, "first").trigger("click");
    expect(wrapper.emitted("state-change")?.at(-1)?.[0]).toMatchObject({ activeId: "first" });
    await tab(wrapper, "first").trigger("keydown", { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(wrapper.emitted("state-change")?.at(-1)).toEqual([{
      items: [items[1], { ...items[0], label: "Renamed" }], activeId: "first",
    }]);

    const emitted = wrapper.emitted("state-change")?.at(-1)?.[0] as { items: { label: string }[] };
    emitted.items[1].label = "Mutated snapshot";
    await nextTick();
    expect(tab(wrapper, "first").text()).toBe("Renamed");
    api(wrapper).close("first");
    await nextTick();
    expect(wrapper.emitted("state-change")?.at(-1)).toEqual([{ items: [items[1]], activeId: "second" }]);
    const events = wrapper.emitted("state-change")!.length;
    api(wrapper).close("missing");
    api(wrapper).updateLabel("missing", "No effect");
    expect(wrapper.emitted("state-change")).toHaveLength(events);
  });

  it("starts empty and opens, activates, and refreshes descriptors without duplicates", async () => {
    const wrapper = await renderTabs(false, []);
    expect(api(wrapper).count).toBe(0);
    expect(wrapper.emitted("active-change")).toBeUndefined();
    expect(wrapper.get('[role="tablist"]').attributes("tabindex")).toBe("0");

    const descriptor = { ...items[0] };
    api(wrapper).open(descriptor);
    descriptor.label = "Changed outside";
    await nextTick();
    expect(tab(wrapper, "first").text()).toBe("First");
    api(wrapper).open(items[1]);
    api(wrapper).open({ ...items[0], label: "Renamed", closable: false });
    await nextTick();

    expect(order(wrapper)).toEqual(["first", "second"]);
    expect(tab(wrapper, "first").text()).toBe("Renamed");
    expect(wrapper.find('[aria-label="Close Renamed"]').exists()).toBe(false);
    expect(selected(wrapper)).toBe("first");
    expect(api(wrapper).count).toBe(2);
    expect(wrapper.emitted("active-change")).toEqual([["first"], ["second"], ["first"]]);
    api(wrapper).open(items[0]);
    await tab(wrapper, "first").trigger("click");
    expect(wrapper.emitted("active-change")).toHaveLength(3);
  });

  it("owns selection and supports arrow wrapping, Home, End, and one tab stop", async () => {
    const wrapper = await renderTabs();
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.attributes("tabindex"))).toEqual(["0", "-1", "-1"]);

    for (const [id, key, expected] of [
      ["first", "ArrowLeft", "third"], ["third", "ArrowRight", "first"],
      ["first", "End", "third"], ["third", "Home", "first"],
    ]) {
      await tab(wrapper, id).trigger("keydown", { key });
      expect(document.activeElement).toBe(tab(wrapper, expected).element);
      expect(selected(wrapper)).toBe(expected);
      expect(wrapper.emitted("active-change")?.at(-1)).toEqual([expected]);
    }

    await tab(wrapper, "second").trigger("click");
    expect(selected(wrapper)).toBe("second");
    expect(tab(wrapper, "second").attributes("tabindex")).toBe("0");
  });

  it("closes inactive tabs silently and selects right, then left, then empty", async () => {
    const wrapper = await renderTabs(false, items.map(item => ({ ...item, closable: true })));
    const notifications = wrapper.emitted("active-change")!.length;
    await wrapper.get('[aria-label="Close Second"]').trigger("click");
    expect(selected(wrapper)).toBe("first");
    expect(wrapper.emitted("active-change")).toHaveLength(notifications);
    await wrapper.get('[aria-label="Close First"]').trigger("click");
    expect(selected(wrapper)).toBe("third");
    api(wrapper).open(items[1]);
    await nextTick();
    await tab(wrapper, "second").trigger("keydown", { key: "Delete" });
    expect(selected(wrapper)).toBe("third");
    await tab(wrapper, "third").trigger("keydown", { key: "Delete" });
    expect(order(wrapper)).toEqual([]);
    expect(api(wrapper).count).toBe(0);
    expect(wrapper.emitted("active-change")?.at(-1)).toEqual([null]);
  });

  it("does not close nonclosable tabs and assigns stable, document-unique IDs targeting the external panel", async () => {
    const parent = mount({
      components: { Tabs },
      template: '<Tabs label="First group" panel-id="example-panel" /><Tabs label="Second group" panel-id="other-panel" />',
    }, { attachTo: document.body });
    mounted.push(parent);
    const [first, second] = parent.findAllComponents(Tabs);
    api(first).open(items[2]);
    api(second).open(items[2]);
    api(first).open(items[0]);
    api(first).open(items[1]);
    await nextTick();
    const button = tab(first, "third");
    const domId = button.attributes("id");
    expect(first.find('[aria-label="Close Third"]').exists()).toBe(false);
    await button.trigger("keydown", { key: "Delete" });
    expect(api(first).count).toBe(3);
    expect(domId).not.toBe(tab(second, "third").attributes("id"));
    expect(button.attributes("aria-controls")).toBe("example-panel");
    expect(first.find('[role="tabpanel"]').exists()).toBe(false);
    api(first).open({ ...items[2], label: "Renamed" });
    await nextTick();
    expect(tab(first, "third").element).toBe(button.element);
    expect(tab(first, "third").attributes("id")).toBe(domId);
  });

  it("focuses the selected replacement on closing a focused tab and the strip when empty", async () => {
    const wrapper = await renderTabs(false, [items[0], items[1]]);
    tab(wrapper, "first").element.focus();
    await tab(wrapper, "first").trigger("keydown", { key: "Delete" });
    expect(document.activeElement).toBe(tab(wrapper, "second").element);
    await tab(wrapper, "second").trigger("keydown", { key: "Delete" });
    expect(document.activeElement).toBe(wrapper.get('[role="tablist"]').element);
  });

  it("does not steal outside focus on open or close, including focus moved by a selection listener", async () => {
    const wrapper = await renderTabs();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    api(wrapper).open(items[1]);
    await nextTick();
    await wrapper.get('[aria-label="Close First"]').trigger("click");
    expect(document.activeElement).toBe(outside);
    await wrapper.setProps({ onActiveChange: () => outside.focus() });
    tab(wrapper, "second").element.focus();
    await tab(wrapper, "second").trigger("keydown", { key: "Delete" });
    expect(document.activeElement).toBe(outside);
  });

  it("reveals an opened or reactivated tab without moving focus from the collection", async () => {
    const wrapper = await renderTabs();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const reveal = vi.fn();
    Object.assign(tab(wrapper, "third").element.parentElement!, { scrollIntoView: reveal });
    api(wrapper).open(items[2]);
    await nextTick();
    expect(reveal).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(document.activeElement).toBe(outside);
  });
});

describe("Open tabs picker", () => {
  it("lists every descriptor in strip order with complete names and current feedback", async () => {
    const longName = "Saved request with a long and descriptive name that should stay readable";
    const descriptors = [
      { id: "request", label: longName, closable: true },
      { id: "draft", label: "Draft: New request", closable: true },
      { id: "history", label: "History: Yesterday's response" },
    ];
    const wrapper = await renderTabs(false, descriptors);
    await wrapper.setProps({ presentation: {
      draft: { unsaved: true, execution: { status: "running" } },
      history: { execution: { status: "success", httpStatus: 404 } },
    } });
    const trigger = pickerTrigger(wrapper);
    expect(tab(wrapper, "request").attributes("title")).toBe(longName);
    expect(trigger.attributes("aria-label")).toBe("Open tabs (3)");
    await trigger.trigger("click");

    expect(wrapper.get('[role="menu"]').attributes("id")).toBe(trigger.attributes("aria-controls"));
    expect(wrapper.findAll('[role="menuitemradio"]').map(item => item.attributes("aria-label"))).toEqual([
      longName, "Draft: New request, Unsaved draft, Sending…", "History: Yesterday's response, HTTP 404",
    ]);
    expect(pickerItem(wrapper, "request").get(".picker-label").text()).toBe(longName);
    expect(pickerItem(wrapper, "request").attributes("aria-checked")).toBe("true");
    expect(pickerItem(wrapper, "history").attributes("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(pickerItem(wrapper, "request").element);

    api(wrapper).updateLabel("draft", "Renamed draft");
    await wrapper.setProps({ presentation: { draft: { unsaved: true } } });
    expect(pickerItem(wrapper, "draft").attributes("aria-label")).toBe("Renamed draft, Unsaved draft");
    expect(pickerItem(wrapper, "history").find(".tab-execution").exists()).toBe(false);
    expect(pickerTrigger(wrapper).element).toBe(trigger.element);
  });

  it("navigates without changing selection, and dismisses Escape back to its stable trigger", async () => {
    const wrapper = await renderTabs();
    const stateNotifications = wrapper.emitted("state-change")!.length;
    const selectionNotifications = wrapper.emitted("active-change")!.length;
    await pickerTrigger(wrapper).trigger("keydown", { key: "ArrowDown" });

    for (const [id, key, expected] of [
      ["first", "ArrowUp", "third"], ["third", "ArrowDown", "first"],
      ["first", "End", "third"], ["third", "Home", "first"],
    ]) {
      await pickerItem(wrapper, id).trigger("keydown", { key });
      expect(document.activeElement).toBe(pickerItem(wrapper, expected).element);
    }
    await pickerItem(wrapper, "first").trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(pickerTrigger(wrapper).attributes("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(pickerTrigger(wrapper).element);
    expect(selected(wrapper)).toBe("first");
    expect(wrapper.emitted("state-change")).toHaveLength(stateNotifications);
    expect(wrapper.emitted("active-change")).toHaveLength(selectionNotifications);

    await pickerTrigger(wrapper).trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).toBe(pickerItem(wrapper, "third").element);
    await pickerItem(wrapper, "third").trigger("keydown", { key: "Tab" });
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(pickerTrigger(wrapper).element);
  });

  it("selects and reveals a menu item through the existing event contract without moving or reopening tabs", async () => {
    const wrapper = await renderTabs(true);
    const original = tab(wrapper, "second").element;
    const reveal = vi.fn();
    Object.assign(original.parentElement!, { scrollIntoView: reveal });
    await pickerTrigger(wrapper).trigger("click");
    await pickerItem(wrapper, "second").trigger("click");

    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(selected(wrapper)).toBe("second");
    expect(order(wrapper)).toEqual(["first", "second", "third"]);
    expect(tab(wrapper, "second").element).toBe(original);
    expect(document.activeElement).toBe(original);
    expect(reveal).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(wrapper.emitted("active-change")?.at(-1)).toEqual(["second"]);
    expect(wrapper.emitted("state-change")?.at(-1)).toEqual([{ items, activeId: "second" }]);

    await tab(wrapper, "second").trigger("keydown", { key: "ArrowLeft", altKey: true, shiftKey: true });
    await pickerTrigger(wrapper).trigger("click");
    expect(wrapper.findAll('[role="menuitemradio"]').map(item => item.attributes("data-picker-tab-id")))
      .toEqual(["second", "first", "third"]);
    expect(document.activeElement).toBe(pickerItem(wrapper, "second").element);
    await pickerItem(wrapper, "second").trigger("click");
    await tab(wrapper, "second").trigger("keydown", { key: "Delete" });
    expect(order(wrapper)).toEqual(["first", "third"]);
    expect(selected(wrapper)).toBe("first");
    expect(pickerTrigger(wrapper).attributes("aria-label")).toBe("Open tabs (2)");
  });

  it("dismisses outside pointer and focus changes without taking focus from the destination", async () => {
    const wrapper = await renderTabs();
    const outside = document.createElement("button");
    document.body.append(outside);
    await pickerTrigger(wrapper).trigger("click");
    await pointer({ element: outside }, "pointerdown");
    outside.focus();
    await nextTick();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(outside);

    await pickerTrigger(wrapper).trigger("click");
    outside.focus();
    await nextTick();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it("preserves focus moved by a selection listener and repairs menu focus after external closing", async () => {
    const wrapper = await renderTabs(false, [items[0], items[1]]);
    await pickerTrigger(wrapper).trigger("click");
    api(wrapper).close("first");
    await nextTick();
    expect(document.activeElement).toBe(pickerItem(wrapper, "second").element);
    api(wrapper).close("second");
    await nextTick();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(pickerTrigger(wrapper).attributes("disabled")).toBeDefined();
    expect(document.activeElement).toBe(wrapper.get('[role="tablist"]').element);

    api(wrapper).open(items[0]);
    api(wrapper).open(items[1]);
    await nextTick();
    const outside = document.createElement("button");
    document.body.append(outside);
    await wrapper.setProps({ onActiveChange: () => outside.focus() });
    await pickerTrigger(wrapper).trigger("click");
    await pickerItem(wrapper, "first").trigger("click");
    expect(document.activeElement).toBe(outside);
  });

  it("cancels a pending reorder when opening the picker and remains disabled when empty", async () => {
    const wrapper = await renderTabs(true);
    const source = tab(wrapper, "first");
    await pointer(source, "pointerdown");
    await pointer(source, "pointermove", { clientX: 280 });
    expect(wrapper.find(".insertion-marker").exists()).toBe(true);
    await pickerTrigger(wrapper).trigger("click");
    expect(wrapper.find(".insertion-marker").exists()).toBe(false);
    await pointer(source, "pointerup", { clientX: 280 });
    expect(order(wrapper)).toEqual(["first", "second", "third"]);

    const empty = await renderTabs(false, []);
    expect(pickerTrigger(empty).attributes("disabled")).toBeDefined();
    await pickerTrigger(empty).trigger("keydown", { key: "ArrowDown" });
    expect(empty.find('[role="menu"]').exists()).toBe(false);
  });

  it("dismisses to the newly activated tab if an external open replaces focused picker content", async () => {
    const wrapper = await renderTabs();
    await pickerTrigger(wrapper).trigger("click");
    api(wrapper).open({ id: "new", label: "New request", closable: true });
    await nextTick();

    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(tab(wrapper, "new").element);
    expect(selected(wrapper)).toBe("new");
  });
});

describe("Tab execution feedback", () => {
  it("updates an inactive tab's sending and HTTP feedback without changing tab ownership", async () => {
    const wrapper = await renderTabs(true);
    const firstButton = tab(wrapper, "first").element;
    const notifications = wrapper.emitted("state-change")!.length;
    await wrapper.setProps({ presentation: { second: { execution: { status: "running" } } } });

    expect(tab(wrapper, "second").text()).toContain("Sending…");
    expect(tab(wrapper, "second").attributes("aria-label")).toBe("Second, Sending…");
    expect(tab(wrapper, "second").find(".execution-spinner").exists()).toBe(true);
    expect(selected(wrapper)).toBe("first");
    expect(tab(wrapper, "first").element).toBe(firstButton);
    expect(wrapper.emitted("state-change")).toHaveLength(notifications);

    await wrapper.setProps({ presentation: { second: { execution: { status: "success", httpStatus: 204 } } } });
    expect(tab(wrapper, "second").get(".tab-execution").text()).toBe("204");
    expect(tab(wrapper, "second").attributes("aria-label")).toBe("Second, HTTP 204");
    expect(tab(wrapper, "second").find(".execution-spinner").exists()).toBe(false);
    expect(tab(wrapper, "first").find(".tab-execution").exists()).toBe(false);
    expect(wrapper.emitted("state-change")).toHaveLength(notifications);

    await tab(wrapper, "second").trigger("click");
    await tab(wrapper, "second").trigger("keydown", { key: "ArrowLeft", altKey: true, shiftKey: true });
    expect(order(wrapper)).toEqual(["second", "first", "third"]);
    expect(tab(wrapper, "second").get(".tab-execution").text()).toBe("204");
    expect(wrapper.emitted("state-change")?.at(-1)).toEqual([{
      items: [items[1], items[0], items[2]], activeId: "second",
    }]);
  });

  it.each<[TabExecution, string, string]>([
    [{ status: "success", httpStatus: 500 }, "500", "HTTP 500"],
    [{ status: "error" }, "Failed", "Failed"],
    [{ status: "cancelled" }, "Cancelled", "Cancelled"],
  ])("identifies %j with text and an accessible status", async (execution, visible, accessible) => {
    const wrapper = await renderTabs();
    await wrapper.setProps({ presentation: { first: { execution } } });

    expect(tab(wrapper, "first").get(".tab-label").text()).toBe("First");
    expect(tab(wrapper, "first").get(".tab-execution").text()).toBe(visible);
    expect(tab(wrapper, "first").attributes("aria-label")).toBe(`First, ${accessible}`);
  });

  it("marks unsaved drafts independently of execution and removes stale feedback", async () => {
    const wrapper = await renderTabs();
    await wrapper.setProps({ presentation: { first: { unsaved: true, execution: { status: "running" } } } });
    expect(tab(wrapper, "first").get(".unsaved-marker").attributes("title")).toBe("Unsaved draft");
    expect(tab(wrapper, "first").attributes("aria-label")).toBe("First, Unsaved draft, Sending…");

    await wrapper.setProps({ presentation: {} });
    expect(tab(wrapper, "first").find(".unsaved-marker").exists()).toBe(false);
    expect(tab(wrapper, "first").find(".tab-execution").exists()).toBe(false);
    expect(tab(wrapper, "first").attributes("aria-label")).toBe("First");
  });
});

describe("Tab reordering", () => {
  it("is disabled by default, including modified arrow keys", async () => {
    const wrapper = await renderTabs();
    await tab(wrapper, "first").trigger("keydown", { key: "ArrowRight", altKey: true, shiftKey: true });
    await pointer(tab(wrapper, "first"), "pointerdown");
    await pointer(tab(wrapper, "first"), "pointermove", { clientX: 390 });
    await pointer(tab(wrapper, "first"), "pointerup", { clientX: 390 });
    expect(order(wrapper)).toEqual(["first", "second", "third"]);
    expect(wrapper.find(".insertion-marker").exists()).toBe(false);
    expect(wrapper.get('[role="tablist"]').attributes("aria-describedby")).toBeUndefined();
  });

  it("moves with the keyboard without wrapping or changing selection, and retains identity and focus", async () => {
    const wrapper = await renderTabs(true);
    const first = tab(wrapper, "first");
    first.element.focus();
    const notifications = wrapper.emitted("active-change")!.length;
    await first.trigger("keydown", { key: "ArrowLeft", altKey: true, shiftKey: true });
    expect(order(wrapper)).toEqual(["first", "second", "third"]);
    expect(wrapper.get('[role="status"]').text()).toBe("");
    await first.trigger("keydown", { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(order(wrapper)).toEqual(["second", "first", "third"]);
    expect(tab(wrapper, "first").element).toBe(first.element);
    expect(document.activeElement).toBe(first.element);
    expect(wrapper.get('[role="status"]').text()).toBe("First moved to position 2 of 3");
    await first.trigger("keydown", { key: "ArrowRight", altKey: true, shiftKey: true });
    await first.trigger("keydown", { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(order(wrapper)).toEqual(["second", "third", "first"]);
    expect(selected(wrapper)).toBe("first");
    expect(wrapper.emitted("active-change")).toHaveLength(notifications);
    const instructions = document.getElementById(wrapper.get('[role="tablist"]').attributes("aria-describedby")!);
    expect(instructions?.textContent).toContain("Alt+Shift+Left");
    await first.trigger("keydown", { key: "ArrowLeft", altKey: true, shiftKey: true, ctrlKey: true });
    expect(order(wrapper)).toEqual(["second", "third", "first"]);
  });

  it("previews an inactive tab's move and commits once on release without activating or closing it", async () => {
    const wrapper = await renderTabs(true);
    const notifications = wrapper.emitted("active-change")!.length;
    const source = tab(wrapper, "second");
    source.element.focus();
    await pointer(source, "pointerdown", { clientX: 210 });
    await pointer(source, "pointermove");
    expect(order(wrapper)).toEqual(["first", "second", "third"]);
    expect(wrapper.find(".insertion-marker").exists()).toBe(true);
    expect(wrapper.get('.drag-source').attributes("data-tab-id")).toBe("second");
    await pointer(source, "pointerup");
    expect(order(wrapper)).toEqual(["second", "first", "third"]);
    expect(document.activeElement).toBe(source.element);
    expect(wrapper.find(".insertion-marker").exists()).toBe(false);
    await pointer(source, "click", { detail: 1 });
    expect(selected(wrapper)).toBe("first");
    expect(wrapper.emitted("active-change")).toHaveLength(notifications);
    expect(api(wrapper).count).toBe(3);
    await pointer(source, "pointerdown");
    await pointer(source, "pointerup");
    await pointer(source, "click", { detail: 1 });
    expect(selected(wrapper)).toBe("second");
  });

  it("keeps small movements as clicks and excludes close buttons, touch, nonprimary pointers, and secondary buttons", async () => {
    const wrapper = await renderTabs(true);
    const source = tab(wrapper, "second");
    await pointer(source, "pointerdown", { clientX: 210 });
    await pointer(source, "pointermove", { clientX: 215 });
    await pointer(source, "pointerup", { clientX: 215 });
    await pointer(source, "click", { detail: 1 });
    expect(selected(wrapper)).toBe("second");
    for (const init of [{ button: 2 }, { isPrimary: false }, { pointerType: "touch" }]) {
      await pointer(source, "pointerdown", { clientX: 210, ...init });
      await pointer(source, "pointermove");
      await pointer(source, "pointerup");
      expect(order(wrapper)).toEqual(["first", "second", "third"]);
      expect(wrapper.find(".insertion-marker").exists()).toBe(false);
    }
    const close = wrapper.get('[aria-label="Close Second"]');
    await pointer(close, "pointerdown", { clientX: 290 });
    await pointer(close, "pointermove");
    await pointer(close, "pointerup");
    expect(wrapper.find(".drag-source").exists()).toBe(false);
  });

  it("ignores foreign pointer events and recomputes the destination on release", async () => {
    const wrapper = await renderTabs(true);
    const source = tab(wrapper, "first");
    await pointer(source, "pointerdown");
    await pointer(source, "pointermove", { pointerId: 2, clientX: 390 });
    await pointer(source, "pointerup", { pointerId: 2, clientX: 390 });
    expect(wrapper.find(".insertion-marker").exists()).toBe(false);
    await pointer(source, "pointermove", { clientX: 280 });
    await pointer(source, "pointerup", { clientX: 390 });
    expect(order(wrapper)).toEqual(["second", "third", "first"]);
    await wrapper.get('[aria-label="Close First"]').trigger("click");
    expect(selected(wrapper)).toBe("third");
  });

  it("does not activate a captured button when an armed press is cancelled or released outside", async () => {
    const wrapper = await renderTabs(true);
    const source = tab(wrapper, "second");
    await pointer(source, "pointerdown", { clientX: 210 });
    await pointer(source, "pointerup", { clientX: 210, clientY: 100 });
    await pointer(source, "click", { detail: 1 });
    expect(selected(wrapper)).toBe("first");
    await pointer(source, "pointerdown", { clientX: 210 });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await pointer(source, "pointerup", { clientX: 210 });
    await pointer(source, "click", { detail: 1 });
    expect(selected(wrapper)).toBe("first");
  });

  it("uses full variable-width entries and keeps ineffective drops silent", async () => {
    const wrapper = await renderTabs(true);
    geometry(wrapper, 400, [80, 180, 100]);
    const source = tab(wrapper, "first");
    await pointer(source, "pointerdown");
    await pointer(source, "pointermove", { clientX: 280 });
    await pointer(source, "pointerup", { clientX: 280 });
    expect(order(wrapper)).toEqual(["second", "first", "third"]);
    const announcement = wrapper.get('[role="status"]').text();
    await pointer(source, "pointerdown", { clientX: 300 });
    await pointer(source, "pointermove", { clientX: 310 });
    expect(wrapper.find(".insertion-marker").exists()).toBe(false);
    await pointer(source, "pointerup", { clientX: 310 });
    expect(order(wrapper)).toEqual(["second", "first", "third"]);
    expect(wrapper.get('[role="status"]').text()).toBe(announcement);
  });

  it.each(["pointercancel", "lostpointercapture", "escape", "blur", "outside", "disable", "open", "navigation", "close"])(
    "cancels on %s without committing the pending move",
    async reason => {
      const wrapper = await renderTabs(true);
      const source = tab(wrapper, "first");
      await pointer(source, "pointerdown");
      await pointer(source, "pointermove", { clientX: 280 });
      expect(wrapper.find(".insertion-marker").exists()).toBe(true);
      switch (reason) {
        case "escape": window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); break;
        case "blur": window.dispatchEvent(new Event("blur")); break;
        case "outside": await pointer(source, "pointerup", { clientX: 280, clientY: 100 }); break;
        case "disable": await wrapper.setProps({ reorderable: false }); break;
        case "open": api(wrapper).open(items[0]); break;
        case "navigation": await source.trigger("keydown", { key: "End" }); break;
        case "close": await wrapper.get('[aria-label="Close Second"]').trigger("click"); break;
        default: await pointer(source, reason); break;
      }
      await nextTick();
      await pointer(source, "pointerup", { clientX: 280 });
      expect(order(wrapper)).toEqual(reason === "close" ? ["first", "third"] : ["first", "second", "third"]);
      expect(wrapper.find(".insertion-marker").exists()).toBe(false);
      expect(wrapper.find(".drag-source").exists()).toBe(false);
      await pointer(source, "click", { detail: 1 });
      if (reason === "navigation") expect(selected(wrapper)).toBe("third");
      await source.trigger("click"); // Keyboard-style activation is never swallowed.
      expect(selected(wrapper)).toBe("first");
    },
  );

  it("scrolls at either edge with a stationary pointer and stops at boundaries, on cancellation, and on unmount", async () => {
    const clock = animationClock();
    const wrapper = await renderTabs(true);
    const strip = geometry(wrapper, 160);
    const source = tab(wrapper, "first");
    await pointer(source, "pointerdown");
    await pointer(source, "pointermove", { clientX: 258 });
    expect(clock.pending()).toBe(1);
    await clock.tick(0);
    await clock.tick(64);
    await clock.tick(128);
    await clock.tick(192);
    expect(strip.scrollLeft).toBeGreaterThan(60);
    expect(wrapper.find(".insertion-marker").exists()).toBe(true);
    await pointer(source, "pointerup", { clientX: 258 });
    expect(order(wrapper)).toEqual(["second", "third", "first"]);
    expect(clock.pending()).toBe(0);

    await pointer(source, "pointerdown", { clientX: 240 });
    await pointer(source, "pointermove", { clientX: 102 });
    await clock.tick(200);
    await clock.tick(264);
    await clock.tick(328);
    expect(strip.scrollLeft).toBeLessThan(60);
    window.dispatchEvent(new Event("blur"));
    expect(clock.pending()).toBe(0);

    strip.scrollLeft = 139;
    await pointer(source, "pointerdown", { clientX: 200 });
    await pointer(source, "pointermove", { clientX: 258 });
    await clock.tick(400);
    await clock.tick(464);
    expect(strip.scrollLeft).toBe(140);
    expect(clock.pending()).toBe(0);
    await pointer(source, "pointermove", { clientX: 102 });
    expect(clock.pending()).toBe(1);
    mounted.splice(mounted.indexOf(wrapper), 1);
    wrapper.unmount();
    expect(clock.pending()).toBe(0);
  });
});

describe("Large tab sets", () => {
  it("bounds the strip while End, reorder, and close still operate on all logical descriptors", async () => {
    const wrapper = await renderLargeTabs();
    expect(wrapper.findAll('[role="tab"]').length).toBeLessThan(20);
    expect(pickerTrigger(wrapper).attributes("aria-label")).toBe("Open tabs (2000)");
    await tab(wrapper, "request-0").trigger("keydown", { key: "End" });
    await flushPromises();
    expect(selected(wrapper)).toBe("request-1999");
    expect(document.activeElement).toBe(tab(wrapper, "request-1999").element);
    expect(tab(wrapper, "request-1999").attributes("aria-posinset")).toBe("2000");
    expect(wrapper.findAll('[role="tab"]').length).toBeLessThan(20);

    await tab(wrapper, "request-1999").trigger("keydown", { key: "ArrowLeft", altKey: true, shiftKey: true });
    await flushPromises();
    const reordered = wrapper.emitted("state-change")!.at(-1)![0] as { items: TabItem[] };
    expect(reordered.items.slice(-2).map(item => item.id)).toEqual(["request-1999", "request-1998"]);
    expect(document.activeElement).toBe(tab(wrapper, "request-1999").element);

    await tab(wrapper, "request-1999").trigger("keydown", { key: "Delete" });
    await flushPromises();
    expect(selected(wrapper)).toBe("request-1998");
    expect(document.activeElement).toBe(tab(wrapper, "request-1998").element);
    expect(pickerTrigger(wrapper).attributes("aria-label")).toBe("Open tabs (1999)");
  });

  it("opens, navigates, and selects the final picker entry without mounting the entire menu", async () => {
    const wrapper = await renderLargeTabs();
    await pickerTrigger(wrapper).trigger("keydown", { key: "ArrowUp" });
    await flushPromises();
    expect(wrapper.findAll('[role="menuitemradio"]').length).toBeLessThan(30);
    expect(document.activeElement).toBe(pickerItem(wrapper, "request-1999").element);
    expect(pickerItem(wrapper, "request-1999").attributes("aria-setsize")).toBe("2000");

    await pickerItem(wrapper, "request-1999").trigger("keydown", { key: "ArrowDown" });
    await flushPromises();
    expect(document.activeElement).toBe(pickerItem(wrapper, "request-0").element);
    await pickerItem(wrapper, "request-0").trigger("keydown", { key: "End" });
    await flushPromises();
    await pickerItem(wrapper, "request-1999").trigger("click");
    await flushPromises();
    expect(selected(wrapper)).toBe("request-1999");
    expect(document.activeElement).toBe(tab(wrapper, "request-1999").element);
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(wrapper.findAll('[role="tab"]').length).toBeLessThan(20);
  });

  it("retains pointer capture across virtual scrolling and drops at the logical destination", async () => {
    const wrapper = await renderLargeTabs();
    const source = tab(wrapper, "request-0");
    const captures = new Set<number>();
    Object.assign(source.element, {
      setPointerCapture: (id: number) => captures.add(id),
      hasPointerCapture: (id: number) => captures.has(id),
      releasePointerCapture: (id: number) => captures.delete(id),
    });
    await pointer(source, "pointerdown");
    await pointer(source, "pointermove", { clientX: 130 });
    const strip = wrapper.get<HTMLElement>('[role="tablist"]').element;
    strip.scrollLeft = 220 * 1_000;
    await wrapper.get('[role="tablist"]').trigger("scroll");
    expect(tab(wrapper, "request-0").element).toBe(source.element);
    await pointer(source, "pointermove", { clientX: 420 });
    await pointer(source, "pointerup", { clientX: 420 });
    const reordered = wrapper.emitted("state-change")!.at(-1)![0] as { items: TabItem[] };
    expect(reordered.items[1_000]?.id).toBe("request-0");
    expect(reordered.items[1_001]?.id).toBe("request-1001");
    expect(captures.size).toBe(0);
    expect(wrapper.findAll('[role="tab"]').length).toBeLessThan(20);
  });
});

type TabsWrapper = ReturnType<typeof mount<typeof Tabs>>;
const mounted: { unmount(): void }[] = [];
const items: readonly TabItem[] = [
  { id: "first", label: "First", closable: true },
  { id: "second", label: "Second", closable: true },
  { id: "third", label: "Third" },
];

async function renderLargeTabs() {
  const descriptors = Array.from({ length: 2_000 }, (_, index) => ({ id: `request-${index}`, label: `Request ${index}`, closable: true }));
  const wrapper = mount(Tabs, {
    attachTo: document.body,
    props: { label: "Large tabs", panelId: "large-panel", initialItems: descriptors, reorderable: true },
  });
  mounted.push(wrapper);
  const strip = wrapper.get<HTMLElement>('[role="tablist"]').element;
  strip.getBoundingClientRect = () => new DOMRect(100, 20, 600, 44);
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, value: 600 },
    scrollWidth: { configurable: true, value: 2_000 * 220 },
  });
  await wrapper.get('[role="tablist"]').trigger("scroll");
  await flushPromises();
  return wrapper;
}

async function renderTabs(reorderable = false, initialItems = items) {
  const wrapper = mount(Tabs, {
    attachTo: document.body,
    props: { label: "Example tabs", panelId: "example-panel", reorderable },
  });
  mounted.push(wrapper);
  for (const item of initialItems) api(wrapper).open(item);
  if (initialItems.length > 0) api(wrapper).open(initialItems[0]);
  await nextTick();
  geometry(wrapper);
  return wrapper;
}

function api(wrapper: TabsWrapper) {
  return wrapper.vm as unknown as TabsHandle;
}

function tab(wrapper: TabsWrapper, id: string) {
  return wrapper.get<HTMLButtonElement>(`[data-tab-id="${id}"] [role="tab"]`);
}

function pickerTrigger(wrapper: TabsWrapper) {
  return wrapper.get<HTMLButtonElement>('[aria-haspopup="menu"]');
}

function pickerItem(wrapper: TabsWrapper, id: string) {
  return wrapper.get<HTMLButtonElement>(`[data-picker-tab-id="${id}"]`);
}

function order(wrapper: TabsWrapper) {
  return wrapper.findAll('[data-tab-id]').map(entry => entry.attributes("data-tab-id"));
}

function selected(wrapper: TabsWrapper) {
  return wrapper.get('[aria-selected="true"]').element.parentElement!.dataset.tabId;
}

function geometry(wrapper: TabsWrapper, width = 300, widths = [100, 100, 100]) {
  const strip = wrapper.get<HTMLElement>('[role="tablist"]').element;
  const sizes = new Map(order(wrapper).map((id, index) => [id, widths[index] ?? 100]));
  strip.getBoundingClientRect = () => new DOMRect(100, 20, width, 44);
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, value: width },
    scrollWidth: { configurable: true, value: widths.reduce((sum, value) => sum + value, 0) },
  });
  for (const entry of wrapper.findAll<HTMLElement>('[data-tab-id]')) {
    entry.element.getBoundingClientRect = () => {
      const ids = order(wrapper);
      const index = ids.indexOf(entry.attributes("data-tab-id"));
      const left = ids.slice(0, index).reduce((sum, id) => sum + sizes.get(id)!, 100) - strip.scrollLeft;
      return new DOMRect(left, 20, sizes.get(ids[index])!, 44);
    };
    const captures = new Set<number>();
    Object.assign(entry.get('[role="tab"]').element, {
      setPointerCapture: (id: number) => captures.add(id),
      hasPointerCapture: (id: number) => captures.has(id),
      releasePointerCapture: (id: number) => captures.delete(id),
    });
  }
  return strip;
}

async function pointer(
  target: { element: Element },
  type: string,
  init: MouseEventInit & { pointerId?: number; pointerType?: string; isPrimary?: boolean } = {},
) {
  const { pointerId = 1, pointerType = "mouse", isPrimary = true, ...mouse } = init;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 110, clientY: 40, ...mouse });
  Object.defineProperties(event, {
    pointerId: { value: pointerId }, pointerType: { value: pointerType }, isPrimary: { value: isPrimary },
  });
  // Match Vue Test Utils' trigger timestamp: capture and target listeners must both see
  // synthetic events created in the same millisecond as mounting their listeners.
  Object.assign(event, { _vts: Date.now() + 1 });
  target.element.dispatchEvent(event);
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
