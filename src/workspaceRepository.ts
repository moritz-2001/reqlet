// WorkspaceRepository atomically saves changed editable records and metadata, separately from bounded captures.
import { historyForStorage } from "./history";
import { bodyText, isBodyDocument } from "./bodyDocument";
import type { HistoryEntry, RequestData } from "./request";
import { createWorkspace, loadWorkspace, type WorkspaceData, type WorkspaceDraft, type WorkspaceStorage } from "./workspace";
import { parseHistoryEntry, parseWorkspace } from "./workspaceValidation";

/** Loaded application state; errors describe preserved data or captures unavailable after reload. */
export interface WorkspaceLoadResult {
  /** Independently editable state, including all captures that could be restored. */
  workspace: WorkspaceData;
  /** User-visible storage problem; null means the entire saved state was restored. */
  error: string | null;
}

/** Asynchronous persistence used by the application; save calls coalesce and never overtake each other. */
export interface WorkspaceRepository {
  /** Loads IndexedDB, migrating valid legacy data without changing its original bytes. */
  load(): Promise<WorkspaceLoadResult>;
  /** Saves after 200 ms without edits, within 1 s of the first queued edit; resolves once durable. */
  save(workspace: WorkspaceData): Promise<{ warning: string | null }>;
  /** Starts pending work immediately, for backgrounding/unmount, and waits for queued writes. */
  flush(): Promise<void>;
}

/** Storage boundary: editable definitions and captured payloads occupy independent records. */
export interface WorkspaceRepositoryStorage {
  /** Returns compact metadata (or an earlier complete document), or undefined before the first save. */
  readDocument(): Promise<unknown>;
  /**
   * Commits metadata and changed/deleted editable records together; failure
   * preserves all previous values. An expected commit identity guards editable
   * deltas and history completion against overwriting a newer window's changes;
   * reject with WorkspaceCommitConflict when that identity no longer matches.
   */
  writeDocument(document: unknown, changes?: WorkspaceRecordChanges, expectedCommitId?: string): Promise<void>;
  /** Reads an independent saved definition once when restoring a version-2 document. */
  readRequest(id: string): Promise<unknown>;
  /** Reads an independent draft once when restoring a version-2 document. */
  readDraft(id: string): Promise<unknown>;
  /** Reads one complete capture, returning undefined when its record is missing. */
  readHistory(id: string): Promise<unknown>;
  /** Atomically replaces one capture; quota failure cannot roll back a definitions write. */
  writeHistory(id: string, entry: HistoryEntry): Promise<void>;
  /** Enumerates stored captures so pruning also removes payload records left by interrupted saves. */
  historyIds(): Promise<string[]>;
  /** Removes a capture after retention or explicit history clearing. */
  removeHistory(id: string): Promise<void>;
}

/** One atomic editable-state commit; unchanged large records are deliberately absent. */
export interface WorkspaceRecordChanges {
  /** New or changed saved definitions, keyed by their stable collection identities. */
  requests: Record<string, RequestData>;
  /** New or changed drafts, including capture inputs and pane preferences. */
  drafts: Record<string, WorkspaceDraft>;
  /** Previously saved definitions deleted by this commit, so their body records can be reclaimed. */
  removedRequestIds: string[];
  /** Previously saved drafts removed or promoted to Collections by this commit. */
  removedDraftIds: string[];
}

/** Storage adapters throw this when a newer editable commit invalidates a prepared delta or history completion. */
export class WorkspaceCommitConflict extends Error {
  constructor() { super("Workspace changed before this storage transaction could commit."); }
}

