// Exercises asynchronous workspace saves and quota feedback through the application interface.
import { flushPromises, mount } from "@vue/test-utils";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import { executeHttp } from "../src/http";
import { createIndexedDbWorkspaceStorage, createWorkspaceRepository } from "../src/workspaceRepository";
import { createWorkspace, type WorkspaceData } from "../src/workspace";

vi.mock("../src/http", () => ({ executeHttp: vi.fn() }));

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.replaceChildren();
});

it("opens an earlier IndexedDB workspace and saves edits without losing its restored request tab", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const workspace = createWorkspace();
  workspace.openTabIds = ["create-workspace"];
  workspace.activeTabId = "create-workspace";
  const { drafts: _drafts, closedDraftIds: _closed, ...earlier } = workspace;
  await storage.writeDocument({ version: 1, workspace: earlier, historyIds: [], warning: null });
  const repository = createWorkspaceRepository(storage, emptyLegacy);
  const initialWorkspace = await repository.load();
  const app = render({ initialWorkspace, repository });

  expect(app.get('[role="tab"][aria-selected="true"]').text()).toContain("Create workspace");
  const url = app.get<HTMLInputElement>('[aria-label="Request URL"]');
  expect(url.element.value).toBe("{{baseUrl}}/workspaces");
  await url.setValue("https://edited.test/recovered-workspace");
  await repository.flush();
  const restored = await createWorkspaceRepository(storage, emptyLegacy).load();
  expect(restored.workspace.requests["create-workspace"].path).toBe("https://edited.test/recovered-workspace");
  expect(restored.workspace.openTabIds).toEqual(["create-workspace"]);
  expect(restored.workspace.activeTabId).toBe("create-workspace");
});

it("defers/coalesces edits and saves the latest URL when the window is backgrounded", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, emptyLegacy);
  const initialWorkspace = await repository.load();
  const app = render({ initialWorkspace, repository });
  await selectRequest(app);
  await repository.flush();
  const write = vi.spyOn(storage, "writeDocument");
  const url = app.get<HTMLInputElement>('[aria-label="Request URL"]');
  await url.setValue("https://edited.test/first");
  await url.setValue("https://edited.test/latest");
  expect(write).not.toHaveBeenCalled();

  window.dispatchEvent(new Event("pagehide"));
  await repository.flush();
  const loaded = await createWorkspaceRepository(storage, emptyLegacy).load();
  expect(loaded.workspace.requests["create-workspace"].path).toBe("https://edited.test/latest");
});

it("shows failed capture persistence while preserving its live response and saving a later definition edit", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  storage.writeHistory = async () => { throw new DOMException("Full", "QuotaExceededError"); };
  const repository = createWorkspaceRepository(storage, emptyLegacy);
  const initialWorkspace = await repository.load();
  const app = render({ initialWorkspace, repository });
  vi.mocked(executeHttp).mockResolvedValue({
    url: "http://localhost:8080/workspaces", status: 200, statusText: "OK", headers: [],
    body: "Response retained for this session", durationMs: 1, sizeBytes: 34,
  });
  await selectRequest(app);
  await app.findAll("button").find(button => button.text() === "Send")!.trigger("click");
  await flushPromises();
  await repository.flush();
  await flushPromises();
  expect(app.get(".app-status").text()).toContain("1 history capture");
  expect(app.text()).toContain("Response retained for this session");

  await app.get<HTMLInputElement>('[aria-label="Request URL"]').setValue("https://edited.test/after-response");
  await repository.flush();
  await flushPromises();
  const restored = await createWorkspaceRepository(storage, emptyLegacy).load();
  expect(restored.workspace.requests["create-workspace"].path).toBe("https://edited.test/after-response");
  expect(restored.workspace.history).toEqual([]);
  expect(restored.error).toContain("will not be restored");
  expect(app.get(".app-status").text()).toContain("1 history capture");
});

it("imports selected OpenAPI operations through workspace tools and persists their ordinary request definitions", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, emptyLegacy);
  const initialWorkspace = await repository.load();
  const existingIds = Object.keys(initialWorkspace.workspace.requests);
  const sendsBeforeImport = vi.mocked(executeHttp).mock.calls.length;
  const app = render({ initialWorkspace, repository });
  await app.get('.app-header [aria-label="Workspace tools"]').trigger("click");
  await app.findAll('[role="menuitem"]').find(item => item.text() === "Import / Export")!.trigger("click");
  await flushPromises();
  await app.get('.import-export textarea').setValue(JSON.stringify({
    openapi: "3.1.0", info: { title: "Imported service", version: "1" },
    servers: [{ url: "https://imported.test/api" }],
    paths: { "/items": { post: { summary: "Create imported item", tags: ["Items"],
      requestBody: { content: { "application/json": { example: { value: "{{literal}}" } } } },
      responses: { "201": { description: "Created" } },
    } } },
  }));
  await app.findAll('.import-export button').find(button => button.text() === "Import")!.trigger("click");
  await vi.waitFor(() => expect(app.find('[aria-label="OpenAPI operations"]').exists()).toBe(true));
  expect(vi.mocked(executeHttp).mock.calls).toHaveLength(sendsBeforeImport);
  await app.findAll('.import-export button').find(button => button.text() === "Import selected operations")!.trigger("click");
  await repository.flush();
  const restored = await createWorkspaceRepository(storage, emptyLegacy).load();
  const imported = Object.entries(restored.workspace.requests).find(([, request]) => request.name === "Create imported item")!;
  expect(imported[1]).toMatchObject({ method: "POST", path: "https://imported.test/api/items", inputMode: "literal" });
  expect(JSON.parse(imported[1].body)).toEqual({ value: "{{literal}}" });
  expect(Object.keys(restored.workspace.requests)).toEqual(expect.arrayContaining(existingIds));
  expect(restored.workspace.collection.at(-1)).toMatchObject({ kind: "folder", name: "Imported service" });
  expect(restored.workspace.openTabIds).toContain(imported[0]);
  expect(vi.mocked(executeHttp).mock.calls).toHaveLength(sendsBeforeImport);
});

const mounted: ReturnType<typeof mount>[] = [];
const emptyLegacy = { getItem: () => null, setItem: () => {} };

function render(props: {
  initialWorkspace: { workspace: WorkspaceData; error: string | null };
  repository: ReturnType<typeof createWorkspaceRepository>;
}) {
  const app = mount(App, { props, attachTo: document.body });
  mounted.push(app);
  return app;
}

async function selectRequest(app: ReturnType<typeof mount>) {
  const folder = app.findAll("aside button").find(button => button.text().includes("Workspaces"))!;
  if (folder.attributes("aria-expanded") === "false") await folder.trigger("click");
  await app.findAll("aside button").find(button => button.text().startsWith("Create workspace"))!.trigger("click");
  await flushPromises();
}
