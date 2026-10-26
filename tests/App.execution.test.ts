// Exercises sending, cancellation, replay, and reload through the complete workspace interface.
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import RequestEditor from "../src/components/RequestEditor.vue";
import HistoryInspector from "../src/components/HistoryInspector.vue";
import { executeHttp } from "../src/http";
import { createWorkspace, loadWorkspace, saveWorkspace } from "../src/workspace";
import type { HistoryEntry, HttpResponse } from "../src/request";
import { editorView, replaceText } from "./editor";
import { isBodyDocument } from "../src/bodyDocument";

vi.mock("../src/http", () => ({ executeHttp: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(executeHttp).mockReset();
  vi.mocked(executeHttp).mockResolvedValue(response);
});

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.replaceChildren();
});

it("sends a resolved snapshot and inspects real response metadata", async () => {
  const app = await renderRequest();
  await button(app, "Send").trigger("click");
  await flushPromises();

  expect(executeHttp).toHaveBeenCalledTimes(1);
  expect(vi.mocked(executeHttp).mock.calls[0][0]).toMatchObject({
    method: "POST", url: "http://localhost:8080/workspaces",
  });
  expect(app.text()).toContain("201");
  expect(app.text()).toContain("Created");
  expect(app.text()).toContain("37");
});

it("sends the newest editor revision immediately and keeps the execution snapshot independent of later edits", async () => {
  const app = await renderRequest();
  const editor = app.getComponent(RequestEditor);
  const surface = editor.get('.body-text');
  await replaceText(surface.element, '{"value":"fresh {{baseUrl}}"}');
  expect(isBodyDocument(editor.props("modelValue").body)).toBe(true);
  await button(app, "Send").trigger("click");
  await flushPromises();
  const captured = vi.mocked(executeHttp).mock.calls[0][0];
  expect(captured.body).toBe('{"value":"fresh http://localhost:8080"}');

  const view = editorView(surface.element);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "later" }, userEvent: "input" });
  expect(captured.body).toBe('{"value":"fresh http://localhost:8080"}');
});

it("cancels an operation and retains cancellation separately from transport errors", async () => {
  vi.mocked(executeHttp).mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  }));
  const app = await renderRequest();
  await button(app, "Send").trigger("click");
  expect(app.text()).toContain("Cancel");
  await button(app, "Cancel").trigger("click");
  await flushPromises();

  expect(app.text().toLowerCase()).toContain("cancelled");
  expect(button(app, "Send").attributes("disabled")).toBeUndefined();
});

it("replays the exact snapshot after its draft URL changes", async () => {
  const app = await renderRequest();
  await button(app, "Send").trigger("click");
  await flushPromises();
  const original = vi.mocked(executeHttp).mock.calls[0][0];
  const editor = app.getComponent(RequestEditor);
  editor.vm.$emit("update:modelValue", { ...editor.props("modelValue"), path: "http://different.test/changed" });
  await flushPromises();
  await button(app, "History").trigger("click");
  await app.get("aside .history-select").trigger("click");
  await button(app, "Send again").trigger("click");
  await flushPromises();

  expect(vi.mocked(executeHttp).mock.calls[1][0]).toEqual(original);
  expect(app.getComponent(RequestEditor).props("modelValue").path).toBe(original.url);
  await workspaceTabs(app).find(tab => tab.get(".tab-label").text() === "Create workspace")!.trigger("click");
  expect(app.getComponent(RequestEditor).props("modelValue").path).toBe("http://different.test/changed");
});

it("keeps execution errors visible and allows another attempt", async () => {
  vi.mocked(executeHttp).mockRejectedValueOnce(new Error("Connection refused"));
  const app = await renderRequest();
  await button(app, "Send").trigger("click");
  await flushPromises();
  expect(app.text()).toContain("Connection refused");
  await button(app, "Send").trigger("click");
  await flushPromises();
  expect(app.text()).toContain("201");
});

