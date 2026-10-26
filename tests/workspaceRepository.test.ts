// Verifies durable workspace/capture ownership, migration, quota recovery, and queued-save ordering.
import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { BodyDocument, bodyEditorText } from "../src/bodyDocument";
import { appendHistory, HISTORY_BYTE_LIMIT, historyForStorage } from "../src/history";
import type { HistoryEntry } from "../src/request";
import { createWorkspace, WORKSPACE_STORAGE_KEY, type WorkspaceData, type WorkspaceStorage } from "../src/workspace";
import { createIndexedDbWorkspaceStorage, createWorkspaceRepository, WorkspaceCommitConflict, type WorkspaceRecordChanges, type WorkspaceRepositoryStorage } from "../src/workspaceRepository";

it("commits and restores complete captures through the production IndexedDB adapter", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory(), "adapter-test");
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = workspaceWithHistory();
  await repository.save(workspace);
  const document = await storage.readDocument() as { workspace: WorkspaceData; historyIds: string[] };

  expect(document.workspace.history).toEqual([]);
  expect(document.workspace.requests).toEqual({});
  expect(await storage.readRequest("create-workspace")).toEqual(workspace.requests["create-workspace"]);
  expect(document.historyIds).toEqual(["capture"]);
  expect(await storage.readHistory("capture")).toEqual(workspace.history[0]);
  const reloaded = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(reloaded).toEqual({ workspace, error: null });

  workspace.history = [];
  await repository.save(workspace);
  expect(await storage.historyIds()).toEqual([]);
});

it("restores saved definitions, drafts, and captures in two readonly transactions regardless of record count", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const workspace = workspaceWithHistory();
  const request = workspace.requests["create-workspace"];
  workspace.requests = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`request-${index}`, request]));
  workspace.collection = Object.keys(workspace.requests).map(id => ({ kind: "request", id, name: request.name, requestType: request.method }));
  workspace.drafts = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`draft-${index}`, { request }]));
  workspace.closedDraftIds = Object.keys(workspace.drafts);
  workspace.history = Array.from({ length: 10 }, (_, index) => capture(`capture-${index}`, "saved response"));
  await createWorkspaceRepository(storage, legacyStorage()).save(workspace);
  const transactions = vi.spyOn(IDBDatabase.prototype, "transaction");

  try {
    expect(await createWorkspaceRepository(storage, legacyStorage()).load()).toEqual({ workspace, error: null });
    expect(transactions.mock.calls.map(([, mode]) => mode)).toEqual(["readonly", "readonly"]);
  } finally {
    transactions.mockRestore();
  }
});

it("keeps record reads on their original side of intervening writes while opening IndexedDB", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const request = createWorkspace().requests["create-workspace"];
  const before = storage.readRequest("request");
  const writing = storage.writeDocument({}, {
    requests: { request }, drafts: {}, removedRequestIds: [], removedDraftIds: [],
  });
  const after = storage.readRequest("request");

  expect(await before).toBeUndefined();
  await writing;
  expect(await after).toEqual(request);
});

it("writes only changed editable records and never reloads unchanged large bodies during autosave", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = createWorkspace();
  const largeBody = "large request ".repeat(100_000);
  workspace.requests["create-workspace"].body = largeBody;
  workspace.drafts.recovered = { request: { ...workspace.requests["invite-member"], body: largeBody } };
  workspace.closedDraftIds = ["recovered"];
  await repository.save(workspace);
  const write = vi.spyOn(storage, "writeDocument");
  const readRequest = vi.spyOn(storage, "readRequest");
  const readDraft = vi.spyOn(storage, "readDraft");

  workspace.layout.sidebar = { horizontal: 300, vertical: "20%" };
  await repository.save(workspace);
  expect(write.mock.calls.map(([, changes]) => changes)).toEqual([
    { requests: {}, drafts: {}, removedRequestIds: [], removedDraftIds: [] }, undefined,
  ]);
  write.mockClear();

  workspace.requests["create-workspace"].headers.push({ name: "x-edited", value: "nested change", enabled: true });
  workspace.drafts.recovered.request.auth = { type: "bearer", token: "changed draft" };
  await repository.save(workspace);
  expect(write.mock.calls.map(([, changes]) => changes)).toEqual([
    {
      requests: { "create-workspace": workspace.requests["create-workspace"] },
      drafts: { recovered: workspace.drafts.recovered }, removedRequestIds: [], removedDraftIds: [],
    }, undefined,
  ]);
  expect(readRequest).not.toHaveBeenCalled();
  expect(readDraft).not.toHaveBeenCalled();
  const metadata = await storage.readDocument() as { version: number; workspace: WorkspaceData };
  expect(metadata.version).toBe(2);
  expect(metadata.workspace.requests).toEqual({});
  expect(metadata.workspace.drafts).toEqual({});
  expect(JSON.stringify(metadata)).not.toContain(largeBody);
  expect(await createWorkspaceRepository(storage, legacyStorage()).load()).toEqual({ workspace, error: null });
});

