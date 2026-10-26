// Runtime validation protects WorkspaceData and portable collections before they enter application state.
import type { CollectionNode } from "./components/collectionTree";
import { isBodyDocument } from "./bodyDocument";
import type { HistoryEntry, RequestData } from "./request";
import type { WorkspaceData } from "./workspace";

/** Validates a versioned workspace and its references, throwing a path-specific error on malformed data. */
export function parseWorkspace(value: unknown): WorkspaceData {
  const workspace = record(value, "workspace");
  if (workspace.version !== 1) fail("workspace.version", "unsupported version; expected 1");
  validateProtobufSources(workspace.protobufSources, "protobufSources");
  validateRequestsAndCollection(workspace.requests, workspace.collection);

  const requests = record(workspace.requests, "requests");
  const environmentIds = new Set<string>();
  for (const [index, item] of array(workspace.environments, "environments").entries()) {
    const path = `environments[${index}]`;
    const environment = record(item, path);
    const id = identity(environment.id, `${path}.id`);
    unique(environmentIds, id, `${path}.id`);
    string(environment.name, `${path}.name`);
    keyValues(environment.variables, `${path}.variables`);
  }
  optionalReference(workspace.activeEnvironmentId, environmentIds, "activeEnvironmentId");

  const historyIds = new Set<string>();
  for (const [index, item] of array(workspace.history, "history").entries()) {
    const path = `history[${index}]`;
    const entry = parseHistoryEntry(item, path);
    unique(historyIds, entry.id, `${path}.id`);
  }

  // These additive fields were absent in the first version-1 document. Normalize
  // only their absence; malformed recovery data must never be silently discarded.
  const drafts = record(workspace.drafts === undefined ? {} : workspace.drafts, "drafts");
  for (const [id, value] of Object.entries(drafts)) {
    identity(id, "draft identity");
    if (Object.prototype.hasOwnProperty.call(requests, id)) fail(`drafts.${id}`, "identity conflicts with a saved request");
    const draft = record(value, `drafts.${id}`);
    requestDefinition(draft.request, `drafts.${id}.request`);
    if (draft.capturedRequest !== undefined) httpRequest(draft.capturedRequest, `drafts.${id}.capturedRequest`);
    if (draft.layout !== undefined) splitSizes(draft.layout, `drafts.${id}.layout`);
  }

  const openIds = new Set<string>();
  for (const [index, value] of array(workspace.openTabIds, "openTabIds").entries()) {
    const id = identity(value, `openTabIds[${index}]`);
    if (!Object.prototype.hasOwnProperty.call(requests, id) && !Object.prototype.hasOwnProperty.call(drafts, id)) {
      fail(`openTabIds[${index}]`, "references a missing request or draft");
    }
    unique(openIds, id, `openTabIds[${index}]`);
  }
  optionalReference(workspace.activeTabId, openIds, "activeTabId");
  if (openIds.size > 0 && workspace.activeTabId === null) fail("activeTabId", "an open workspace must select a tab");

  const closedIds = new Set<string>();
  const closedDraftIds = array(workspace.closedDraftIds === undefined ? [] : workspace.closedDraftIds, "closedDraftIds");
  for (const [index, value] of closedDraftIds.entries()) {
    const id = identity(value, `closedDraftIds[${index}]`);
    if (!Object.prototype.hasOwnProperty.call(drafts, id)) fail(`closedDraftIds[${index}]`, "references a missing draft");
    if (openIds.has(id)) fail(`closedDraftIds[${index}]`, "a closed draft cannot also be open");
    unique(closedIds, id, `closedDraftIds[${index}]`);
  }
  for (const id of Object.keys(drafts)) {
    if (!openIds.has(id) && !closedIds.has(id)) fail(`drafts.${id}`, "must be open or recoverable");
  }

  const layout = record(workspace.layout, "layout");
  if (layout.sidebar !== undefined) splitSizes(layout.sidebar, "layout.sidebar");
  for (const [id, sizes] of Object.entries(record(layout.requests, "layout.requests"))) {
    identity(id, "layout.requests identity");
    splitSizes(sizes, `layout.requests.${id}`);
  }
  if (workspace.drafts === undefined || workspace.closedDraftIds === undefined) {
    return { ...workspace, drafts, closedDraftIds } as unknown as WorkspaceData;
  }
  return value as WorkspaceData;
}

