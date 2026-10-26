// Defines the saved collection hierarchy and controlled presentation contract shared by its renderers.
import type { RequestData } from "../request";

/** A sidebar entry; request content is owned separately by the application. */
export type CollectionNode =
  | {
      /** Identifies a folder entry, which may contain folders and requests. */
      readonly kind: "folder";
      /** Stable identity, unique across the collection; preserved when renamed or moved. */
      readonly id: string;
      /** Display name shown in the sidebar. */
      readonly name: string;
      /** Entries in display order; an empty array represents an empty folder. */
      readonly children: readonly CollectionNode[];
    }
  | {
      /** Identifies a saved request reference, which has no children. */
      readonly kind: "request";
      /** Fallback method for standalone rendering; the canonical request registry takes precedence. */
      readonly requestType: string;
      /** Stable request identity, unique across the collection; used to look up request content. */
      readonly id: string;
      /** Fallback display name; rendering uses the canonical request name when available. */
      readonly name: string;
    };

/** Controlled row presentation shared by recursive and windowed collection rendering. */
export interface CollectionTreePresentation {
  /** One manager-owned expansion set shared by all recursive branches. */
  expandedFolderIds: ReadonlySet<string>;
  /** Active editor identity, independent of the entry being managed. */
  selectedRequestId?: string | null;
  /** Canonical request labels and methods; omitted uses reference metadata. */
  requests?: Readonly<Record<string, RequestData>>;
  /** Management target when a folder is selected; does not activate a request. */
  selectedFolderId?: string | null;
  /** Temporary request filter; omission restores normal visibility and expansion. */
  matchingRequestIds?: ReadonlySet<string>;
  /** Precomputed matching ancestors; omission derives them from descendants for standalone callers. */
  matchingFolderIds?: ReadonlySet<string>;
  /** Matching folders manually collapsed for the current query; omission auto-expands all matches without changing normal expansion. */
  searchCollapsedFolderIds?: ReadonlySet<string>;
  /** Menu target whose trigger should appear expanded; omission closes all triggers. */
  actionMenuTargetId?: string | null;
  /** Entry currently being renamed; omission leaves labels as buttons. */
  renamingId?: string | null;
  /** Uncommitted name owned by the manager, independent of canonical data. */
  renameValue?: string;
  /** Validation feedback retained beside the uncommitted name. */
  renameError?: string;
  /** Whether positional moves are currently available; filtering disables them. */
  reorderEnabled?: boolean;
  /** Drag source for visual feedback; null or omission means no active drag. */
  draggedId?: string | null;
  /** Valid effective drop boundary; null or omission hides placement feedback. */
  dropTarget?: { id: string | null; position: "before" | "inside" | "after" | "root" } | null;
}

/** The hierarchy and its controlled interaction state; definitions remain owner-owned. */
export interface CollectionTreeProps extends CollectionTreePresentation {
  /** Ordered root entries; only expanded and matching descendants become visible rows. */
  readonly nodes: readonly CollectionNode[];
  /** False while a sidebar is hidden; activation remeasures the retained scrollport. */
  readonly interactionEnabled?: boolean;
}

/** Applies temporary search-collapse choices independently from remembered browsing expansion. */
export function collectionFolderExpanded(state: CollectionTreePresentation, id: string): boolean {
  return state.matchingRequestIds !== undefined
    ? !state.searchCollapsedFolderIds?.has(id) : state.expandedFolderIds.has(id);
}
