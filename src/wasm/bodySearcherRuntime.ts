// Retains one response in Wasm memory and yields between bounded literal-search scans.
import { LARGE_BODY_QUERY_LIMIT, type LargeBodyRange } from "../components/largeBody.ts";

// Worker task ranges are independent of the visible page size. Vectorized scans
// keep these ranges short while avoiding one MessageChannel round trip per page.
const searchChunkSize = 256 * 1024;

/** A retained response computation. Disposing invalidates pending and future nonempty searches. */
export interface BodySearcher {
  /** Searches original UTF-16 offsets with wraparound; aborting preserves the retained response. */
  find(query: string, from: number, direction: 1 | -1, signal: AbortSignal): Promise<LargeBodyRange | null>;
  /** Releases source memory. Pending searches stop before their next Wasm scan. */
  dispose(): void;
}

/** Copies a response once, off the UI thread; subsequent queries reuse its original UTF-16 units. */
export async function createBodySearcher(module: WebAssembly.Module, text: string): Promise<BodySearcher> {
  const wasm = new WebAssembly.Instance(module).exports as unknown as SearchExports;
  const sourceLength = text.length;
  const document = wasm.buffer_new(sourceLength);
  // One channel belongs to the retained response. Reusing it avoids allocating
  // hundreds of channel pairs per full scan while still yielding real tasks.
  const tasks = createSearchTasks();
  try {
    const input = new Uint16Array(wasm.memory.buffer, wasm.buffer_text(document), text.length);
    for (let from = 0; from < text.length; from += 256 * 1024) {
      const to = Math.min(text.length, from + 256 * 1024);
      for (let index = from; index < to; index += 1) input[index] = text.charCodeAt(index);
      if (to < text.length) await tasks.wait();
    }
  } catch (error) {
    wasm.buffer_free(document);
    tasks.dispose();
    throw error;
  }

  let disposed = false;
  return {
    async find(query, from, direction, signal) {
      if (!sourceLength || !query || query.length > LARGE_BODY_QUERY_LIMIT || Number.isNaN(from)) return null;
      checkActive();
      const queryBuffer = wasm.buffer_new(query.length);
      let compiled: number;
      try {
        const input = new Uint16Array(wasm.memory.buffer, wasm.buffer_text(queryBuffer), query.length);
        for (let index = 0; index < query.length; index += 1) input[index] = query.charCodeAt(index);
        compiled = wasm.query_new(queryBuffer);
      } finally {
        wasm.buffer_free(queryBuffer);
      }
      if (!compiled) return null;

      try {
        // Forward filters inclusive match starts; backward filters exclusive
        // match-end boundaries, preserving the legacy behavior for fractional offsets.
        const roundedFrom = direction === 1 ? Math.ceil(from) : Math.floor(from);
        const start = Math.min(sourceLength, Math.max(0, roundedFrom));
        const segments = direction === 1
          ? [{ from: start, to: sourceLength }, { from: 0, to: start }]
          : [{ from: 0, to: start }, { from: start, to: sourceLength }];
        for (const segment of segments) {
          for (let cursor = direction === 1 ? segment.from : segment.to;
            direction === 1 ? cursor < segment.to : cursor > segment.from;) {
            await tasks.wait();
            checkActive();
            const from = direction === 1 ? cursor : Math.max(segment.from, cursor - searchChunkSize);
            const to = direction === 1 ? Math.min(segment.to, cursor + searchChunkSize) : cursor;
            const packed = wasm.scan_range(document, compiled, from, to, Number(direction === -1));
            if (packed !== -1n) {
              return { from: Number((packed >> 32n) & 0xffff_ffffn), to: Number(packed & 0xffff_ffffn) };
            }
            cursor = direction === 1 ? to : from;
          }
        }
        return null;
      } finally {
        wasm.query_free(compiled);
      }

      function checkActive() {
        if (disposed || signal.aborted) throw new DOMException("Search cancelled", "AbortError");
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      wasm.buffer_free(document);
      tasks.dispose();
    },
  };
}

/** A response-owned task queue gives cancellation messages a turn without recreating channels per chunk. */
function createSearchTasks() {
  const channel = typeof MessageChannel === "undefined" ? undefined : new MessageChannel();
  const waiting: (() => void)[] = [];
  if (channel) channel.port1.onmessage = () => waiting.shift()?.();

  return {
    wait(): Promise<void> {
      if (!channel) return new Promise(resolve => setTimeout(resolve, 0));
      return new Promise(resolve => {
        waiting.push(resolve);
        channel.port2.postMessage(null);
      });
    },
    dispose() {
      channel?.port1.close();
      channel?.port2.close();
      // Wake suspended scans so they observe disposal and release their query
      // handles in finally, rather than stranding unresolved promises.
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

/** Private ownership ABI; only document handles survive between searches. */
interface SearchExports {
  /** Linear memory; views must be recreated after allocations that can grow it. */
  memory: WebAssembly.Memory;
  /** Allocates a zeroed UTF-16 source/query buffer owned by the host. */
  buffer_new(length: number): number;
  /** Borrows the current input pointer for filling a live buffer. */
  buffer_text(buffer: number): number;
  /** Releases a live source/query buffer exactly once. */
  buffer_free(buffer: number): void;
  /** Copies query matching state; the input buffer is no longer needed afterward. */
  query_new(buffer: number): number;
  /** Releases one compiled query after its last scan. */
  query_free(query: number): void;
  /** Returns packed start/end offsets or signed -1n; ranges bound candidate starts/ends. */
  scan_range(document: number, query: number, from: number, to: number, backward: number): bigint;
}
