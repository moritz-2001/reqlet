// Verifies collection operations through their immutable public contract and stable identities.
import { expect, it } from "vitest";
import {
  collectionFolders, collectionSiblingPlacement, createCollectionNode, deleteCollectionNode, duplicateCollectionNode,
  findCollectionNode, moveCollectionNode, renameCollectionNode, restoreCollectionEdit, restoreCollectionNode,
  type CollectionEditRecovery, type CollectionState,
} from "../src/collections";
import { createRequest } from "../src/request";

it("creates folders and requests in display order without modifying the supplied collection", () => {
  const empty: CollectionState = { requests: {}, nodes: [] };
  const folder = createCollectionNode(empty, "folder", "  Team API  ", null, () => "folder");
  const request = createCollectionNode(folder, "request", "List people", "folder", () => "people");

  expect(empty).toEqual({ requests: {}, nodes: [] });
  expect(folder.nodes).toEqual([{ kind: "folder", id: "folder", name: "Team API", children: [] }]);
  expect(request.requests.people).toEqual(createRequest("List people"));
  expect(findCollectionNode(request.nodes, "people")).toMatchObject({ kind: "request", id: "people", name: "List people" });
  expect(request.selectedId).toBe("people");
  expect(request.deletedRequestIds).toEqual([]);
  expect(folder.requests).toEqual({});
});

it("renames canonical requests and folders while keeping their stable IDs and content", () => {
  const state = collection();
  const request = renameCollectionNode(state, "people", "All people");
  const folder = renameCollectionNode(request, "team", "Account API");

  expect(request.requests.people).toEqual({ ...state.requests.people, name: "All people" });
  expect(findCollectionNode(folder.nodes, "people")).toMatchObject({ id: "people", name: "All people" });
  expect(findCollectionNode(folder.nodes, "team")).toMatchObject({ id: "team", name: "Account API" });
  expect(state.requests.people.name).toBe("List people");
  expect(findCollectionNode(state.nodes, "team")?.name).toBe("Team API");
});

it("duplicates complete nested folders with fresh identities and independently editable request fields", () => {
  const state = collection();
  state.requests.people = {
    ...state.requests.people, name: "Name edited outside the tree", method: "PATCH",
    headers: [{ name: "X-Tag", value: "one", enabled: true }],
    query: [{ name: "tag", value: "two", enabled: false }],
    auth: { type: "bearer", token: "secret" },
  };
  const ids = ["team-copy", "people-copy", "nested-copy", "invite-copy"];
  const copy = duplicateCollectionNode(state, "team", "Team API copy", null, () => ids.shift()!);

  expect(collectionFolders(copy.nodes).map(folder => folder.path)).toEqual([
    "Team API", "Team API / Members", "Empty", "Team API copy", "Team API copy / Members",
  ]);
  expect(copy.selectedId).toBe("team-copy");
  expect(findCollectionNode(copy.nodes, "people-copy")).toMatchObject({
    id: "people-copy", name: "Name edited outside the tree", requestType: "PATCH",
  });
  expect(copy.requests["people-copy"]).toEqual(state.requests.people);
  expect(copy.requests["invite-copy"]).toEqual(state.requests.invite);
  copy.requests["people-copy"].headers[0].value = "changed";
  copy.requests["people-copy"].query[0].enabled = true;
  copy.requests["people-copy"].auth = { type: "none" };
  expect(state.requests.people.headers[0].value).toBe("one");
  expect(state.requests.people.query[0].enabled).toBe(false);
  expect(state.requests.people.auth).toEqual({ type: "bearer", token: "secret" });
  expect(state.nodes).toHaveLength(2);
});