/** Creates a repository with an injectable storage boundary and optional smaller history budget for tests. */
export function createWorkspaceRepository(
  storage: WorkspaceRepositoryStorage,
  legacyStorage?: WorkspaceStorage,
  historyByteLimit?: number,
): WorkspaceRepository {
  // A corrupt definitions document blocks autosave for this repository's lifetime.
  // Loading again explicitly rechecks it; ordinary edits cannot overwrite recovery data.
  let blocked: string | null = null;
  let loaded = false;
  // Pending state is read only when its batch starts. A quiet-period debounce
  // combines typing events; the first queued time bounds how long continuous edits wait.
  let pending: SaveBatch | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | null = null;
  // These detached snapshots describe the last committed editable state. They
  // retain immutable body strings while isolating nested objects from caller edits.
  // Only compact metadata is reread on an ordinary save; a different document is
  // restored and validated before it can be replaced (for example, another window).
  let durableWorkspace: WorkspaceData | null = null;
  let durableDocument: StoredWorkspace | null = null;
  // Captures are copied on history insertion, so execution IDs survive longer than
  // object identities. Detached snapshots let us check for later nested mutations
  // without rescanning body strings, and reuse their exact serialized size.
  let captureSnapshots = new Map<string, CaptureSnapshot>();
  // Only successfully read/written snapshots enter this map. The current key
  // inventory is checked before reuse, and repository removals invalidate it.
  const durableCaptures = new Map<string, HistoryEntry>();

  const repository: WorkspaceRepository = {
    async load() {
      loaded = true;
      blocked = null;
      captureSnapshots.clear();
      durableCaptures.clear();
      durableWorkspace = null;
      durableDocument = null;
      let value: unknown;
      try {
        value = await storage.readDocument();
      } catch (error) {
        const legacy = loadWorkspace(legacyStorage);
        blocked = `Local workspace storage is unavailable. ${message(error)}`;
        return {
          workspace: legacy.workspace,
          error: `Could not load durable storage: ${blocked}${legacy.error ? ` ${legacy.error}` : " Legacy data remains available in this session; new edits cannot be saved."}`,
        };
      }
      try {
        if (value !== undefined && value !== null) return await restoreDocument(parseDocument(value));
      } catch (error) {
        blocked = `Saved workspace is unreadable and was preserved. ${message(error)}`;
        return { workspace: createWorkspace(), error: `Could not load workspace: ${blocked}` };
      }

      const legacy = loadWorkspace(legacyStorage);
      if (legacy.error) {
        blocked = `Legacy workspace was preserved. ${legacy.error}`;
        return legacy;
      }
      try {
        const result = await persist(legacy.workspace);
        return { workspace: legacy.workspace, error: result.warning };
      } catch (error) {
        return { workspace: legacy.workspace, error: `Could not migrate workspace: ${message(error)}` };
      }
    },
    save(workspace) {
      return new Promise((resolve, reject) => {
        if (pending) {
          pending.workspace = workspace;
          pending.waiters.push({ resolve, reject });
        } else pending = { workspace, queuedAt: Date.now(), waiters: [{ resolve, reject }] };
        scheduleSave();
      });
    },
    async flush() {
      do {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        await drain(true);
      } while (pending);
    },
  };
  return repository;

  function scheduleSave() {
    if (writing || !pending) return;
    if (timer !== undefined) clearTimeout(timer);

    const remaining = Math.max(0, pending.queuedAt + 1000 - Date.now());
    timer = setTimeout(() => { timer = undefined; void drain(); }, Math.min(200, remaining));
  }

  function drain(flush = false): Promise<void> {
    if (writing) return writing;
    writing = (async () => {
      while (pending) {
        const batch = pending;
        pending = null;
        try {
          if (!loaded) await repository.load();
          if (blocked) throw new Error(blocked);
          const result = await persist(batch.workspace);
          for (const waiter of batch.waiters) waiter.resolve(result);
        } catch (error) {
          for (const waiter of batch.waiters) waiter.reject(error);
        }
        // Ordinary saves debounce edits received during a slow commit as a new
        // batch. Explicit flush drains them immediately while preserving order.
        if (!flush) break;
      }
    })().finally(() => {
      writing = null;
      if (pending) scheduleSave();
    });
    return writing;
  }

  async function restoreDocument(document: StoredWorkspace): Promise<WorkspaceLoadResult> {
    // Start independent records together so the IndexedDB adapter can hydrate
    // definitions, drafts, and captures in one readonly transaction.
    const [workspace, restored] = await Promise.all([
      readEditableWorkspace(document),
      Promise.all(document.historyIds.map(async id => {
        try {
          const entry = await storage.readHistory(id);
          const validated = parseHistoryEntry(entry);
          if (validated.id !== id) throw new Error("Capture identity differs from its storage key.");
          return validated;
        } catch {
          // A missing/corrupt capture must not hide otherwise valid editable work.
          return null;
        }
      })),
    ]);
    durableWorkspace = snapshotEditableWorkspace(workspace);
    durableDocument = copyJsonValue(document);
    const history: HistoryEntry[] = [];
    for (const entry of restored) if (entry) history.push(entry);
    const unavailable = document.historyIds.length - history.length;
    return {
      workspace: { ...workspace, history },
      error: unavailable > 0 ? historyWarning(unavailable, "could not be restored") : document.warning,
    };
  }

  async function persist(workspace: WorkspaceData): Promise<{ warning: string | null }> {
    // Snapshot once when the debounced batch starts, before any asynchronous
    // work lets edits mutate its input. Unchanged records reuse detached copies;
    // changed containers are copied without serializing or duplicating body text.
    const editable = snapshotEditableWorkspace(parseWorkspace(workspace), durableWorkspace);
    const historyCount = workspace.history.length;
    const prepared = new Map<string, CaptureSnapshot>();
    const selected = historyForStorage(workspace.history, historyByteLimit, entry => {
      const snapshot = captureSnapshots.get(entry.id);
      if (snapshot && sameJsonValue(snapshot.capture, entry)) {
        prepared.set(entry.id, snapshot);
        return snapshot.sizeBytes;
      }

      const serialized = JSON.stringify(entry);
      const replacement = {
        capture: copyJsonValue(entry),
        sizeBytes: new TextEncoder().encode(serialized).byteLength,
      };
      prepared.set(entry.id, replacement);
      return replacement.sizeBytes;
    });
    // Retain only bounded captures after yielding from the edit event. Rejected
    // multi-megabyte bodies are never serialized into the definitions document.
    captureSnapshots = new Map(selected.entries.map(entry => [entry.id, prepared.get(entry.id)!]));
    const captures = [...captureSnapshots.values()].map(snapshot => snapshot.capture);

    let previous = await refreshEditableSnapshot();
    // The first commit after a version-1 document populates every editable record.
    // Earlier version-2 documents without commit identities also rewrite records
    // once, since their delta baseline cannot be checked atomically.
    let expectedCommitId = previous?.version === 2 ? previous.commitId : undefined;
    let changes = materializeChanges(editableChanges(editable, durableWorkspace, expectedCommitId === undefined));
    const document: StoredWorkspaceV2 = {
      version: 2,
      commitId: crypto.randomUUID(),
      workspace: { ...editable, requests: {}, drafts: {} },
      requestIds: Object.keys(editable.requests),
      draftIds: Object.keys(editable.drafts),
      historyIds: captures.map(entry => entry.id),
      warning: INCOMPLETE_HISTORY_WARNING,
    };

    // Reserve the final document size before writing any payload. Interrupted saves
    // can leave unreferenced records outside previous.historyIds; reclaim those first,
    // then evict older referenced captures only if editable work still cannot fit.
    const previousIds = new Set(previous?.historyIds ?? []);
    let orphanIds: string[] = [];
    try { orphanIds = (await storage.historyIds()).filter(id => !previousIds.has(id)); }
    catch { /* A failed inventory must not prevent a definitions write that could succeed. */ }
    const evictable = [...orphanIds, ...[...previousIds].reverse()];
    let conflicts = 0;
    for (;;) {
      try {
        await storage.writeDocument(document, changes, expectedCommitId);
        durableWorkspace = editable;
        durableDocument = copyJsonValue(document);
        break;
      } catch (error) {
        if (error instanceof WorkspaceCommitConflict) {
          if (++conflicts >= 3) throw new Error("Could not save definitions and drafts because another window kept changing the workspace. Try saving again.");

          // Recompute against the newer durable records, while retaining the
          // detached batch captured before any asynchronous work began.
          previous = await refreshEditableSnapshot();
          expectedCommitId = previous?.version === 2 ? previous.commitId : undefined;
          changes = materializeChanges(editableChanges(editable, durableWorkspace, expectedCommitId === undefined));
          continue;
        }
        const id = isQuotaError(error) ? evictable.shift() : undefined;
        if (id === undefined) throw new Error(`Could not save definitions and drafts: ${message(error)}`);
        await storage.removeHistory(id);
        durableCaptures.delete(id);
      }
    }

    const selectedIds = new Set(document.historyIds);
    for (const id of durableCaptures.keys()) {
      if (!selectedIds.has(id)) durableCaptures.delete(id);
    }
    let storedIds: Set<string> | undefined;
    let cleanupFailed = false;
    try {
      storedIds = new Set(await storage.historyIds());
      for (const id of storedIds) {
        if (!selectedIds.has(id)) {
          await storage.removeHistory(id);
          storedIds.delete(id);
          durableCaptures.delete(id);
        }
      }
    } catch {
      // Cleanup is retried on the next save. Failure cannot undo saved definitions.
      cleanupFailed = true;
    }

    const savedIds: string[] = [];
    for (const capture of captures) {
      // Ordinary definition edits retain the same detached snapshot. Avoid cloning
      // its potentially multi-megabyte IndexedDB body back onto the UI thread.
      if (storedIds?.has(capture.id) && durableCaptures.get(capture.id) === capture) {
        savedIds.push(capture.id);
        continue;
      }
      try {
        const stored = await storage.readHistory(capture.id);
        const existing = parseHistoryEntry(stored);
        if (sameJsonValue(existing, capture)) {
          // Captures are immutable snapshots. Rewriting an equivalent durable record
          // adds quota risk during ordinary definition edits and cannot improve it.
          savedIds.push(capture.id);
          durableCaptures.set(capture.id, capture);
          continue;
        }
      } catch {
        // Missing, unreadable, or invalid records need a fresh write before being referenced.
      }
      try {
        await storage.writeHistory(capture.id, capture);
        savedIds.push(capture.id);
        durableCaptures.set(capture.id, capture);
      } catch {
        // Omit the whole exchange: an empty body would misrepresent the received response.
        durableCaptures.delete(capture.id);
      }
    }
    const omitted = historyCount - savedIds.length;
    document.historyIds = savedIds;
    const warnings = [
      omitted > 0 ? historyWarning(omitted, "could not be saved within local storage limits") : "",
      cleanupFailed ? "Some removed history captures could not be deleted from local storage." : "",
    ].filter(Boolean);
    document.warning = warnings.length > 0 ? warnings.join(" ") : null;
    try {
      // Finalizing history references is metadata-only; large editable records
      // already committed atomically and never participate in this second write.
      await storage.writeDocument(document, undefined, document.commitId);
      durableDocument = copyJsonValue(document);
    } catch {
      // The first definitions write is already durable and carries a warning. Its
      // candidate IDs let reload restore any bodies that did finish before failure.
      return { warning: INCOMPLETE_HISTORY_WARNING };
    }
    return { warning: document.warning };
  }

  async function refreshEditableSnapshot(): Promise<StoredWorkspace | null> {
    const value = await storage.readDocument();
    if (value === undefined || value === null) {
      durableWorkspace = null;
      durableDocument = null;
      return null;
    }

    try {
      const document = parseDocument(value);
      if ((document.version === 2 && document.commitId === undefined) || !sameJsonValue(document, durableDocument)) {
        durableWorkspace = snapshotEditableWorkspace(await readEditableWorkspace(document));
        durableDocument = copyJsonValue(document);
      }
      return document;
    } catch (error) {
      blocked = `Saved workspace is unreadable and was preserved. ${message(error)}`;
      throw new Error(blocked);
    }
  }

  async function readEditableWorkspace(document: StoredWorkspace): Promise<WorkspaceData> {
    if (document.version === 1) return document.workspace;

    const [requests, drafts] = await Promise.all([
      Promise.all(document.requestIds.map(async id => [id, await storage.readRequest(id)] as const)),
      Promise.all(document.draftIds.map(async id => [id, await storage.readDraft(id)] as const)),
    ]);
    // Missing or corrupt editable records block the entire load/save. Unlike
    // optional history, silently omitting a definition would destroy user work.
    return parseWorkspace({ ...document.workspace, requests: Object.fromEntries(requests), drafts: Object.fromEntries(drafts) });
  }
}