/** Validates one independent execution capture without revalidating unrelated workspace definitions. */
export function parseHistoryEntry(value: unknown, path = "history entry"): HistoryEntry {
  const entry = record(value, path);
  identity(entry.id, `${path}.id`);
  identity(entry.requestId, `${path}.requestId`);
  string(entry.name, `${path}.name`);
  string(entry.startedAt, `${path}.startedAt`);
  if (!Number.isFinite(Date.parse(entry.startedAt))) fail(`${path}.startedAt`, "expected a timestamp");
  httpRequest(entry.request, `${path}.request`);
  historyResult(entry.result, `${path}.result`);
  return value as HistoryEntry;
}

/** Shared portable-collection contract; drafts may retain incomplete URLs while references stay valid. */
export function validateRequestsAndCollection(
  requestValues: unknown,
  collectionValues: unknown,
): asserts requestValues is Record<string, RequestData> {
  const requests = record(requestValues, "requests");
  for (const [id, value] of Object.entries(requests)) {
    identity(id, "request identity");
    requestDefinition(value, `requests.${id}`);
  }

  const ids = new Set<string>();
  const referenced = new Set<string>();
  function visit(values: unknown, path: string, depth: number) {
    if (depth > 100) fail(path, "folder nesting exceeds 100 levels");
    for (const [index, value] of array(values, path).entries()) {
      const itemPath = `${path}[${index}]`;
      const node = record(value, itemPath);
      const id = identity(node.id, `${itemPath}.id`);
      unique(ids, id, `${itemPath}.id`);
      string(node.name, `${itemPath}.name`);
      if (node.kind === "folder") {
        if (Object.prototype.hasOwnProperty.call(requests, id)) fail(`${itemPath}.id`, "folder identity conflicts with a request");
        visit(node.children, `${itemPath}.children`, depth + 1);
      } else if (node.kind === "request") {
        string(node.requestType, `${itemPath}.requestType`);
        if (!Object.prototype.hasOwnProperty.call(requests, id)) fail(`${itemPath}.id`, "references a missing request");
        referenced.add(id);
      } else {
        fail(`${itemPath}.kind`, "expected folder or request");
      }
    }
  }
  visit(collectionValues, "collection", 0);
  for (const id of Object.keys(requests)) {
    if (!referenced.has(id)) fail(`requests.${id}`, "has no collection reference");
  }
}

/** Parses the shared collection payload after validating both definitions and hierarchy. */
export function parseCollection(value: unknown): { requests: Record<string, RequestData>; collection: readonly CollectionNode[]; protobufSources?: import("./protobuf").ProtobufSource[] } {
  const collection = record(value, "collection document");
  validateRequestsAndCollection(collection.requests, collection.collection);
  validateProtobufSources(collection.protobufSources, "protobufSources");
  return { requests: collection.requests, collection: collection.collection as CollectionNode[], ...(collection.protobufSources === undefined ? {} : { protobufSources: collection.protobufSources as import("./protobuf").ProtobufSource[] }) };
}

function requestDefinition(value: unknown, path: string) {
  const request = record(value, path);
  if (request.inputMode !== undefined && request.inputMode !== "template" && request.inputMode !== "literal") {
    fail(`${path}.inputMode`, "expected template or literal");
  }
  if (request.protobuf !== undefined) {
    const binding = record(request.protobuf, `${path}.protobuf`);
    identity(binding.sourceId, `${path}.protobuf.sourceId`);
    string(binding.messageName, `${path}.protobuf.messageName`);
  }
  for (const key of ["name", "method", "path", "contentType"]) string(request[key], `${path}.${key}`);
  // Live definitions may hold an immutable editor revision. Portable imports and
  // persisted records still arrive as strings; arbitrary body-shaped objects fail.
  if (!isBodyDocument(request.body)) string(request.body, `${path}.body`);
  keyValues(request.headers, `${path}.headers`);
  keyValues(request.query, `${path}.query`);
  positive(request.timeoutMs, `${path}.timeoutMs`);
  redirectPolicy(request.redirectPolicy, `${path}.redirectPolicy`);
  sensitiveHeaderNames(request.sensitiveHeaderNames, `${path}.sensitiveHeaderNames`);
  const auth = record(request.auth, `${path}.auth`);
  switch (auth.type) {
    case "none": return;
    case "bearer": string(auth.token, `${path}.auth.token`); return;
    case "basic":
      string(auth.username, `${path}.auth.username`);
      string(auth.password, `${path}.auth.password`);
      return;
    case "api-key":
      string(auth.name, `${path}.auth.name`);
      string(auth.value, `${path}.auth.value`);
      if (auth.location !== "header" && auth.location !== "query") fail(`${path}.auth.location`, "expected header or query");
      return;
    default: fail(`${path}.auth.type`, "unknown authentication type");
  }
}