it("keeps an exchange alive while its tab closes and restores its completed response", async () => {
  let complete!: (value: HttpResponse) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(executeHttp).mockImplementation((_request, operationSignal) => {
    signal = operationSignal;
    return new Promise(resolve => { complete = resolve; });
  });
  const app = await renderRequest();
  await button(app, "Send").trigger("click");
  await app.get('[aria-label="Close Create workspace"]').trigger("click");
  expect(signal?.aborted).toBe(false);
  complete(response);
  await flushPromises();
  await app.findAll("aside button").find(item => item.text().startsWith("Create workspace"))!.trigger("click");
  expect(app.text()).toContain("201 Created");
});

it("deleting a running request cancels it and removes its open tab", async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(executeHttp).mockImplementation((_request, operationSignal) => {
    signal = operationSignal;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    });
  });
  const app = await renderRequest();
  await button(app, "Send").trigger("click");
  await collectionAction(app, "Create workspace", "Delete");
  await app.get('form[aria-label="Delete request"]').trigger("submit");
  await flushPromises();

  expect(signal?.aborted).toBe(true);
  expect(workspaceTabs(app)).toHaveLength(0);
  expect(app.text()).toContain("Select a request from Collections");
});

it("renaming an open request updates the tab and editor heading", async () => {
  const app = await renderRequest();
  await collectionAction(app, "Create workspace", "Rename");
  await app.get('[aria-label="Collection entry name"]').setValue("Renamed workspace");
  await app.get('form[aria-label="Rename request"]').trigger("submit");
  await flushPromises();

  expect(selectedTab(app).get(".tab-label").text()).toBe("Renamed workspace");
  expect(app.get("h1.request-heading").text()).toBe("Renamed workspace");
});

it("restores edited requests and open tabs after remounting", async () => {
  const app = await renderRequest();
  const editor = app.getComponent(RequestEditor);
  editor.vm.$emit("update:modelValue", { ...editor.props("modelValue"), path: "http://localhost:8081/persisted" });
  await flushPromises();
  app.unmount();
  mounted.splice(mounted.indexOf(app), 1);
  const restored = mount(App, { attachTo: document.body });
  mounted.push(restored);
  await flushPromises();

  expect(restored.getComponent(RequestEditor).props("modelValue").path).toBe("http://localhost:8081/persisted");
  expect(selectedTab(restored).text()).toBe("Create workspace");
});

it("opens a captured execution in the workspace without sending or changing saved requests", async () => {
  const app = await renderRequest();
  await button(app, "Send").trigger("click");
  await flushPromises();
  const editorElement = app.get(".request-editor").element;
  const editor = app.getComponent(RequestEditor);
  editor.vm.$emit("update:modelValue", { ...editor.props("modelValue"), body: "my unsent draft" });
  vi.mocked(executeHttp).mockRejectedValueOnce(new Error("Latest execution failed"));
  await button(app, "Send").trigger("click");
  await flushPromises();
  const saved = loadWorkspace().workspace;
  await button(app, "History").trigger("click");
  const earlierExecution = app.findAll("aside .history-select")[1];
  await earlierExecution.trigger("click");

  const panel = app.get('.request-panel:not([hidden])');
  expect(panel.text()).toContain("History · Read-only execution snapshot");
  expect(panel.text()).toContain("201 Created");
  expect(panel.text()).not.toContain("Latest execution failed");
  expect(panel.findAll('[role="textbox"]').every(box => box.attributes("aria-readonly") === "true")).toBe(true);
  expect(app.find("aside .response-inspector").exists()).toBe(false);
  expect(executeHttp).toHaveBeenCalledTimes(2);
  expect(loadWorkspace().workspace).toEqual(saved);
  expect(workspaceTabs(app)).toHaveLength(2);
  await earlierExecution.trigger("click");
  expect(workspaceTabs(app)).toHaveLength(2);

  await app.get('[aria-label="Close Create workspace · History"]').trigger("click");
  expect(selectedTab(app).get(".tab-label").text()).toBe("Create workspace");
  expect(app.get(".request-editor").element).toBe(editorElement);
  expect(app.getComponent(RequestEditor).props("modelValue").body).toBe("my unsent draft");
  expect(panel.text()).toContain("Latest execution failed");
});

