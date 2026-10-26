// Retains one response computation while cancellable, generation-scoped queries scan in bounded chunks.
import { loadBodySearcher } from "../wasm/bodySearcher";
import type { BodySearcher } from "../wasm/bodySearcherRuntime";
import type { SearchWorkerRequest, SearchWorkerReply } from "./largeBodySearch";

let searcher: Promise<BodySearcher | undefined> | undefined;
// The active query owns its controller; newer queries and cancel messages stop
// only its scan, preserving the worker's response for subsequent searches.
let active: { id: number; controller: AbortController } | undefined;

self.onmessage = async (event: MessageEvent<SearchWorkerRequest>) => {
  const request = event.data;
  if (request.type === "load") {
    searcher ??= loadBodySearcher(request.text).catch(() => undefined);
    return;
  }
  if (request.type === "cancel") {
    if (active?.id === request.id) active.controller.abort();
    return;
  }

  active?.controller.abort();
  const controller = new AbortController();
  active = { id: request.id, controller };
  try {
    const document = await searcher;
    if (controller.signal.aborted) return;
    if (!document) {
      reply({ id: request.id, status: "unavailable" });
      return;
    }
    const match = await document.find(request.query, request.from, request.direction, controller.signal);
    if (!controller.signal.aborted) {
      reply(match ? { id: request.id, status: "found", match } : { id: request.id, status: "not-found" });
    }
  } catch {
    if (!controller.signal.aborted) reply({ id: request.id, status: "unavailable" });
  } finally {
    if (active?.id === request.id) active = undefined;
  }
};

function reply(result: SearchWorkerReply) {
  self.postMessage(result);
}
