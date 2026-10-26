// Verifies deletion and Undo through collection controls, tabs, and the active request editor.
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import CollectionManager from "../src/components/CollectionManager.vue";
import RequestEditor from "../src/components/RequestEditor.vue";
import { executeHttp } from "../src/http";
import { createRequest } from "../src/request";
import { createWorkspace, saveWorkspace } from "../src/workspace";

vi.mock("../src/http", () => ({ executeHttp: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(executeHttp).mockReset();
});

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.replaceChildren();
});

it("restores a deleted subtree, its original tab positions and selection, and pane preferences without dropping later edits", async () => {
  const app = render();
  await deleteEntry(app, "Workspaces");
  expect(app.get('form[aria-label="Delete folder"]').text()).toContain("3 requests will be removed");
  await app.get('form[aria-label="Delete folder"]').trigger("submit");
  expect(tabNames(app)).toEqual(["Outside"]);
  expect(app.getComponent(CollectionManager).props("requests")["create-workspace"]).toBeUndefined();
  expect(app.get('.workspace-notice').text()).toContain("3 requests removed");
  await app.get('[aria-label="Request URL"]').setValue("https://edited-after-delete.test");
  await button(app, "Undo collection deletion").trigger("click");

  const manager = app.getComponent(CollectionManager);
  expect(manager.props("nodes").map(node => node.id)).toEqual(["workspaces", "drafts", "outside"]);
  expect(Object.keys(manager.props("requests"))).toHaveLength(4);
  expect(manager.props("requests").outside.path).toBe("https://edited-after-delete.test");
  expect(tabNames(app)).toEqual(["List workspaces", "Outside", "Create workspace", "Invite member"]);
  expect(activeTab(app)).toBe("Create workspace");
  expect(app.getComponent(RequestEditor).props("layout")).toEqual({ horizontal: "61%", vertical: "43%" });
  expect(app.find('.workspace-notice').exists()).toBe(false);
});

it("keeps a later tab choice and later tab closures when undoing a request deletion", async () => {
  const app = render();
  const folder = app.findAll('.tree-row').find(row => row.text().includes("Workspaces"))!;
  if (folder.attributes("aria-expanded") === "false") await folder.trigger("click");
  await deleteEntry(app, "Create workspace");
  await app.get('form[aria-label="Delete request"]').trigger("submit");
  await app.findAll('[role="tab"]').find(tab => tab.get('.tab-label').text() === "Outside")!.trigger("click");
  await app.get('[aria-label="Close List workspaces"]').trigger("click");
  await button(app, "Undo collection deletion").trigger("click");

  expect(activeTab(app)).toBe("Outside");
  expect(tabNames(app)).toEqual(["Outside", "Create workspace", "Invite member"]);
  expect(app.getComponent(CollectionManager).props("requests")["create-workspace"].name).toBe("Create workspace");
});

it("cancels deleted requests and does not restart their exchanges on Undo", async () => {
  vi.mocked(executeHttp).mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  }));
  const app = render();
  await button(app, "Send").trigger("click");
  const signal = vi.mocked(executeHttp).mock.calls[0][1]!;
  await deleteEntry(app, "Workspaces");
  await app.get('form[aria-label="Delete folder"]').trigger("submit");
  expect(signal.aborted).toBe(true);
  await button(app, "Undo collection deletion").trigger("click");
  await flushPromises();

  expect(executeHttp).toHaveBeenCalledTimes(1);
  expect(app.getComponent(RequestEditor).props("execution")).toEqual({ status: "cancelled" });
});

it("retains only the latest deletion and releases recovery when dismissed", async () => {
  const app = render();
  await deleteEntry(app, "Workspaces");
  await app.get('form[aria-label="Delete folder"]').trigger("submit");
  await deleteEntry(app, "Outside");
  await app.get('form[aria-label="Delete request"]').trigger("submit");
  await button(app, "Undo collection deletion").trigger("click");
  expect(Object.keys(app.getComponent(CollectionManager).props("requests"))).toEqual(["outside"]);
  await deleteEntry(app, "Outside");
  await app.get('form[aria-label="Delete request"]').trigger("submit");
  await app.get('[aria-label="Dismiss collection recovery"]').trigger("click");
  expect(app.findAll('button').some(candidate => candidate.text() === "Undo collection deletion")).toBe(false);
});

type AppWrapper = ReturnType<typeof mount<typeof App>>;
const mounted: AppWrapper[] = [];

function render() {
  const workspace = createWorkspace();
  workspace.requests.outside = { ...createRequest("Outside"), path: "https://outside.test" };
  workspace.collection.push({ kind: "request", id: "outside", name: "Outside", requestType: "GET" });
  workspace.openTabIds = ["list-workspaces", "outside", "create-workspace", "invite-member"];
  workspace.activeTabId = "create-workspace";
  workspace.layout.requests["create-workspace"] = { horizontal: "61%", vertical: "43%" };
  saveWorkspace(workspace);
  const app = mount(App, { attachTo: document.body });
  mounted.push(app);
  return app;
}

async function deleteEntry(app: AppWrapper, name: string) {
  await app.get(`[aria-label="Actions for ${name}"]`).trigger("click");
  await menuItem("Delete").trigger("click");
}

function menuItem(name: string) {
  return new DOMWrapper(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(item => item.textContent === name)!);
}

function button(app: AppWrapper, name: string) {
  return app.findAll('button').find(candidate => candidate.text() === name)!;
}

function tabNames(app: AppWrapper) {
  return app.findAll('[aria-label="Open workspace tabs"] [role="tab"]').map(tab => tab.get('.tab-label').text());
}

function activeTab(app: AppWrapper) {
  return app.get('[aria-label="Open workspace tabs"] [role="tab"][aria-selected="true"]').get('.tab-label').text();
}
