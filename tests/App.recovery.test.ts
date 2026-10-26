// Exercises draft recovery, background feedback, and non-destructive history Undo through the workspace UI.
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import RequestEditor from "../src/components/RequestEditor.vue";
import HistoryInspector from "../src/components/HistoryInspector.vue";
import { executeHttp } from "../src/http";
import type { HistoryEntry, HttpResponse } from "../src/request";
import { createWorkspace, loadWorkspace, saveWorkspace } from "../src/workspace";

vi.mock("../src/http", () => ({ executeHttp: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(executeHttp).mockReset().mockResolvedValue(response);
});
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.replaceChildren();
});

it("autosaves captured drafts and restores exact replay inputs after reload", async () => {
  const app = await historyApp();
  await button(app, "Open as draft").trigger("click");
  const id = loadWorkspace().workspace.activeTabId!;
  expect(loadWorkspace().workspace.drafts[id].capturedRequest).toEqual(captured.request);
  expect(app.get('.unsaved-marker').exists()).toBe(true);
  unmount(app);
  const restored = render();
  await flushPromises();

  expect(restored.getComponent(RequestEditor).props("capturedRequest")).toEqual(captured.request);
  expect(restored.getComponent(RequestEditor).props("modelValue").body).toBe("{{literal}}");
  expect(restored.text()).toContain("Autosaved locally");
  await button(restored, "Send").trigger("click");
  await flushPromises();
  expect(vi.mocked(executeHttp).mock.calls[0][0]).toEqual(captured.request);
});

it("recovers an edited closed draft after reload without promoting it to Collections", async () => {
  const app = await historyApp();
  await button(app, "Open as draft").trigger("click");
  await app.get('[aria-label="Request URL"]').setValue("https://edited.test/action");
  const editor = app.getComponent(RequestEditor);
  editor.vm.$emit("update:layout", { horizontal: "61%", vertical: "43%" });
  await flushPromises();
  const id = loadWorkspace().workspace.activeTabId!;
  await app.get('[aria-label="Close Captured request · Unsaved"]').trigger("click");
  expect(loadWorkspace().workspace.closedDraftIds).toEqual([id]);
  expect(loadWorkspace().workspace.drafts[id].capturedRequest).toBeUndefined();
  unmount(app);
  const restored = render();
  await button(restored, "Reopen closed draft").trigger("click");

  expect(restored.get('[aria-label="Request URL"]').element.value).toBe("https://edited.test/action");
  expect(restored.getComponent(RequestEditor).props("layout")).toEqual({ horizontal: "61%", vertical: "43%" });
  expect(loadWorkspace().workspace.closedDraftIds).toEqual([]);
  expect(loadWorkspace().workspace.requests[id]).toBeUndefined();
  await button(restored, "Save to Collections").trigger("click");
  expect(loadWorkspace().workspace.drafts[id]).toBeUndefined();
  expect(loadWorkspace().workspace.requests[id].path).toBe("https://edited.test/action");
});

it("shows progress and completed HTTP errors on an inactive request tab", async () => {
  let complete!: (response: HttpResponse) => void;
  vi.mocked(executeHttp).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const app = render();
  await selectRequest(app, "Create workspace");
  await button(app, "Send").trigger("click");
  await selectRequest(app, "List workspaces");
  const sendingTab = app.findAll('[role="tab"]').find(tab => tab.find('.tab-label').text() === "Create workspace")!;
  expect(sendingTab.text()).toContain("Sending");
  complete({ ...response, status: 403, statusText: "Forbidden" });
  await flushPromises();
  expect(sendingTab.get('.tab-execution').text()).toBe("403");
  expect(sendingTab.attributes('aria-selected')).toBe("false");
});

it("announces a completed closed-tab request and opens its captured response", async () => {
  let complete!: (response: HttpResponse) => void;
  vi.mocked(executeHttp).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const app = render();
  await selectRequest(app, "Create workspace");
  await button(app, "Send").trigger("click");
  await app.get('[aria-label="Close Create workspace"]').trigger("click");
  complete(response);
  await flushPromises();
  expect(app.get('.workspace-notice').text()).toContain("Create workspace · 200 OK");
  await button(app, "Show response").trigger("click");
  expect(app.getComponent(HistoryInspector).props("entry").request.url).toBe("http://localhost:8080/workspaces");
  expect(app.find('.workspace-notice').exists()).toBe(false);
});

it("undoes clearing history without dropping executions completed since the clear", async () => {
  const app = await historyApp();
  await button(app, "Clear history").trigger("click");
  expect(app.getComponent(HistoryInspector).props("entry").id).toBe(captured.id);
  await button(app, "Collections").trigger("click");
  await selectRequest(app, "Create workspace");
  await button(app, "Send").trigger("click");
  await flushPromises();
  const recent = loadWorkspace().workspace.history[0];
  await button(app, "Undo clear history").trigger("click");
  expect(loadWorkspace().workspace.history).toHaveLength(2);
  expect(loadWorkspace().workspace.history).toEqual(expect.arrayContaining([captured, recent]));
  expect(app.find('.workspace-notice').exists()).toBe(false);
});

it("opens the active environment editor from a field error and focuses its variables", async () => {
  const app = render();
  await selectRequest(app, "Create workspace");
  await app.get('[aria-label="Request URL"]').setValue("{{missing}}/action");
  await app.get('.url-field .field-error button').trigger("click");
  await flushPromises();
  expect(app.get('.management-panel').isVisible()).toBe(true);
  expect(app.get('.inspection-selection select').element.value).toBe("local");
  expect(document.activeElement).toBe(app.get('[aria-label="variable 1 name"]').element);
});

const response: HttpResponse = {
  url: "https://captured.test/action", status: 200, statusText: "OK",
  headers: [{ name: "Content-Type", value: "application/json" }], body: '{"ok":true}', durationMs: 12, sizeBytes: 11,
};
const captured: HistoryEntry = {
  id: "captured", requestId: "create-workspace", name: "Captured request", startedAt: "2026-10-22T10:00:00Z",
  request: {
    method: "POST", url: response.url, headers: [{ name: "X-Literal", value: "{{literal}}" }],
    body: "{{literal}}", timeoutMs: 5000,
  },
  result: { status: "success", response },
};
type AppWrapper = ReturnType<typeof mount<typeof App>>;
const mounted: AppWrapper[] = [];

function render() {
  const app = mount(App, { attachTo: document.body });
  mounted.push(app);
  return app;
}
function unmount(app: AppWrapper) {
  app.unmount();
  mounted.splice(mounted.indexOf(app), 1);
}
async function historyApp() {
  const workspace = createWorkspace();
  workspace.history = [captured];
  saveWorkspace(workspace);
  const app = render();
  await button(app, "History").trigger("click");
  await app.get('.history-select').trigger("click");
  return app;
}
async function selectRequest(app: AppWrapper, name: string) {
  const folder = app.findAll('aside button').find(button => button.text().includes("Workspaces"))!;
  if (folder.attributes('aria-expanded') === "false") await folder.trigger("click");
  await app.findAll('aside button').find(button => button.text().startsWith(name))!.trigger("click");
}
function button(app: AppWrapper, name: string) {
  return app.findAll('button').find(button => button.text() === name)!;
}
