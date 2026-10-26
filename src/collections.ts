// CollectionState and its immutable operations keep the hierarchy and canonical request registry in sync.
import type { CollectionNode } from "./components/collectionTree";
import { createRequest, type RequestData } from "./request";

/** Parent-owned saved requests and the hierarchy that references them. */
export interface CollectionState {
  /** Canonical request definitions keyed by the request node's stable ID. */
  requests: Record<string, RequestData>;
  /** Ordered root entries; folders own their ordered descendants. */
  nodes: readonly CollectionNode[];
}

/** Complete replacement produced by a single collection operation. */
export interface CollectionChange extends CollectionState {
  /** Entry to manage after the operation; null clears a deleted selection. */
  selectedId: string | null;
  /** Removed request IDs, allowing the owner to close tabs and cancel execution before replacement. */
  deletedRequestIds: readonly string[];
  /** Detached recovery snapshot for a deletion; absent for all other operations. */
  deletion?: CollectionDeletion;
  /** Targeted Undo for an effective rename or move; absent for no-ops and recovery. */
  recovery?: CollectionEditRecovery;
}

/** Stable destination shared by folder moves and precise sibling ordering. */
export interface CollectionPlacement {
  /** Containing folder identity; null selects the collection root. */
  readonly parentId: string | null;
  /** Direct child to insert before after removing the source; null appends. */
  readonly beforeId: string | null;
}

/** Minimal information for Undo that preserves newer request content and unrelated entries. */
export type CollectionEditRecovery = {
  /** Distinguishes name recovery from original-location recovery. */
  readonly kind: "rename";
  /** Stable identity of the renamed request or folder. */
  readonly id: string;
  /** Canonical name to restore if the entry still has the committed name. */
  readonly previousName: string;
  /** Committed name, used to reject Undo after a newer rename. */
  readonly name: string;
} | {
  /** Distinguishes original-location recovery from name recovery. */
  readonly kind: "move";
  /** Stable identity of the moved request or entire folder subtree. */
  readonly id: string;
  /** Former containing folder; null means root. Missing folders prevent recovery. */
  readonly parentId: string | null;
  /** Original sibling identities, including the target, used to find surviving neighbors. */
  readonly siblingIds: readonly string[];
};

/** Removed subtree and its former position, retained only until Undo is dismissed or replaced. */
export interface CollectionDeletion {
  /** Independent subtree snapshot, retaining every folder and request identity. */
  node: CollectionNode;
  /** Independent editable definitions for requests referenced by node. */
  requests: Record<string, RequestData>;
  /** Former containing folder; null means root. A missing folder restores at root. */
  parentId: string | null;
  /** Former sibling order anchors insertion without undoing later sibling edits or moves. */
  siblingIds: readonly string[];
}

/** A folder destination with its full path, so equally named folders remain distinguishable. */
export interface CollectionFolder {
  /** Stable folder ID passed as an operation's parentId. */
  id: string;
  /** Human-readable path from the collection root. */
  path: string;
}

/** Adds an independently editable request or an empty folder at the destination's end. */
export function createCollectionNode(
  state: CollectionState,
  kind: CollectionNode["kind"],
  name: string,
  parentId: string | null = null,
  createId: () => string = () => crypto.randomUUID(),
): CollectionChange {
  validateParent(state.nodes, parentId);
  const id = uniqueId(createId, occupiedIds(state));
  const displayName = validateName(name);
  const node: CollectionNode = kind === "folder"
    ? { kind, id, name: displayName, children: [] }
    : { kind, id, name: displayName, requestType: "GET" };

  return {
    requests: kind === "request" ? { ...state.requests, [id]: createRequest(displayName) } : state.requests,
    nodes: appendNode(state.nodes, parentId, node),
    selectedId: id,
    deletedRequestIds: [],
  };
}

/** Renames a saved entry without changing its identity, location, or request content. */
export function renameCollectionNode(state: CollectionState, id: string, name: string): CollectionChange {
  const node = requireNode(state.nodes, id);
  const displayName = validateName(name);
  const previousName = node.kind === "request" ? requireRequest(state, id).name : node.name;
  if (displayName === previousName) return unchangedCollection(state, id);

  const requests = node.kind === "request"
    ? { ...state.requests, [id]: { ...requireRequest(state, id), name: displayName } }
    : state.requests;

  return {
    requests,
    nodes: replaceNode(state.nodes, id, { ...node, name: displayName }),
    selectedId: id,
    deletedRequestIds: [],
    recovery: { kind: "rename", id, previousName, name: displayName },
  };
}