it("moves requests and whole folders without changing IDs or losing content", () => {
  const state = freeze(collection());
  const request = moveCollectionNode(state, "people", { parentId: "empty", beforeId: null });
  const folder = moveCollectionNode(request, "nested", { parentId: null, beforeId: null });
  const rootRequest = moveCollectionNode(folder, "people", { parentId: null, beforeId: null });

  expect(findCollectionNode(request.nodes, "empty")).toMatchObject({ children: [{ id: "people" }] });
  expect(findCollectionNode(folder.nodes, "team")).toMatchObject({ children: [] });
  expect(folder.nodes.at(-1)).toMatchObject({ id: "nested", children: [{ id: "invite" }] });
  expect(rootRequest.nodes.at(-1)).toMatchObject({ id: "people" });
  expect(rootRequest.requests).toBe(state.requests);
  expect(findCollectionNode(folder.nodes, "nested")).toBe(findCollectionNode(state.nodes, "nested"));
  expect(findCollectionNode(state.nodes, "team")).toMatchObject({ children: [{ id: "people" }, { id: "nested" }] });
  expect(moveCollectionNode(state, "empty", { parentId: null, beforeId: null }).nodes).toBe(state.nodes);
});

it("places mixed siblings precisely before the first entry, in the middle, and at the end", () => {
  const state = freeze(createCollectionNode(collection(), "request", "Root request", null, () => "root"));
  const first = moveCollectionNode(state, "root", { parentId: null, beforeId: "team" });
  const middle = moveCollectionNode(first, "empty", { parentId: null, beforeId: "team" });
  const last = moveCollectionNode(middle, "root", { parentId: null, beforeId: null });

  expect(first.nodes.map(node => node.id)).toEqual(["root", "team", "empty"]);
  expect(middle.nodes.map(node => node.id)).toEqual(["root", "empty", "team"]);
  expect(last.nodes.map(node => node.id)).toEqual(["empty", "team", "root"]);
  expect(state.nodes.map(node => node.id)).toEqual(["team", "empty", "root"]);
  expect(last.requests).toBe(state.requests);
  expect(first.recovery).toEqual({ kind: "move", id: "root", parentId: null, siblingIds: ["team", "empty", "root"] });
});

it("removes a source from its old ancestor before inserting it beside that ancestor", () => {
  const state = freeze(collection());
  const root = moveCollectionNode(state, "nested", { parentId: null, beforeId: "empty" });
  const intoAncestor = moveCollectionNode(root, "invite", { parentId: "team", beforeId: "people" });

  expect(root.nodes.map(node => node.id)).toEqual(["team", "nested", "empty"]);
  expect(findCollectionNode(root.nodes, "team")).toMatchObject({ children: [{ id: "people" }] });
  expect(findCollectionNode(intoAncestor.nodes, "team")).toMatchObject({ children: [{ id: "invite" }, { id: "people" }] });
  expect(findCollectionNode(intoAncestor.nodes, "nested")).toMatchObject({ children: [] });
  expect(intoAncestor.requests.invite).toBe(state.requests.invite);
});

it("keeps state references and omits recovery for unchanged placements and canonical trimmed names", () => {
  const state = freeze(collection());
  const results = [
    moveCollectionNode(state, "people", { parentId: "team", beforeId: "people" }),
    moveCollectionNode(state, "people", { parentId: "team", beforeId: "nested" }),
    moveCollectionNode(state, "nested", { parentId: "team", beforeId: null }),
    renameCollectionNode(state, "people", "  List people  "),
    renameCollectionNode(state, "team", "  Team API  "),
  ];

  for (const result of results) {
    expect(result.nodes).toBe(state.nodes);
    expect(result.requests).toBe(state.requests);
    expect(result.recovery).toBeUndefined();
  }

  const editedOutsideTree = { ...state, requests: { ...state.requests, people: { ...state.requests.people, name: "Canonical name" } } };
  const unchanged = renameCollectionNode(editedOutsideTree, "people", " Canonical name ");
  expect(unchanged.nodes).toBe(editedOutsideTree.nodes);
  expect(unchanged.requests).toBe(editedOutsideTree.requests);
});

