// Tests the persistence interface through reloads, rejected documents, and storage failures.
import { expect, it } from "vitest";
import { createWorkspace, loadWorkspace, saveWorkspace, WORKSPACE_STORAGE_KEY } from "../src/workspace";
import type { WorkspaceData, WorkspaceStorage } from "../src/workspace";
import { parseCollection, parseWorkspace } from "../src/workspaceValidation";
import { importCurl } from "../src/interchange";
import { prepareRequest } from "../src/prepareRequest";

it("starts independent editable examples with a selected local environment and no responses", () => {
  const first = createWorkspace();
  const second = createWorkspace();
  expect(loadWorkspace(storage()).workspace).toEqual(first);
  expect(first.environments).toEqual([{
    id: "local", name: "Local", variables: [{ name: "baseUrl", value: "http://localhost:8080", enabled: true }],
  }]);
  expect(first.activeEnvironmentId).toBe("local");
  expect(first.requests["create-workspace"].path).toBe("{{baseUrl}}/workspaces");
  expect(first.history).toEqual([]);
  expect(first.openTabIds).toEqual([]);
  expect(first.activeTabId).toBeNull();
  expect(first.requests["create-workspace"]).not.toHaveProperty("responseBody");
  first.requests["create-workspace"].auth = { type: "bearer", token: "saved locally" };
  expect(second.requests["create-workspace"].auth).toEqual({ type: "none" });
  expect(parseWorkspace(first)).toEqual(first);
});

it("reloads definitions, credentials, environment, resolved history, tab order, and unclamped split preferences", () => {
  const target = storage();
  const workspace = editedWorkspace();
  saveWorkspace(workspace, target);
  const restored = loadWorkspace(target);
  expect(restored.error).toBeNull();
  expect(restored.workspace).toEqual(workspace);
  expect(restored.workspace).not.toBe(workspace);
  expect(restored.workspace.requests["create-workspace"]).not.toBe(workspace.requests["create-workspace"]);

  restored.workspace.requests["create-workspace"].body = "second edit";
  saveWorkspace(restored.workspace, target);
  expect(loadWorkspace(target).workspace.requests["create-workspace"].body).toBe("second edit");
});

it("loads earlier version-1 documents without draft recovery or protobuf fields", () => {
  const { drafts: _drafts, closedDraftIds: _closed, ...earlier } = createWorkspace();
  const restored = loadWorkspace(storage(JSON.stringify(earlier)));
  expect(restored.error).toBeNull();
  expect(restored.workspace.drafts).toEqual({});
  expect(restored.workspace.closedDraftIds).toEqual([]);
  expect(restored.workspace.protobufSources).toBeUndefined();
  expect(Object.values(restored.workspace.requests).every(request => request.protobuf === undefined)).toBe(true);
});

it("reloads protobuf sources and independent bindings for saved requests, open drafts, and closed drafts", () => {
  const workspace = createWorkspace();
  workspace.protobufSources = [
    { id: "models", name: "User models", rootPath: "/missing/models", includePaths: ["/missing/dependencies"] },
    { id: "unlinked", name: "Imported models", rootPath: null, includePaths: [] },
  ];
  workspace.requests["create-workspace"].protobuf = { sourceId: "models", messageName: "users.CreateRequest" };
  workspace.requests["list-workspaces"].protobuf = { sourceId: "removed", messageName: "users.ListRequest" };
  workspace.drafts = {
    open: { request: { ...workspace.requests["create-workspace"], protobuf: { sourceId: "unlinked", messageName: "users.ImportRequest" } } },
    closed: { request: { ...workspace.requests["create-workspace"], protobuf: { sourceId: "models", messageName: "users.DeletedMessage" } } },
  };
  workspace.openTabIds = ["create-workspace", "open"];
  workspace.activeTabId = "open";
  workspace.closedDraftIds = ["closed"];
  const original = structuredClone(workspace);
  const target = storage();
  saveWorkspace(workspace, target);

  const restored = loadWorkspace(target);
  expect(restored.error).toBeNull();
  expect(restored.workspace).toEqual(original);
  restored.workspace.protobufSources![0].includePaths.push("/new/dependency");
  restored.workspace.requests["create-workspace"].protobuf!.messageName = "users.EditedRequest";
  restored.workspace.drafts.open.request.protobuf!.messageName = "users.EditedDraft";
  restored.workspace.drafts.closed.request.protobuf!.sourceId = "unlinked";
  expect(workspace).toEqual(original);
  expect(loadWorkspace(target).workspace).toEqual(original);
});