it("materializes a body revision only when its edited request record is committed", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = createWorkspace();
  const body = new BodyDocument(bodyEditorText("large body ".repeat(100_000)));
  workspace.requests["create-workspace"].body = body;
  const materialize = vi.spyOn(body, "toString");
  await repository.save(workspace);
  expect(materialize).toHaveBeenCalledTimes(1);
  expect(await storage.readRequest("create-workspace")).toMatchObject({ body: body.toString() });
  materialize.mockClear();

  workspace.activeEnvironmentId = null;
  await repository.save(workspace);
  expect(materialize).not.toHaveBeenCalled();
  const revision = new BodyDocument(body.text.replace(0, 5, bodyEditorText("edited")));
  workspace.requests["create-workspace"].body = revision;
  await repository.save(workspace);
  expect(await storage.readRequest("create-workspace")).toMatchObject({ body: revision.toString() });
});

it("promotes drafts and deletes saved definitions together with their metadata", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = createWorkspace();
  workspace.drafts.promoted = { request: { ...workspace.requests["create-workspace"], name: "Promoted draft" } };
  workspace.closedDraftIds = ["promoted"];
  await repository.save(workspace);
  workspace.requests = { promoted: workspace.drafts.promoted.request };
  delete workspace.drafts.promoted;
  workspace.closedDraftIds = [];
  workspace.collection = [{ kind: "request", id: "promoted", name: "Promoted draft", requestType: "POST" }];
  await repository.save(workspace);

  expect(await storage.readDraft("promoted")).toBeUndefined();
  expect(await storage.readRequest("create-workspace")).toBeUndefined();
  expect(await storage.readRequest("promoted")).toEqual(workspace.requests.promoted);
  expect(await createWorkspaceRepository(storage, legacyStorage()).load()).toEqual({ workspace, error: null });
});

it("rolls back every editable record and metadata when one record cannot be cloned", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const workspace = createWorkspace();
  workspace.drafts.kept = { request: workspace.requests["create-workspace"] };
  workspace.closedDraftIds = ["kept"];
  await createWorkspaceRepository(storage, legacyStorage()).save(workspace);
  const document = await storage.readDocument();
  const invalidDraft = { request: workspace.requests["create-workspace"], uncloneable: () => "invalid" };
  const changes: WorkspaceRecordChanges = {
    requests: { "create-workspace": { ...workspace.requests["create-workspace"], name: "Must roll back" } },
    drafts: { invalid: invalidDraft }, removedRequestIds: [], removedDraftIds: ["kept"],
  };

  await expect(storage.writeDocument({ version: 999 }, changes)).rejects.toThrow();
  expect(await storage.readDocument()).toEqual(document);
  expect(await storage.readRequest("create-workspace")).toEqual(workspace.requests["create-workspace"]);
  expect(await storage.readDraft("kept")).toEqual(workspace.drafts.kept);
  expect(await storage.readDraft("invalid")).toBeUndefined();
});

it("preserves corrupt editable records and blocks autosave instead of silently omitting them", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const workspace = createWorkspace();
  await createWorkspaceRepository(storage, legacyStorage()).save(workspace);
  const document = await storage.readDocument();
  const corrupt = { ...workspace.requests["create-workspace"], headers: "unreadable" };
  await storage.writeDocument(document, {
    requests: { "create-workspace": corrupt as unknown as WorkspaceData["requests"][string] },
    drafts: {}, removedRequestIds: [], removedDraftIds: [],
  });
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const loaded = await repository.load();
  expect(loaded.error).toContain("preserved");
  await expect(repository.save(loaded.workspace)).rejects.toThrow("preserved");
  expect(await storage.readDocument()).toEqual(document);
  expect(await storage.readRequest("create-workspace")).toEqual(corrupt);
});

it.each(["request", "draft"] as const)("blocks autosave when a batched load encounters a missing %s record", async kind => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const workspace = workspaceWithHistory();
  workspace.drafts.recovered = { request: workspace.requests["create-workspace"] };
  workspace.closedDraftIds = ["recovered"];
  await createWorkspaceRepository(storage, legacyStorage()).save(workspace);
  const document = await storage.readDocument();
  await storage.writeDocument(document, {
    requests: {}, drafts: {},
    removedRequestIds: kind === "request" ? ["create-workspace"] : [],
    removedDraftIds: kind === "draft" ? ["recovered"] : [],
  });

  const repository = createWorkspaceRepository(storage, legacyStorage());
  const loaded = await repository.load();
  expect(loaded.error).toContain("preserved");
  await expect(repository.save(loaded.workspace)).rejects.toThrow("preserved");
  expect(await storage.readDocument()).toEqual(document);
  expect(await storage.readHistory("capture")).toEqual(workspace.history[0]);
});

