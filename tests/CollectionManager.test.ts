// Exercises collection creation and management through controlled UI events, without native prompts.
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it } from "vitest";
import CollectionManager from "../src/components/CollectionManager.vue";
import { collectionFolders, findCollectionNode, type CollectionChange, type CollectionState } from "../src/collections";
import { createRequest } from "../src/request";

afterEach(() => {
  for (const manager of mounted.splice(0)) manager.unmount();
  document.body.replaceChildren();
});

it("creates a folder and a nested request and opens the new request using its stable ID", async () => {
  const manager = await renderManager({ requests: {}, nodes: [] });
  await manager.get('[aria-label="More creation options"]').trigger("click");
  await menuItem("+ New folder").trigger("click");
  await manager.get('[aria-label="Collection entry name"]').setValue("Team API");
  await manager.get("form").trigger("submit");
  const folder = manager.props("nodes")[0];
  expect(folder).toMatchObject({ kind: "folder", name: "Team API", children: [] });

  await button(manager, "+ New request").trigger("click");
  expect(manager.get<HTMLSelectElement>('[aria-label="Collection destination"]').element.value).toBe(folder.id);
  await manager.get('[aria-label="Collection entry name"]').setValue("List people");
  await manager.get("form").trigger("submit");
  const id = Object.keys(manager.props("requests"))[0];
  expect(manager.props("requests")[id]).toEqual(createRequest("List people"));
  expect(findCollectionNode(manager.props("nodes"), id)?.name).toBe("List people");
  expect(manager.emitted("select-request")!.at(-1)).toEqual([id]);
  expect(buttonContaining(manager, "Team API").attributes("aria-expanded")).toBe("true");
});

it("renders canonical names and custom methods after editing outside the collection tree", async () => {
  const state = collection();
  const manager = await renderManager(state);
  await buttonContaining(manager, "Team API").trigger("click");
  await manager.setProps({ requests: { ...state.requests, people: { ...state.requests.people, name: "Edited request", method: "PROPFIND" } } });
  const request = buttonContaining(manager, "Edited request");
  expect(request.text()).toContain("PROPFIND");
  expect(manager.findAll(".request-row").map(row => row.text())).not.toContain("Stale tree name");
  await request.trigger("click");
  expect(manager.emitted("select-request")!.at(-1)).toEqual(["people"]);
  expect(manager.get('[aria-label="Actions for Edited request"]').exists()).toBe(true);
});

it("renames, duplicates, moves, and deletes a request through the visible controls", async () => {
  const manager = await renderManager(collection());
  await buttonContaining(manager, "Team API").trigger("click");
  await buttonContaining(manager, "List people").trigger("click");
  await action(manager, "List people", "Rename");
  await manager.get('[aria-label="Collection entry name"]').setValue("All people");
  await manager.get("form").trigger("submit");
  expect(manager.props("requests").people.name).toBe("All people");
  expect(findCollectionNode(manager.props("nodes"), "people")?.name).toBe("All people");

  await action(manager, "All people", "Duplicate");
  await manager.get("form").trigger("submit");
  const copiedId = Object.keys(manager.props("requests")).find(id => id !== "people")!;
  expect(manager.props("requests")[copiedId].name).toBe("All people copy");
  await action(manager, "All people copy", "Move to");
  await moveDialog().get('[aria-label="Collection destination"]').setValue("");
  await moveDialog().get("form").trigger("submit");
  expect(manager.props("nodes").at(-1)).toMatchObject({ kind: "request", id: copiedId });

  await action(manager, "All people copy", "Delete");
  await button(manager, "Cancel").trigger("click");
  expect(manager.props("requests")[copiedId]).toBeDefined();
  await action(manager, "All people copy", "Delete");
  await manager.get("form").trigger("submit");
  expect(manager.props("requests")[copiedId]).toBeUndefined();
  expect((manager.emitted("change")!.at(-1)![0] as CollectionChange).deletedRequestIds).toEqual([copiedId]);
  expect(manager.props("requests").people.name).toBe("All people");
});