/** Opens the browser's durable store lazily; the optional factory/name isolate adapter tests. */
export function createIndexedDbWorkspaceStorage(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  databaseName = "api-tool.workspace",
): WorkspaceRepositoryStorage {
  let database: Promise<IDBDatabase> | undefined;
  // A synchronous restoration wave shares one transaction instead of paying a
  // transaction's scheduling/commit cost for every record. Opening the database
  // yields once so callers can append their reads. Other operations detach this
  // batch before awaiting open(), preserving read/write invocation order.
  let pendingReads: PendingRecordRead[] | null = null;

  return {
    readDocument: () => transact("documents", "readonly", store => store.get("workspace")),
    writeDocument,
    readRequest: id => readRecord("requests", id),
    readDraft: id => readRecord("drafts", id),
    readHistory: id => readRecord("history", id),
    writeHistory: async (id, entry) => { await transact("history", "readwrite", store => store.put(entry, id)); },
    historyIds: async () => (await transact("history", "readonly", store => store.getAllKeys())).map(String),
    removeHistory: async id => { await transact("history", "readwrite", store => store.delete(id)); },
  };

  function open(): Promise<IDBDatabase> {
    if (!database) database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error("IndexedDB is unavailable in this environment.")); return; }
      const request = factory.open(databaseName, 2);
      request.onupgradeneeded = () => {
        for (const name of ["documents", "requests", "drafts", "history"]) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open local workspace storage."));
      request.onblocked = () => reject(new Error("Local workspace storage is blocked by another application window."));
    });
    return database;
  }

  function readRecord(store: RecordStore, id: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (pendingReads) pendingReads.push({ store, id, resolve, reject });
      else {
        pendingReads = [{ store, id, resolve, reject }];
        void readRecords(pendingReads);
      }
    });
  }

  async function readRecords(reads: PendingRecordRead[]): Promise<void> {
    try {
      const db = await open();
      if (pendingReads === reads) pendingReads = null;
      const stores = [...new Set(reads.map(read => read.store))];
      const transaction = db.transaction(stores, "readonly");
      // Queue all gets before yielding: IndexedDB closes an idle transaction at
      // the end of its task, so a later asynchronous read needs a fresh batch.
      const requests = reads.map(read => transaction.objectStore(read.store).get(read.id));
      transaction.oncomplete = () => {
        for (const [index, read] of reads.entries()) read.resolve(requests[index]!.result);
      };
      const failed = () => {
        const error = transaction.error ?? new Error("Local storage transaction failed.");
        for (const read of reads) read.reject(error);
      };
      transaction.onabort = failed;
      transaction.onerror = failed;
    } catch (error) {
      if (pendingReads === reads) pendingReads = null;
      for (const read of reads) read.reject(error);
    }
  }

  async function transact<T>(store: string, mode: IDBTransactionMode, operation: (target: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    pendingReads = null;
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = operation(transaction.objectStore(store));
      // Request success precedes transaction commit. Only completion means a write
      // survived quota checks; resolving on request.onsuccess would report false saves.
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error("Local storage transaction was aborted."));
      transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error("Local storage transaction failed."));
    });
  }

  async function writeDocument(document: unknown, changes?: WorkspaceRecordChanges, expectedCommitId?: string): Promise<void> {
    pendingReads = null;
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(changes ? ["documents", "requests", "drafts"] : ["documents"], "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Local storage transaction was aborted."));
      const documents = transaction.objectStore("documents");
      if (expectedCommitId === undefined) commit();
      else {
        const current = documents.get("workspace");
        current.onsuccess = () => {
          if (current.result?.commitId === expectedCommitId) commit();
          else { transaction.abort(); reject(new WorkspaceCommitConflict()); }
        };
      }

      function commit() {
        try {
          if (changes) {
            const requests = transaction.objectStore("requests");
            const drafts = transaction.objectStore("drafts");
            for (const id of changes.removedRequestIds) requests.delete(id);
            for (const id of changes.removedDraftIds) drafts.delete(id);
            for (const [id, request] of Object.entries(changes.requests)) requests.put(request, id);
            for (const [id, draft] of Object.entries(changes.drafts)) drafts.put(draft, id);
          }
          documents.put(document, "workspace");
        } catch (error) {
          // A synchronous clone failure must also abort previously queued writes.
          transaction.abort();
          reject(error);
        }
      }
    });
  }
}