it("retries outstanding record changes after an editable transaction fails", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = createWorkspace();
  await repository.save(workspace);
  const original = await storage.readRequest("create-workspace");
  workspace.requests["create-workspace"].headers.push({ name: "x-retry", value: "retained", enabled: true });
  const write = storage.writeDocument;
  let fail = true;
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if (fail) throw new Error("Temporary transaction failure");
    await write(document, changes, expectedCommitId);
  };

  await expect(repository.save(workspace)).rejects.toThrow("Temporary transaction failure");
  expect(await storage.readRequest("create-workspace")).toEqual(original);
  fail = false;
  expect(await repository.save(workspace)).toEqual({ warning: null });
  expect(await storage.readRequest("create-workspace")).toEqual(workspace.requests["create-workspace"]);
});

it("refreshes record snapshots after another repository edits bodies without changing workspace metadata", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const first = createWorkspaceRepository(storage, legacyStorage());
  const workspace = createWorkspace();
  await first.save(workspace);
  const second = createWorkspaceRepository(storage, legacyStorage());
  const otherWorkspace = (await second.load()).workspace;
  const previousMetadata = await storage.readDocument() as { commitId: string; workspace: WorkspaceData };
  otherWorkspace.requests["create-workspace"].body = "Written in another window";
  await second.save(otherWorkspace);
  const changedMetadata = await storage.readDocument() as { commitId: string; workspace: WorkspaceData };
  expect(changedMetadata.workspace).toEqual(previousMetadata.workspace);
  expect(changedMetadata.commitId).not.toBe(previousMetadata.commitId);

  // Saving the first window's complete state must also persist its body value,
  // rather than declaring success while retaining another window's body record.
  workspace.environments[0].name = "First window's final state";
  await first.save(workspace);
  expect(await createWorkspaceRepository(storage, legacyStorage()).load()).toEqual({ workspace, error: null });
});

it("rechecks record snapshots from earlier version-2 envelopes without commit identities", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const workspace = createWorkspace();
  await createWorkspaceRepository(storage, legacyStorage()).save(workspace);
  const { commitId: _commitId, ...earlier } = await storage.readDocument() as { commitId: string };
  await storage.writeDocument(earlier);
  const repository = createWorkspaceRepository(storage, legacyStorage());
  expect(await repository.load()).toEqual({ workspace, error: null });
  const other = { ...workspace.requests["create-workspace"], body: "Changed by an earlier writer" };
  await storage.writeDocument(earlier, {
    requests: { "create-workspace": other }, drafts: {}, removedRequestIds: [], removedDraftIds: [],
  });

  await repository.save(workspace);
  expect(await createWorkspaceRepository(storage, legacyStorage()).load()).toEqual({ workspace, error: null });
});

it("prevents an older history completion from overwriting a newer editable commit", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const first = createWorkspaceRepository(storage, legacyStorage());
  const workspace = (await first.load()).workspace;
  const second = createWorkspaceRepository(storage, legacyStorage());
  const otherWorkspace = (await second.load()).workspace;
  const write = storage.writeDocument;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let pause = true;
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if (pause && changes === undefined && expectedCommitId !== undefined) { pause = false; entered(); await gate; }
    await write(document, changes, expectedCommitId);
  };
  workspace.requests["create-workspace"].body = "Older committed body";
  const saving = first.save(workspace);
  await started;
  otherWorkspace.requests["create-workspace"].body = "Newer committed body";
  await second.save(otherWorkspace);
  const newerDocument = await storage.readDocument();
  release();

  expect((await saving).warning).toContain("did not finish");
  expect(await storage.readDocument()).toEqual(newerDocument);
  expect(await createWorkspaceRepository(storage, legacyStorage()).load()).toEqual({ workspace: otherWorkspace, error: null });
  // The older repository observes the newer token on its next save and refreshes
  // its record baseline before promising that its own complete state is durable.
  await first.save(workspace);
  expect(await createWorkspaceRepository(storage, legacyStorage()).load()).toEqual({ workspace, error: null });
});

it("recomputes a delta when another window commits after its baseline was read", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const first = createWorkspaceRepository(storage, legacyStorage());
  const workspace = (await first.load()).workspace;
  const second = createWorkspaceRepository(storage, legacyStorage());
  const otherWorkspace = (await second.load()).workspace;
  const write = storage.writeDocument;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let pause = true;
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if (pause && changes && expectedCommitId !== undefined) { pause = false; entered(); await gate; }
    await write(document, changes, expectedCommitId);
  };
  workspace.environments[0].name = "Final local metadata";
  const saving = first.save(workspace);
  await started;
  otherWorkspace.requests["create-workspace"].body = "Concurrent body edit";
  await second.save(otherWorkspace);
  release();

  expect(await saving).toEqual({ warning: null });
  expect(await createWorkspaceRepository(storage, legacyStorage()).load()).toEqual({ workspace, error: null });
});

