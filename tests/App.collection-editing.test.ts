// Exercises collection organization through the sidebar while App preserves editors, executions, and durable workspace data.
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import { executeHttp } from "../src/http";
import { createRequest } from "../src/request";
import { createWorkspace, loadWorkspace, saveWorkspace, type WorkspaceData } from "../src/workspace";
import { createIndexedDbWorkspaceStorage, createWorkspaceRepository } from "../src/workspaceRepository";
import { editorView, replaceText } from "./editor";

vi.mock("../src/http", () => ({ executeHttp: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(executeHttp).mockReset();
});

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("keeps the active editor, tab order, body, and pane preferences while renaming and ordering an inactive request", async () => {
  const app = render();
  await expand(app, "Source");
  await replaceText(app.get(".body-text").element, "retained active body");
  const editor = app.get(".request-editor").element;
  const body = editorView(app.get(".body-text").element);
  const divider = app.get('.body-panels [role="separator"]');
  const split = divider.attributes("aria-valuenow");

  await rename(app, "Inactive request", "  Organized request  ");
  await action(app, "Organized request", "Move down");

  expect(activeTab(app)).toBe("Active request");
  expect(tabNames(app)).toEqual(["Active request", "Organized request", "Sibling request"]);
  expect(app.get(".request-editor").element).toBe(editor);
  expect(editorView(app.get(".body-text").element)).toBe(body);
  expect(body.state.doc.toString()).toBe("retained active body");
  expect(app.get<HTMLInputElement>('[aria-label="Request URL"]').element.value).toBe("https://active.test");
  expect(divider.attributes("aria-valuenow")).toBe(split);
  expect(sourceChildren(loadWorkspace().workspace)).toEqual(["sibling", "inactive"]);
  expect(executeHttp).not.toHaveBeenCalled();
  expect(app.get('[aria-label="Workspace notifications"]').text()).toContain("Moved “Organized request” · Source");
});

it("keeps a running exchange alive while another request is renamed and moved", async () => {
  vi.mocked(executeHttp).mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  }));
  const app = render();
  await expand(app, "Source");
  await button(app, "Send").trigger("click");
  const signal = vi.mocked(executeHttp).mock.calls[0][1]!;
  const editor = app.get(".request-editor").element;

  await rename(app, "Inactive request", "Organized request");
  await move(app, "Organized request", "destination");

  expect(signal.aborted).toBe(false);
  expect(executeHttp).toHaveBeenCalledTimes(1);
  expect(activeTab(app)).toBe("Active request");
  expect(app.get(".request-editor").element).toBe(editor);
  expect(button(app, "Cancel").exists()).toBe(true);
});

it("undoes a rename against current definitions without replacing later request edits or tab selection", async () => {
  const app = render();
  await expand(app, "Source");
  await rename(app, "Inactive request", "Renamed request");
  await app.get('[aria-label="Request URL"]').setValue("https://active.test/later");
  await requestRow(app, "Renamed request").trigger("click");
  await replaceText(app.get(".body-text").element, "later target body");
  await app.get('[aria-label="Request URL"]').setValue("https://inactive.test/later");

  await button(app, "Undo collection edit").trigger("click");

  expect(activeTab(app)).toBe("Inactive request");
  expect(tabNames(app)).toEqual(["Active request", "Inactive request", "Sibling request"]);
  expect(editorView(app.get(".body-text").element).state.doc.toString()).toBe("later target body");
  const saved = loadWorkspace().workspace;
  expect(saved.requests.active.path).toBe("https://active.test/later");
  expect(saved.requests.inactive.path).toBe("https://inactive.test/later");
  expect(saved.requests.inactive.body).toBe("later target body");
  expect(findButton(app, "Undo collection edit")).toBeUndefined();
});

it("undoes movement without discarding later edits to the moved request", async () => {
  const app = render();
  await expand(app, "Source");
  await move(app, "Inactive request", "destination");
  await requestRow(app, "Inactive request").trigger("click");
  await app.get('[aria-label="Request URL"]').setValue("https://inactive.test/after-moving");

  await button(app, "Undo collection edit").trigger("click");

  const saved = loadWorkspace().workspace;
  expect(sourceChildren(saved)).toEqual(["inactive", "sibling"]);
  expect(saved.requests.inactive.path).toBe("https://inactive.test/after-moving");
  expect(activeTab(app)).toBe("Inactive request");
});

