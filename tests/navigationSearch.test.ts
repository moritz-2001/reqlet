// Verifies shared saved-request metadata and matching behavior through the public navigation boundary.
import { expect, it } from "vitest";
import { filterCollectionRequests, indexCollectionRequests, searchCollectionRequests } from "../src/navigationSearch";
import { createRequest } from "../src/request";
import type { CollectionState } from "../src/collections";

it("indexes canonical request metadata and ancestor paths in tree order", () => {
  const { nodes, requests } = collection();
  expect(indexCollectionRequests(nodes, requests)).toMatchObject([
    { id: "people", name: "List people", method: "GET", url: "{{baseUrl}}/users", folderPath: "Team API" },
    { id: "create", name: "Create person", method: "POST", url: "{{baseUrl}}/users", folderPath: "Team API / Administration" },
    { id: "health", name: "Health check", method: "PROPFIND", url: "https://service.test/health", folderPath: "" },
  ]);
  expect(indexCollectionRequests(nodes, requests).map(entry => entry.ancestorFolderIds))
    .toEqual([["team"], ["team", "admin"], []]);
});

it("matches every case-insensitive query word across name, URL, method, and ancestor folders", () => {
  const { nodes, requests } = collection();
  expect(searchCollectionRequests(nodes, requests, "  TEAM\nPOST\tuser  ")).toEqual(["create"]);
  expect(searchCollectionRequests(nodes, requests, "crea ADMIN baseurl")).toEqual(["create"]);
  expect(searchCollectionRequests(nodes, requests, "PFIND HEALTH")).toEqual(["health"]);
  expect(searchCollectionRequests(nodes, requests, "team health")).toEqual([]);
  expect(searchCollectionRequests(nodes, requests, "stale")).toEqual([]);
});

it("returns all saved requests for an empty query without changing tree order or source data", () => {
  const { nodes, requests } = collection();
  const before = JSON.stringify({ nodes, requests });
  expect(searchCollectionRequests(nodes, requests, " \n\t")).toEqual(["people", "create", "health"]);
  expect(searchCollectionRequests(nodes, requests, "user")).toEqual(["people", "create"]);
  expect(JSON.stringify({ nodes, requests })).toBe(before);
});

it("shares matching with pre-indexed navigation and omits missing definitions", () => {
  const { nodes, requests } = collection();
  const entries = indexCollectionRequests(nodes, requests);
  expect(filterCollectionRequests(entries, "team user").map(entry => entry.id))
    .toEqual(searchCollectionRequests(nodes, requests, "team user"));
  expect(entries).toHaveLength(3);
  expect(indexCollectionRequests(nodes, { health: requests.health }).map(entry => entry.id)).toEqual(["health"]);
  expect(searchCollectionRequests(nodes, { health: requests.health }, "people")).toEqual([]);
});

function collection(): CollectionState {
  return {
    requests: {
      health: { ...createRequest("Health check"), method: "PROPFIND", path: "https://service.test/health" },
      create: { ...createRequest("Create person"), method: "POST", path: "{{baseUrl}}/users" },
      people: { ...createRequest("List people"), path: "{{baseUrl}}/users" },
    },
    nodes: [
      { kind: "folder", id: "team", name: "Team API", children: [
        { kind: "request", id: "people", name: "Stale people", requestType: "DELETE" },
        { kind: "folder", id: "admin", name: "Administration", children: [
          { kind: "request", id: "create", name: "Stale create", requestType: "DELETE" },
        ] },
      ] },
      { kind: "request", id: "health", name: "Stale health", requestType: "DELETE" },
      { kind: "request", id: "missing", name: "Orphan", requestType: "GET" },
    ],
  };
}
