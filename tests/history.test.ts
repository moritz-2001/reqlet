// Verifies bounded, independent execution snapshots through the public history insertion interface.
import { expect, it } from "vitest";
import { appendHistory, HISTORY_BYTE_LIMIT, HISTORY_LIMIT, historyForStorage } from "../src/history";
import type { HistoryEntry } from "../src/request";

it("retains the newest execution starts first, even when completion arrives out of order", () => {
  const newest = entry("newest", "2026-10-22T12:00:00Z");
  const oldest = entry("oldest", "2026-10-22T10:00:00Z");
  const middle = entry("middle", "2026-10-22T11:00:00Z");
  const previous = [oldest, newest];

  expect(appendHistory(previous, middle).map(item => item.id)).toEqual(["newest", "middle", "oldest"]);
  expect(previous).toEqual([oldest, newest]);
});

it("keeps at most the newest 100 records and does not displace them with an older execution", () => {
  const entries = Array.from({ length: HISTORY_LIMIT + 5 }, (_, index) => entry(
    `execution-${index}`, new Date(Date.UTC(2026, 9, 22, 12, index)).toISOString(),
  ));
  const history = appendHistory(entries, entry("too-old", "2026-10-21T12:00:00Z"));

  expect(history).toHaveLength(100);
  expect(history[0].id).toBe("execution-104");
  expect(history[99].id).toBe("execution-5");
  expect(entries).toHaveLength(105);
});

it("replaces a reused execution identity and puts the supplied record first for equal timestamps", () => {
  const previous = entry("same-id");
  const other = entry("other-id");
  const replacement = { ...previous, name: "Replacement", result: { status: "cancelled" } } as HistoryEntry;
  const history = appendHistory([other, previous], replacement);

  expect(history.map(item => item.id)).toEqual(["same-id", "other-id"]);
  expect(history[0].name).toBe("Replacement");
  expect(history[0].result).toEqual({ status: "cancelled" });
  expect(previous.name).toBe("Create item");
});

it("owns independent request and response snapshots for new and retained entries", () => {
  const previous = entry("previous", "2026-10-22T10:00:00Z");
  const incoming = entry("incoming");
  incoming.request.sensitiveHeaderNames = ["x-key"];
  previous.request.sensitiveHeaderNames = ["x-previous"];
  const history = appendHistory([previous], incoming);

  incoming.request.headers[0].value = "changed-secret";
  incoming.request.body = "changed request";
  if (incoming.result.status === "success") {
    incoming.result.response.headers[0].value = "text/html";
    incoming.result.response.body = "changed response";
  }
  previous.request.headers[0].value = "changed previous";
  incoming.request.sensitiveHeaderNames.push("changed");
  previous.request.sensitiveHeaderNames[0] = "changed";
  expect(history[0].request.headers[0].value).toBe("Bearer captured-secret");
  expect(history[0].request.body).toBe('{"name":"original"}');
  expect(history[0].result).toMatchObject({
    status: "success", response: { body: '{"id":1}', headers: [{ name: "Content-Type", value: "application/json" }] },
  });
  expect(history[1].request.headers[0].value).toBe("Bearer captured-secret");
  expect(history[0].request.sensitiveHeaderNames).toEqual(["x-key"]);
  expect(history[1].request.sensitiveHeaderNames).toEqual(["x-previous"]);

  history[1].request.url = "https://changed.test";
  if (history[1].result.status === "success") history[1].result.response.headers[0].value = "text/plain";
  expect(previous.request.url).toBe("https://api.example.test/items?name=original");
  expect(previous.result).toMatchObject({ status: "success", response: { headers: [{ value: "application/json" }] } });
});

it("retains failure and cancellation as independent completed results", () => {
  const failed = { ...entry("failed"), result: { status: "error", error: "Connection refused" } } as HistoryEntry;
  const cancelled = { ...entry("cancelled"), result: { status: "cancelled" } } as HistoryEntry;
  const history = appendHistory([failed], cancelled);

  failed.result = { status: "error", error: "Changed error" };
  expect(history.map(item => item.result)).toEqual([
    { status: "cancelled" }, { status: "error", error: "Connection refused" },
  ]);
  expect(history[0].result).not.toBe(cancelled.result);
});

it("retains complete captures at the exact serialized UTF-8 boundary, including escapes and metadata", () => {
  const capture = entry("utf8");
  capture.request.body = "é😀\n\"\\";
  capture.name = "測定";
  if (capture.result.status === "success") capture.result.response.body = "\u0000é😀\t";
  const exact = new TextEncoder().encode(JSON.stringify(capture)).byteLength;

  expect(historyForStorage([capture], exact)).toEqual({ entries: [capture], omitted: 0 });
  expect(historyForStorage([capture], exact - 1)).toEqual({ entries: [], omitted: 1 });
});

it("does not serialize captures whose request or response body already exceeds the storage budget", () => {
  const response = entry("response");
  if (response.result.status === "success") response.result.response.body = "x".repeat(HISTORY_BYTE_LIMIT + 1);
  const request = entry("request");
  request.request.body = "x".repeat(HISTORY_BYTE_LIMIT + 1);
  const sizeOf = () => { throw new Error("Oversized bodies must not be serialized to discover their size."); };

  expect(historyForStorage([request, response], HISTORY_BYTE_LIMIT, sizeOf)).toEqual({ entries: [], omitted: 2 });
});

it("chooses the newest 100 storable captures without changing the input order", () => {
  const entries = Array.from({ length: HISTORY_LIMIT + 2 }, (_, index) => entry(
    `execution-${index}`, new Date(Date.UTC(2026, 9, 22, 12, index)).toISOString(),
  ));
  const result = historyForStorage(entries);

  expect(result.entries.map(item => item.id)).toEqual(entries.slice(2).reverse().map(item => item.id));
  expect(result.omitted).toBe(2);
  expect(entries[0].id).toBe("execution-0");
});

function entry(id: string, startedAt = "2026-10-22T11:00:00Z"): HistoryEntry {
  return {
    id, requestId: "saved-request", name: "Create item", startedAt,
    request: {
      method: "POST", url: "https://api.example.test/items?name=original",
      headers: [{ name: "Authorization", value: "Bearer captured-secret" }],
      body: '{"name":"original"}', timeoutMs: 30000,
    },
    result: {
      status: "success",
      response: {
        url: "https://api.example.test/items?name=original", status: 201, statusText: "Created",
        headers: [{ name: "Content-Type", value: "application/json" }], body: '{"id":1}',
        durationMs: 24, sizeBytes: 8,
      },
    },
  };
}