it("stops retrying after repeated conflicts instead of keeping a save pending indefinitely", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = (await repository.load()).workspace;
  const write = storage.writeDocument;
  let conflicts = 0;
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if (changes && expectedCommitId !== undefined) {
      const current = await storage.readDocument() as object;
      await write({ ...current, commitId: crypto.randomUUID() });
      conflicts += 1;
    }
    await write(document, changes, expectedCommitId);
  };
  workspace.requests["create-workspace"].body = "Cannot win concurrent writes";

  await expect(repository.save(workspace)).rejects.toThrow("another window kept changing");
  expect(conflicts).toBe(3);
  expect(await storage.readRequest("create-workspace")).toEqual(createWorkspace().requests["create-workspace"]);
});

it("upgrades a version-1 database without changing its document until the first atomic record save", async () => {
  const factory = new IDBFactory();
  const databaseName = "database-upgrade-test";
  const workspace = workspaceWithHistory();
  const document = { version: 1, workspace: { ...workspace, history: [] }, historyIds: ["capture"], warning: null };
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("documents");
      request.result.createObjectStore("history");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(["documents", "history"], "readwrite");
    transaction.objectStore("documents").put(document, "workspace");
    transaction.objectStore("history").put(workspace.history[0], "capture");
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();

  const storage = createIndexedDbWorkspaceStorage(factory, databaseName);
  const repository = createWorkspaceRepository(storage, legacyStorage());
  expect(await repository.load()).toEqual({ workspace, error: null });
  expect(await storage.readDocument()).toEqual(document);
  expect(await repository.save(workspace)).toEqual({ warning: null });
  expect(await storage.readDocument()).toMatchObject({ version: 2, requestIds: Object.keys(workspace.requests) });
  expect(await createWorkspaceRepository(storage, legacyStorage()).load()).toEqual({ workspace, error: null });
});

it("migrates legacy data without rewriting its source bytes and prefers the new store thereafter", async () => {
  const workspace = workspaceWithHistory();
  const source = JSON.stringify(workspace);
  const legacy = legacyStorage(source);
  const storage = memoryStorage();
  const repository = createWorkspaceRepository(storage, legacy);
  expect(await repository.load()).toEqual({ workspace, error: null });
  expect(legacy.getItem(WORKSPACE_STORAGE_KEY)).toBe(source);

  workspace.requests["create-workspace"].name = "Migrated edit";
  await repository.save(workspace);
  expect(legacy.getItem(WORKSPACE_STORAGE_KEY)).toBe(source);
  const reloaded = await createWorkspaceRepository(storage, legacy).load();
  expect(reloaded.workspace.requests["create-workspace"].name).toBe("Migrated edit");
});

it("normalizes earlier version-1 IndexedDB documents before restoring open requests and saving drafts", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory(), "earlier-workspace-test");
  const workspace = workspaceWithHistory();
  workspace.openTabIds = ["create-workspace"];
  workspace.activeTabId = "create-workspace";
  const { drafts: _drafts, closedDraftIds: _closed, ...earlier } = { ...workspace, history: [] };
  const document = { version: 1, workspace: earlier, historyIds: ["capture"], warning: null };
  await storage.writeDocument(document);
  await storage.writeHistory("capture", workspace.history[0]);

  const repository = createWorkspaceRepository(storage, legacyStorage());
  const restored = await repository.load();
  expect(restored).toEqual({ workspace, error: null });
  expect(restored.workspace.drafts).toEqual({});
  expect(restored.workspace.closedDraftIds).toEqual([]);
  expect(await storage.readDocument()).toEqual(document);

  restored.workspace.drafts.recovered = { request: { ...workspace.requests["create-workspace"], name: "Recovered draft" } };
  restored.workspace.closedDraftIds = ["recovered"];
  expect(await repository.save(restored.workspace)).toEqual({ warning: null });
  const reloaded = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(reloaded.workspace).toEqual(restored.workspace);
});

it.each(["{broken", JSON.stringify({ ...createWorkspace(), version: 999 })])(
  "preserves unreadable legacy data and refuses autosave of the unsaved starter",
  async source => {
    const legacy = legacyStorage(source);
    const storage = memoryStorage();
    const repository = createWorkspaceRepository(storage, legacy);
    const loaded = await repository.load();
    expect(loaded.error).toContain("Could not load workspace");
    await expect(repository.save(loaded.workspace)).rejects.toThrow("preserved");
    expect(await storage.readDocument()).toBeUndefined();
    expect(legacy.getItem(WORKSPACE_STORAGE_KEY)).toBe(source);
  },
);

it("preserves an unsupported new document and refuses to replace it with legacy examples", async () => {
  const storage = memoryStorage();
  const unsupported = { version: 999, important: "user work" };
  await storage.writeDocument(unsupported);
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const loaded = await repository.load();
  expect(loaded.error).toContain("preserved");
  await expect(repository.save(loaded.workspace)).rejects.toThrow("preserved");
  expect(await storage.readDocument()).toEqual(unsupported);
});

