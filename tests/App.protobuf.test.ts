// Exercises protobuf loading, recovery, and captured-input preservation through the workspace UI.
import { flushPromises, mount } from "@vue/test-utils";
import { undo } from "@codemirror/commands";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import App from "../src/App.vue";
import BodyText from "../src/components/BodyText.vue";
import RequestEditor from "../src/components/RequestEditor.vue";
import { executeHttp } from "../src/http";
import { loadProtobufSource, type ProtobufCatalog } from "../src/protobuf";
import { prepareRequest } from "../src/prepareRequest";
import { createWorkspace, loadWorkspace, type WorkspaceData } from "../src/workspace";
import { editorView, replaceText } from "./editor";

vi.mock("../src/protobuf", async importOriginal => ({
  ...await importOriginal<typeof import("../src/protobuf")>(),
  loadProtobufSource: vi.fn(),
}));
vi.mock("../src/http", () => ({ executeHttp: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(loadProtobufSource).mockReset().mockResolvedValue(catalog);
  vi.mocked(open).mockReset();
  vi.mocked(executeHttp).mockReset().mockResolvedValue({
    status: 200, statusText: "OK", url: "https://example.test/", headers: [],
    body: "", durationMs: 1, sizeBytes: 0,
  });
});

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.replaceChildren();
});

it("allows selecting an unaffected message while showing diagnostics for skipped files", async () => {
  const partial = { ...replacementCatalog, loadDiagnostics: ["broken.proto: missing dependency.proto"] };
  vi.mocked(loadProtobufSource).mockResolvedValueOnce(partial);
  const app = await render();
  expect(context(app)?.catalog).toEqual(partial);
  expect(app.get(".protobuf-settings [role=status]").text()).toContain("Some protobuf files could not be loaded");

  await app.findAll('[aria-label="Request settings"] [role="tab"]').find(tab => tab.text() === "Advanced")!.trigger("click");
  const search = app.get('.binding-picker [role="combobox"]');
  await search.trigger("focus");
  await search.setValue("demo.Other");
  await search.trigger("keydown", { key: "Enter" });
  expect(loadWorkspace().workspace.requests["create-workspace"].protobuf?.messageName).toBe("demo.Other");

  await openManager(app);
  expect(app.get(".protobuf-manager").text()).toContain("Partially loaded");
  expect(app.get(".protobuf-manager").text()).toContain("broken.proto: missing dependency.proto");
});

it("loads restored bindings and retains the editor, Undo, and old catalog through a failed reload", async () => {
  const initialLoad = deferred<ProtobufCatalog>();
  vi.mocked(loadProtobufSource).mockReturnValueOnce(initialLoad.promise);
  const app = await render();
  expect(app.get(".protobuf-settings [role=status]").text()).toContain("Loading");
  expect(context(app)).toBeUndefined();
  initialLoad.resolve(catalog);
  await flushPromises();
  expect(context(app)).toEqual({ catalog, messageName: binding.messageName });

  const body = app.get(".body-text");
  const view = editorView(body.element);
  await replaceText(body.element, '{"value":"retained edit"}');
  const reload = deferred<ProtobufCatalog>();
  vi.mocked(loadProtobufSource).mockReturnValueOnce(reload.promise);
  await openManager(app);
  await app.get('[aria-label="Reload Models"]').trigger("click");
  expect(app.get(".protobuf-settings [role=status]").text()).toContain("Reloading");
  expect(context(app)?.catalog).toEqual(catalog);
  reload.reject(new Error("models.proto: invalid syntax"));
  await flushPromises();
  expect(app.get(".protobuf-settings [role=status]").text()).toContain("previous models");
  expect(app.get(".protobuf-manager").text()).toContain("models.proto: invalid syntax");
  expect(context(app)?.catalog).toEqual(catalog);
  expect(editorView(body.element)).toBe(view);
  expect(view.state.doc.toString()).toBe('{"value":"retained edit"}');
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("{}");
});

it.each(["success", "failure"])("ignores an older load's %s after relinking to a newer folder", async outcome => {
  const older = deferred<ProtobufCatalog>();
  const newer = deferred<ProtobufCatalog>();
  vi.mocked(loadProtobufSource).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const app = await render();
  await openManager(app);
  vi.mocked(open).mockResolvedValueOnce("/new-models");
  await app.get('[aria-label="Relink Models"]').trigger("click");
  await flushPromises();
  expect(loadProtobufSource).toHaveBeenLastCalledWith({ ...source, rootPath: "/new-models" });
  expect(context(app)).toBeUndefined();
  newer.resolve(replacementCatalog);
  await flushPromises();
  if (outcome === "success") older.resolve(catalog);
  else older.reject(new Error("Old folder is unavailable"));
  await flushPromises();

  expect(context(app)?.catalog).toEqual(replacementCatalog);
  expect(app.get(".protobuf-settings [role=status]").text()).toContain("Ready");
  expect(app.get(".protobuf-manager").text()).not.toContain("Old folder is unavailable");
  expect(loadWorkspace().workspace.protobufSources).toEqual([{ ...source, rootPath: "/new-models" }]);
});

it("clears old assistance on dependency changes and recovers after the replacement load fails", async () => {
  const app = await render();
  const changed = deferred<ProtobufCatalog>();
  vi.mocked(loadProtobufSource).mockReturnValueOnce(changed.promise);
  await openManager(app);
  vi.mocked(open).mockResolvedValueOnce("/new-dependencies");
  await app.get('[aria-label="Add import directory to Models"]').trigger("click");
  await flushPromises();
  expect(loadProtobufSource).toHaveBeenLastCalledWith({ ...source, includePaths: ["/new-dependencies"] });
  expect(context(app)).toBeUndefined();
  changed.reject(new Error("Missing dependency.proto"));
  await flushPromises();
  expect(context(app)).toBeUndefined();
  expect(app.get(".protobuf-settings [role=status]").text()).toContain("Missing dependency.proto");
  await app.get('[aria-label="Reload Models"]').trigger("click");
  await flushPromises();
  expect(context(app)?.catalog).toEqual(catalog);
  expect(app.get(".protobuf-settings [role=status]").text()).toContain("Ready");
});