it.each([
  ["duplicate sources", "protobufSources", (value: WorkspaceData) => { value.protobufSources!.push({ ...value.protobufSources![0] }); }],
  ["invalid root", "protobufSources[0].rootPath", (value: WorkspaceData) => { value.protobufSources![0].rootPath = 42 as never; }],
  ["invalid include path", "protobufSources", (value: WorkspaceData) => { value.protobufSources![0].includePaths = [null as never]; }],
  ["invalid source identity", "requests.create-workspace.protobuf.sourceId", (value: WorkspaceData) => { value.requests["create-workspace"].protobuf!.sourceId = ""; }],
  ["invalid message", "requests.create-workspace.protobuf.messageName", (value: WorkspaceData) => { value.requests["create-workspace"].protobuf!.messageName = null as never; }],
  ["invalid draft binding", "drafts.open.request.protobuf", (value: WorkspaceData) => { value.drafts.open.request.protobuf = null as never; }],
])("preserves stored protobuf metadata with %s for recovery", (_description, path, mutate) => {
  const workspace = createWorkspace();
  workspace.protobufSources = [{ id: "models", name: "Models", rootPath: null, includePaths: [] }];
  workspace.requests["create-workspace"].protobuf = { sourceId: "models", messageName: "Request" };
  workspace.drafts.open = { request: { ...workspace.requests["create-workspace"] } };
  workspace.openTabIds = ["open"];
  workspace.activeTabId = "open";
  mutate(workspace);
  const serialized = JSON.stringify(workspace);
  const target = storage(serialized);

  const restored = loadWorkspace(target);
  expect(restored.error).toContain(path);
  expect(target.getItem(WORKSPACE_STORAGE_KEY)).toBe(serialized);
  expect(() => saveWorkspace(restored.workspace, target)).toThrow(/preserved.*Back up and remove/);
  expect(target.getItem(WORKSPACE_STORAGE_KEY)).toBe(serialized);
});

it("persists cURL literal mode without reinterpreting placeholders after edits and reload", () => {
  const workspace = createWorkspace();
  workspace.requests["create-workspace"] = { ...importCurl("curl --data-raw '{{token}}' https://example.com"), name: "Edited import" };
  workspace.environments[0].variables.push({ name: "token", value: "secret", enabled: true });
  const target = storage();
  saveWorkspace(workspace, target);
  const restored = loadWorkspace(target);
  expect(restored.error).toBeNull();
  const request = restored.workspace.requests["create-workspace"];
  expect(request.inputMode).toBe("literal");
  expect(prepareRequest({ ...request, body: "edited {{token}}" }, restored.workspace.environments[0]).body).toBe("edited {{token}}");
});

it.each([null, "invalid", true])("preserves workspace data containing invalid input mode %j", inputMode => {
  const workspace = createWorkspace();
  workspace.requests["create-workspace"].inputMode = inputMode as never;
  const serialized = JSON.stringify(workspace);
  const target = storage(serialized);
  expect(loadWorkspace(target).error).toContain("inputMode");
  expect(target.getItem(WORKSPACE_STORAGE_KEY)).toBe(serialized);
});

it("restores open and closed drafts including their exact captured inputs and layout", () => {
  const workspace = createWorkspace();
  const draft = {
    request: { ...workspace.requests["create-workspace"], body: "{{literal}}" },
    capturedRequest: {
      method: "POST", url: "https://captured.test/", body: "{{literal}}", timeoutMs: 5000,
      headers: [{ name: "Authorization", value: "Bearer {{literal}}" }],
    },
    layout: { horizontal: "60%", vertical: "40%" },
  };
  workspace.drafts = { open: draft, closed: draft };
  workspace.openTabIds = ["open"];
  workspace.activeTabId = "open";
  workspace.closedDraftIds = ["closed"];
  const target = storage();
  saveWorkspace(workspace, target);
  expect(loadWorkspace(target).workspace).toEqual(workspace);
});

it.each([
  ["missing closed draft", (value: WorkspaceData) => { value.closedDraftIds = ["missing"]; }],
  ["unreachable draft", (value: WorkspaceData) => { value.drafts.orphan = { request: value.requests["create-workspace"] }; }],
  ["open and closed draft", (value: WorkspaceData) => {
    value.drafts.draft = { request: value.requests["create-workspace"] };
    value.openTabIds = ["draft"]; value.activeTabId = "draft"; value.closedDraftIds = ["draft"];
  }],
  ["malformed recovery data", (value: WorkspaceData) => { value.drafts = null as never; }],
])("rejects %s instead of losing recoverable work", (_description, mutate) => {
  const workspace = createWorkspace();
  mutate(workspace);
  expect(() => parseWorkspace(workspace)).toThrow(/^Invalid /);
});

it.each([
  ["invalid JSON", "{broken"],
  ["unsupported schema", JSON.stringify({ ...createWorkspace(), version: 2 })],
  ["invalid request", JSON.stringify({ ...createWorkspace(), requests: { bad: { name: "Incomplete" } } })],
  ["invalid reference", JSON.stringify({ ...createWorkspace(), openTabIds: ["missing"], activeTabId: "missing" })],
])("preserves %s on load and blocks autosave from replacing it", (_description, serialized) => {
  const target = storage(serialized);
  const loaded = loadWorkspace(target);
  expect(loaded.error).toContain("Could not load workspace");
  expect(loaded.workspace).toEqual(createWorkspace());
  expect(target.getItem(WORKSPACE_STORAGE_KEY)).toBe(serialized);
  expect(() => saveWorkspace(loaded.workspace, target)).toThrow(/preserved.*Back up and remove/);
  expect(target.getItem(WORKSPACE_STORAGE_KEY)).toBe(serialized);
});

