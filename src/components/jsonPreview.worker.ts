// Computes source-preserving JSONC previews in Rust/Wasm, isolated from the UI thread.
import type { JsonPreviewResult } from "./jsonPreview";
import { LARGE_BODY_THRESHOLD } from "./largeBody";
import { loadJsonFormatter } from "../wasm/jsonFormatter";

// A worker owns one preview. Catch initialization failure immediately, even if
// loading finishes before its source message arrives, so Raw remains available.
const formatter = loadJsonFormatter().catch(() => undefined);

self.onmessage = async (event: MessageEvent<string>) => {
  let result: JsonPreviewResult;
  try {
    const format = await formatter;
    result = format ? format(event.data, LARGE_BODY_THRESHOLD) : { status: "unavailable" };
  } catch {
    result = { status: "unavailable" };
  }
  self.postMessage(result);
};