it("resolves one-step sibling placement while recognizing boundaries and missing identities", () => {
  const state = createCollectionNode(collection(), "request", "Third entry", "team", () => "third");

  expect(collectionSiblingPlacement(state.nodes, "people", -1)).toBeNull();
  expect(collectionSiblingPlacement(state.nodes, "third", 1)).toBeNull();
  expect(collectionSiblingPlacement(state.nodes, "missing", 1)).toBeNull();
  expect(collectionSiblingPlacement(state.nodes, "nested", -1)).toEqual({ parentId: "team", beforeId: "people" });
  expect(collectionSiblingPlacement(state.nodes, "people", 1)).toEqual({ parentId: "team", beforeId: "third" });
  expect(collectionSiblingPlacement(state.nodes, "nested", 1)).toEqual({ parentId: "team", beforeId: null });
  expect(collectionSiblingPlacement(state.nodes, "empty", -1)).toEqual({ parentId: null, beforeId: "team" });

  const moved = moveCollectionNode(state, "people", collectionSiblingPlacement(state.nodes, "people", 1)!);
  expect(findCollectionNode(moved.nodes, "team")).toMatchObject({ children: [{ id: "nested" }, { id: "people" }, { id: "third" }] });
});

it("rejects cycles, unknown destinations, request parents, empty names, and identity collisions", () => {
  const state = collection();
  expect(() => moveCollectionNode(state, "team", { parentId: "team", beforeId: null })).toThrow(/itself/);
  expect(() => moveCollectionNode(state, "team", { parentId: "nested", beforeId: null })).toThrow(/descendants/);
  expect(() => moveCollectionNode(state, "people", { parentId: "missing", beforeId: null })).toThrow(/no longer exists/);
  expect(() => moveCollectionNode(state, "missing", { parentId: null, beforeId: null })).toThrow(/no longer exists/);
  expect(() => moveCollectionNode(state, "people", { parentId: "invite", beforeId: null })).toThrow(/folder/);
  expect(() => moveCollectionNode(state, "people", { parentId: "empty", beforeId: "people" })).toThrow(/insertion point/);
  expect(() => moveCollectionNode(state, "people", { parentId: "team", beforeId: "invite" })).toThrow(/insertion point/);
  expect(() => moveCollectionNode(state, "people", { parentId: null, beforeId: "missing" })).toThrow(/insertion point/);
  expect(() => createCollectionNode(state, "request", "New", "people")).toThrow(/folder/);
  expect(() => renameCollectionNode(state, "people", "  ")).toThrow(/name/);
  expect(() => duplicateCollectionNode(state, "people", "Copy", null, () => "team")).toThrow(/unique/);
  expect(() => createCollectionNode(state, "folder", "New", null, () => "people")).toThrow(/unique/);
  expect(findCollectionNode(state.nodes, "team")).toMatchObject({ children: [{ id: "people" }, { id: "nested" }] });
});

it("undoes a canonical rename while preserving later request edits and unrelated changes", () => {
  const state = collection();
  state.requests.people.name = "Canonical previous name";
  const renamed = renameCollectionNode(freeze(state), "people", "  Current name  ");
  const later = createCollectionNode(renamed, "folder", "Later folder", null, () => "later");
  const edited = { ...later, requests: { ...later.requests, people: { ...later.requests.people, body: "later body" } } };
  const restored = restoreCollectionEdit(freeze(edited), renamed.recovery!);

  expect(renamed.recovery).toEqual({ kind: "rename", id: "people", previousName: "Canonical previous name", name: "Current name" });
  expect(restored.requests.people).toEqual({ ...edited.requests.people, name: "Canonical previous name" });
  expect(findCollectionNode(restored.nodes, "people")).toMatchObject({ name: "Canonical previous name" });
  expect(findCollectionNode(restored.nodes, "later")).toBeDefined();
  expect(restored.recovery).toBeUndefined();
  expect(renamed.requests.people.name).toBe("Current name");
});