it("keeps valid legacy definitions visible when IndexedDB cannot be opened", async () => {
  const workspace = workspaceWithHistory();
  workspace.requests["create-workspace"].name = "Existing local work";
  const source = JSON.stringify(workspace);
  const legacy = legacyStorage(source);
  const storage = memoryStorage();
  storage.readDocument = async () => { throw new Error("Access denied"); };
  const repository = createWorkspaceRepository(storage, legacy);
  const loaded = await repository.load();
  expect(loaded.workspace).toEqual(workspace);
  expect(loaded.error).toContain("Access denied");
  expect(loaded.error).toContain("new edits cannot be saved");
  await expect(repository.save(workspace)).rejects.toThrow("unavailable");
  expect(legacy.getItem(WORKSPACE_STORAGE_KEY)).toBe(source);
});

it("saves definitions and later edits even when storing a response exceeds quota", async () => {
  const storage = memoryStorage();
  storage.writeHistory = async () => { throw new DOMException("Full", "QuotaExceededError"); };
  const repository = createWorkspaceRepository(storage, legacyStorage());
  await repository.load();
  const workspace = workspaceWithHistory();
  const result = await repository.save(workspace);
  expect(result.warning).toContain("1 history capture");
  expect(result.warning).toContain("will not be restored");
  expect(workspace.history[0].result).toMatchObject({ response: { body: "received body" } });

  workspace.requests["create-workspace"].path = "https://edited.test/after-large-response";
  await repository.save(workspace);
  const restored = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(restored.workspace.requests["create-workspace"].path).toBe("https://edited.test/after-large-response");
  expect(restored.workspace.history).toEqual([]);
  expect(restored.error).toContain("1 history capture");
});

it("keeps an equivalent durable capture when later capture writes would exceed quota", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = workspaceWithHistory();
  await repository.save(workspace);
  const original = workspace.history[0];
  // Equivalent snapshots can be reconstructed with a different object field order.
  const { request, result, ...identity } = original;
  workspace.history[0] = { result, request, ...identity };
  storage.writeHistory = async () => { throw new DOMException("Full", "QuotaExceededError"); };
  workspace.requests["create-workspace"].path = "https://edited.test/keep-capture";
  expect(await repository.save(workspace)).toEqual({ warning: null });

  const restored = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(restored.workspace.requests["create-workspace"].path).toBe("https://edited.test/keep-capture");
  expect(restored.workspace.history).toEqual([original]);
  expect(restored.error).toBeNull();
});

it("does not reload unchanged capture bodies during later definition edits or equivalent history copies", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = workspaceWithHistory();
  workspace.history[0] = capture("capture", "large response ".repeat(100_000));
  await repository.save(workspace);
  const read = storage.readHistory;
  const reads: string[] = [];
  storage.readHistory = async id => { reads.push(id); return read(id); };
  storage.writeHistory = async () => { throw new DOMException("Full", "QuotaExceededError"); };

  workspace.requests["create-workspace"].name = "Edited definition";
  expect(await repository.save(workspace)).toEqual({ warning: null });
  workspace.history = appendHistory([], workspace.history[0]);
  workspace.requests["create-workspace"].body = "Another edit";
  expect(await repository.save(workspace)).toEqual({ warning: null });
  expect(reads).toEqual([]);
  expect(await read("capture")).toEqual(workspace.history[0]);
});

it("rechecks capture content after nested in-place mutations instead of reusing an older snapshot", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = workspaceWithHistory();
  await repository.save(workspace);
  const original = await storage.readHistory("capture");
  const entry = workspace.history[0];
  entry.request.headers.push({ name: "x-captured", value: "changed request header" });
  entry.request.sensitiveHeaderNames = ["x-captured"];
  if (entry.result.status === "success") {
    entry.result.response.body = "changed response";
    entry.result.response.headers.push({ name: "x-response", value: "changed response header" });
  }
  expect(await storage.readHistory("capture")).toEqual(original);
  expect(await repository.save(workspace)).toEqual({ warning: null });
  const reloaded = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(reloaded).toEqual({ workspace, error: null });
});

it("recalculates the UTF-8 budget when an existing body changes without changing its character count", async () => {
  const storage = memoryStorage();
  const workspace = workspaceWithHistory();
  workspace.history[0] = capture("capture", "a".repeat(512));
  const exact = new TextEncoder().encode(JSON.stringify(workspace.history[0])).byteLength;
  const repository = createWorkspaceRepository(storage, legacyStorage(), exact);
  expect(await repository.save(workspace)).toEqual({ warning: null });
  const result = workspace.history[0].result;
  if (result.status !== "success") throw new Error("Expected a completed response.");
  result.response.body = "é".repeat(512);

  expect((await repository.save(workspace)).warning).toContain("1 history capture");
  expect((await repository.load()).workspace.history).toEqual([]);
  expect(result.response.body).toBe("é".repeat(512));
});

