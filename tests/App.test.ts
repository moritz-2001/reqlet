// Verifies request-tab lifecycle through collection controls and the rendered editors.
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { editorView, replaceText } from "./editor";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import RequestEditor from "../src/components/RequestEditor.vue";
import * as http from "../src/http";

beforeEach(() => localStorage.clear());

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("opens nested requests once, activates existing tabs, and keeps their order", async () => {
  const app = await renderApp();
  await selectRequest(app, "Create workspace");
  await selectRequest(app, "Invite member");
  await selectRequest(app, "Create workspace");

  expect(app.findAll('[aria-label="Open workspace tabs"] [role="tab"]').map(tab => tab.text())).toEqual(["Create workspace", "Invite member"]);
  expect(activeTab(app)).toBe("Create workspace");
  expect(app.get('aside [aria-current="true"]').text()).toContain("Create workspace");
  await app.findAll('[aria-label="Open workspace tabs"] [role="tab"]')[1].trigger("click");
  expect(activePanel(app).get<HTMLInputElement>('[aria-label="Request URL"]').element.value).toContain("/workspaces/ws_8f29/members");
  expect(app.get('aside [aria-current="true"]').text()).toContain("Invite member");
});

it("renders one external shared panel and caches editors by request ID", async () => {
  const app = await renderApp();
  await selectRequest(app, "Create workspace");
  const firstEditor = activePanel(app).get(".request-editor").element;
  const panel = activePanel(app).element;
  await selectRequest(app, "List workspaces");

  const strip = app.get('[role="tablist"][aria-label="Open workspace tabs"]').element;
  for (const tab of app.findAll('[aria-label="Open workspace tabs"] [role="tab"]')) {
    expect(document.getElementById(tab.attributes("aria-controls")!)).toBe(panel);
  }
  expect(strip.contains(panel)).toBe(false);
  expect(app.findAll('.request-panel[role="tabpanel"]')).toHaveLength(1);
  expect(app.findAll(".request-editor")).toHaveLength(1);
  expect(panel.getAttribute("aria-label")).toBe("List workspaces");
  expect(activePanel(app).get(".request-editor").element).not.toBe(firstEditor);
  await selectRequest(app, "Create workspace");
  expect(activePanel(app).get(".request-editor").element).toBe(firstEditor);
});

it("keeps active content, selection, drafts, editor identity, and status intact when reordered", async () => {
  const app = await renderApp();
  await selectRequest(app, "Create workspace");
  await replaceText(activePanel(app).get(".body-text").element, "retained draft");
  const firstEditor = activePanel(app).get(".request-editor").element;
  await selectRequest(app, "List workspaces");
  await selectRequest(app, "Invite member");
  await selectRequest(app, "Create workspace");
  const firstTab = app.findAll('[aria-label="Open workspace tabs"] [role="tab"]')[0];
  await firstTab.trigger("keydown", { key: "ArrowRight", altKey: true, shiftKey: true });
  expect(app.findAll('[aria-label="Open workspace tabs"] [role="tab"]').map(tab => tab.text())).toEqual(["List workspaces", "Create workspace", "Invite member"]);
  expect(activeTab(app)).toBe("Create workspace");
  expect(app.get('aside [aria-current="true"]').text()).toContain("Create workspace");
  expect(activePanel(app).get(".request-editor").element).toBe(firstEditor);
  expect(editorView(activePanel(app).get(".body-text").element).state.doc.toString()).toBe("retained draft");
  expect(app.get(".app-status").text()).toContain("3 tabs open");
  await app.get('[aria-label="Close Create workspace"]').trigger("click");
  expect(activeTab(app)).toBe("Invite member");
  expect(app.get(".app-status").text()).toContain("2 tabs open");
});

it("keeps body edits and content types independent, including after closing and reopening", async () => {
  const app = await renderApp();
  await selectRequest(app, "Create workspace");
  await replaceText(activePanel(app).get(".body-text").element, "my request draft");
  await activePanel(app).get("select").setValue("text/plain");
  await (await bodyActions(app)).get('[role="menuitemcheckbox"]').trigger("click");
  await selectRequest(app, "List workspaces");
  expect(editorView(activePanel(app).get(".body-text").element).state.doc.toString()).toBe("");
  expect(activePanel(app).get("select").element.value).toBe("application/json");
  await activePanel(app).findAll("button").find(button => button.text() === "Add body")!.trigger("click");
  expect((await bodyActions(app)).get('[role="menuitemcheckbox"]').attributes("aria-checked")).toBe("false");

  await selectRequest(app, "Create workspace");
  expect(editorView(activePanel(app).get(".body-text").element).state.doc.toString()).toBe("my request draft");
  expect((await bodyActions(app)).get('[role="menuitemcheckbox"]').attributes("aria-checked")).toBe("true");
  await app.get('[aria-label="Close Create workspace"]').trigger("click");
  await selectRequest(app, "Create workspace");
  expect(editorView(activePanel(app).get(".body-text").element).state.doc.toString()).toBe("my request draft");
  expect(activePanel(app).get("select").element.value).toBe("text/plain");
  expect((await bodyActions(app)).get('[role="menuitemcheckbox"]').attributes("aria-checked")).toBe("true");
});

