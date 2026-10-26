// Verifies reusable whole-response search sessions through cancellation, worker replies, and fallback results.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LARGE_BODY_QUERY_LIMIT } from "../src/components/largeBody";
import { createLargeBodySearch } from "../src/components/largeBodySearch";

beforeEach(() => {
  vi.stubGlobal("Worker", SearchWorker);
});

afterEach(() => {
  for (const search of searches.splice(0)) search.dispose();
  workers.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads the original source once and reuses it across successive queries and directions", async () => {
  const text = "first 😀 second first";
  const search = session(text);
  expect(workers).toHaveLength(0);
  const first = search.find("first", 0, 1, signal());
  expect(workers).toHaveLength(1);
  const worker = workers[0]!;
  expect(worker.messages[0]).toEqual({ type: "load", text });
  const firstRequest = worker.findRequests()[0]!;
  expect(firstRequest).toMatchObject({ query: "first", from: 0, direction: 1 });
  worker.reply({ id: firstRequest.id, status: "found", match: { from: 0, to: 5 } });
  await expect(first).resolves.toEqual({ from: 0, to: 5 });

  const second = search.find("second", text.length, -1, signal());
  const secondRequest = worker.findRequests()[1]!;
  expect(secondRequest).toMatchObject({ query: "second", from: text.length, direction: -1 });
  expect(secondRequest.id).not.toBe(firstRequest.id);
  worker.reply({ id: secondRequest.id, status: "found", match: { from: 9, to: 15 } });
  await expect(second).resolves.toEqual({ from: 9, to: 15 });
  expect(workers).toHaveLength(1);
  expect(worker.messages.filter(message => message.type === "load")).toEqual([{ type: "load", text }]);
  expect(worker.terminated).toBe(false);
});

it("returns null for an absent worker match", async () => {
  const search = session("source");
  const pending = search.find("missing", 0, 1, signal());
  const worker = workers[0]!;
  worker.reply({ id: worker.findRequests()[0]!.id, status: "not-found" });
  await expect(pending).resolves.toBeNull();
});

it("aborts promptly while retaining the loaded source for the next query", async () => {
  const search = session("first second");
  const controller = new AbortController();
  const pending = search.find("first", 0, 1, controller.signal);
  const aborted = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const worker = workers[0]!;
  const firstRequest = worker.findRequests()[0]!;
  controller.abort();
  await aborted;
  expect(worker.messages).toContainEqual({ type: "cancel", id: firstRequest.id });
  expect(worker.terminated).toBe(false);

  const next = search.find("second", 0, 1, signal());
  const secondRequest = worker.findRequests()[1]!;
  worker.reply({ id: secondRequest.id, status: "found", match: { from: 6, to: 12 } });
  await expect(next).resolves.toEqual({ from: 6, to: 12 });
  expect(workers).toHaveLength(1);
  expect(worker.messages.filter(message => message.type === "load")).toHaveLength(1);
});

it("supersedes an in-flight query and ignores stale replies until the current query completes", async () => {
  const search = session("first second");
  const first = search.find("first", 0, 1, signal());
  const superseded = expect(first).rejects.toMatchObject({ name: "AbortError" });
  const worker = workers[0]!;
  const firstRequest = worker.findRequests()[0]!;
  const second = search.find("second", 0, 1, signal());
  const secondRequest = worker.findRequests()[1]!;
  await superseded;
  expect(worker.messages).toContainEqual({ type: "cancel", id: firstRequest.id });

  let settled = false;
  void second.then(() => { settled = true; });
  worker.reply({ id: firstRequest.id, status: "found", match: { from: 0, to: 5 } });
  worker.reply({ id: firstRequest.id, status: "unavailable" });
  worker.reply({ id: secondRequest.id + 1, status: "not-found" });
  await Promise.resolve();
  expect(settled).toBe(false);
  worker.reply({ id: secondRequest.id, status: "found", match: { from: 6, to: 12 } });
  await expect(second).resolves.toEqual({ from: 6, to: 12 });
  expect(worker.terminated).toBe(false);
});

it("disposes pending work, releases the worker, and tolerates late replies and repeated disposal", async () => {
  const search = session("first second");
  const pending = search.find("first", 0, 1, signal());
  const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const worker = workers[0]!;
  const request = worker.findRequests()[0]!;
  search.dispose();
  await cancelled;
  expect(worker.terminated).toBe(true);
  worker.reply({ id: request.id, status: "found", match: { from: 0, to: 5 } });
  expect(() => search.dispose()).not.toThrow();
  expect(workers).toHaveLength(1);
});

it("ignores an old query's later abort after another query has started", async () => {
  const search = session("first second");
  const controller = new AbortController();
  const first = search.find("first", 0, 1, controller.signal);
  const worker = workers[0]!;
  worker.reply({ id: worker.findRequests()[0]!.id, status: "found", match: { from: 0, to: 5 } });
  await first;

  const second = search.find("second", 0, 1, signal());
  const request = worker.findRequests()[1]!;
  controller.abort();
  worker.reply({ id: request.id, status: "found", match: { from: 6, to: 12 } });
  await expect(second).resolves.toEqual({ from: 6, to: 12 });
  expect(worker.messages).not.toContainEqual({ type: "cancel", id: request.id });
});