type RecordStore = "requests" | "drafts" | "history";

interface PendingRecordRead {
  /** Independent record store participating in this readonly restoration transaction. */
  store: RecordStore;
  /** Stable identity whose exact stored value is returned, including undefined when absent. */
  id: string;
  /** Settles only after the whole transaction completes, preserving the adapter's durability boundary. */
  resolve: (value: unknown) => void;
  /** Reports opening, request, or transaction failures to this individual caller. */
  reject: (error: unknown) => void;
}

type StoredWorkspace = StoredWorkspaceV1 | StoredWorkspaceV2;

interface StoredWorkspaceV1 {
  /** Storage-envelope version, independent of the logical WorkspaceData version. */
  version: 1;
  /** Editable state with an empty history; complete captures live in separate records. */
  workspace: WorkspaceData;
  /** Ordered capture keys restored into workspace.history; missing records produce a visible warning. */
  historyIds: string[];
  /** Durable partial-save notice; null means all selected captures committed and pruning succeeded. */
  warning: string | null;
}

interface StoredWorkspaceV2 {
  /** Envelope version that separates editable records from compact workspace metadata. */
  version: 2;
  /**
   * Unique token for the atomic editable commit, retained by its history-only
   * completion write. Detects another window's record edits even when metadata
   * fields are unchanged. Omission identifies earlier version-2 envelopes whose
   * records must be rechecked before saving.
   */
  commitId?: string;
  /** Collection, environments, and preferences; request, draft, and history containers are empty. */
  workspace: WorkspaceData;
  /** Saved-definition keys hydrated from the requests store before validating cross references. */
  requestIds: string[];
  /** Draft keys hydrated from the drafts store, including closed recovery entries. */
  draftIds: string[];
  /** Ordered independently durable captures; missing records produce a visible warning. */
  historyIds: string[];
  /** Null after complete capture persistence; otherwise the durable partial-save or cleanup notice. */
  warning: string | null;
}

