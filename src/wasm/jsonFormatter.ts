// Loads the bundled computation asset once per preview worker; Vite emits its production URL.
import wasmUrl from "./generated/json_formatter.wasm?url";
import { createJsonFormatter, type JsonFormatter } from "./jsonFormatterRuntime";

/** Fetches and compiles the local asset without relying on the webview serving a Wasm MIME type. */
export async function loadJsonFormatter(): Promise<JsonFormatter> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Could not load the JSON formatter (${response.status}).`);

  return createJsonFormatter(await WebAssembly.compile(await response.arrayBuffer()));
}