it("undoes a folder rename and rejects stale or deleted rename targets", () => {
  const renamed = renameCollectionNode(collection(), "team", "Accounts");
  const restored = restoreCollectionEdit(renamed, renamed.recovery!);
  const renamedAgain = renameCollectionNode(renamed, "team", "Newer name");

  expect(findCollectionNode(restored.nodes, "team")?.name).toBe("Team API");
  expect(restored.requests).toBe(renamed.requests);
  expect(restored.recovery).toBeUndefined();
  expect(() => restoreCollectionEdit(renamedAgain, renamed.recovery!)).toThrow(/renamed again/);
  expect(() => restoreCollectionEdit(deleteCollectionNode(renamed, "team"), renamed.recovery!)).toThrow(/no longer exists/);
  expect(findCollectionNode(renamedAgain.nodes, "team")?.name).toBe("Newer name");
});

it("undoes movement using surviving original neighbors and preserves later data edits", () => {
  const state = createCollectionNode(collection(), "request", "Third entry", "team", () => "third");
  const moved = moveCollectionNode(state, "nested", { parentId: "empty", beforeId: null });
  const edited = renameCollectionNode(moved, "invite", "Edited after movement");
  const added = createCollectionNode(edited, "request", "New entry", "team", () => "new");
  const restored = restoreCollectionEdit(freeze(added), moved.recovery!);

  expect(moved.recovery).toEqual({ kind: "move", id: "nested", parentId: "team", siblingIds: ["people", "nested", "third"] });
  expect(findCollectionNode(restored.nodes, "team")).toMatchObject({
    children: [{ id: "people" }, { id: "nested" }, { id: "third" }, { id: "new" }],
  });
  expect(restored.requests.invite.name).toBe("Edited after movement");
  expect(restored.requests).toBe(added.requests);
  expect(restored.recovery).toBeUndefined();

  const nextRemoved = deleteCollectionNode(added, "third");
  const restoredAfterPrevious = restoreCollectionEdit(nextRemoved, moved.recovery!);
  expect(findCollectionNode(restoredAfterPrevious.nodes, "team")).toMatchObject({
    children: [{ id: "people" }, { id: "nested" }, { id: "new" }],
  });

  const allNeighborsRemoved = deleteCollectionNode(nextRemoved, "people");
  const restoredAtEnd = restoreCollectionEdit(allNeighborsRemoved, moved.recovery!);
  expect(findCollectionNode(restoredAtEnd.nodes, "team")).toMatchObject({ children: [{ id: "new" }, { id: "nested" }] });
});

it("undoes sibling movement and root movement without restoring an old collection snapshot", () => {
  const state = collection();
  const reordered = moveCollectionNode(state, "empty", { parentId: null, beforeId: "team" });
  const added = createCollectionNode(reordered, "folder", "New root folder", null, () => "new");
  const restored = restoreCollectionEdit(added, reordered.recovery!);

  expect(restored.nodes.map(node => node.id)).toEqual(["team", "empty", "new"]);

  const nested = moveCollectionNode(added, "team", { parentId: "empty", beforeId: null });
  const rootRestored = restoreCollectionEdit(nested, nested.recovery!);
  expect(rootRestored.nodes.map(node => node.id)).toEqual(["empty", "team", "new"]);
  expect(findCollectionNode(rootRestored.nodes, "empty")).toMatchObject({ children: [] });
});

it("rejects unavailable move recovery when a parent disappears or recovery would create a cycle", () => {
  const moved = moveCollectionNode(collection(), "nested", { parentId: "empty", beforeId: null });
  const parentRemoved = deleteCollectionNode(moved, "team");
  const cyclic = moveCollectionNode(moved, "team", { parentId: "nested", beforeId: null });
  const targetRemoved = deleteCollectionNode(moved, "nested");
  const recovery: CollectionEditRecovery = moved.recovery!;

  expect(() => restoreCollectionEdit(freeze(parentRemoved), recovery)).toThrow(/no longer exists/);
  expect(() => restoreCollectionEdit(freeze(cyclic), recovery)).toThrow(/descendants/);
  expect(() => restoreCollectionEdit(freeze(targetRemoved), recovery)).toThrow(/no longer exists/);
  expect(findCollectionNode(parentRemoved.nodes, "empty")).toMatchObject({ children: [{ id: "nested" }] });
  expect(findCollectionNode(cyclic.nodes, "nested")).toMatchObject({ children: [{ id: "invite" }, { id: "team" }] });
});