interface SaveBatch {
  /** Latest live state, replaced by edits until this batch starts and snapshots it. */
  workspace: WorkspaceData;
  /** First queued edit's timestamp; later edits postpone the quiet timer but never this deadline. */
  queuedAt: number;
  /** Callers waiting for the same coalesced durable result. */
  waiters: {
    resolve(result: { warning: string | null }): void;
    reject(error: unknown): void;
  }[];
}

interface CaptureSnapshot {
  /** Detached values compared against later input, so in-place mutations invalidate cached sizing. */
  capture: HistoryEntry;
  /** Exact UTF-8 length of the serialized capture, including JSON escaping and metadata. */
  sizeBytes: number;
}

const INCOMPLETE_HISTORY_WARNING = "Definitions and drafts are saved. History persistence did not finish; some captures may not be restored after reload. Keep this window open to inspect or copy any captures you need.";

function parseDocument(value: unknown): StoredWorkspace {
  if (!value || typeof value !== "object") throw new Error("Invalid workspace storage document.");
  const document = value as StoredWorkspace;
  if (document.version !== 1 && document.version !== 2) throw new Error("Unsupported workspace storage version.");
  // Validation also supplies additive version-1 fields absent in older documents.
  // Return that normalized state so application owners can safely read draft recovery data.
  const workspace = document.version === 1 ? parseWorkspace(document.workspace) : document.workspace;
  if (!workspace || typeof workspace !== "object") throw new Error("Invalid stored workspace metadata.");
  if (!Array.isArray(workspace.history) || workspace.history.length !== 0) throw new Error("Captured payloads must be stored separately.");
  storedIds(document.historyIds, "history");
  if (document.version === 2) {
    if (document.commitId !== undefined && (typeof document.commitId !== "string" || !document.commitId)) {
      throw new Error("Invalid editable commit identity.");
    }
    storedIds(document.requestIds, "request");
    storedIds(document.draftIds, "draft");
    if (!workspace.requests || typeof workspace.requests !== "object" || Array.isArray(workspace.requests)
      || Object.keys(workspace.requests).length !== 0 || !workspace.drafts || typeof workspace.drafts !== "object"
      || Array.isArray(workspace.drafts) || Object.keys(workspace.drafts).length !== 0) {
      throw new Error("Editable records must be stored separately.");
    }
  }
  if (document.warning !== null && typeof document.warning !== "string") throw new Error("Invalid storage warning.");
  return { ...document, workspace };
}

