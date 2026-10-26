// Owns one lazy response-search worker, with reusable source memory and a cooperative JavaScript fallback.
import { findLargeBodyMatch, LARGE_BODY_QUERY_LIMIT, type LargeBodyRange } from "./largeBody";

/** An active Find session for one immutable response, released when Find closes or its viewer hides. */
export interface LargeBodySearch {
  /** Starts the latest search; aborting or superseding a query preserves the retained response. */
  find(query: string, from: number, direction: 1 | -1, signal: AbortSignal): Promise<LargeBodyRange | null>;
  /** Cancels unfinished work and releases the worker's complete response copy. Idempotent. */
  dispose(): void;
}

/** Creates a session without copying text; the first valid query lazily starts the worker. */
export function createLargeBodySearch(text: string): LargeBodySearch {
  let worker: Worker | undefined;
  let failed = false;
  let disposed = false;
  let nextId = 0;
  let pending: PendingSearch | undefined;

  return {
    find(query, from, direction, signal) {
      if (!text.length || !query || query.length > LARGE_BODY_QUERY_LIMIT) return Promise.resolve(null);
      if (disposed || signal.aborted) return Promise.reject(cancelled());
      pending?.cancel();

      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const controller = new AbortController();
        const finish = (result: LargeBodyRange | null, error?: unknown) => {
          if (pending?.id !== id) return;
          pending = undefined;
          signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(result);
        };
        const abort = () => {
          controller.abort();
          finish(null, cancelled());
          try { worker?.postMessage({ type: "cancel", id } satisfies SearchWorkerRequest); }
          catch { disableWorker(); }
        };
        const current: PendingSearch = {
          id,
          cancel: abort,
          complete: match => finish(match),
          fallback: () => {
            void findLargeBodyMatch(text, query, from, direction, controller.signal)
              .then(match => finish(match), error => finish(null, error));
          },
        };
        pending = current;
        signal.addEventListener("abort", abort, { once: true });

        if (failed) {
          current.fallback();
          return;
        }
        try {
          if (!worker) {
            const created = new Worker(new URL("./largeBodySearch.worker.ts", import.meta.url), { type: "module" });
            worker = created;
            created.onmessage = (event: MessageEvent<SearchWorkerReply>) => {
              if (worker !== created || pending?.id !== event.data.id) return;
              if (event.data.status === "unavailable") disableWorker();
              else pending.complete(event.data.status === "found" ? event.data.match : null);
            };
            created.onerror = event => { event.preventDefault(); disableWorker(); };
            created.onmessageerror = disableWorker;
            created.postMessage({ type: "load", text } satisfies SearchWorkerRequest);
          }
          worker.postMessage({ type: "find", id, query, from, direction } satisfies SearchWorkerRequest);
        } catch {
          disableWorker();
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending?.cancel();
      worker?.terminate();
      worker = undefined;
    },
  };

  function disableWorker() {
    if (failed) return;
    failed = true;
    worker?.terminate();
    worker = undefined;
    pending?.fallback();
  }
}

/** Private messages carry full source once, then only small query/cancellation intents. */
export type SearchWorkerRequest =
  | { type: "load"; text: string }
  | { type: "find"; id: number; query: string; from: number; direction: 1 | -1 }
  | { type: "cancel"; id: number };

/** Only the matching generation can update a session; unavailable switches it permanently to fallback. */
export type SearchWorkerReply =
  | { id: number; status: "found"; match: LargeBodyRange }
  | { id: number; status: "not-found" | "unavailable" };

interface PendingSearch {
  /** Correlates replies so cancelled/replaced queries cannot change the current selection. */
  id: number;
  /** Rejects and aborts both worker and fallback work for this generation. */
  cancel(): void;
  /** Resolves only if this generation still owns the pending search. */
  complete(match: LargeBodyRange | null): void;
  /** Runs the existing bounded JavaScript scanner after a permanent worker failure. */
  fallback(): void;
}

function cancelled(): DOMException {
  return new DOMException("Search cancelled", "AbortError");
}