function keyValues(value: unknown, path: string) {
  for (const [index, item] of array(value, path).entries()) {
    const entryPath = `${path}[${index}]`;
    const entry = record(item, entryPath);
    string(entry.name, `${entryPath}.name`);
    string(entry.value, `${entryPath}.value`);
    if (typeof entry.enabled !== "boolean") fail(`${entryPath}.enabled`, "expected a boolean");
  }
}

function headers(value: unknown, path: string) {
  for (const [index, item] of array(value, path).entries()) {
    const entry = record(item, `${path}[${index}]`);
    string(entry.name, `${path}[${index}].name`);
    string(entry.value, `${path}[${index}].value`);
  }
}

function httpRequest(value: unknown, path: string) {
  const request = record(value, path);
  string(request.method, `${path}.method`);
  httpUrl(request.url, `${path}.url`);
  headers(request.headers, `${path}.headers`);
  string(request.body, `${path}.body`);
  positive(request.timeoutMs, `${path}.timeoutMs`);
  redirectPolicy(request.redirectPolicy, `${path}.redirectPolicy`);
  sensitiveHeaderNames(request.sensitiveHeaderNames, `${path}.sensitiveHeaderNames`);
}

function sensitiveHeaderNames(value: unknown, path: string) {
  if (value === undefined) return;
  for (const [index, name] of array(value, path).entries()) {
    string(name, `${path}[${index}]`);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) fail(`${path}[${index}]`, "expected an HTTP header name");
  }
}

function redirectPolicy(value: unknown, path: string) {
  if (value !== undefined && !["never", "same-origin", "follow"].includes(String(value))) {
    fail(path, "expected never, same-origin, or follow");
  }
}

function historyResult(value: unknown, path: string) {
  const result = record(value, path);
  if (result.status === "cancelled") return;
  if (result.status === "error") {
    string(result.error, `${path}.error`);
    return;
  }
  if (result.status !== "success") fail(`${path}.status`, "history requires a completed result");

  const response = record(result.response, `${path}.response`);
  httpUrl(response.url, `${path}.response.url`);
  if (!Number.isInteger(response.status) || (response.status as number) < 100 || (response.status as number) > 999) {
    fail(`${path}.response.status`, "expected an HTTP status between 100 and 999");
  }
  string(response.statusText, `${path}.response.statusText`);
  headers(response.headers, `${path}.response.headers`);
  string(response.body, `${path}.response.body`);
  nonnegative(response.durationMs, `${path}.response.durationMs`);
  nonnegative(response.sizeBytes, `${path}.response.sizeBytes`);
}

function splitSizes(value: unknown, path: string) {
  const sizes = record(value, path);
  for (const direction of ["horizontal", "vertical"]) {
    const size = sizes[direction];
    if (typeof size === "number" && Number.isFinite(size) && size >= 0) continue;
    if (typeof size === "string" && /^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(size)
      && Number.isFinite(parseFloat(size)) && parseFloat(size) <= 100) continue;
    fail(`${path}.${direction}`, "expected nonnegative pixels or a percentage from 0% to 100%");
  }
}

function optionalReference(value: unknown, ids: Set<string>, path: string) {
  if (value === null) return;
  const id = identity(value, path);
  if (!ids.has(id)) fail(path, "references a missing identity");
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") fail(path, "expected text");
}

function identity(value: unknown, path: string): string {
  string(value, path);
  if (!value || ["__proto__", "constructor", "prototype"].includes(value)) fail(path, "expected a safe, nonempty identity");
  return value;
}

function unique(ids: Set<string>, id: string, path: string) {
  if (ids.has(id)) fail(path, "duplicate identity");
  ids.add(id);
}

function nonnegative(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(path, "expected a finite nonnegative number");
}

function positive(value: unknown, path: string) {
  nonnegative(value, path);
  if (value === 0) fail(path, "expected a positive number");
}

function httpUrl(value: unknown, path: string) {
  string(value, path);
  try {
    if (!["http:", "https:"].includes(new URL(value).protocol)) throw new Error();
  } catch {
    fail(path, "expected an absolute HTTP(S) URL");
  }
}

function fail(path: string, reason: string): never {
  throw new Error(`Invalid ${path}: ${reason}.`);
}

function validateProtobufSources(value: unknown, path: string) {
  if (value === undefined) return;
  const ids = new Set<string>();
  for (const [index, item] of array(value, path).entries()) {
    const source = record(item, `${path}[${index}]`);
    unique(ids, identity(source.id, `${path}[${index}].id`), path);
    string(source.name, `${path}[${index}].name`);
    if (source.rootPath !== null) string(source.rootPath, `${path}[${index}].rootPath`);
    for (const include of array(source.includePaths, `${path}[${index}].includePaths`)) string(include, path);
  }
}
