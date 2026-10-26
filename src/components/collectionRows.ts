// Projects visible collection rows without mounting components or copying request definitions.
import { collectionFolderExpanded, type CollectionNode, type CollectionTreeProps } from "./collectionTree";

/** One visible entry, retaining its real sibling and hierarchy context when other rows are unmounted. */
export interface CollectionRow {
  /** Canonical entry reference; request content remains in the owner's registry. */
  readonly node: CollectionNode;
  /** Zero-based indentation; accessibility exposes this as a one-based level. */
  readonly depth: number;
  /** One-based position among the visible siblings at this level. */
  readonly position: number;
  /** Visible sibling count, independent of the viewport window. */
  readonly siblingCount: number;
  /** Index of this entry's last visible descendant, including an empty-folder placeholder. */
  readonly subtreeEnd: number;
  /** True for the extra inside-drop message after an expanded empty folder. */
  readonly empty: boolean;
}

/** Produces one depth-first projection for filtering, viewport placement, focus, and subtree boundaries. */
export function visibleCollectionRows(props: CollectionTreeProps): readonly CollectionRow[] {
  const rows: CollectionRow[] = [];
  const matchingFolders = props.matchingFolderIds ?? deriveMatchingFolders(props.nodes, props.matchingRequestIds);
  const matches = (node: CollectionNode) => props.matchingRequestIds === undefined
    || (node.kind === "request" ? props.matchingRequestIds.has(node.id) : matchingFolders.has(node.id));
  function visit(nodes: readonly CollectionNode[], depth: number) {
    const visible = nodes.filter(matches);
    for (let index = 0; index < visible.length; index++) {
      const node = visible[index]!;
      const start = rows.length;
      const row = { node, depth, position: index + 1, siblingCount: visible.length, subtreeEnd: start, empty: false };
      rows.push(row);
      if (node.kind === "folder" && collectionFolderExpanded(props, node.id)) {
        if (node.children.length) visit(node.children, depth + 1);
        else rows.push({ ...row, depth: depth + 1, empty: true });
      }
      row.subtreeEnd = rows.length - 1;
    }
  }
  visit(props.nodes, 0);
  return rows;
}

function deriveMatchingFolders(nodes: readonly CollectionNode[], requestIds?: ReadonlySet<string>): ReadonlySet<string> {
  const matching = new Set<string>();
  if (requestIds === undefined) return matching;
  function visit(entries: readonly CollectionNode[]): boolean {
    let found = false;
    for (const node of entries) {
      const childMatches = node.kind === "request" ? requestIds!.has(node.id) : visit(node.children);
      if (childMatches && node.kind === "folder") matching.add(node.id);
      found ||= childMatches;
    }
    return found;
  }
  visit(nodes);
  return matching;
}