it("retains independent folds in cached request editors, including after reopening", async () => {
  const app = await renderApp();
  await selectRequest(app, "Create workspace");
  const first = activePanel(app).get(".body-text");
  await (await bodyActions(app)).findAll("button").find(button => button.text() === "Collapse value")!.trigger("click");
  expect(first.find(".cm-foldPlaceholder").exists()).toBe(true);
  await selectRequest(app, "List workspaces");
  expect(activePanel(app).get(".body-text").find(".cm-foldPlaceholder").exists()).toBe(false);
  await selectRequest(app, "Create workspace");
  expect(activePanel(app).get(".body-text").find(".cm-foldPlaceholder").exists()).toBe(true);
  await app.get('[aria-label="Close Create workspace"]').trigger("click");
  await selectRequest(app, "Create workspace");
  expect(activePanel(app).get(".body-text").find(".cm-foldPlaceholder").exists()).toBe(true);
});

it("keeps pane splits independent while switching tabs and restores them after reopening", async () => {
  vi.spyOn(http, "executeHttp").mockResolvedValue({
    url: "http://localhost:8080/workspaces", status: 200, statusText: "OK",
    headers: [], body: "Response body", durationMs: 1, sizeBytes: 13,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    return this.classList.contains("body-panels")
      ? new DOMRect(0, 0, 600, 500)
      : new DOMRect(0, 0, 800, 600);
  });
  const app = await renderApp();
  await selectRequest(app, "List workspaces");
  await activePanel(app).findAll("button").find(button => button.text() === "Add body")!.trigger("click");
  await activePanel(app).get(".send-button").trigger("click");
  await flushPromises();
  const otherInitialValue = activePanel(app).get('[role="separator"]').attributes("aria-valuenow");
  await selectRequest(app, "Create workspace");
  await activePanel(app).get(".send-button").trigger("click");
  await flushPromises();
  const divider = activePanel(app).get('[role="separator"]');
  const initialValue = divider.attributes("aria-valuenow");
  await divider.trigger("keydown", { key: "ArrowDown" });
  const resizedValue = divider.attributes("aria-valuenow");
  expect(resizedValue).not.toBe(initialValue);

  await selectRequest(app, "List workspaces");
  expect(activePanel(app).get('[role="separator"]').attributes("aria-valuenow")).toBe(otherInitialValue);
  await selectRequest(app, "Create workspace");
  expect(activePanel(app).get('[role="separator"]').attributes("aria-valuenow")).toBe(resizedValue);
  await app.get('[aria-label="Close Create workspace"]').trigger("click");
  await selectRequest(app, "Create workspace");
  expect(activePanel(app).get('[role="separator"]').attributes("aria-valuenow")).toBe(resizedValue);
});

it("keeps a cached editor's delayed updates bound to its request after switching", async () => {
  const app = await renderApp();
  await selectRequest(app, "Create workspace");
  const first = app.getComponent(RequestEditor);
  const updated = { ...first.props("modelValue"), body: "update completed after switching" };
  await selectRequest(app, "List workspaces");
  first.vm.$emit("update:modelValue", updated);
  expect(editorView(activePanel(app).get(".body-text").element).state.doc.toString()).toBe("");
  await selectRequest(app, "Create workspace");
  expect(editorView(activePanel(app).get(".body-text").element).state.doc.toString()).toBe(updated.body);
});

it("keeps selection when an inactive tab closes and selects right, then left, then empty", async () => {
  const app = await renderApp();
  for (const name of ["Create workspace", "List workspaces", "Invite member"]) await selectRequest(app, name);
  await app.get('[aria-label="Close List workspaces"]').trigger("click");
  expect(activeTab(app)).toBe("Invite member");

  await selectRequest(app, "List workspaces");
  await selectRequest(app, "Invite member");
  await app.get('[aria-label="Close Invite member"]').trigger("click");
  expect(activeTab(app)).toBe("List workspaces");
  await app.get('[aria-label="Close List workspaces"]').trigger("click");
  expect(activeTab(app)).toBe("Create workspace");
  await app.get('[aria-label="Open workspace tabs"] [role="tab"]').trigger("keydown", { key: "Delete" });
  expect(app.findAll('[aria-label="Open workspace tabs"] [role="tab"]')).toHaveLength(0);
  expect(app.find(".request-editor").exists()).toBe(false);
  expect(app.get(".app-status").text()).toContain("0 tabs open");
  await selectRequest(app, "Create workspace");
  expect(app.get(".app-status").text()).toContain("1 tab open");
  await app.get('[aria-label="Close Create workspace"]').trigger("click");
  expect(app.findAll('aside [aria-current="true"]')).toHaveLength(0);
  expect(app.text()).toContain("Select a request from Collections");
});

type AppWrapper = ReturnType<typeof mount<typeof App>>;
const mounted: AppWrapper[] = [];

async function renderApp() {
  const app = mount(App, { attachTo: document.body });
  mounted.push(app);
  await app.get('aside .folder-row[aria-expanded="false"]').trigger("click");
  return app;
}

async function selectRequest(app: AppWrapper, name: string) {
  if (name === "Invite member") {
    const members = app.findAll("aside button").find(button => button.text().includes("Members"))!;
    if (members.attributes("aria-expanded") === "false") await members.trigger("click");
  }
  const request = app.findAll("aside button").find(button => button.text().startsWith(name))!;
  await request.trigger("click");
}

function activeTab(app: AppWrapper) {
  return app.get('[aria-label="Open workspace tabs"] [role="tab"][aria-selected="true"]').text();
}

function activePanel(app: AppWrapper) {
  return app.get('.request-panel[role="tabpanel"]:not([hidden])');
}

async function bodyActions(app: AppWrapper) {
  const trigger = activePanel(app).get('.body-panel [aria-label="More body actions"]');
  await trigger.trigger("click");
  return new DOMWrapper(document.getElementById(trigger.attributes("aria-controls")!)!);
}