it("reports an unavailable move Undo when the original parent was deleted and keeps the current placement", async () => {
  const app = render();
  await expand(app, "Source");
  await move(app, "Inactive request", "destination");
  await action(app, "Source", "Delete");
  await app.get('form[aria-label="Delete folder"]').trigger("submit");

  await button(app, "Undo collection edit").trigger("click");

  const destination = loadWorkspace().workspace.collection.find(node => node.id === "destination");
  expect(destination?.kind === "folder" && destination.children.map(node => node.id)).toEqual(["inactive"]);
  expect(app.get('[aria-label="Workspace notifications"] [role="alert"]').text()).toMatch(/undo|folder|parent/i);
  expect(button(app, "Undo collection deletion").exists()).toBe(true);
});

it("keeps deletion recovery independent and invalidates edit recovery when its target subtree is deleted", async () => {
  const app = render();
  await expand(app, "Source");
  await rename(app, "Inactive request", "Renamed request");
  await action(app, "Sibling request", "Delete");
  await app.get('form[aria-label="Delete request"]').trigger("submit");
  expect(button(app, "Undo collection edit").exists()).toBe(true);
  expect(button(app, "Undo collection deletion").exists()).toBe(true);
  await button(app, "Undo collection edit").trigger("click");
  await button(app, "Undo collection deletion").trigger("click");
  expect(sourceChildren(loadWorkspace().workspace)).toEqual(["inactive", "sibling"]);
  expect(tabNames(app)).toEqual(["Active request", "Inactive request", "Sibling request"]);

  await rename(app, "Inactive request", "Renamed again");
  await action(app, "Source", "Delete");
  await app.get('form[aria-label="Delete folder"]').trigger("submit");
  expect(findButton(app, "Undo collection edit")).toBeUndefined();
  await button(app, "Undo collection deletion").trigger("click");
  expect(loadWorkspace().workspace.requests.inactive.name).toBe("Renamed again");
});

it("dismisses edit recovery and leaves ineffective rename without a new notice", async () => {
  const app = render();
  await expand(app, "Source");
  await rename(app, "Inactive request", "Renamed request");
  await app.get('[aria-label="Dismiss collection edit recovery"]').trigger("click");
  expect(findButton(app, "Undo collection edit")).toBeUndefined();
  await rename(app, "Renamed request", " Renamed request ");
  expect(findButton(app, "Undo collection edit")).toBeUndefined();
});

it("cancels an uncommitted rename when narrow navigation closes or changes to history", async () => {
  vi.stubGlobal("matchMedia", vi.fn(() => Object.assign(new EventTarget(), { matches: true })));
  const app = render();
  await button(app, "Navigation").trigger("click");
  await expand(app, "Source");
  await action(app, "Inactive request", "Rename");
  await app.get('[aria-label="Collection entry name"]').setValue("Uncommitted name");

  await app.get('[aria-label="Close navigation"]').trigger("click");

  expect(app.find('[aria-label="Collection entry name"]').exists()).toBe(false);
  await button(app, "Navigation").trigger("click");
  await action(app, "Inactive request", "Rename");
  await app.get('[aria-label="Collection entry name"]').setValue("Another uncommitted name");
  await button(app, "History").trigger("click");
  await button(app, "Collections").trigger("click");
  expect(app.find('[aria-label="Collection entry name"]').exists()).toBe(false);
  expect(requestRow(app, "Inactive request").isVisible()).toBe(true);
  expect(loadWorkspace().workspace.requests.inactive.name).toBe("Inactive request");
  expect(findButton(app, "Undo collection edit")).toBeUndefined();
});

it("keeps narrow navigation open when Escape belongs to rename or search composition", async () => {
  vi.stubGlobal("matchMedia", vi.fn(() => Object.assign(new EventTarget(), { matches: true })));
  const app = render();
  await button(app, "Navigation").trigger("click");
  await expand(app, "Source");
  await action(app, "Inactive request", "Rename");
  const name = app.get('[aria-label="Collection entry name"]');
  await name.setValue("Uncommitted name");

  await name.trigger("keydown", { key: "Escape", isComposing: true });

  expect(button(app, "Navigation").attributes("aria-expanded")).toBe("true");
  expect(app.find('[aria-label="Collection entry name"]').exists()).toBe(true);
  await name.trigger("keydown", { key: "Escape" });
  const search = app.get<HTMLInputElement>('[aria-label="Search requests"]');
  await search.setValue("source");
  await search.trigger("keydown", { key: "Escape", isComposing: true });
  expect(button(app, "Navigation").attributes("aria-expanded")).toBe("true");
  expect(search.element.value).toBe("source");
  expect(loadWorkspace().workspace.requests.inactive.name).toBe("Inactive request");
});

