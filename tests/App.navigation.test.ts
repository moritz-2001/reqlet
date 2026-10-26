// Verifies quick-open and navigation continuity through the workspace without executing requests or replacing drafts.
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import type { HistoryEntry } from "../src/request";
import { createWorkspace, loadWorkspace, saveWorkspace } from "../src/workspace";
import { editorView, press, replaceText } from "./editor";

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("opens narrow navigation on demand and retains browsing state after selecting requests and history", async () => {
  viewportQuery(true);
  const workspace = createWorkspace();
  workspace.history = [historyEntry("invite", "Invite member", 500)];
  saveWorkspace(workspace);
  const app = renderApp();
  const navigation = app.get('[aria-label="Workspace navigation"]');
  const toggle = button(app, "Navigation");
  expect(toggle.attributes("aria-controls")).toBe(navigation.attributes("id"));
  expect(toggle.attributes("aria-expanded")).toBe("false");
  expect(navigation.isVisible()).toBe(false);

  await toggle.trigger("click");
  expect(navigation.isVisible()).toBe(true);
  expect(toggle.attributes("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(button(app, "Collections").element);
  expect(app.get('[aria-label="Request workspace"]').attributes("inert")).toBeDefined();
  const search = navigation.get<HTMLInputElement>('[aria-label="Search requests"]');
  await search.setValue("invite");
  await navigation.findAll(".request-row").find(row => row.text().includes("Invite member"))!.trigger("click");
  expect(toggle.attributes("aria-expanded")).toBe("false");
  expect(navigation.isVisible()).toBe(false);
  expect(app.get('[aria-label="Request workspace"]').attributes("inert")).toBeUndefined();
  expect(document.activeElement).toBe(app.get('[role="tabpanel"]').element);

  await toggle.trigger("click");
  expect(navigation.get('[aria-label="Search requests"]').element).toBe(search.element);
  expect(search.element.value).toBe("invite");
  await button(app, "History").trigger("click");
  const historySearch = navigation.get<HTMLInputElement>('[aria-label="Search executions"]');
  await historySearch.setValue("invite");
  await navigation.get(".history-select").trigger("click");
  expect(navigation.isVisible()).toBe(false);
  expect(app.get('[aria-label="Open workspace tabs"] [aria-selected="true"] .tab-label').text()).toBe("Invite member · History");
  expect(document.activeElement).toBe(app.get('[role="tabpanel"]').element);

  await toggle.trigger("click");
  expect(button(app, "History").attributes("aria-pressed")).toBe("true");
  expect(navigation.get('[aria-label="Search executions"]').element).toBe(historySearch.element);
  expect(historySearch.element.value).toBe("invite");
});

it("dismisses narrow navigation and restores desktop navigation without changing saved split sizes", async () => {
  const viewport = viewportQuery(true);
  const workspace = createWorkspace();
  workspace.layout.sidebar = { horizontal: 320, vertical: 200 };
  saveWorkspace(workspace);
  const app = renderApp();
  const navigation = app.get('[aria-label="Workspace navigation"]');
  const toggle = button(app, "Navigation");
  await toggle.trigger("click");
  await button(app, "History").trigger("keydown", { key: "Escape" });
  expect(navigation.isVisible()).toBe(false);
  expect(document.activeElement).toBe(toggle.element);
  await toggle.trigger("click");
  await app.get('[aria-label="Dismiss navigation"]').trigger("click");
  expect(toggle.attributes("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(toggle.element);

  await toggle.trigger("click");
  await viewport.setMatches(false);
  expect(navigation.isVisible()).toBe(true);
  expect(app.find(".navigation-toggle").exists()).toBe(false);
  expect(app.find('[aria-label="Dismiss navigation"]').exists()).toBe(false);
  await viewport.setMatches(true);
  expect(navigation.isVisible()).toBe(false);
  expect(button(app, "Navigation").attributes("aria-expanded")).toBe("false");
  expect(loadWorkspace().workspace.layout.sidebar).toEqual({ horizontal: 320, vertical: 200 });
});

it("opens a nested request from any sidebar view using Cmd/Ctrl+K and focuses its workspace", async () => {
  const app = renderApp();
  await button(app, "History").trigger("click");
  await shortcut("k", { metaKey: true });
  const query = app.get('.quick-open [role="combobox"]');
  expect(document.activeElement).toBe(query.element);
  await query.setValue("members invite");
  expect(app.findAll('[role="option"]')).toHaveLength(1);
  await query.trigger("keydown", { key: "Enter" });
  expect(app.find("dialog.quick-open").exists()).toBe(false);
  expect(app.get('[aria-label="Open workspace tabs"]').get('[role="tab"][aria-selected="true"]').text()).toBe("Invite member");
  expect(document.activeElement).toBe(app.get('[role="tabpanel"]').element);

  await shortcut("K", { ctrlKey: true });
  expect(app.find("dialog.quick-open").exists()).toBe(true);
  await app.get('.quick-open [role="combobox"]').trigger("keydown", { key: "Escape" });
  expect(app.find("dialog.quick-open").exists()).toBe(false);
  expect(document.activeElement).toBe(app.get('[role="tabpanel"]').element);
});

it("reuses tabs and retained body drafts when opening the same result again", async () => {
  const app = renderApp();
  await button(app, "Quick open").trigger("click");
  await app.get('.quick-open [role="combobox"]').setValue("create workspace");
  await app.get('.quick-open [role="combobox"]').trigger("keydown", { key: "Enter" });
  const body = app.get(".body-text");
  await replaceText(body.element, "retained draft");
  const editor = editorView(body.element);
  expect(press(editor, "k", { ctrlKey: true }).defaultPrevented).toBe(true);
  await nextTick();
  expect(editor.state.doc.toString()).toBe("retained draft");
  await app.get('.quick-open [role="combobox"]').setValue("create workspace");
  await app.get('.quick-open [role="combobox"]').trigger("keydown", { key: "Enter" });
  expect(app.get('[aria-label="Open workspace tabs"]').findAll('[role="tab"]')).toHaveLength(1);
  expect(editorView(app.get(".body-text").element)).toBe(editor);
  expect(editor.state.doc.toString()).toBe("retained draft");
});

it("dismisses to its opener, ignores unmodified and composing keys, and cleans up shortcuts on unmount", async () => {
  const app = renderApp();
  await shortcut("k");
  await shortcut("k", { ctrlKey: true, isComposing: true });
  expect(app.find("dialog.quick-open").exists()).toBe(false);
  const opener = button(app, "Quick open");
  opener.element.focus();
  await opener.trigger("click");
  await app.get('[aria-label="Close quick open"]').trigger("click");
  expect(document.activeElement).toBe(opener.element);
  app.unmount();
  mounted.splice(mounted.indexOf(app), 1);
  expect((await shortcut("k", { ctrlKey: true })).defaultPrevented).toBe(false);
});

it("preserves collection browsing and history filters while switching between their independent scrollports", async () => {
  const workspace = createWorkspace();
  workspace.history = [historyEntry("invite", "Invite member", 500), historyEntry("list", "List workspaces", 200)];
  saveWorkspace(workspace);
  const app = renderApp();
  const collections = app.get('[aria-label="Collections"]');
  const collectionView = app.findAll<HTMLElement>(".sidebar-view").find(view => view.find('[aria-label="Collections"]').exists())!;
  const collectionNode = collectionView.element;
  const search = collections.get<HTMLInputElement>('[aria-label="Search requests"]');
  const workspaces = collections.findAll(".folder-row").find(folder => folder.text().includes("Workspaces"))!;
  await workspaces.trigger("click");
  const members = collections.findAll(".folder-row").find(folder => folder.text().includes("Members"))!;
  await members.trigger("click");
  await search.setValue("invite");
  collectionNode.scrollTop = 80;

  await button(app, "History").trigger("click");
  expect(collections.isVisible()).toBe(false);
  const history = app.get('[aria-label="Execution history"]');
  const historyView = app.findAll<HTMLElement>(".sidebar-view").find(view => view.find('[aria-label="Execution history"]').exists())!;
  const historyNode = historyView.element;
  const historySearch = history.get<HTMLInputElement>('[aria-label="Search executions"]');
  const resultFilter = history.get<HTMLSelectElement>('[aria-label="Filter execution results"]');
  await historySearch.setValue("invite");
  await resultFilter.setValue("http-error");
  expect(history.findAll(".history-select")).toHaveLength(1);
  await history.get(".history-select").trigger("click");
  historyNode.scrollTop = 56;

  await button(app, "Collections").trigger("click");
  expect(collections.isVisible()).toBe(true);
  expect(history.isVisible()).toBe(false);
  expect(app.get('[aria-label="Collections"]').element.parentElement).toBe(collectionNode);
  expect(search.element.isConnected).toBe(true);
  expect(search.element.value).toBe("invite");
  expect(collectionView.element.scrollTop).toBe(80);
  expect(collections.findAll(".request-row").filter(row => row.isVisible()).map(row => row.get(".node-name").text())).toEqual(["Invite member"]);
  await search.trigger("keydown", { key: "Escape" });
  expect(workspaces.attributes("aria-expanded")).toBe("true");
  expect(members.attributes("aria-expanded")).toBe("true");

  await button(app, "History").trigger("click");
  expect(app.get('[aria-label="Execution history"]').element.parentElement).toBe(historyNode);
  expect(historySearch.element.isConnected).toBe(true);
  expect(historySearch.element.value).toBe("invite");
  expect(resultFilter.element.value).toBe("http-error");
  expect(historyView.element.scrollTop).toBe(56);
  expect(history.get(".history-name").text()).toBe("Invite member");
  expect(history.get(".history-select").attributes("aria-pressed")).toBe("true");
  expect(app.get('[aria-label="Open workspace tabs"] [aria-selected="true"] .tab-label').text()).toBe("Invite member · History");
});

type AppWrapper = ReturnType<typeof mount<typeof App>>;
const mounted: AppWrapper[] = [];

function viewportQuery(matches: boolean) {
  const query = Object.assign(new EventTarget(), { matches });
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return {
    async setMatches(next: boolean) {
      query.matches = next;
      query.dispatchEvent(Object.assign(new Event("change"), { matches: next }));
      await nextTick();
    },
  };
}

function renderApp() {
  const app = mount(App, { attachTo: document.body });
  mounted.push(app);
  return app;
}

function button(app: AppWrapper, text: string) {
  return app.findAll("button").find(button => button.text().startsWith(text))!;
}

async function shortcut(key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  (document.activeElement ?? document.body).dispatchEvent(event);
  await nextTick();
  return event;
}

function historyEntry(id: string, name: string, status: number): HistoryEntry {
  const url = `https://service.test/${id}`;
  return {
    id, requestId: id, name, startedAt: "2026-10-22T11:00:00Z",
    request: { method: "GET", url, headers: [], body: "", timeoutMs: 12000 },
    result: {
      status: "success",
      response: { status, statusText: "", url, headers: [], durationMs: 10, sizeBytes: 0, body: "" },
    },
  };
}
