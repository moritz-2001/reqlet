// Verifies the compact workspace menu through its visible actions and keyboard focus behavior.
import { mount } from "@vue/test-utils";
import { afterEach, expect, it } from "vitest";
import WorkspaceTools from "../src/components/WorkspaceTools.vue";

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
});

it("groups all workspace managers and restores a stable focus target before selecting one", async () => {
  const menu = render();
  const trigger = menu.get('[aria-label="Workspace tools"]');
  expect(menu.find('[role="menu"]').exists()).toBe(false);
  await trigger.trigger("click");
  const items = menu.findAll('[role="menuitem"]');
  expect(items.map(item => item.text())).toEqual(["Manage environments", "Protobuf models", "Import / Export"]);
  expect(document.activeElement).toBe(items[0].element);
  expect(trigger.attributes("aria-expanded")).toBe("true");
  await items[1].trigger("click");
  expect(menu.emitted("select")).toEqual([["protobuf"]]);
  expect(menu.find('[role="menu"]').exists()).toBe(false);
  expect(document.activeElement).toBe(trigger.element);
});

it("supports arrow keys, Home, End, and Escape without leaking focus into removed items", async () => {
  const menu = render();
  const trigger = menu.get('[aria-label="Workspace tools"]');
  await trigger.trigger("keydown", { key: "ArrowUp" });
  const items = menu.findAll('[role="menuitem"]');
  expect(document.activeElement).toBe(items[2].element);
  await items[2].trigger("keydown", { key: "ArrowDown" });
  expect(document.activeElement).toBe(items[0].element);
  await items[0].trigger("keydown", { key: "End" });
  expect(document.activeElement).toBe(items[2].element);
  await items[2].trigger("keydown", { key: "Home" });
  expect(document.activeElement).toBe(items[0].element);
  await items[0].trigger("keydown", { key: "Escape" });
  expect(menu.find('[role="menu"]').exists()).toBe(false);
  expect(document.activeElement).toBe(trigger.element);
  expect(menu.emitted("select")).toBeUndefined();
});

it.each([false, true])("dismisses for native Tab navigation from its stable header trigger (shift=%s)", async shiftKey => {
  const menu = render();
  const trigger = menu.get('[aria-label="Workspace tools"]');
  await trigger.trigger("click");
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(event);
  await menu.vm.$nextTick();
  expect(menu.find('[role="menu"]').exists()).toBe(false);
  // The browser continues its native Tab order from this element; jsdom does not implement traversal.
  expect(document.activeElement).toBe(trigger.element);
  expect(event.defaultPrevented).toBe(false);
});

it("dismisses on outside pointer input without taking focus from the clicked control", async () => {
  const menu = render();
  await menu.get('[aria-label="Workspace tools"]').trigger("click");
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await menu.vm.$nextTick();
  expect(menu.find('[role="menu"]').exists()).toBe(false);
  expect(document.activeElement).toBe(outside);
});

it("dismisses when another control receives focus without taking that focus back", async () => {
  const menu = render();
  await menu.get('[aria-label="Workspace tools"]').trigger("keydown", { key: "ArrowDown" });
  expect(document.activeElement).toBe(menu.get('[role="menuitem"]').element);
  const outside = document.createElement("input");
  document.body.append(outside);
  outside.focus();
  await menu.vm.$nextTick();
  expect(menu.find('[role="menu"]').exists()).toBe(false);
  expect(menu.get('[aria-label="Workspace tools"]').attributes("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(outside);
  expect(menu.emitted("select")).toBeUndefined();
});

type MenuWrapper = ReturnType<typeof mount<typeof WorkspaceTools>>;
const mounted: MenuWrapper[] = [];

function render() {
  const menu = mount(WorkspaceTools, { attachTo: document.body });
  mounted.push(menu);
  return menu;
}