it("restores organized names, sibling order, tabs, and editor content through the durable repository on reload", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, emptyLegacy);
  await repository.load();
  const saved = repository.save(fixture());
  await repository.flush();
  await saved;
  const app = mountApp({ initialWorkspace: await repository.load(), repository });
  await expand(app, "Source");
  await rename(app, "Inactive request", "Reloaded request");
  await action(app, "Reloaded request", "Move down");
  await replaceText(app.get(".body-text").element, "durable active body");
  await repository.flush();
  await flushPromises();
  app.unmount();
  mounted.splice(mounted.indexOf(app), 1);

  const nextRepository = createWorkspaceRepository(storage, emptyLegacy);
  const initialWorkspace = await nextRepository.load();
  expect(sourceChildren(initialWorkspace.workspace)).toEqual(["sibling", "inactive"]);
  const restored = mountApp({ initialWorkspace, repository: nextRepository });
  await expand(restored, "Source");

  expect(activeTab(restored)).toBe("Active request");
  expect(tabNames(restored)).toEqual(["Active request", "Reloaded request", "Sibling request"]);
  expect(editorView(restored.get(".body-text").element).state.doc.toString()).toBe("durable active body");
  expect(restored.findAll('.request-row').map(row => row.get('.node-name').text())).toEqual([
    "Active request", "Sibling request", "Reloaded request",
  ]);
  expect(findButton(restored, "Undo collection edit")).toBeUndefined();
});

type AppWrapper = ReturnType<typeof mount<typeof App>>;
const mounted: AppWrapper[] = [];
const emptyLegacy = { getItem: () => null, setItem: () => {} };

function fixture(): WorkspaceData {
  const workspace = createWorkspace();
  workspace.requests = {
    active: { ...createRequest("Active request"), method: "POST", path: "https://active.test", body: "initial active body" },
    inactive: { ...createRequest("Inactive request"), method: "POST", path: "https://inactive.test", body: "initial inactive body" },
    sibling: { ...createRequest("Sibling request"), path: "https://sibling.test" },
  };
  workspace.collection = [
    { kind: "request", id: "active", name: "Active request", requestType: "POST" },
    { kind: "folder", id: "source", name: "Source", children: [
      { kind: "request", id: "inactive", name: "Inactive request", requestType: "POST" },
      { kind: "request", id: "sibling", name: "Sibling request", requestType: "GET" },
    ] },
    { kind: "folder", id: "destination", name: "Destination", children: [] },
  ];
  workspace.openTabIds = ["active", "inactive", "sibling"];
  workspace.activeTabId = "active";
  workspace.layout.requests.active = { horizontal: "61%", vertical: "43%" };
  return workspace;
}

function render() {
  saveWorkspace(fixture());
  return mountApp();
}

function mountApp(props: InstanceType<typeof App>["$props"] = {}) {
  const app = mount(App, { props, attachTo: document.body });
  mounted.push(app);
  return app;
}

async function expand(app: AppWrapper, name: string) {
  const folder = app.findAll('.folder-row').find(row => row.get('.node-name').text() === name)!;
  if (folder.attributes("aria-expanded") === "false") await folder.trigger("click");
}

async function action(app: AppWrapper, name: string, label: string) {
  await app.get(`[aria-label="Actions for ${name}"]`).trigger("click");
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(item => item.textContent?.trim() === label)!;
  await new DOMWrapper(item).trigger("click");
}

async function rename(app: AppWrapper, previous: string, name: string) {
  await action(app, previous, "Rename");
  await app.get('[aria-label="Collection entry name"]').setValue(name);
  await app.get('form[aria-label="Rename request"]').trigger("submit");
}

async function move(app: AppWrapper, name: string, destination: string) {
  await action(app, name, "Move to");
  const dialog = new DOMWrapper(document.querySelector<HTMLDialogElement>('dialog[aria-label="Move request"]')!);
  await dialog.get('[aria-label="Collection destination"]').setValue(destination);
  await dialog.get("form").trigger("submit");
}

function requestRow(app: AppWrapper, name: string) {
  return app.findAll('.request-row').find(row => row.get('.node-name').text() === name)!;
}

function findButton(app: AppWrapper, name: string) {
  return app.findAll('button').find(candidate => candidate.text() === name);
}

function button(app: AppWrapper, name: string) {
  const result = findButton(app, name);
  if (!result) throw new Error(`Expected button: ${name}`);
  return result;
}

function tabNames(app: AppWrapper) {
  return app.findAll('[aria-label="Open workspace tabs"] [role="tab"]').map(tab => tab.get('.tab-label').text());
}

function activeTab(app: AppWrapper) {
  return app.get('[aria-label="Open workspace tabs"] [role="tab"][aria-selected="true"]').get('.tab-label').text();
}

function sourceChildren(workspace: WorkspaceData) {
  const source = workspace.collection.find(node => node.id === "source");
  return source?.kind === "folder" ? source.children.map(node => node.id) : [];
}