it("keeps an active save's capture detached from mutations received during its writes", async () => {
  const storage = memoryStorage();
  const repository = createWorkspaceRepository(storage, legacyStorage());
  await repository.load();
  const write = storage.writeDocument;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let pause = true;
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if (pause) { pause = false; entered(); await gate; }
    await write(document, changes, expectedCommitId);
  };
  const workspace = workspaceWithHistory();
  const saving = repository.save(workspace);
  await started;
  const result = workspace.history[0].result;
  if (result.status !== "success") throw new Error("Expected a completed response.");
  result.response.body = "changed during write";
  result.response.headers.push({ name: "x-later", value: "received during write" });
  release();
  await saving;

  expect(await storage.readHistory("capture")).toMatchObject({ result: { response: { body: "received body", headers: [] } } });
  await repository.save(workspace);
  expect(await storage.readHistory("capture")).toEqual(workspace.history[0]);
});

it("rewrites a previously saved capture when its durable record is missing", async () => {
  const storage = memoryStorage();
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = workspaceWithHistory();
  await repository.save(workspace);
  await storage.removeHistory("capture");
  workspace.requests["create-workspace"].name = "Edit after missing capture";

  expect(await repository.save(workspace)).toEqual({ warning: null });
  expect(await storage.readHistory("capture")).toEqual(workspace.history[0]);
});

it("rewrites captures evicted to make room for definitions and reports quota failures", async () => {
  const storage = memoryStorage();
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = workspaceWithHistory();
  await repository.save(workspace);
  const write = storage.writeDocument;
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if ((await storage.historyIds()).length) throw new DOMException("Full", "QuotaExceededError");
    await write(document, changes, expectedCommitId);
  };
  storage.writeHistory = async () => { throw new DOMException("Full", "QuotaExceededError"); };
  workspace.requests["create-workspace"].name = "Edit survives eviction";

  expect((await repository.save(workspace)).warning).toContain("1 history capture");
  const reloaded = await repository.load();
  expect(reloaded.workspace.requests["create-workspace"].name).toBe("Edit survives eviction");
  expect(reloaded.workspace.history).toEqual([]);
});

it("does not claim a changed capture was saved when replacing its previous content fails", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = workspaceWithHistory();
  await repository.save(workspace);
  const original = await storage.readHistory("capture");
  workspace.history[0] = capture("capture", "replacement body");
  storage.writeHistory = async () => { throw new DOMException("Full", "QuotaExceededError"); };
  const result = await repository.save(workspace);
  expect(result.warning).toContain("1 history capture");
  expect(result.warning).toContain("will not be restored");

  const restored = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(restored.workspace.history).toEqual([]);
  expect(restored.error).toContain("will not be restored");
  expect(await storage.readHistory("capture")).toEqual(original);
});

it("evicts old payloads when quota pressure would otherwise prevent a definition edit", async () => {
  const storage = memoryStorage();
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = workspaceWithHistory();
  await repository.save(workspace);
  const write = storage.writeDocument;
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if ((await storage.historyIds()).length) throw new DOMException("Full", "QuotaExceededError");
    await write(document, changes, expectedCommitId);
  };
  workspace.history = [];
  workspace.requests["create-workspace"].body = "edit must survive";
  await repository.save(workspace);
  const restored = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(restored.workspace.requests["create-workspace"].body).toBe("edit must survive");
  expect(restored.workspace.history).toEqual([]);
});

it("reclaims an orphan capture even when the previous document has no history references", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = createWorkspace();
  await repository.save(workspace);
  await storage.writeHistory("orphan", capture("orphan", "left by an interrupted save"));
  const write = storage.writeDocument;
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if (await storage.readHistory("orphan")) throw new DOMException("Full", "QuotaExceededError");
    await write(document, changes, expectedCommitId);
  };
  workspace.requests["create-workspace"].body = "edit after interrupted cleanup";
  expect(await repository.save(workspace)).toEqual({ warning: null });

  const restored = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(restored.workspace.requests["create-workspace"].body).toBe("edit after interrupted cleanup");
  expect(restored.workspace.history).toEqual([]);
  expect(await storage.historyIds()).toEqual([]);
});

it("reclaims orphan payloads before evicting referenced history under quota pressure", async () => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = workspaceWithHistory();
  await repository.save(workspace);
  await storage.writeHistory("orphan", capture("orphan", "left by an interrupted save"));
  const write = storage.writeDocument;
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if ((await storage.historyIds()).length > 1) throw new DOMException("Full", "QuotaExceededError");
    await write(document, changes, expectedCommitId);
  };
  storage.writeHistory = async () => { throw new DOMException("Full", "QuotaExceededError"); };
  workspace.requests["create-workspace"].body = "latest definition";
  expect(await repository.save(workspace)).toEqual({ warning: null });

  const restored = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(restored.workspace.requests["create-workspace"].body).toBe("latest definition");
  expect(restored.workspace.history).toEqual(workspace.history);
  expect(restored.error).toBeNull();
  expect(await storage.historyIds()).toEqual(["capture"]);
});

