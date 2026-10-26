// Verifies workspace tool entry points and focus restoration through the application's compact header.
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it } from "vitest";
import App from "../src/App.vue";

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
});

it("keeps the sending environment visible while grouping occasional actions behind Workspace tools", async () => {
  const app = render();
  const header = app.get(".app-header");
  expect(header.get('label.environment-selector').text()).toContain("Environment");
  expect(header.get("select").element.value).toBe("local");
  expect(header.findAll("button").map(button => button.attributes("aria-label") ?? button.text()))
    .toEqual(["Quick open ⌘/Ctrl K", "Workspace tools"]);
  await header.get("select").setValue("");
  expect(header.get("select").element.value).toBe("");
  await header.get("select").setValue("local");
  expect(header.get("select").element.value).toBe("local");
  await openTool(app, "Manage environments");
  expect(app.get('[role="dialog"]').text()).toContain("Active for sending: Local.");
  expect(header.get("select").element.value).toBe("local");
});

it.each([
  ["Manage environments", '[role="dialog"][aria-labelledby]', "Close environments"],
  ["Protobuf models", "dialog.protobuf-manager[open]", "Close protobuf models"],
  ["Import / Export", '.import-export [role="dialog"]', "Close import and export"],
])("opens %s from the menu and returns focus on Escape", async (name, selector, closeLabel) => {
  const app = render();
  await openTool(app, name);
  expect(app.get(selector).isVisible()).toBe(true);
  const close = app.get(`[aria-label="${closeLabel}"]`);
  await close.trigger("keydown", { key: "Escape" });
  if (name === "Protobuf models") expect(app.get("dialog.protobuf-manager").attributes("open")).toBeUndefined();
  else expect(app.find(selector).exists()).toBe(false);
  expect(document.activeElement).toBe(app.get('.app-header [aria-label="Workspace tools"]').element);
});

it("preserves import behavior when launched from the workspace menu", async () => {
  const app = render();
  await openTool(app, "Import / Export");
  await app.get('.import-export textarea').setValue("curl 'https://example.com/from-header'");
  await app.findAll("button").find(button => button.text() === "Import")!.trigger("click");
  expect(app.get('.import-export [role="status"]').text()).toContain("Imported 1 request(s)");
  await app.get('[aria-label="Close import and export"]').trigger("click");
  await app.findAll("aside button").find(button => button.text().startsWith("Imported cURL request"))!.trigger("click");
  expect(app.get<HTMLInputElement>('[aria-label="Request URL"]').element.value).toBe("https://example.com/from-header");
});

it("dismisses workspace tools when the quick-open shortcut moves focus to its dialog", async () => {
  const app = render();
  const tools = app.get('.app-header [aria-label="Workspace tools"]');
  await tools.trigger("click");
  expect(app.find('.workspace-tools [role="menu"]').exists()).toBe(true);
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", {
    key: "k", metaKey: true, bubbles: true, cancelable: true,
  }));
  await flushPromises();
  expect(app.find('.workspace-tools [role="menu"]').exists()).toBe(false);
  expect(tools.attributes("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(app.get('.quick-open [role="combobox"]').element);
  await app.get('[aria-label="Close quick open"]').trigger("click");
  expect(app.find('.workspace-tools [role="menu"]').exists()).toBe(false);
});

type AppWrapper = ReturnType<typeof mount<typeof App>>;
const mounted: AppWrapper[] = [];

function render() {
  const app = mount(App, { attachTo: document.body });
  mounted.push(app);
  return app;
}

async function openTool(app: AppWrapper, name: string) {
  await app.get('.app-header [aria-label="Workspace tools"]').trigger("click");
  await app.findAll('[role="menuitem"]').find(item => item.text() === name)!.trigger("click");
  await flushPromises();
}