/** Copies a whole subtree with fresh IDs and independent request fields. */
export function duplicateCollectionNode(
  state: CollectionState,
  id: string,
  name: string,
  parentId: string | null,
  createId: () => string = () => crypto.randomUUID(),
): CollectionChange {
  const source = requireNode(state.nodes, id);
  validateParent(state.nodes, parentId);
  const displayName = validateName(name);
  const requests = { ...state.requests };
  const ids = occupiedIds(state);
  const clone = (node: CollectionNode, overrideName?: string): CollectionNode => {
    const cloneId = uniqueId(createId, ids);
    if (node.kind === "folder") {
      return { ...node, id: cloneId, name: overrideName ?? node.name, children: node.children.map(child => clone(child)) };
    }

    const request = requireRequest(state, node.id);
    const requestName = overrideName ?? request.name;
    requests[cloneId] = {
      ...request,
      name: requestName,
      headers: request.headers.map(header => ({ ...header })),
      query: request.query.map(parameter => ({ ...parameter })),
      auth: { ...request.auth },
    };
    return { ...node, id: cloneId, name: requestName, requestType: request.method };
  };
  const copy = clone(source, displayName);

  return { requests, nodes: appendNode(state.nodes, parentId, copy), selectedId: copy.id, deletedRequestIds: [] };
}

/** Moves before a direct child or appends, preserving request objects and complete subtrees. */
export function moveCollectionNode(state: CollectionState, id: string, placement: CollectionPlacement): CollectionChange {
  const node = requireNode(state.nodes, id);
  const { parentId, beforeId } = placement;
  validateParent(state.nodes, parentId);
  if (parentId === id || (node.kind === "folder" && parentId !== null && findCollectionNode(node.children, parentId))) {
    throw new Error("A folder cannot be moved into itself or one of its descendants.");
  }

  const previousParentId = collectionParentId(state.nodes, id);
  const previousSiblings = collectionChildren(state.nodes, previousParentId);
  if (beforeId === id && parentId === previousParentId) return unchangedCollection(state, id);

  const destinationSiblings = collectionChildren(state.nodes, parentId).filter(sibling => sibling.id !== id);
  const destinationIndex = beforeId === null
    ? destinationSiblings.length : destinationSiblings.findIndex(sibling => sibling.id === beforeId);
  if (destinationIndex === -1) throw new Error("The insertion point is no longer in the destination folder.");
  if (parentId === previousParentId && previousSiblings.findIndex(sibling => sibling.id === id) === destinationIndex) {
    return unchangedCollection(state, id);
  }

  const withoutSource = removeNode(state.nodes, id);
  const remainingSiblings = collectionChildren(withoutSource, parentId);
  const siblings = [...remainingSiblings.slice(0, destinationIndex), node, ...remainingSiblings.slice(destinationIndex)];
  const nodes = replaceChildren(withoutSource, parentId, siblings);

  return {
    requests: state.requests, nodes, selectedId: id, deletedRequestIds: [],
    recovery: { kind: "move", id, parentId: previousParentId, siblingIds: previousSiblings.map(sibling => sibling.id) },
  };
}

/** Restores only the recorded name or location against current data, without creating another Undo. */
export function restoreCollectionEdit(state: CollectionState, recovery: CollectionEditRecovery): CollectionChange {
  const node = requireNode(state.nodes, recovery.id);
  if (recovery.kind === "rename") {
    const currentName = node.kind === "request" ? requireRequest(state, node.id).name : node.name;
    if (currentName !== recovery.name) throw new Error("Cannot undo because this entry has been renamed again.");
    const { recovery: _recovery, ...change } = renameCollectionNode(state, node.id, recovery.previousName);
    return change;
  }

  validateParent(state.nodes, recovery.parentId);
  const siblings = collectionChildren(state.nodes, recovery.parentId).filter(sibling => sibling.id !== node.id);
  const originalIndex = recovery.siblingIds.indexOf(node.id);
  const next = recovery.siblingIds.slice(originalIndex + 1).find(id => siblings.some(sibling => sibling.id === id));
  const previous = recovery.siblingIds.slice(0, originalIndex).reverse().find(id => siblings.some(sibling => sibling.id === id));
  const beforeId = next
    ?? (previous ? siblings[siblings.findIndex(sibling => sibling.id === previous) + 1]?.id : null)
    ?? null;
  const { recovery: _recovery, ...change } = moveCollectionNode(state, node.id, { parentId: recovery.parentId, beforeId });
  return change;
}