it("keeps a durable incomplete-history notice if a final metadata commit fails", async () => {
  const storage = memoryStorage();
  const repository = createWorkspaceRepository(storage, legacyStorage());
  await repository.load();
  const write = storage.writeDocument;
  let calls = 0;
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if (++calls === 2) throw new Error("Interrupted");
    await write(document, changes, expectedCommitId);
  };
  const result = await repository.save(workspaceWithHistory());
  expect(result.warning).toContain("did not finish");
  const restored = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(restored.workspace.history).toHaveLength(1);
  expect(restored.error).toContain("did not finish");
});

it.each(["missing", "corrupt", "mismatched"])("restores editable work and available captures while warning about a %s capture", async state => {
  const storage = createIndexedDbWorkspaceStorage(new IDBFactory());
  const workspace = workspaceWithHistory();
  workspace.history.push(capture("available", "complete response"));
  await createWorkspaceRepository(storage, legacyStorage()).save(workspace);
  if (state === "missing") await storage.removeHistory("capture");
  else if (state === "corrupt") await storage.writeHistory("capture", {} as HistoryEntry);
  else await storage.writeHistory("capture", capture("wrong-identity", "unavailable response"));

  const loaded = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(loaded.workspace.requests).toEqual(workspace.requests);
  expect(loaded.workspace.history).toEqual([workspace.history[1]]);
  expect(loaded.error).toContain("1 history capture");
  expect(loaded.error).toContain("could not be restored");
});

it("reports failed payload cleanup instead of claiming that cleared captures were deleted", async () => {
  const storage = memoryStorage();
  const repository = createWorkspaceRepository(storage, legacyStorage());
  const workspace = workspaceWithHistory();
  await repository.save(workspace);
  storage.removeHistory = async () => { throw new Error("Access denied"); };
  workspace.history = [];
  const saved = await repository.save(workspace);
  expect(saved.warning).toContain("could not be deleted");
  const restored = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(restored.workspace.history).toEqual([]);
  expect(restored.error).toContain("could not be deleted");
});

it("coalesces synchronous edits, defers storage work, and flushes without waiting for its timer", async () => {
  const storage = memoryStorage();
  const repository = createWorkspaceRepository(storage, legacyStorage());
  await repository.load();
  const write = storage.writeDocument;
  const names: string[] = [];
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if (changes?.requests["create-workspace"]) names.push(changes.requests["create-workspace"].name);
    await write(document, changes, expectedCommitId);
  };
  const workspace = createWorkspace();
  workspace.requests["create-workspace"].name = "First edit";
  const first = repository.save(workspace);
  workspace.requests["create-workspace"].name = "Latest edit";
  const second = repository.save(workspace);
  expect(names).toEqual([]);
  await repository.flush();
  await Promise.all([first, second]);
  expect(names).toEqual(["Latest edit"]);
});

it("coalesces typing across tasks and persists after the quiet period", async () => {
  const storage = memoryStorage();
  const repository = createWorkspaceRepository(storage, legacyStorage());
  await repository.load();
  const workspace = createWorkspace();
  vi.useFakeTimers();
  try {
    workspace.requests["create-workspace"].body = "first";
    const first = repository.save(workspace);
    await vi.advanceTimersByTimeAsync(150);
    workspace.requests["create-workspace"].body = "latest";
    const second = repository.save(workspace);
    await vi.advanceTimersByTimeAsync(150);
    expect((await storage.readRequest("create-workspace") as { body: string }).body)
      .not.toBe("latest");

    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([first, second]);
    expect((await repository.load()).workspace.requests["create-workspace"].body).toBe("latest");
  } finally {
    vi.useRealTimers();
  }
});

it("bounds the delay while edits continue arriving without a quiet period", async () => {
  const storage = memoryStorage();
  const repository = createWorkspaceRepository(storage, legacyStorage());
  await repository.load();
  const workspace = createWorkspace();
  vi.useFakeTimers();
  try {
    const saves: Promise<unknown>[] = [];
    for (let edit = 0; edit < 10; edit++) {
      workspace.requests["create-workspace"].body = `edit ${edit}`;
      saves.push(repository.save(workspace));
      await vi.advanceTimersByTimeAsync(100);
    }
    await Promise.all(saves);
    expect((await repository.load()).workspace.requests["create-workspace"].body).toBe("edit 9");
  } finally {
    vi.useRealTimers();
  }
});