it("preserves a removed source's binding and ignores its pending load after Undo starts a new load", async () => {
  const removedLoad = deferred<ProtobufCatalog>();
  const restoredLoad = deferred<ProtobufCatalog>();
  vi.mocked(loadProtobufSource).mockReturnValueOnce(removedLoad.promise).mockReturnValueOnce(restoredLoad.promise);
  const app = await render();
  await openManager(app);
  await app.get('[aria-label="Remove Models"]').trigger("click");
  expect(context(app)).toBeUndefined();
  expect(loadWorkspace().workspace.requests["create-workspace"].protobuf).toEqual(binding);
  expect(app.get(".protobuf-settings [role=status]").text()).toContain("removed");
  await button(app, "Undo removal").trigger("click");
  await flushPromises();
  restoredLoad.resolve(replacementCatalog);
  await flushPromises();
  removedLoad.resolve(catalog);
  await flushPromises();

  expect(context(app)?.catalog).toEqual(replacementCatalog);
  expect(loadWorkspace().workspace.protobufSources).toEqual([source]);
  expect(loadProtobufSource).toHaveBeenCalledTimes(2);
});

it("keeps captured transport inputs when selecting and clearing a model, then exits capture mode on a body edit", async () => {
  const workspace = configuredWorkspace();
  const request = { ...workspace.requests["create-workspace"], protobuf: undefined };
  const captured = { ...prepareRequest(request), body: '{"captured":true}' };
  workspace.drafts.draft = { request, capturedRequest: captured };
  workspace.openTabIds = ["draft"];
  workspace.activeTabId = "draft";
  const app = await render(workspace);
  await app.findAll('[aria-label="Request settings"] [role="tab"]').find(tab => tab.text() === "Advanced")!.trigger("click");
  await app.get(".binding-picker select").setValue(source.id);
  const search = app.get('.binding-picker [role="combobox"]');
  await search.trigger("focus");
  await search.setValue(binding.messageName);
  await search.trigger("keydown", { key: "Enter" });
  await flushPromises();
  expect(loadWorkspace().workspace.drafts.draft.request.protobuf).toEqual(binding);
  expect(app.getComponent(RequestEditor).props("capturedRequest")).toEqual(captured);
  await button(app, "Send").trigger("click");
  await flushPromises();
  expect(vi.mocked(executeHttp).mock.calls[0][0]).toEqual(captured);
  await app.get(".binding-picker select").setValue("");
  expect(context(app)).toBeUndefined();
  expect(app.getComponent(RequestEditor).props("capturedRequest")).toEqual(captured);
  await app.findAll('[aria-label="Request settings"] [role="tab"]').find(tab => tab.text() === "Body")!.trigger("click");
  await replaceText(app.get(".request-editor .body-text").element, '{"edited":true}');
  expect(app.getComponent(RequestEditor).props("capturedRequest")).toBeUndefined();
  await button(app, "Send").trigger("click");
  await flushPromises();
  expect(vi.mocked(executeHttp).mock.calls[1][0].body).toBe('{"edited":true}');
});

it("keeps requests sendable with their persisted binding when the source cannot load", async () => {
  vi.mocked(loadProtobufSource).mockRejectedValueOnce(new Error("Folder access denied"));
  const workspace = configuredWorkspace();
  const expected = prepareRequest(workspace.requests["create-workspace"]);
  const app = await render(workspace);
  expect(app.get(".protobuf-settings [role=status]").text()).toContain("Folder access denied");
  await button(app, "Send").trigger("click");
  await flushPromises();
  expect(vi.mocked(executeHttp).mock.calls[0][0]).toEqual(expected);
  expect(loadWorkspace().workspace.requests["create-workspace"].protobuf).toEqual(binding);
});

const source = { id: "models", name: "Models", rootPath: "/models", includePaths: [] };
const binding = { sourceId: source.id, messageName: "demo.Request" };
const catalog: ProtobufCatalog = { messages: { [binding.messageName]: [] }, enums: {} };
const replacementCatalog: ProtobufCatalog = { messages: { [binding.messageName]: [], "demo.Other": [] }, enums: {} };
const mounted: ReturnType<typeof mount>[] = [];

function configuredWorkspace(): WorkspaceData {
  const workspace = createWorkspace();
  workspace.requests["create-workspace"] = {
    ...workspace.requests["create-workspace"], path: "https://example.test/", body: "{}", protobuf: { ...binding },
  };
  workspace.protobufSources = [{ ...source, includePaths: [] }];
  workspace.openTabIds = ["create-workspace"];
  workspace.activeTabId = "create-workspace";
  return workspace;
}

async function render(workspace = configuredWorkspace()) {
  const app = mount(App, { props: { initialWorkspace: { workspace, error: null } }, attachTo: document.body });
  mounted.push(app);
  await flushPromises();
  return app;
}

function context(app: ReturnType<typeof mount>) {
  return app.getComponent(RequestEditor).getComponent(BodyText).props("protobufContext");
}

function button(app: ReturnType<typeof mount>, label: string) {
  return app.findAll("button").find(candidate => candidate.text() === label)!;
}

async function openManager(app: ReturnType<typeof mount>) {
  await app.get('[aria-label="Workspace tools"]').trigger("click");
  await app.findAll('[role="menuitem"]').find(item => item.text() === "Protobuf models")!.trigger("click");
  await flushPromises();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