/** Resolves a one-step sibling move; null means the target is absent or already at that boundary. */
export function collectionSiblingPlacement(
  nodes: readonly CollectionNode[], id: string, direction: -1 | 1,
): CollectionPlacement | null {
  if (!findCollectionNode(nodes, id)) return null;
  const parentId = collectionParentId(nodes, id);
  const siblings = collectionChildren(nodes, parentId);
  const index = siblings.findIndex(node => node.id === id);
  if (index + direction < 0 || index + direction >= siblings.length) return null;

  return { parentId, beforeId: direction === -1 ? siblings[index - 1].id : siblings[index + 2]?.id ?? null };
}

/** Removes an entry and all descendant requests in one immutable operation. */
export function deleteCollectionNode(state: CollectionState, id: string): CollectionChange {
  const node = requireNode(state.nodes, id);
  const deletedRequestIds = collectionRequestIds(node);
  const deleted = new Set(deletedRequestIds);
  const requests = Object.fromEntries(Object.entries(state.requests).filter(([requestId]) => !deleted.has(requestId)));
  const parentId = collectionParentId(state.nodes, id);
  const parent = parentId === null ? undefined : requireNode(state.nodes, parentId);
  const siblings = parent?.kind === "folder" ? parent.children : state.nodes;
  const deletion: CollectionDeletion = {
    node: JSON.parse(JSON.stringify(node)),
    requests: Object.fromEntries(deletedRequestIds.map(requestId => [requestId, cloneRequest(requireRequest(state, requestId))])),
    parentId,
    siblingIds: siblings.map(sibling => sibling.id),
  };

  return { requests, nodes: removeNode(state.nodes, id), selectedId: null, deletedRequestIds, deletion };
}

/** Restores a deletion into current state without replacing newer definitions or hierarchy edits. */
export function restoreCollectionNode(state: CollectionState, deletion: CollectionDeletion): CollectionChange {
  const restoredIds = occupiedIds({ requests: deletion.requests, nodes: [deletion.node] });
  const occupied = occupiedIds(state);
  if ([...restoredIds].some(id => occupied.has(id))) {
    throw new Error("Cannot undo deletion because a recovered identity is already in use.");
  }

  const parent = deletion.parentId === null ? undefined : findCollectionNode(state.nodes, deletion.parentId);
  const siblings = parent?.kind === "folder" ? parent.children : state.nodes;
  const position = restoredPosition(siblings, deletion.siblingIds, deletion.node.id);
  const node: CollectionNode = JSON.parse(JSON.stringify(deletion.node));
  const restoredSiblings = [...siblings.slice(0, position), node, ...siblings.slice(position)];

  return {
    requests: {
      ...state.requests,
      ...Object.fromEntries(Object.entries(deletion.requests).map(([id, request]) => [id, cloneRequest(request)])),
    },
    nodes: parent?.kind === "folder"
      ? replaceNode(state.nodes, parent.id, { ...parent, children: restoredSiblings }) : restoredSiblings,
    selectedId: node.id,
    deletedRequestIds: [],
  };
}

/** Lists all affected requests, including those inside nested folders, in collection order. */
export function collectionRequestIds(node: CollectionNode): string[] {
  return node.kind === "request" ? [node.id] : node.children.flatMap(collectionRequestIds);
}

/** Finds an entry by identity, regardless of its current nesting. */
export function findCollectionNode(nodes: readonly CollectionNode[], id: string): CollectionNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === "folder") {
      const child = findCollectionNode(node.children, id);
      if (child) return child;
    }
  }
  return undefined;
}

/** Returns an entry's containing folder; null represents the root or an absent entry. */
export function collectionParentId(nodes: readonly CollectionNode[], id: string, parentId: string | null = null): string | null {
  for (const node of nodes) {
    if (node.id === id) return parentId;
    if (node.kind === "folder" && findCollectionNode(node.children, id)) {
      return collectionParentId(node.children, id, node.id);
    }
  }
  return null;
}