function storedIds(value: unknown, kind: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !id
    || ["__proto__", "constructor", "prototype"].includes(id)) || new Set(value).size !== value.length) {
    throw new Error(`Invalid stored ${kind} identities.`);
  }
}

function snapshotEditableWorkspace(workspace: WorkspaceData, previous: WorkspaceData | null = null): WorkspaceData {
  const { requests, drafts, history: _history, ...metadata } = workspace;
  return {
    ...copyJsonValue(metadata),
    requests: snapshotRecords(requests, previous?.requests),
    drafts: snapshotRecords(drafts, previous?.drafts),
    history: [],
  };
}

function snapshotRecords<T>(records: Record<string, T>, previous: Record<string, T> = {}): Record<string, T> {
  return Object.fromEntries(Object.entries(records).map(([id, value]) => [
    id, sameJsonValue(previous[id], value) ? previous[id] : copyJsonValue(value),
  ]));
}

function editableChanges(workspace: WorkspaceData, previous: WorkspaceData | null, rewrite = false): WorkspaceRecordChanges {
  return {
    requests: changedRecords(workspace.requests, rewrite ? undefined : previous?.requests),
    drafts: changedRecords(workspace.drafts, rewrite ? undefined : previous?.drafts),
    removedRequestIds: Object.keys(previous?.requests ?? {}).filter(id => !Object.prototype.hasOwnProperty.call(workspace.requests, id)),
    removedDraftIds: Object.keys(previous?.drafts ?? {}).filter(id => !Object.prototype.hasOwnProperty.call(workspace.drafts, id)),
  };
}

