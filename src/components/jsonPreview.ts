// Runs medium-sized read-only JSON formatting outside the UI thread; each request owns its worker lifetime.

/** Complete formatting outcome; unavailable keeps the original response usable when workers cannot run. */
export type JsonPreviewResult =
  | { status: "formatted"; text: string }
  | { status: "invalid" }
  | { status: "too-large" }
  | { status: "unavailable" };

/** Formats one immutable source, releasing its worker on completion, failure, or cancellation. */
export function formatJsonPreview(text: string, signal: AbortSignal): Promise<JsonPreviewResult> {
  if (signal.aborted) return Promise.reject(new DOMException("Formatting cancelled", "AbortError"));

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL("./jsonPreview.worker.ts", import.meta.url), { type: "module" }); }
    catch { resolve({ status: "unavailable" }); return; }

    function dispose() {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    }
    function abort() {
      dispose();
      reject(new DOMException("Formatting cancelled", "AbortError"));
    }
    function finish(result: JsonPreviewResult) {
      dispose();
      resolve(result);
    }
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<JsonPreviewResult>) => finish(event.data);
    worker.onerror = event => { event.preventDefault(); finish({ status: "unavailable" }); };
    worker.onmessageerror = () => finish({ status: "unavailable" });
    try { worker.postMessage(text); }
    catch { finish({ status: "unavailable" }); }
  });
}