it("keeps an inspected snapshot open after clearing history and restores only saved tabs", async () => {
  const app = await renderRequest();
  await button(app, "Send").trigger("click");
  await flushPromises();
  await button(app, "History").trigger("click");
  await app.get("aside .history-select").trigger("click");
  await button(app, "Clear history").trigger("click");

  expect(app.getComponent(HistoryInspector).text()).toContain("201 Created");
  expect(app.get("aside").text()).toContain("No executions yet");
  expect(loadWorkspace().workspace.history).toEqual([]);
  expect(loadWorkspace().workspace.openTabIds).toEqual(["create-workspace"]);
  expect(loadWorkspace().workspace.activeTabId).toBe("create-workspace");
  app.unmount();
  mounted.splice(mounted.indexOf(app), 1);
  const restored = mount(App, { attachTo: document.body });
  mounted.push(restored);
  await flushPromises();

  expect(restored.findComponent(HistoryInspector).exists()).toBe(false);
  expect(workspaceTabs(restored).map(tab => tab.get(".tab-label").text())).toEqual(["Create workspace"]);
  expect(restored.getComponent(RequestEditor).props("modelValue").name).toBe("Create workspace");
});

it("can inspect history with no saved tabs without persisting its runtime identity", async () => {
  const workspace = createWorkspace();
  workspace.history = [{
    id: "old-execution", requestId: "deleted-request", name: "Deleted request",
    startedAt: "2026-10-22T11:00:00Z",
    request: { method: "GET", url: "https://api.example.test/old", headers: [], body: "", timeoutMs: 5000 },
    result: { status: "success", response },
  }];
  saveWorkspace(workspace);
  const app = mount(App, { attachTo: document.body });
  mounted.push(app);
  await button(app, "History").trigger("click");
  await app.get("aside .history-select").trigger("click");

  expect(app.getComponent(HistoryInspector).props("entry").requestId).toBe("deleted-request");
  expect(loadWorkspace().workspace).toEqual(workspace);
  expect(executeHttp).not.toHaveBeenCalled();
  await app.get('[aria-label="Close Deleted request · History"]').trigger("click");
  expect(workspaceTabs(app)).toHaveLength(0);
  expect(app.text()).toContain("Select a request from Collections");
});

it("opens captured inputs as a visibly unsaved draft without sending or growing collections", async () => {
  const app = await renderHistory();
  const saved = loadWorkspace().workspace;
  await button(app, "Open as draft").trigger("click");

  expect(executeHttp).not.toHaveBeenCalled();
  expect(app.getComponent(RequestEditor).props("modelValue")).toMatchObject({
    name: captured.name, inputMode: "literal", method: "POST", path: captured.request.url,
    headers: captured.request.headers.map(header => ({ ...header, enabled: true })),
    query: [], auth: { type: "none" }, body: "{{literal}}", timeoutMs: 5000,
  });
  expect(app.text()).toContain("Unsaved draft");
  expect(app.text()).toContain("Autosaved locally. Recoverable after closing or reload");
  expect(app.get(".request-target").text()).toContain("Captured inputs");
  expect(loadWorkspace().workspace.requests).toEqual(saved.requests);
  expect(loadWorkspace().workspace.collection).toEqual(saved.collection);
  expect(Object.keys(loadWorkspace().workspace.drafts)).toHaveLength(1);

  const editor = app.getComponent(RequestEditor);
  editor.vm.$emit("update:modelValue", { ...editor.props("modelValue"), body: "edited {{baseUrl}}" });
  await flushPromises();
  expect(app.get(".request-target").text()).toContain("Literal inputs");
  expect(app.getComponent(RequestEditor).props("capturedRequest")).toBeUndefined();
  await button(app, "Send").trigger("click");
  await flushPromises();
  expect(vi.mocked(executeHttp).mock.calls[0][0].body).toBe("edited {{baseUrl}}");
  await app.get(".input-mode-field select").setValue("template");
  await button(app, "Send").trigger("click");
  await flushPromises();
  expect(vi.mocked(executeHttp).mock.calls[1][0].body).toBe("edited http://localhost:8080");
  expect(loadWorkspace().workspace.requests).toEqual(saved.requests);
  expect(loadWorkspace().workspace.collection).toEqual(saved.collection);
  expect(loadWorkspace().workspace.history.find(entry => entry.id === captured.id)).toEqual(captured);
});