function changedRecords<T>(records: Record<string, T>, previous: Record<string, T> = {}): Record<string, T> {
  return Object.fromEntries(Object.entries(records).filter(([id, value]) => !sameJsonValue(previous[id], value)));
}

function materializeChanges(changes: WorkspaceRecordChanges): WorkspaceRecordChanges {
  return {
    ...changes,
    requests: Object.fromEntries(Object.entries(changes.requests).map(([id, request]) => [id, storedRequest(request)])),
    drafts: Object.fromEntries(Object.entries(changes.drafts).map(([id, draft]) => [id, { ...draft, request: storedRequest(draft.request) }])),
  };
}

function storedRequest(request: RequestData): RequestData {
  return { ...request, body: bodyText(request.body) };
}

function historyWarning(count: number, reason: string): string {
  return `Definitions and drafts are saved. ${count} history capture${count === 1 ? "" : "s"} ${reason} and will not be restored after reload.`;
}

function isQuotaError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "name" in error && error.name === "QuotaExceededError";
}

function copyJsonValue<T>(value: T): T {
  // Copy mutable containers while retaining immutable strings and document
  // revisions. Comparing later input never walks the shared text internals or
  // compares a separately parsed multi-megabyte string.
  if (isBodyDocument(value)) return value;
  if (Array.isArray(value)) return value.map(copyJsonValue) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJsonValue(item)])) as T;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (isBodyDocument(left) || isBodyDocument(right)) return false;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;

  const leftFields = left as Record<string, unknown>;
  const rightFields = right as Record<string, unknown>;
  const keys = Object.keys(leftFields);
  return keys.length === Object.keys(rightFields).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(rightFields, key)
      && sameJsonValue(leftFields[key], rightFields[key]));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