it("does not allocate a worker for empty sources or empty and over-limit queries, including aborted requests", async () => {
  const controller = new AbortController();
  controller.abort();
  for (const source of ["", "some text"]) {
    const search = session(source);
    for (const query of ["", "x".repeat(LARGE_BODY_QUERY_LIMIT + 1)]) {
      await expect(search.find(query, 0, 1, controller.signal)).resolves.toBeNull();
    }
  }
  await expect(session("").find("valid", 0, 1, controller.signal)).resolves.toBeNull();
  await expect(session("").find("valid", 0, -1, signal())).resolves.toBeNull();
  expect(workers).toHaveLength(0);
});

it("rejects valid pre-aborted queries before creating a worker", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(session("source").find("source", 0, 1, controller.signal))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(workers).toHaveLength(0);
});

it.each(["construction", "load", "find", "error", "messageerror", "unavailable"] as const)(
  "preserves literal Unicode results and falls back permanently after worker %s failure",
  async failure => {
    let constructionAttempts = 0;
    if (failure === "construction") {
      vi.stubGlobal("Worker", class {
        constructor() {
          constructionAttempts++;
          throw new Error("Worker unavailable");
        }
      });
    } else if (failure === "load" || failure === "find") {
      const postMessage = SearchWorker.prototype.postMessage;
      vi.spyOn(SearchWorker.prototype, "postMessage").mockImplementation(function (this: SearchWorker, message) {
        if (message.type === failure) throw new Error("Cannot post to worker");
        postMessage.call(this, message);
      });
    }

    const text = "😀 xx [Needle] yy [NEEDLE]";
    const firstOffset = text.indexOf("[Needle]");
    const secondOffset = text.indexOf("[NEEDLE]");
    const search = session(text);
    const first = search.find("[needle]", 0, 1, signal());
    if (failure === "error") workers[0]!.fail();
    else if (failure === "messageerror") workers[0]!.messageError();
    else if (failure === "unavailable") {
      const worker = workers[0]!;
      worker.reply({ id: worker.findRequests()[0]!.id, status: "unavailable" });
    }
    await expect(first).resolves.toEqual({ from: firstOffset, to: firstOffset + 8 });
    await expect(search.find("[needle]", firstOffset + 8, 1, signal()))
      .resolves.toEqual({ from: secondOffset, to: secondOffset + 8 });
    await expect(search.find("[needle]", firstOffset, -1, signal()))
      .resolves.toEqual({ from: secondOffset, to: secondOffset + 8 });
    await expect(search.find("missing", 0, 1, signal())).resolves.toBeNull();
    if (failure === "construction") expect(constructionAttempts).toBe(1);
    else {
      expect(workers).toHaveLength(1);
      expect(workers[0]!.terminated).toBe(true);
    }
  },
);

it("preserves prompt cancellation after falling back from an unavailable worker", async () => {
  const search = session("x".repeat(1024 * 1024));
  const controller = new AbortController();
  const pending = search.find("missing", 0, 1, controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const worker = workers[0]!;
  worker.reply({ id: worker.findRequests()[0]!.id, status: "unavailable" });
  controller.abort();
  await cancelled;
  expect(worker.terminated).toBe(true);

  const nextController = new AbortController();
  const next = search.find("missing", 0, 1, nextController.signal);
  const nextCancelled = expect(next).rejects.toMatchObject({ name: "AbortError" });
  nextController.abort();
  await nextCancelled;
  expect(workers).toHaveLength(1);
});

it("supersedes and disposes in-flight fallback searches even when their caller signals remain active", async () => {
  vi.stubGlobal("Worker", class { constructor() { throw new Error("Worker unavailable"); } });
  const search = session("x".repeat(1024 * 1024));
  const firstSignal = signal();
  const first = search.find("missing", 0, 1, firstSignal);
  const firstCancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
  const secondSignal = signal();
  const second = search.find("absent", 0, -1, secondSignal);
  const secondCancelled = expect(second).rejects.toMatchObject({ name: "AbortError" });
  await firstCancelled;
  search.dispose();
  await secondCancelled;
  expect(firstSignal.aborted).toBe(false);
  expect(secondSignal.aborted).toBe(false);
});

type SearchSession = ReturnType<typeof createLargeBodySearch>;
type FindRequest = { type: "find"; id: number; query: string; from: number; direction: 1 | -1 };
type Request = { type: "load"; text: string } | FindRequest | { type: "cancel"; id: number };
type Reply =
  | { id: number; status: "found"; match: { from: number; to: number } }
  | { id: number; status: "not-found" | "unavailable" };
const searches: SearchSession[] = [];
const workers: SearchWorker[] = [];

class SearchWorker {
  messages: Request[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<Reply>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor() { workers.push(this); }
  postMessage(message: Request) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(reply: Reply) { this.onmessage?.(new MessageEvent("message", { data: reply })); }
  fail() { this.onerror?.(new Event("error", { cancelable: true })); }
  messageError() { this.onmessageerror?.(); }
  findRequests(): FindRequest[] { return this.messages.filter(message => message.type === "find"); }
}

function session(text: string): SearchSession {
  const search = createLargeBodySearch(text);
  searches.push(search);
  return search;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