it("sends the exact captured request repeatedly without adding saved definitions or applying a changed environment", async () => {
  const app = await renderHistory();
  const saved = loadWorkspace().workspace;
  await app.get(".environment-selector select").setValue("");
  // The captured body/header deliberately contain placeholders that must remain literal.
  for (let index = 0; index < 3; index++) {
    await workspaceTabs(app).find(tab => tab.get(".tab-label").text() === `${captured.name} · History`)!.trigger("click");
    await button(app, "Send again").trigger("click");
    await flushPromises();
    expect(vi.mocked(executeHttp).mock.calls[index][0]).toEqual(captured.request);
    expect(app.get(".request-target").text()).toContain("Captured inputs");
    expect(app.text()).toContain("201 Created");
  }

  expect(executeHttp).toHaveBeenCalledTimes(3);
  expect(loadWorkspace().workspace.requests).toEqual(saved.requests);
  expect(loadWorkspace().workspace.collection).toEqual(saved.collection);
  expect(loadWorkspace().workspace.history).toHaveLength(4);
  expect(loadWorkspace().workspace.openTabIds).toHaveLength(3);
  expect(Object.keys(loadWorkspace().workspace.drafts)).toHaveLength(3);
});

it("keeps an unedited captured draft exact on manual Send and retains failures for retry", async () => {
  const app = await renderHistory();
  await button(app, "Open as draft").trigger("click");
  vi.mocked(executeHttp).mockRejectedValueOnce(new Error("Snapshot transport failed"));
  await button(app, "Send").trigger("click");
  await flushPromises();
  expect(app.get(".response-inspector").text()).toContain("Snapshot transport failed");
  await button(app, "Send").trigger("click");
  await flushPromises();

  expect(vi.mocked(executeHttp).mock.calls.map(call => call[0])).toEqual([captured.request, captured.request]);
  expect(loadWorkspace().workspace.history.map(entry => entry.result.status)).toEqual(["success", "error", "success"]);
  expect(Object.keys(loadWorkspace().workspace.requests)).toHaveLength(3);
});

it("saves an edited draft only on explicit action and preserves its editor and running operation", async () => {
  const app = await renderHistory();
  await button(app, "Open as draft").trigger("click");
  const editor = app.getComponent(RequestEditor);
  const editorElement = app.get(".request-editor").element;
  editor.vm.$emit("update:modelValue", { ...editor.props("modelValue"), name: "My saved variation", body: "saved body" });
  editor.vm.$emit("update:layout", { horizontal: "61%", vertical: "45%" });
  await flushPromises();
  vi.mocked(executeHttp).mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  }));
  await button(app, "Send").trigger("click");
  await button(app, "Save to Collections").trigger("click");
  await flushPromises();

  const saved = loadWorkspace().workspace;
  const id = saved.openTabIds[0];
  expect(Object.keys(saved.requests)).toHaveLength(4);
  expect(saved.requests[id]).toMatchObject({ name: "My saved variation", body: "saved body" });
  expect(saved.collection.at(-1)).toMatchObject({ kind: "request", id, name: "My saved variation" });
  expect(saved.layout.requests[id]).toEqual({ horizontal: "61%", vertical: "45%" });
  expect(saved.activeTabId).toBe(id);
  expect(selectedTab(app).get(".tab-label").text()).toBe("My saved variation");
  expect(app.get(".request-editor").element).toBe(editorElement);
  expect(app.text()).not.toContain("Unsaved draft");
  await button(app, "Cancel").trigger("click");
  await flushPromises();
  expect(app.get(".response-inspector").text().toLowerCase()).toContain("cancelled");
  expect(loadWorkspace().workspace.history[0].requestId).toBe(id);
});