it("renames, duplicates, moves, and deletes folder subtrees and excludes cycle destinations", async () => {
  const state = collection();
  state.nodes = [...state.nodes, { kind: "folder", id: "other", name: "Other", children: [] }];
  const manager = await renderManager(state);
  await buttonContaining(manager, "Team API").trigger("click");
  await action(manager, "Team API", "Rename");
  await manager.get('[aria-label="Collection entry name"]').setValue("Accounts");
  await manager.get("form").trigger("submit");
  expect(manager.props("nodes")[0]).toMatchObject({ id: "team", name: "Accounts" });
  await action(manager, "Accounts", "Duplicate");
  await manager.get("form").trigger("submit");
  const copiedFolder = manager.props("nodes").at(-1)!;
  expect(copiedFolder).toMatchObject({ kind: "folder", name: "Accounts copy" });
  expect(Object.keys(manager.props("requests"))).toHaveLength(2);

  await action(manager, "Accounts copy", "Move to");
  const destinations = moveDialog().findAll("select option").map(option => option.attributes("value"));
  expect(destinations).toEqual(["", "team", "other"]);
  await moveDialog().get('[aria-label="Collection destination"]').setValue("other");
  await moveDialog().get("form").trigger("submit");
  expect(collectionFolders(manager.props("nodes")).map(folder => folder.path)).toEqual(["Accounts", "Other", "Other / Accounts copy"]);
  await action(manager, "Accounts copy", "Delete");
  expect(manager.get("form").text()).toContain("all requests and folders inside it");
  expect(manager.get("form").text()).toContain("1 request will be removed. You can undo this deletion.");
  await manager.get("form").trigger("submit");
  expect(Object.keys(manager.props("requests"))).toEqual(["people"]);
  expect(findCollectionNode(manager.props("nodes"), copiedFolder.id)).toBeUndefined();
  const deletion = manager.emitted("change")!.at(-1)![0] as CollectionChange;
  expect(deletion.deletedRequestIds).toHaveLength(1);
  expect(deletion.deletion).toMatchObject({ node: { id: copiedFolder.id }, requests: {
    [deletion.deletedRequestIds[0]]: { name: "List people" },
  } });
});

it("emits one complete change before the owner replaces definitions and keeps invalid edits unapplied", async () => {
  const manager = await renderManager(collection());
  const removed: Array<{ id: string; existed: boolean }> = [];
  await manager.setProps({ onChange: change => {
    for (const id of change.deletedRequestIds) removed.push({ id, existed: !!manager.props("requests")[id] });
    void manager.setProps({ requests: change.requests, nodes: change.nodes });
  } });
  await buttonContaining(manager, "Team API").trigger("click");
  await action(manager, "Team API", "Rename");
  await manager.get('[aria-label="Collection entry name"]').setValue("  ");
  await manager.get("form").trigger("submit");
  expect(manager.get('[role="alert"]').text()).toContain("Enter a name");
  expect(manager.props("nodes")[0].name).toBe("Team API");
  await manager.get("form").trigger("keydown", { key: "Escape" });
  expect(manager.find("form").exists()).toBe(false);
  await action(manager, "Team API", "Delete");
  await manager.get("form").trigger("submit");
  expect(removed).toEqual([{ id: "people", existed: true }]);
  expect(manager.props("requests")).toEqual({});
  expect(manager.emitted("delete-request")).toBeUndefined();
  expect(manager.emitted("delete-entry")).toBeUndefined();
  expect(manager.emitted("update:requests")).toBeUndefined();
});