it("reports inaccessible storage while still returning a usable unsaved workspace", () => {
  const target: WorkspaceStorage = {
    getItem() { throw new Error("Access denied"); },
    setItem() { throw new Error("Access denied"); },
  };
  expect(loadWorkspace(target)).toEqual({
    workspace: createWorkspace(), error: "Could not load workspace: Access denied",
  });
  expect(() => saveWorkspace(createWorkspace(), target)).toThrow("Access denied");
});

it("reports full storage and retains the last saved document", () => {
  const saved = JSON.stringify(createWorkspace());
  const target: WorkspaceStorage = {
    getItem() { return saved; },
    setItem() { throw new Error("Quota exceeded"); },
  };
  expect(() => saveWorkspace(editedWorkspace(), target)).toThrow("Local storage could not save the workspace: Quota exceeded");
  expect(target.getItem(WORKSPACE_STORAGE_KEY)).toBe(saved);
});

it("rejects malformed live state before changing saved data", () => {
  const target = storage();
  const workspace = createWorkspace();
  saveWorkspace(workspace, target);
  const saved = target.getItem(WORKSPACE_STORAGE_KEY);
  workspace.activeEnvironmentId = "missing";
  expect(() => saveWorkspace(workspace, target)).toThrow("activeEnvironmentId");
  expect(target.getItem(WORKSPACE_STORAGE_KEY)).toBe(saved);
});

it("accepts unfinished request URLs and history whose source definition was deleted", () => {
  const workspace = editedWorkspace();
  workspace.requests["create-workspace"].path = "";
  workspace.history[0].requestId = "deleted-request";
  expect(parseWorkspace(workspace)).toBe(workspace);
});

it("persists nonstandard HTTP statuses accepted by the native transport", () => {
  const workspace = editedWorkspace();
  const result = workspace.history[0].result;
  if (result.status !== "success") throw new Error("Expected response fixture");
  result.response.status = 600;
  const target = storage();
  saveWorkspace(workspace, target);
  expect(loadWorkspace(target).workspace.history[0].result).toEqual(result);
});

it.each([
  ["collection request reference", (value: WorkspaceData) => { value.collection = [{ kind: "request", id: "missing", name: "Missing", requestType: "GET" }]; }],
  ["duplicate tab identities", (value: WorkspaceData) => { value.openTabIds.push(value.openTabIds[0]); }],
  ["unselected open tabs", (value: WorkspaceData) => { value.activeTabId = null; }],
  ["unknown auth", (value: WorkspaceData) => { value.requests["create-workspace"].auth = { type: "unknown" } as never; }],
  ["running history", (value: WorkspaceData) => { value.history[0].result = { status: "running", startedAt: "today" } as never; }],
  ["invalid split", (value: WorkspaceData) => { value.layout.sidebar!.vertical = "101%"; }],
  ["unsafe identity", (value: WorkspaceData) => { value.environments[0].id = "__proto__"; }],
])("rejects %s in runtime documents", (_description, mutate) => {
  const workspace = editedWorkspace();
  mutate(workspace);
  expect(() => parseWorkspace(workspace)).toThrow(/^Invalid /);
});

it("validates portable definitions and hierarchy through the shared collection boundary", () => {
  const workspace = createWorkspace();
  const payload = { requests: workspace.requests, collection: workspace.collection };
  expect(parseCollection(payload)).toEqual(payload);
  expect(() => parseCollection({ ...payload, collection: [] })).toThrow("has no collection reference");
  expect(() => parseCollection({ ...payload, collection: [...workspace.collection, workspace.collection[0]] })).toThrow("duplicate identity");
});

function editedWorkspace(): WorkspaceData {
  const workspace = createWorkspace();
  workspace.requests["create-workspace"].body = "Edited draft";
  workspace.requests["create-workspace"].auth = { type: "basic", username: "local-user", password: "local-password" };
  workspace.openTabIds = ["invite-member", "create-workspace"];
  workspace.activeTabId = "create-workspace";
  workspace.layout = {
    sidebar: { horizontal: 420, vertical: "35%" },
    requests: { "create-workspace": { horizontal: "71.25%", vertical: 900 } },
  };
  workspace.history = [{
    id: "execution-1", requestId: "create-workspace", name: "Create workspace", startedAt: "2026-10-22T11:00:00.000Z",
    request: {
      method: "POST", url: "http://localhost:8080/workspaces?tag=a&tag=b",
      headers: [{ name: "Authorization", value: "Bearer resolved-token" }], body: '{"name":"Before edit"}', timeoutMs: 1000,
    },
    result: { status: "success", response: {
      url: "http://localhost:8080/workspaces?tag=a&tag=b", status: 201, statusText: "Created",
      headers: [{ name: "Content-Type", value: "application/json" }], body: '{"created":true}', durationMs: 37.5, sizeBytes: 16,
    } },
  }];
  return workspace;
}

function storage(initial: string | null = null): WorkspaceStorage {
  const values = new Map<string, string>();
  if (initial !== null) values.set(WORKSPACE_STORAGE_KEY, initial);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}