it("cancels unsaved replays and restores their editable draft after reload", async () => {
  const app = await renderHistory();
  vi.mocked(executeHttp).mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  }));
  await button(app, "Send again").trigger("click");
  await button(app, "Cancel").trigger("click");
  await flushPromises();
  expect(app.get(".response-inspector").text().toLowerCase()).toContain("cancelled");
  expect(loadWorkspace().workspace.history[0].result.status).toBe("cancelled");
  expect(Object.keys(loadWorkspace().workspace.requests)).toHaveLength(3);
  app.unmount();
  mounted.splice(mounted.indexOf(app), 1);
  const restored = mount(App, { attachTo: document.body });
  mounted.push(restored);
  await flushPromises();

  expect(workspaceTabs(restored)).toHaveLength(1);
  expect(restored.getComponent(RequestEditor).props("capturedRequest")).toEqual(captured.request);
  expect(restored.text()).toContain("Autosaved locally");
  expect(restored.findComponent(HistoryInspector).exists()).toBe(false);
});

it("lets an unsaved replay finish into history after its tab closes", async () => {
  const app = await renderHistory();
  let complete!: (response: HttpResponse) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(executeHttp).mockImplementation((_request, operationSignal) => {
    signal = operationSignal;
    return new Promise(resolve => { complete = resolve; });
  });
  await button(app, "Send again").trigger("click");
  await app.get('[aria-label="Close Captured create · Unsaved"]').trigger("click");
  expect(signal?.aborted).toBe(false);
  complete(response);
  await flushPromises();

  expect(app.findComponent(RequestEditor).exists()).toBe(false);
  expect(app.getComponent(HistoryInspector).props("entry").id).toBe(captured.id);
  expect(loadWorkspace().workspace.history).toHaveLength(2);
  expect(loadWorkspace().workspace.history[0].request).toEqual(captured.request);
  expect(loadWorkspace().workspace.history[0].result).toEqual({ status: "success", response });
  expect(Object.keys(loadWorkspace().workspace.requests)).toHaveLength(3);
});

const response: HttpResponse = {
  url: "http://localhost:8080/workspaces", status: 201, statusText: "Created",
  headers: [{ name: "Content-Type", value: "application/json" }],
  body: '{"created":true}', durationMs: 37, sizeBytes: 16,
};
const captured: HistoryEntry = {
  id: "captured-exchange", requestId: "create-workspace", name: "Captured create",
  startedAt: "2026-10-22T11:00:00Z",
  request: {
    method: "POST", url: "https://captured.example.test/action?key=original", body: "{{literal}}", timeoutMs: 5000,
    headers: [
      { name: "Authorization", value: "Bearer original-secret" },
      { name: "X-Literal", value: "{{literal}}" },
      { name: "X-Ordered", value: "first" }, { name: "X-Ordered", value: "second" },
    ],
  },
  result: { status: "success", response },
};
type AppWrapper = ReturnType<typeof mount<typeof App>>;
const mounted: AppWrapper[] = [];

async function renderRequest() {
  const app = mount(App, { attachTo: document.body });
  mounted.push(app);
  await app.get('aside .folder-row[aria-expanded="false"]').trigger("click");
  const request = app.findAll("aside button").find(item => item.text().startsWith("Create workspace"));
  await request!.trigger("click");
  return app;
}

async function renderHistory() {
  const workspace = createWorkspace();
  workspace.history = [captured];
  workspace.environments[0].variables.push({ name: "literal", value: "active-environment-value", enabled: true });
  saveWorkspace(workspace);
  const app = mount(App, { attachTo: document.body });
  mounted.push(app);
  await button(app, "History").trigger("click");
  await app.get("aside .history-select").trigger("click");
  return app;
}

function workspaceTabs(app: AppWrapper) {
  return app.findAll('[aria-label="Open workspace tabs"] [role="tab"]');
}

function selectedTab(app: AppWrapper) {
  return app.get('[aria-label="Open workspace tabs"] [role="tab"][aria-selected="true"]');
}

function button(app: AppWrapper, label: string) {
  const found = app.findAll("button").find(item => item.text() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function collectionAction(app: AppWrapper, request: string, action: string) {
  await app.get(`[aria-label="Actions for ${request}"]`).trigger("click");
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    .find(candidate => candidate.textContent?.trim() === action);
  if (!item) throw new Error(`Missing collection action: ${action}`);
  await new DOMWrapper(item).trigger("click");
}