/** Lists valid folder destinations in display order; root is represented separately by null. */
export function collectionFolders(nodes: readonly CollectionNode[], prefix = ""): CollectionFolder[] {
  return nodes.flatMap(node => {
    if (node.kind !== "folder") return [];
    const path = prefix ? `${prefix} / ${node.name}` : node.name;
    return [{ id: node.id, path }, ...collectionFolders(node.children, path)];
  });
}

function requireNode(nodes: readonly CollectionNode[], id: string): CollectionNode {
  const node = findCollectionNode(nodes, id);
  if (!node) throw new Error("This collection entry no longer exists.");
  return node;
}

function unchangedCollection(state: CollectionState, id: string): CollectionChange {
  return { requests: state.requests, nodes: state.nodes, selectedId: id, deletedRequestIds: [] };
}

function collectionChildren(nodes: readonly CollectionNode[], parentId: string | null): readonly CollectionNode[] {
  if (parentId === null) return nodes;
  const parent = requireNode(nodes, parentId);
  if (parent.kind !== "folder") throw new Error("Choose a folder as the destination.");
  return parent.children;
}

function replaceChildren(
  nodes: readonly CollectionNode[], parentId: string | null, children: readonly CollectionNode[],
): readonly CollectionNode[] {
  if (parentId === null) return children;
  const parent = requireNode(nodes, parentId);
  if (parent.kind !== "folder") throw new Error("Choose a folder as the destination.");
  return replaceNode(nodes, parentId, { ...parent, children });
}

function requireRequest(state: CollectionState, id: string): RequestData {
  const request = state.requests[id];
  if (!request) throw new Error("This request no longer exists.");
  return request;
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Enter a name for this collection entry.");
  return trimmed;
}

function validateParent(nodes: readonly CollectionNode[], parentId: string | null) {
  if (parentId !== null && requireNode(nodes, parentId).kind !== "folder") {
    throw new Error("Choose a folder as the destination.");
  }
}

function occupiedIds(state: CollectionState): Set<string> {
  const collect = (nodes: readonly CollectionNode[]): string[] => nodes.flatMap(node =>
    node.kind === "folder" ? [node.id, ...collect(node.children)] : [node.id]);
  return new Set([...Object.keys(state.requests), ...collect(state.nodes)]);
}

function uniqueId(createId: () => string, occupied: Set<string>): string {
  const id = createId();
  if (!id || occupied.has(id)) throw new Error("Could not create a unique collection identity. Please try again.");
  occupied.add(id);
  return id;
}

function appendNode(nodes: readonly CollectionNode[], parentId: string | null, entry: CollectionNode): readonly CollectionNode[] {
  return replaceChildren(nodes, parentId, [...collectionChildren(nodes, parentId), entry]);
}

function replaceNode(nodes: readonly CollectionNode[], id: string, replacement: CollectionNode): readonly CollectionNode[] {
  const replaced = nodes.map(node => {
    if (node.id === id) return replacement;
    if (node.kind !== "folder") return node;
    const children = replaceNode(node.children, id, replacement);
    return children === node.children ? node : { ...node, children };
  });
  return replaced.some((node, index) => node !== nodes[index]) ? replaced : nodes;
}

function removeNode(nodes: readonly CollectionNode[], id: string): readonly CollectionNode[] {
  const remaining = nodes.filter(node => node.id !== id).map(node => {
    if (node.kind !== "folder") return node;
    const children = removeNode(node.children, id);
    return children === node.children ? node : { ...node, children };
  });
  return remaining.length !== nodes.length || remaining.some((node, index) => node !== nodes[index]) ? remaining : nodes;
}

function restoredPosition(siblings: readonly CollectionNode[], originalIds: readonly string[], id: string): number {
  const originalIndex = originalIds.indexOf(id);
  const next = originalIds.slice(originalIndex + 1).find(candidate => siblings.some(node => node.id === candidate));
  if (next) return siblings.findIndex(node => node.id === next);

  const previous = originalIds.slice(0, originalIndex).reverse().find(candidate => siblings.some(node => node.id === candidate));
  return previous ? siblings.findIndex(node => node.id === previous) + 1 : Math.min(originalIndex, siblings.length);
}

function cloneRequest(request: RequestData): RequestData {
  // Definitions are JSON-persistable data. Detach every nested editable field so
  // a cached editor or caller retaining old objects cannot mutate recovery data.
  return JSON.parse(JSON.stringify(request));
}
