// Pure navigation filters match canonical requests and captured executions without changing their owners.
import type { CollectionNode } from "./components/collectionTree";
import type { HistoryEntry, RequestData } from "./request";

/** Visible completion categories; HTTP failures remain distinct from transport failures. */
export type HistoryResultFilter = "all" | "http-success" | "http-error" | "transport-error" | "cancelled";

/** Canonical saved-request metadata shared by collection search and keyboard navigation. */
export interface CollectionSearchEntry {
  /** Stable identity used to open the saved request in the workspace. */
  id: string;
  /** Current request name, independent of fallback labels in the collection tree. */
  name: string;
  /** Current editable HTTP method, including custom methods. */
  method: string;
  /** Saved URL text; environment references remain unresolved during navigation. */
  url: string;
  /** Ancestor names separated by " / "; empty for requests at the collection root. */
  folderPath: string;
  /** Ancestors in root-to-parent order, used to reveal matching branches without rescanning subtrees. */
  ancestorFolderIds: readonly string[];
  /** Lowercase metadata prepared once per index revision for repeated query filtering. */
  searchText: string;
}

/** Finds request IDs in tree order, matching every query word across name, URL, method, and folder path. */
export function searchCollectionRequests(
  nodes: readonly CollectionNode[],
  requests: Readonly<Record<string, RequestData>>,
  query: string,
): string[] {
  return filterCollectionRequests(indexCollectionRequests(nodes, requests), query).map(entry => entry.id);
}

/** Captures canonical metadata in tree order; missing definitions are omitted because they cannot be opened. */
export function indexCollectionRequests(
  nodes: readonly CollectionNode[],
  requests: Readonly<Record<string, RequestData>>,
): CollectionSearchEntry[] {
  const indexed: CollectionSearchEntry[] = [];

  function visit(entries: readonly CollectionNode[], path: string, ancestorFolderIds: readonly string[]) {
    for (const node of entries) {
      if (node.kind === "folder") {
        visit(node.children, path ? `${path} / ${node.name}` : node.name, [...ancestorFolderIds, node.id]);
      } else {
        const request = requests[node.id];
        if (request) indexed.push({
          id: node.id, name: request.name, method: request.method, url: request.path, folderPath: path,
          ancestorFolderIds,
          searchText: `${request.name} ${request.method} ${request.path} ${path}`.toLocaleLowerCase(),
        });
      }
    }
  }

  visit(nodes, "", []);
  return indexed;
}

/** Keeps entries whose metadata contains every whitespace-separated query word, preserving input order. */
export function filterCollectionRequests(entries: readonly CollectionSearchEntry[], query: string): CollectionSearchEntry[] {
  const terms = searchTerms(query);
  return entries.filter(entry => terms.every(term => entry.searchText.includes(term)));
}

/** Filters captured metadata in its supplied order; request bodies and credentials are not searched. */
export function filterHistoryEntries(
  entries: readonly HistoryEntry[],
  query: string,
  resultFilter: HistoryResultFilter,
): HistoryEntry[] {
  const terms = searchTerms(query);
  return entries.filter(entry => {
    const matchesResult = resultFilter === "all" || historyResultCategory(entry) === resultFilter;
    return matchesResult && matchesTerms(`${entry.name} ${entry.request.method} ${entry.request.url}`, terms);
  });
}

/** Classifies an exchange by HTTP status when a response exists, otherwise by its completion reason. */
export function historyResultCategory(entry: HistoryEntry): Exclude<HistoryResultFilter, "all"> {
  if (entry.result.status === "success") return entry.result.response.status >= 400 ? "http-error" : "http-success";
  return entry.result.status === "error" ? "transport-error" : "cancelled";
}

function searchTerms(query: string): string[] {
  return query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
}

function matchesTerms(value: string, terms: readonly string[]): boolean {
  const normalized = value.toLocaleLowerCase();
  return terms.every(term => normalized.includes(term));
}