it("deletes a folder subtree and reports every removed request for its owner's cleanup", () => {
  const state = collection();
  const result = deleteCollectionNode(state, "team");
  expect(result.nodes).toEqual([{ kind: "folder", id: "empty", name: "Empty", children: [] }]);
  expect(result.requests).toEqual({});
  expect(result.deletedRequestIds).toEqual(["people", "invite"]);
  expect(result.selectedId).toBeNull();
  expect(Object.keys(state.requests)).toEqual(["people", "invite"]);
  expect(deleteCollectionNode(state, "empty").deletedRequestIds).toEqual([]);

  const single = deleteCollectionNode(state, "invite");
  expect(single.deletedRequestIds).toEqual(["invite"]);
  expect(Object.keys(single.requests)).toEqual(["people"]);
  expect(findCollectionNode(single.nodes, "nested")).toMatchObject({ children: [] });
});

it("undoes a nested subtree deletion with stable identities while retaining later edits and original sibling position", () => {
  const state = collection();
  const deleted = deleteCollectionNode(state, "nested");
  const edited = renameCollectionNode(deleted, "people", "People edited after deletion");
  const added = createCollectionNode(edited, "request", "New sibling", "team", () => "new");
  const restored = restoreCollectionNode(added, deleted.deletion!);

  expect(findCollectionNode(restored.nodes, "team")).toMatchObject({ children: [{ id: "people" }, { id: "nested" }, { id: "new" }] });
  expect(restored.requests.people.name).toBe("People edited after deletion");
  expect(restored.requests.new.name).toBe("New sibling");
  expect(restored.requests.invite).toEqual(state.requests.invite);
  expect(findCollectionNode(restored.nodes, "nested")).toEqual(findCollectionNode(state.nodes, "nested"));
  expect(findCollectionNode(deleted.nodes, "nested")).toBeUndefined();
});

it("keeps recovery snapshots independent and restores at root if the containing folder disappeared", () => {
  const state = collection();
  state.requests.invite.auth = { type: "bearer", token: "kept" };
  const deleted = deleteCollectionNode(state, "nested");
  state.requests.invite.auth.token = "detached mutation";
  const parentDeleted = deleteCollectionNode(deleted, "team");
  const restored = restoreCollectionNode(parentDeleted, deleted.deletion!);

  expect(restored.nodes.map(node => node.id)).toContain("nested");
  expect(restored.requests.invite.auth).toEqual({ type: "bearer", token: "kept" });
  restored.requests.invite.name = "Changed after Undo";
  expect(deleted.deletion!.requests.invite.name).toBe("Invite member");
});

it("refuses recovery when any recovered identity is reused without overwriting newer content", () => {
  const deleted = deleteCollectionNode(collection(), "team");
  const replacement = createCollectionNode(deleted, "request", "Replacement", null, () => "invite");
  expect(() => restoreCollectionNode(replacement, deleted.deletion!)).toThrow(/already in use/);
  expect(replacement.requests.invite.name).toBe("Replacement");
  expect(findCollectionNode(replacement.nodes, "team")).toBeUndefined();

  const folderCollision = createCollectionNode(deleted, "folder", "Replacement folder", null, () => "nested");
  expect(() => restoreCollectionNode(folderCollision, deleted.deletion!)).toThrow(/already in use/);
  expect(folderCollision.requests).toEqual({});
});

function collection(): CollectionState {
  return {
    requests: { people: createRequest("List people"), invite: createRequest("Invite member") },
    nodes: [
      { kind: "folder", id: "team", name: "Team API", children: [
        { kind: "request", id: "people", name: "List people", requestType: "GET" },
        { kind: "folder", id: "nested", name: "Members", children: [
          { kind: "request", id: "invite", name: "Invite member", requestType: "POST" },
        ] },
      ] },
      { kind: "folder", id: "empty", name: "Empty", children: [] },
    ],
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
