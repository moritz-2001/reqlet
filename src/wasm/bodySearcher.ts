// Loads Vite's local search asset for one worker-owned response session.
import wasmUrl from "./generated/body_search.wasm?url";
import { createBodySearcher, type BodySearcher } from "./bodySearcherRuntime";

/** Loads the computation and copies exact source units into its worker-owned Wasm memory. */
export async function loadBodySearcher(text: string): Promise<BodySearcher> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Could not load response search (${response.status}).`);

  return createBodySearcher(await WebAssembly.compile(await response.arrayBuffer()), text);
}