it("debounces edits received during a slow commit and lets flush bypass their remaining delay", async () => {
  const storage = memoryStorage();
  const repository = createWorkspaceRepository(storage, legacyStorage());
  await repository.load();
  const write = storage.writeDocument;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pause = true;
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if (pause) { pause = false; await gate; }
    await write(document, changes, expectedCommitId);
  };
  const workspace = createWorkspace();
  vi.useFakeTimers();
  try {
    workspace.requests["create-workspace"].body = "first batch";
    const first = repository.save(workspace);
    await vi.advanceTimersByTimeAsync(200);
    workspace.requests["create-workspace"].body = "during commit";
    const second = repository.save(workspace);
    release();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect((await storage.readRequest("create-workspace") as { body: string }).body)
      .toBe("first batch");

    await vi.advanceTimersByTimeAsync(100);
    workspace.requests["create-workspace"].body = "latest queued edit";
    const third = repository.save(workspace);
    await vi.advanceTimersByTimeAsync(100);
    expect((await storage.readRequest("create-workspace") as { body: string }).body)
      .toBe("first batch");
    await repository.flush();
    await Promise.all([second, third]);
    expect((await repository.load()).workspace.requests["create-workspace"].body).toBe("latest queued edit");
  } finally {
    release();
    vi.useRealTimers();
  }
});

it("restores captures in stored order without waiting for earlier reads to finish", async () => {
  const storage = memoryStorage();
  const workspace = workspaceWithHistory();
  workspace.history.push(capture("second", "another response"));
  await createWorkspaceRepository(storage, legacyStorage()).save(workspace);
  const read = storage.readHistory;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reads: string[] = [];
  storage.readHistory = async id => {
    reads.push(id);
    if (id === "capture") await gate;
    else release();
    return read(id);
  };

  const restored = await createWorkspaceRepository(storage, legacyStorage()).load();
  expect(reads).toEqual(["capture", "second"]);
  expect(restored).toEqual({ workspace, error: null });
});

it("serializes edits received during an active save so an older write cannot win", async () => {
  const storage = memoryStorage();
  const repository = createWorkspaceRepository(storage, legacyStorage());
  await repository.load();
  const write = storage.writeDocument;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pause = true;
  storage.writeDocument = async (document, changes, expectedCommitId) => {
    if (pause) { pause = false; entered(); await gate; }
    await write(document, changes, expectedCommitId);
  };
  const first = createWorkspace();
  first.requests["create-workspace"].name = "Older";
  const firstSave = repository.save(first);
  const flushing = repository.flush();
  await started;
  const second = createWorkspace();
  second.requests["create-workspace"].name = "Newest";
  const secondSave = repository.save(second);
  release();
  await Promise.all([firstSave, secondSave, flushing]);
  expect((await repository.load()).workspace.requests["create-workspace"].name).toBe("Newest");
});

it("enforces the UTF-8 capture budget while retaining smaller recent entries", () => {
  const large = capture("large", "x".repeat(HISTORY_BYTE_LIMIT + 1));
  const small = capture("small", "é😀");
  const exact = new TextEncoder().encode(JSON.stringify(small)).byteLength;
  expect(historyForStorage([large, small], exact)).toEqual({ entries: [small], omitted: 1 });
  expect(historyForStorage([small], exact - 1)).toEqual({ entries: [], omitted: 1 });
});

function workspaceWithHistory(): WorkspaceData {
  return { ...createWorkspace(), history: [capture("capture", "received body")] };
}

function capture(id: string, body: string): HistoryEntry {
  return {
    id, requestId: "create-workspace", name: "Captured", startedAt: "2026-10-23T12:00:00Z",
    request: { method: "POST", url: "https://api.test/", headers: [], body: "request", timeoutMs: 1000 },
    result: { status: "success", response: {
      url: "https://api.test/", status: 200, statusText: "OK", headers: [], body, durationMs: 1, sizeBytes: body.length,
    } },
  };
}

function legacyStorage(initial: string | null = null): WorkspaceStorage {
  const values = new Map<string, string>(initial === null ? [] : [[WORKSPACE_STORAGE_KEY, initial]]);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

function memoryStorage(): WorkspaceRepositoryStorage {
  let document: unknown;
  const history = new Map<string, unknown>();
  const requests = new Map<string, unknown>();
  const drafts = new Map<string, unknown>();
  const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
  return {
    readDocument: async () => copy(document),
    writeDocument: async (value, changes, expectedCommitId) => {
      if (expectedCommitId !== undefined && (document as { commitId?: string })?.commitId !== expectedCommitId) {
        throw new WorkspaceCommitConflict();
      }
      if (changes) {
        for (const id of changes.removedRequestIds) requests.delete(id);
        for (const id of changes.removedDraftIds) drafts.delete(id);
        for (const [id, request] of Object.entries(changes.requests)) requests.set(id, copy(request));
        for (const [id, draft] of Object.entries(changes.drafts)) drafts.set(id, copy(draft));
      }
      document = copy(value);
    },
    readRequest: async id => copy(requests.get(id)),
    readDraft: async id => copy(drafts.get(id)),
    readHistory: async id => copy(history.get(id)),
    writeHistory: async (id, entry) => { history.set(id, copy(entry)); },
    historyIds: async () => [...history.keys()],
    removeHistory: async id => { history.delete(id); },
  };
}
