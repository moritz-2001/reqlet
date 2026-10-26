// Defines persistent tab descriptors, transient presentation, and commands without exposing tab state.

/** A tab's identity and presentation; request data and panels belong to the caller. */
export interface TabItem {
  /** Stable identity unique within a Tabs instance, independent of title or order. */
  readonly id: string;
  /** Visible title and accessible name of the tab. */
  readonly label: string;
  /** Enables the close action; omitted or false means this tab cannot be closed. */
  readonly closable?: boolean;
}

/** Execution feedback supplied by a caller without making Tabs depend on a transport. */
export type TabExecution =
  | { readonly status: "running" }
  | { readonly status: "success"; readonly httpStatus: number }
  | { readonly status: "error" }
  | { readonly status: "cancelled" };

/** Caller-owned feedback displayed alongside a tab's persistent title. */
export interface TabPresentation {
  /** Marks an editable draft awaiting explicit saving; omitted or false means no draft marker. */
  readonly unsaved?: boolean;
  /** Latest execution for this identity; omission hides feedback before the first execution. */
  readonly execution?: TabExecution;
}

/** Serializable selection and order snapshot emitted after a tab operation. */
export interface TabsState {
  /** Open descriptors in their current visual order, copied from the component's owned state. */
  readonly items: readonly TabItem[];
  /** Selected open identity; null means there are no open tabs. */
  readonly activeId: string | null;
}

/** Commands and read-only status available through a Tabs component reference. */
export interface TabsHandle {
  /** Opens and activates a new tab, or refreshes and activates an existing ID without moving it. */
  open(item: TabItem): void;
  /** Reopens only ids from a prior snapshot at surviving sibling positions, preserving current tabs and selection unless activeId is supplied. */
  restore(snapshot: TabsState, ids: readonly string[], activeId?: string): void;
  /** Closes a closable tab and selects its neighbor when necessary; unknown IDs have no effect. */
  close(id: string): void;
  /** Replaces an open tab's visible label while preserving order, selection, and closability. */
  updateLabel(id: string, label: string): void;
  /** Number of currently open tabs, updated on opening and closing, for external status displays. */
  readonly count: number;
}
