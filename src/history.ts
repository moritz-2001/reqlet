// Execution history retains independent snapshots; appendHistory is the workspace's only insertion operation.
import type { HistoryEntry } from "./request";
import { copyHttpRequest } from "./requestSnapshot";

/** Maximum completed exchanges retained in the locally persisted workspace. */
export const HISTORY_LIMIT = 100;

/** Maximum UTF-8 bytes retained in persisted captures, independently of editable definitions. */
export const HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;

/**
 * Chooses recent complete captures that fit both retention limits. Oversized captures remain
 * available in the current session; callers report omitted captures before saving this subset.
 * A caller retaining detached snapshots may supply their cached, exact serialized UTF-8 size.
 */
export function historyForStorage(
  entries: readonly HistoryEntry[],
  byteLimit = HISTORY_BYTE_LIMIT,
  sizeOf: (entry: HistoryEntry) => number = serializedSize,
): { entries: HistoryEntry[]; omitted: number } {
  const retained: HistoryEntry[] = [];
  let remaining = byteLimit;
  for (const entry of [...entries].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))) {
    if (retained.length === HISTORY_LIMIT) break;
    // UTF-8 cannot use fewer bytes than UTF-16 code units. Avoid serializing a huge
    // response just to discover that it cannot fit in the persistence budget.
    const bodyLength = entry.request.body.length
      + (entry.result.status === "success" ? entry.result.response.body.length : 0);
    if (bodyLength > remaining) continue;

    const size = sizeOf(entry);
    if (size > remaining) continue;
    retained.push(entry);
    remaining -= size;
  }

  return { entries: retained, omitted: entries.length - retained.length };
}

/**
 * Records a completed exchange, newest start first, without sharing its mutable snapshots.
 * Reusing an execution ID replaces the prior record. Equal start times put the new record first.
 */
export function appendHistory(entries: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...entries.filter(previous => previous.id !== entry.id)]
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, HISTORY_LIMIT)
    .map(snapshotEntry);
}

function snapshotEntry(entry: HistoryEntry): HistoryEntry {
  return {
    ...entry,
    request: copyHttpRequest(entry.request),
    result: entry.result.status === "success"
      ? {
          status: "success",
          response: {
            ...entry.result.response,
            headers: entry.result.response.headers.map(header => ({ ...header })),
          },
        }
      : { ...entry.result },
  };
}

function serializedSize(entry: HistoryEntry): number {
  return new TextEncoder().encode(JSON.stringify(entry)).byteLength;
}
