// WorkspaceData is the persisted application document; storage failures leave existing data untouched.
import type { CollectionNode } from "./components/collectionTree";
import type { SplitSizes } from "./components/splitPane";
import { createRequest } from "./request";
import type { Environment, HistoryEntry, HttpRequest, RequestData } from "./request";
import { parseWorkspace } from "./workspaceValidation";

/** Versioned saved definitions and user preferences, excluding live operations and editor internals. */
export interface WorkspaceData {
  /** Schema discriminator; unsupported versions are preserved until a compatible application loads them. */
  version: 1;
  /** Shared local protobuf projects; catalogs are loaded separately at runtime. */
  protobufSources?: import("./protobuf").ProtobufSource[];
  /** Saved definitions keyed by stable request IDs, independently of tab and collection order. */
  requests: Record<string, RequestData>;
  /** Ordered folders and references into requests; deleting a request removes its reference. */
  collection: readonly CollectionNode[];
  /** Named variable scopes, including any locally saved credentials. */
  environments: Environment[];
  /** Selected environment identity; null means requests resolve without an environment. */
  activeEnvironmentId: string | null;
  /** Completed exchanges with resolved snapshots; entries may outlive deleted definitions. */
  history: HistoryEntry[];
  /** Draft definitions retained independently of Collections, whether open or recently closed. */
  drafts: Record<string, WorkspaceDraft>;
  /** Recently closed draft identities, newest first; reopening removes an identity from this list. */
  closedDraftIds: string[];
  /** Open saved-request and draft identities in visual order; history snapshots remain transient. */
  openTabIds: string[];
  /** Selected open saved-request or draft identity; null means no persistent tabs are open. */
  activeTabId: string | null;
  /** Preferred divider positions, independent of temporary measured geometry and minimum sizes. */
  layout: {
    /** Sidebar preferences; omission uses the component's default split. */
    sidebar?: SplitSizes;
    /** Request/response preferences keyed by request identity; missing entries use defaults. */
    requests: Record<string, SplitSizes>;
  };
}

/** Locally autosaved work that has not yet been added to Collections. */
export interface WorkspaceDraft {
  /** Editable definition restored on reload and retained when its tab closes. */
  request: RequestData;
  /** Exact history inputs until the first edit; omission prepares the definition using its literal or template mode. */
  capturedRequest?: HttpRequest;
  /** Divider preferences transferred to the saved request on promotion; omission uses editor defaults. */
  layout?: SplitSizes;
}

/** Minimal local-storage contract; injectable to test unavailable or full storage without browser globals. */
export interface WorkspaceStorage {
  /** Reads the stored document, returning null before the workspace has been saved. */
  getItem(key: string): string | null;
  /** Atomically replaces a document, or throws while preserving the previous value. */
  setItem(key: string, value: string): void;
}

/** Stable key shared by loading, autosaving, and explicit manual recovery. */
export const WORKSPACE_STORAGE_KEY = "api-tool.workspace";

/** Starts an independent workspace with editable examples and no simulated response data. */
export function createWorkspace(): WorkspaceData {
  const requests: Record<string, RequestData> = {
    "create-workspace": {
      ...createRequest("Create workspace"), method: "POST", path: "{{baseUrl}}/workspaces",
      body: '{"name":"Example workspace","settings":{"notifications":true}}',
    },
    "list-workspaces": {
      ...createRequest("List workspaces"), path: "{{baseUrl}}/workspaces",
    },
    "invite-member": {
      ...createRequest("Invite member"), method: "POST", path: "{{baseUrl}}/workspaces/ws_8f29/members",
      body: '{"email":"member@example.com","role":"member"}',
    },
  };

  return {
    version: 1,
    requests,
    collection: [
      {
        kind: "folder", id: "workspaces", name: "Workspaces", children: [
          { kind: "request", id: "create-workspace", name: requests["create-workspace"].name, requestType: "POST" },
          { kind: "request", id: "list-workspaces", name: requests["list-workspaces"].name, requestType: "GET" },
          {
            kind: "folder", id: "workspace-members", name: "Members", children: [
              { kind: "request", id: "invite-member", name: requests["invite-member"].name, requestType: "POST" },
            ],
          },
        ],
      },
      { kind: "folder", id: "drafts", name: "Drafts", children: [] },
    ],
    environments: [{ id: "local", name: "Local", variables: [{ name: "baseUrl", value: "http://localhost:8080", enabled: true }] }],
    activeEnvironmentId: "local",
    history: [], drafts: {}, closedDraftIds: [], openTabIds: [], activeTabId: null, layout: { requests: {} },
  };
}

/** Loads a validated document, or an unsaved starter plus a readable error without altering stored bytes. */
export function loadWorkspace(storage?: WorkspaceStorage): { workspace: WorkspaceData; error: string | null } {
  try {
    const serialized = resolveStorage(storage).getItem(WORKSPACE_STORAGE_KEY);
    return { workspace: serialized === null ? createWorkspace() : parseStoredWorkspace(serialized), error: null };
  } catch (error) {
    return { workspace: createWorkspace(), error: `Could not load workspace: ${message(error)}` };
  }
}

/** Saves a complete document; invalid existing data blocks autosave to preserve recoverable user data. */
export function saveWorkspace(workspace: WorkspaceData, storage?: WorkspaceStorage): void {
  const target = resolveStorage(storage);
  const previous = target.getItem(WORKSPACE_STORAGE_KEY);
  if (previous !== null) {
    try {
      parseStoredWorkspace(previous);
    } catch (error) {
      throw new Error(`Saved workspace is unreadable and was preserved. Back up and remove localStorage["${WORKSPACE_STORAGE_KEY}"] to start fresh. ${message(error)}`);
    }
  }

  parseWorkspace(workspace);
  try {
    target.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
  } catch (error) {
    throw new Error(`Local storage could not save the workspace: ${message(error)}`);
  }
}

function resolveStorage(storage?: WorkspaceStorage): WorkspaceStorage {
  const target = storage ?? globalThis.localStorage;
  if (!target) throw new Error("Local storage is unavailable in this environment.");
  return target;
}

function parseStoredWorkspace(serialized: string): WorkspaceData {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Saved workspace contains invalid JSON.");
  }
  return parseWorkspace(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
