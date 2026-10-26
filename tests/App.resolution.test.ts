// Verifies that active drafts share Send/preview/export inputs and retain redirect safety after editing.
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import HistoryInspector from "../src/components/HistoryInspector.vue";
import ImportExport from "../src/components/ImportExport.vue";
import RequestEditor from "../src/components/RequestEditor.vue";
import { executeHttp } from "../src/http";
import { importCurl } from "../src/interchange";
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
  vi.restoreAllMocks();
});

it("enables active draft cURL export and shares captured inputs with its preview and Send", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const entry = historyEntry();
  const app = await renderHistory(entry);
  await button(app, "Open as draft").trigger("click");
  const editor = app.getComponent(RequestEditor);
  const panel = app.getComponent(ImportExport);
  expect(panel.props("activeRequest")).toEqual(editor.props("modelValue"));
  expect(panel.props("capturedRequest")).toEqual(entry.request);
  expect(app.get(".request-target code").text()).toBe(entry.request.url);

  await panel.vm.open();
  await panel.get('input[type="checkbox"]').setValue(true);
  expect(button(app, "Copy active cURL").attributes("disabled")).toBeUndefined();
  await button(app, "Copy active cURL").trigger("click");
  await flushPromises();
  const exported = importCurl(writeText.mock.calls[0][0]);
  expect(exported.path).toBe(entry.request.url);
  expect(exported.body).toBe("{{token}}");
  expect(exported.headers).toContainEqual({ name: "X-Key", value: "{{token}}", enabled: true });
  await button(app, "Send").trigger("click");
  await flushPromises();
  expect(vi.mocked(executeHttp).mock.calls[0][0]).toEqual(entry.request);
});

it("preserves redirect policy and credential header metadata when the first edit leaves captured mode", async () => {
  const entry = historyEntry();
  entry.request.redirectPolicy = "same-origin";
  const app = await renderHistory(entry);
  await button(app, "Open as draft").trigger("click");
  const editor = app.getComponent(RequestEditor);
  expect(editor.props("modelValue").redirectPolicy).toBe("same-origin");
  expect(editor.props("modelValue").sensitiveHeaderNames).toEqual(["x-key"]);
  await app.get('[aria-label="Request URL"]').setValue("https://edited.test/action");
  expect(editor.props("capturedRequest")).toBeUndefined();
  expect(app.getComponent(ImportExport).props("capturedRequest")).toBeUndefined();
  await button(app, "Send").trigger("click");
  await flushPromises();
  expect(vi.mocked(executeHttp).mock.calls[0][0]).toMatchObject({
    url: "https://edited.test/action", body: "{{token}}", redirectPolicy: "same-origin", sensitiveHeaderNames: ["x-key"],
    headers: [{ name: "X-Key", value: "{{token}}" }, { name: "Content-Type", value: "text/plain" }],
  });
  await app.get(".input-mode-field select").setValue("template");
  await button(app, "Send").trigger("click");
  await flushPromises();
  expect(vi.mocked(executeHttp).mock.calls[1][0]).toMatchObject({ body: "environment-token",
    redirectPolicy: "same-origin", sensitiveHeaderNames: ["x-key"],
    headers: [{ name: "X-Key", value: "environment-token" }, { name: "Content-Type", value: "text/plain" }],
  });
  expect(loadWorkspace().workspace.history.find(item => item.id === entry.id)?.request).toEqual(entry.request);
});

it("preserves literal cURL payloads through Send, history, draft promotion, and another Send", async () => {
  const workspace = createWorkspace();
  const imported = importCurl("curl -H 'X-Token: {{token}}' --data-raw '{{token}}' https://literal.test/action");
  workspace.requests = { imported };
  workspace.collection = [{ kind: "request", id: "imported", name: imported.name, requestType: imported.method }];
  workspace.openTabIds = ["imported"];
  workspace.activeTabId = "imported";
  workspace.environments[0].variables.push({ name: "token", value: "changed-environment-token", enabled: true });
  saveWorkspace(workspace);
  const app = mount(App, { attachTo: document.body });
  mounted.push(app);
  await button(app, "Send").trigger("click");
  await flushPromises();
  const original = vi.mocked(executeHttp).mock.calls[0][0];
  expect(original.body).toBe("{{token}}");
  await button(app, "History").trigger("click");
  await app.get(".history-select").trigger("click");
  await button(app, "Open as draft").trigger("click");
  expect(app.getComponent(RequestEditor).props("modelValue").inputMode).toBe("literal");
  await button(app, "Save to Collections").trigger("click");
  expect(app.getComponent(RequestEditor).props("capturedRequest")).toBeUndefined();
  await button(app, "Send").trigger("click");
  await flushPromises();
  expect(vi.mocked(executeHttp).mock.calls[1][0]).toEqual(original);
});

it("keeps inspected history, editable metadata, captured metadata, and running inputs independently owned", async () => {
  const entry = historyEntry();
  const app = await renderHistory(entry);
  const inspected = app.getComponent(HistoryInspector).props("entry");
  await button(app, "Open as draft").trigger("click");
  const editor = app.getComponent(RequestEditor);
  const request = editor.props("modelValue");
  const captured = editor.props("capturedRequest")!;
  request.sensitiveHeaderNames!.push("x-editor-only");
  expect(captured.sensitiveHeaderNames).toEqual(["x-key"]);
  expect(inspected.request.sensitiveHeaderNames).toEqual(["x-key"]);
  let complete!: (value: HttpResponse) => void;
  vi.mocked(executeHttp).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await button(app, "Send").trigger("click");
  captured.sensitiveHeaderNames!.push("x-capture-only");
  captured.headers[0].value = "changed after send";
  const sent = vi.mocked(executeHttp).mock.calls[0][0];
  expect(sent.sensitiveHeaderNames).toEqual(["x-key"]);
  expect(sent.headers[0].value).toBe("{{token}}");
  complete(response);
  await flushPromises();
  expect(loadWorkspace().workspace.history[0].request).toEqual(entry.request);
  expect(inspected.request).toEqual(entry.request);
});

const response: HttpResponse = {
  url: "https://captured.test/action", status: 200, statusText: "OK", headers: [], body: "ok", durationMs: 1, sizeBytes: 2,
};
type AppWrapper = ReturnType<typeof mount<typeof App>>;
const mounted: AppWrapper[] = [];

function historyEntry(): HistoryEntry {
  return { id: "captured", requestId: "deleted", name: "Captured request", startedAt: "2026-10-22T10:00:00Z",
    request: { method: "POST", url: "https://captured.test/action", body: "{{token}}", timeoutMs: 5000,
      headers: [{ name: "X-Key", value: "{{token}}" }], redirectPolicy: "never", sensitiveHeaderNames: ["x-key"] },
    result: { status: "success", response } };
}

async function renderHistory(entry: HistoryEntry) {
  const workspace = createWorkspace();
  workspace.history = [entry];
  workspace.environments[0].variables.push({ name: "token", value: "environment-token", enabled: true });
  saveWorkspace(workspace);
  const app = mount(App, { attachTo: document.body });
  mounted.push(app);
  await button(app, "History").trigger("click");
  await app.get(".history-select").trigger("click");
  return app;
}

function button(app: AppWrapper, label: string) {
  return app.findAll("button").find(item => item.text() === label)!;
}
