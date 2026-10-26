// Bounds large response pages and cooperatively searches original text without copying the complete body.

/** Read-only bodies above this UTF-16 length use raw, bounded pages instead of whole-document JSON tools. */
export const LARGE_BODY_THRESHOLD = 512 * 1024;
/** Maximum UTF-16 length supplied to a large response's plain-text editor. */
export const LARGE_BODY_PAGE_SIZE = 64 * 1024;
/** Bounds the overlap needed to find a literal spanning two search chunks. */
export const LARGE_BODY_QUERY_LIMIT = 4096;
// Reserve one code unit so moving a boundary away from CRLF or a surrogate pair still fits the page budget.
const pageStride = LARGE_BODY_PAGE_SIZE - 1;

/** Half-open offsets into the original response, before the editor normalizes line endings. */
export interface LargeBodyRange {
  /** Inclusive UTF-16 offset in the original source. */
  readonly from: number;
  /** Exclusive UTF-16 offset in the original source. */
  readonly to: number;
}

/** Returns the fixed page count without inspecting or copying response contents. */
export function largeBodyPageCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / pageStride));
}

/** Locates the fixed page containing a source offset; boundaries preserve Unicode pairs and CRLF. */
export function largeBodyPageIndex(text: string, offset: number): number {
  const index = Math.min(largeBodyPageCount(text) - 1, Math.max(0, Math.floor(offset / pageStride)));
  return index + 1 < largeBodyPageCount(text) && offset >= boundary(text, (index + 1) * pageStride)
    ? index + 1 : index;
}

/** Returns one bounded, contiguous page; consecutive pages reconstruct the exact original response. */
export function largeBodyPage(text: string, index: number): LargeBodyRange {
  const page = Math.min(largeBodyPageCount(text) - 1, Math.max(0, index));
  return { from: boundary(text, page * pageStride), to: boundary(text, (page + 1) * pageStride) };
}

/** Keeps a match spanning a page boundary visible in one bounded window. Ordinary page navigation stays fixed. */
export function largeBodyMatchPage(text: string, match: LargeBodyRange): LargeBodyRange {
  const page = largeBodyPage(text, largeBodyPageIndex(text, match.from));
  if (match.to <= page.to) return page;

  const from = boundary(text, match.from);
  return { from, to: boundary(text, from + pageStride) };
}

/**
 * Finds the next/previous case-insensitive literal in original source order, wrapping once.
 * Work yields between bounded chunks; aborting rejects with AbortError and never returns a stale match.
 * `from` is inclusive for forward searches and an exclusive match-end boundary for backward searches.
 */
export async function findLargeBodyMatch(
  text: string, query: string, from: number, direction: 1 | -1, signal: AbortSignal,
): Promise<LargeBodyRange | null> {
  if (!query || query.length > LARGE_BODY_QUERY_LIMIT) return null;

  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const start = Math.min(text.length, Math.max(0, from));
  const segments: LargeBodyRange[] = direction === 1
    ? [{ from: start, to: text.length }, { from: 0, to: start }]
    : [{ from: 0, to: start }, { from: start, to: text.length }];
  for (const segment of segments) {
    if (direction === 1) {
      for (let offset = segment.from; offset < segment.to; offset += LARGE_BODY_PAGE_SIZE) {
        await yieldSearch(signal);
        const end = Math.min(segment.to, offset + LARGE_BODY_PAGE_SIZE);
        const window = searchWindow(text, offset, Math.min(text.length, end + query.length - 1));
        expression.lastIndex = offset - window.from;
        for (let match = expression.exec(window.text); match; match = expression.exec(window.text)) {
          const from = window.from + match.index;
          if (from >= offset && from < end) return { from, to: from + match[0].length };
          if (from >= end) break;

          // Unicode regexes can move lastIndex back when it points into a pair.
          // Skip that earlier match without hiding overlapping matches after it.
          expression.lastIndex = match.index + (window.text.codePointAt(match.index)! > 0xffff ? 2 : 1);
        }
      }
    } else {
      for (let end = segment.to; end > segment.from; end -= LARGE_BODY_PAGE_SIZE) {
        await yieldSearch(signal);
        const offset = Math.max(segment.from, end - LARGE_BODY_PAGE_SIZE);
        const window = searchWindow(text, Math.max(0, offset - query.length + 1), end);
        expression.lastIndex = 0;
        let found: LargeBodyRange | null = null;
        for (let match = expression.exec(window.text); match; match = expression.exec(window.text)) {
          const range = { from: window.from + match.index, to: window.from + match.index + match[0].length };
          if (range.to <= end && range.to > offset && range.to > segment.from) found = range;
          // Backward navigation chooses the rightmost literal, including overlapping
          // occurrences. Advance by a complete code point so Unicode regexes cannot
          // move lastIndex back into the same surrogate pair.
          expression.lastIndex = match.index + (window.text.codePointAt(match.index)! > 0xffff ? 2 : 1);
        }
        if (found) return found;
      }
    }
  }
  return null;
}

function searchWindow(text: string, from: number, to: number): { from: number; text: string } {
  // Keep complete source code points around both edges: a split valid pair must
  // not become a false match for a lone-surrogate query. Callers filter this
  // extra context against their original search bounds.
  const start = boundary(text, from);
  const end = boundary(text, to) < to ? to + 1 : to;
  return { from: start, text: text.slice(start, end) };
}

function boundary(text: string, offset: number): number {
  const position = Math.min(text.length, offset);
  if (position > 0 && position < text.length) {
    const before = text.charCodeAt(position - 1);
    const after = text.charCodeAt(position);
    if (before === 13 && after === 10 || before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      return position - 1;
    }
  }
  return position;
}

function yieldSearch(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // MessageChannel yields to rendering/input without nested setTimeout's browser
    // delay. The fallback also lets DOM test environments exercise cancellation.
    const channel = typeof MessageChannel === "undefined" ? undefined : new MessageChannel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      channel?.port1.close();
      channel?.port2.close();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Search cancelled", "AbortError"));
    };
    const finish = () => {
      cleanup();
      if (signal.aborted) reject(new DOMException("Search cancelled", "AbortError"));
      else resolve();
    };
    if (channel) {
      channel.port1.onmessage = finish;
      channel.port2.postMessage(null);
    } else timer = setTimeout(finish, 0);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