it("keeps secondary creation and entry actions behind their contextual buttons", async () => {
  const manager = await renderManager(collection());
  expect(button(manager, "+ New request").exists()).toBe(true);
  expect(manager.find("h2").exists()).toBe(false);
  expect(manager.find(".entry-actions").exists()).toBe(false);
  expect(document.querySelector('[role="menu"]')).toBeNull();

  const trigger = manager.get<HTMLButtonElement>('[aria-label="More creation options"]');
  trigger.element.focus();
  await trigger.trigger("click");
  expect(trigger.attributes("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(menuItem("+ New folder").element);
  await menuItem("+ New folder").trigger("keydown", { key: "Escape" });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(trigger.attributes("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger.element);
});

it("supports menu keyboard navigation and outside dismissal without activating requests", async () => {
  const manager = await renderManager(searchableCollection());
  await buttonContaining(manager, "Team API").trigger("click");
  const trigger = manager.get<HTMLButtonElement>('[aria-label="Actions for List people"]');
  trigger.element.focus();
  await trigger.trigger("click");
  expect(document.activeElement).toBe(menuItem("Rename").element);
  await menuItem("Rename").trigger("keydown", { key: "ArrowUp" });
  expect(document.activeElement).toBe(menuItem("Delete").element);
  await menuItem("Delete").trigger("keydown", { key: "Home" });
  expect(document.activeElement).toBe(menuItem("Rename").element);
  await menuItem("Rename").trigger("keydown", { key: "End" });
  expect(document.activeElement).toBe(menuItem("Delete").element);
  await menuItem("Delete").trigger("keydown", { key: "Escape" });
  expect(document.activeElement).toBe(trigger.element);
  expect(manager.emitted("select-request")).toBeUndefined();

  await trigger.trigger("click");
  await manager.get('[aria-label="Search requests"]').trigger("pointerdown");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(trigger.attributes("aria-expanded")).toBe("false");
  expect(manager.emitted("select-request")).toBeUndefined();

  await trigger.trigger("click");
  await menuItem("Rename").trigger("keydown", { key: "Tab" });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger.element);

  await trigger.trigger("click");
  const backwardsTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  menuItem("Rename").element.dispatchEvent(backwardsTab);
  expect(backwardsTab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(trigger.element);
});

it("captures the contextual target while active request selection changes", async () => {
  const manager = await renderManager(searchableCollection());
  await manager.setProps({ selectedRequestId: "health" });
  await buttonContaining(manager, "Team API").trigger("click");
  await action(manager, "List people", "Rename");
  expect(manager.emitted("select-request")).toBeUndefined();
  expect(manager.get<HTMLInputElement>('[aria-label="Collection entry name"]').element.value).toBe("List people");
  await manager.setProps({ selectedRequestId: "update" });
  await manager.get('[aria-label="Collection entry name"]').setValue("All people");
  await manager.get("form").trigger("submit");
  expect(manager.props("requests").people.name).toBe("All people");
  expect(manager.props("requests").update.name).toBe("Update person");
  expect(manager.props("requests").health.name).toBe("Health");
  expect(document.activeElement).toBe(manager.get('[aria-label="Actions for All people"]').element);
});

it("finds canonical request names, URLs, methods, and folder paths without changing the collection", async () => {
  const state = searchableCollection();
  const original = structuredClone(state);
  const manager = await renderManager(state);
  const search = manager.get('[aria-label="Search requests"]');

  await search.setValue("team PUT");
  expect(visibleRequests(manager)).toEqual(["Update personPUT"]);
  expect(manager.get('[role="status"]').text()).toBe("1 matching request");
  await search.setValue("API.EXAMPLE.TEST/PEOPLE");
  expect(visibleRequests(manager)).toEqual(["List peopleGET", "Update personPUT"]);
  await search.setValue("Update person");
  expect(visibleRequests(manager)).toEqual(["Update personPUT"]);
  await search.setValue("missing request");
  expect(visibleRequests(manager)).toEqual([]);
  expect(manager.get('[role="status"]').text()).toBe("No requests match your search.");
  await search.trigger("keydown", { key: "Enter" });
  expect(manager.emitted("select-request")).toBeUndefined();
  expect(manager.props("requests")).toEqual(original.requests);
  expect(manager.props("nodes")).toEqual(original.nodes);
});

it("reveals matches inside closed folders and restores nested expansion after clearing search", async () => {
  const manager = await renderManager(searchableCollection());
  expect(manager.find('[data-collection-row="people"]').exists()).toBe(false);
  expect(manager.find('[data-collection-row="update"]').exists()).toBe(false);
  await buttonContaining(manager, "Team API").trigger("click");
  await buttonContaining(manager, "Writes").trigger("click");
  await buttonContaining(manager, "Team API").trigger("click");
  expect(buttonContaining(manager, "Team API").attributes("aria-expanded")).toBe("false");
  const search = manager.get('[aria-label="Search requests"]');
  await search.setValue("PUT");

  expect(buttonContaining(manager, "Team API").attributes("aria-expanded")).toBe("true");
  expect(visibleRequests(manager)).toEqual(["Update personPUT"]);
  expect(manager.find('[data-collection-row="people"]').exists()).toBe(false);
  expect(manager.find('[data-collection-row="health"]').exists()).toBe(false);
  await manager.get('[aria-label="Clear request search"]').trigger("click");
  expect(buttonContaining(manager, "Team API").attributes("aria-expanded")).toBe("false");
  expect(visibleRequests(manager)).toEqual(["HealthGET"]);
  expect(manager.find('[data-collection-row="update"]').exists()).toBe(false);
  await buttonContaining(manager, "Team API").trigger("click");
  expect(buttonContaining(manager, "Writes").attributes("aria-expanded")).toBe("true");
  expect(visibleRequests(manager)).toEqual(["List peopleGET", "Update personPUT", "HealthGET"]);
});

it("lets search folders collapse and reexpand without changing remembered browsing expansion", async () => {
  const manager = await renderManager(searchableCollection());
  await buttonContaining(manager, "Team API").trigger("click");
  const search = manager.get('[aria-label="Search requests"]');
  await search.setValue("PUT");
  expect(visibleRequests(manager)).toEqual(["Update personPUT"]);

  await buttonContaining(manager, "Writes").trigger("click");
  expect(buttonContaining(manager, "Writes").attributes("aria-expanded")).toBe("false");
  expect(visibleRequests(manager)).toEqual([]);
  await buttonContaining(manager, "Team API").trigger("click");
  expect(buttonContaining(manager, "Team API").attributes("aria-expanded")).toBe("false");
  expect(manager.find('[data-collection-row="writes"]').exists()).toBe(false);
  await buttonContaining(manager, "Team API").trigger("click");
  expect(buttonContaining(manager, "Writes").attributes("aria-expanded")).toBe("false");
  await buttonContaining(manager, "Writes").trigger("click");
  expect(visibleRequests(manager)).toEqual(["Update personPUT"]);

  await buttonContaining(manager, "Team API").trigger("click");
  await search.setValue("Update");
  expect(buttonContaining(manager, "Team API").attributes("aria-expanded")).toBe("true");
  expect(visibleRequests(manager)).toEqual(["Update personPUT"]);
  await buttonContaining(manager, "Team API").trigger("click");
  await manager.get('[aria-label="Clear request search"]').trigger("click");
  expect(buttonContaining(manager, "Team API").attributes("aria-expanded")).toBe("true");
  expect(buttonContaining(manager, "Writes").attributes("aria-expanded")).toBe("false");
  expect(visibleRequests(manager)).toEqual(["List peopleGET", "HealthGET"]);
  expect(manager.emitted("change")).toBeUndefined();
});

it("supports keyboard quick-open, first-match selection, and Escape clearing with focus retained", async () => {
  const manager = await renderManager(searchableCollection());
  const search = manager.get<HTMLInputElement>('[aria-label="Search requests"]');
  await search.setValue("PUT");
  manager.vm.focusSearch();
  expect(document.activeElement).toBe(search.element);
  expect(search.element.selectionStart).toBe(0);
  expect(search.element.selectionEnd).toBe(3);
  await search.trigger("keydown", { key: "Enter" });
  expect(manager.emitted("select-request")).toEqual([["update"]]);

  await search.trigger("keydown", { key: "Escape" });
  expect(search.element.value).toBe("");
  expect(document.activeElement).toBe(search.element);
  expect(manager.find('[role="status"]').exists()).toBe(false);
  expect(buttonContaining(manager, "Team API").attributes("aria-expanded")).toBe("false");
});

it("leaves IME Enter and Escape to composition without opening a request or clearing the query", async () => {
  const manager = await renderManager(searchableCollection());
  const search = manager.get<HTMLInputElement>('[aria-label="Search requests"]');
  await search.setValue("PUT");
  await search.trigger("keydown", { key: "Enter", isComposing: true });
  expect(manager.emitted("select-request")).toBeUndefined();
  await search.trigger("keydown", { key: "Escape", isComposing: true });
  expect(search.element.value).toBe("PUT");
  expect(visibleRequests(manager)).toEqual(["Update personPUT"]);

  await search.trigger("keydown", { key: "Enter" });
  expect(manager.emitted("select-request")).toEqual([["update"]]);
  await search.trigger("keydown", { key: "Escape" });
  expect(search.element.value).toBe("");
});

it("keeps temporary ancestor expansion out of browsing state after opening a result", async () => {
  const manager = await renderManager(searchableCollection());
  await buttonContaining(manager, "Team API").trigger("click");
  expect(buttonContaining(manager, "Writes").attributes("aria-expanded")).toBe("false");

  await manager.get('[aria-label="Search requests"]').setValue("PUT");
  expect(buttonContaining(manager, "Writes").attributes("aria-expanded")).toBe("true");
  await manager.get('[aria-label="Search requests"]').trigger("keydown", { key: "Enter" });
  await manager.setProps({ selectedRequestId: "update" });
  expect(manager.emitted("select-request")).toEqual([["update"]]);
  await manager.get('[aria-label="Clear request search"]').trigger("click");

  expect(buttonContaining(manager, "Team API").attributes("aria-expanded")).toBe("true");
  expect(buttonContaining(manager, "Writes").attributes("aria-expanded")).toBe("false");
  expect(visibleRequests(manager)).toEqual(["List peopleGET", "HealthGET"]);
  expect(document.activeElement).toBe(manager.get('[aria-label="Search requests"]').element);
});

it("keeps results in tree order and recomputes them after canonical metadata changes", async () => {
  const state = searchableCollection();
  const manager = await renderManager(state);
  const search = manager.get('[aria-label="Search requests"]');
  await search.setValue("TEAM people");
  expect(visibleRequests(manager)).toEqual(["List peopleGET", "Update personPUT"]);
  await search.trigger("keydown", { key: "Enter" });
  expect(manager.emitted("select-request")!.at(-1)).toEqual(["people"]);

  await manager.setProps({ requests: {
    ...state.requests,
    people: { ...state.requests.people, name: "List members", path: "https://api.example.test/members" },
  } });
  expect(visibleRequests(manager)).toEqual(["Update personPUT"]);
  expect(manager.get('[role="status"]').text()).toBe("1 matching request");
});

it("renames in place through F2, saves only explicit submission, and leaves composition keys alone", async () => {
  const manager = await renderManager(searchableCollection());
  await buttonContaining(manager, "Team API").trigger("click");
  const row = buttonContaining(manager, "List people");
  row.element.focus();
  await row.trigger("keydown", { key: "F2" });
  const input = manager.get<HTMLInputElement>('[aria-label="Collection entry name"]');
  expect(document.activeElement).toBe(input.element);
  expect(input.element.selectionStart).toBe(0);
  expect(input.element.selectionEnd).toBe("List people".length);
  expect(manager.get('.inline-rename').element.closest('[data-collection-id]')?.getAttribute('data-collection-id')).toBe("people");
  await input.setValue("  All people  ");
  await input.trigger("compositionstart");
  await input.trigger("keydown", { key: "Enter", isComposing: true });
  await manager.get("form").trigger("submit");
  await input.trigger("keydown", { key: "Escape", isComposing: true });
  expect(manager.props("requests").people.name).toBe("List people");
  expect(manager.find('.inline-rename').exists()).toBe(true);
  await input.trigger("compositionend");
  await button(manager, "Save").trigger("click");
  // Native button submission is represented explicitly in jsdom.
  if (manager.find("form").exists()) await manager.get("form").trigger("submit");
  expect(manager.props("requests").people.name).toBe("All people");
  expect(manager.emitted("select-request")).toBeUndefined();
});

it("cancels inline names on Escape or outside focus without stealing the chosen focus target", async () => {
  const manager = await renderManager(collection());
  await buttonContaining(manager, "Team API").trigger("click");
  await action(manager, "List people", "Rename");
  await manager.get('[aria-label="Collection entry name"]').setValue("Discard this");
  const search = manager.get<HTMLInputElement>('[aria-label="Search requests"]');
  search.element.focus();
  await Promise.resolve();
  expect(manager.find('.inline-rename').exists()).toBe(false);
  expect(document.activeElement).toBe(search.element);
  expect(manager.props("requests").people.name).toBe("List people");
  await action(manager, "List people", "Rename");
  await manager.get('[aria-label="Collection entry name"]').setValue("Discard again");
  await manager.get('[aria-label="Collection entry name"]').trigger("keydown", { key: "Escape" });
  expect(manager.find('.inline-rename').exists()).toBe(false);
  expect(document.activeElement).toBe(manager.get('[aria-label="Actions for List people"]').element);
  expect(manager.emitted("change")).toBeUndefined();
});

it("does not emit changes or recovery for the same trimmed name", async () => {
  const manager = await renderManager(collection());
  await buttonContaining(manager, "Team API").trigger("click");
  await action(manager, "List people", "Rename");
  await manager.get('[aria-label="Collection entry name"]').setValue("  List people  ");
  await manager.get("form").trigger("submit");
  expect(manager.emitted("change")).toBeUndefined();
  expect(manager.find("form").exists()).toBe(false);
});

it("orders siblings from keyboard and menu without opening a request and disables boundary actions", async () => {
  const manager = await renderManager(searchableCollection());
  await buttonContaining(manager, "Team API").trigger("click");
  const trigger = manager.get<HTMLButtonElement>('[aria-label="Actions for List people"]');
  trigger.element.focus();
  await trigger.trigger("keydown", { key: "ArrowDown", altKey: true, shiftKey: true });
  const team = findCollectionNode(manager.props("nodes"), "team");
  expect(team?.kind === "folder" && team.children.map(node => node.id)).toEqual(["writes", "people"]);
  expect(manager.emitted("select-request")).toBeUndefined();
  expect(document.activeElement).toBe(trigger.element);
  await trigger.trigger("click");
  expect(menuItem("Move down").attributes("disabled")).toBeDefined();
  await menuItem("Move up").trigger("click");
  const reordered = findCollectionNode(manager.props("nodes"), "team");
  expect(reordered?.kind === "folder" && reordered.children.map(node => node.id)).toEqual(["people", "writes"]);
  await trigger.trigger("click");
  expect(menuItem("Move up").attributes("disabled")).toBeDefined();
});

it("searches every valid destination while filtering requests and keeps positional controls unavailable", async () => {
  const state = searchableCollection();
  state.nodes = [...state.nodes, { kind: "folder", id: "empty", name: "Empty destination", children: [] }];
  const manager = await renderManager(state);
  await manager.get('[aria-label="Search requests"]').setValue("List people");
  expect(manager.find('.drag-handle').exists()).toBe(false);
  await manager.get('[aria-label="Actions for List people"]').trigger("click");
  expect(menuItem("Move up").attributes("disabled")).toBeDefined();
  expect(menuItem("Move down").attributes("disabled")).toBeDefined();
  await menuItem("Move to").trigger("click");
  const dialog = moveDialog();
  expect(document.activeElement).toBe(dialog.get('[aria-label="Search destination folders"]').element);
  expect(dialog.findAll('option').map(option => option.text())).toContain("Empty destination");
  expect(dialog.get('option[value="team"]').attributes("disabled")).toBeDefined();
  expect(dialog.get('button[type="submit"]').attributes("disabled")).toBeDefined();
  await dialog.get('[aria-label="Search destination folders"]').setValue("EMPTY destination");
  expect(dialog.findAll('option:not(:disabled)').map(option => option.text())).toEqual(["Empty destination"]);
  await dialog.get('[aria-label="Collection destination"]').setValue("empty");
  await dialog.get('form').trigger("submit");
  expect(findCollectionNode(manager.props("nodes"), "empty")).toMatchObject({ children: [{ id: "people" }] });
  expect(manager.get<HTMLInputElement>('[aria-label="Search requests"]').element.value).toBe("List people");
  expect(manager.emitted("select-request")).toBeUndefined();
  expect(document.activeElement).toBe(manager.get('[aria-label="Actions for List people"]').element);
});

it("retains nested expansion when reparenting a folder and focuses its new row", async () => {
  const manager = await renderManager(searchableCollection());
  await buttonContaining(manager, "Team API").trigger("click");
  await buttonContaining(manager, "Writes").trigger("click");
  await action(manager, "Writes", "Move to");
  await moveDialog().get('[aria-label="Collection destination"]').setValue("");
  await moveDialog().get("form").trigger("submit");
  expect(buttonContaining(manager, "Writes").attributes("aria-expanded")).toBe("true");
  expect(visibleRequests(manager)).toEqual(["List peopleGET", "HealthGET", "Update personPUT"]);
  expect(document.activeElement).toBe(manager.get('[aria-label="Actions for Writes"]').element);
});

it("retains folder-path search after a rename removes its results and returns focus to search", async () => {
  const manager = await renderManager(searchableCollection());
  const search = manager.get<HTMLInputElement>('[aria-label="Search requests"]');
  await search.setValue("Team API");
  await action(manager, "Team API", "Rename");
  await manager.get('[aria-label="Collection entry name"]').setValue("Accounts");
  await manager.get("form").trigger("submit");
  expect(search.element.value).toBe("Team API");
  expect(visibleRequests(manager)).toEqual([]);
  expect(document.activeElement).toBe(search.element);
  expect(manager.get('[aria-live="polite"]').text()).toContain("Accounts");
});

it("creates requests and folders directly in a folder from its contextual menu", async () => {
  const manager = await renderManager(searchableCollection());
  await buttonContaining(manager, "Team API").trigger("click");
  await action(manager, "Writes", "New folder here");
  expect(manager.get<HTMLSelectElement>('[aria-label="Collection destination"]').element.value).toBe("writes");
  await manager.get('[aria-label="Collection entry name"]').setValue("Nested");
  await manager.get("form").trigger("submit");
  expect(collectionFolders(manager.props("nodes")).map(folder => folder.path)).toContain("Team API / Writes / Nested");
  expect(manager.emitted("select-request")).toBeUndefined();
  await action(manager, "Nested", "New request here");
  await manager.get('[aria-label="Collection entry name"]').setValue("New nested request");
  await manager.get("form").trigger("submit");
  expect(manager.emitted("select-request")).toHaveLength(1);
  expect(visibleRequests(manager)).toContain("New nested requestGET");
});

it("starts a fresh rename after hiding an input during composition", async () => {
  const manager = await renderManager(collection());
  await buttonContaining(manager, "Team API").trigger("click");
  await action(manager, "List people", "Rename");
  await manager.get('[aria-label="Collection entry name"]').trigger("compositionstart");
  await manager.setProps({ interactionEnabled: false });
  await manager.setProps({ interactionEnabled: true });
  await action(manager, "List people", "Rename");
  await manager.get('[aria-label="Collection entry name"]').setValue("Fresh name");
  await manager.get("form").trigger("submit");
  expect(manager.props("requests").people.name).toBe("Fresh name");
});

it("closes a stale target's editor and leaves current definitions untouched", async () => {
  const manager = await renderManager(collection());
  await buttonContaining(manager, "Team API").trigger("click");
  await action(manager, "List people", "Rename");
  await manager.get('[aria-label="Collection entry name"]').setValue("Outdated edit");
  await manager.setProps({ requests: {}, nodes: [] });
  await flushPromises();
  expect(manager.find("form").exists()).toBe(false);
  expect(manager.emitted("change")).toBeUndefined();
  expect(document.activeElement).toBe(manager.get('[aria-label="Search requests"]').element);
});

type ManagerWrapper = ReturnType<typeof mount<typeof CollectionManager>>;
const mounted: ManagerWrapper[] = [];

async function renderManager(state: CollectionState) {
  const manager = mount(CollectionManager, { attachTo: document.body, props: state });
  mounted.push(manager);
  await manager.setProps({
    onChange: (change: CollectionChange) => { void manager.setProps({ requests: change.requests, nodes: change.nodes }); },
  });
  return manager;
}

function button(manager: ManagerWrapper, text: string) {
  return manager.findAll("button").find(candidate => candidate.text() === text)!;
}

function buttonContaining(manager: ManagerWrapper, text: string) {
  return manager.findAll(".tree-row").find(candidate => candidate.text().includes(text))!;
}

async function action(manager: ManagerWrapper, entry: string, label: string) {
  await manager.get(`[aria-label="Actions for ${entry}"]`).trigger("click");
  await menuItem(label).trigger("click");
}

function moveDialog() {
  return new DOMWrapper(document.querySelector<HTMLDialogElement>("dialog.move-dialog")!);
}

function menuItem(label: string) {
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    .find(candidate => candidate.textContent === label);
  if (!item) throw new Error(`Menu item “${label}” was not found.`);
  return new DOMWrapper(item);
}

function collection(): CollectionState {
  return {
    requests: { people: createRequest("List people") },
    nodes: [{ kind: "folder", id: "team", name: "Team API", children: [
      { kind: "request", id: "people", name: "Stale tree name", requestType: "POST" },
    ] }],
  };
}

function visibleRequests(manager: ManagerWrapper): string[] {
  return manager.findAll(".request-row").filter(row => row.isVisible()).map(row => row.text());
}

function searchableCollection(): CollectionState {
  return {
    requests: {
      people: { ...createRequest("List people"), path: "https://api.example.test/people" },
      update: { ...createRequest("Update person"), method: "PUT", path: "https://api.example.test/people/42" },
      health: { ...createRequest("Health"), path: "https://service.test/health" },
    },
    nodes: [
      { kind: "folder", id: "team", name: "Team API", children: [
        { kind: "request", id: "people", name: "Stale name", requestType: "POST" },
        { kind: "folder", id: "writes", name: "Writes", children: [
          { kind: "request", id: "update", name: "Stale update", requestType: "POST" },
        ] },
      ] },
      { kind: "request", id: "health", name: "Health", requestType: "GET" },
    ],
  };
}
