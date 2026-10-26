# JSON formatting computation

Medium read-only JSON previews use a pure Rust formatter compiled to WebAssembly
inside the existing preview worker. Vue owns presentation and original response
text; the worker owns one computation and all of its Wasm memory. Explicit
editable formatting and previews of at most 64 Ki UTF-16 units retain the
TypeScript formatter. Bodies above 512 Ki units retain the raw paged viewer.

## Application interface

Call [formatJsonPreview](../src/components/jsonPreview.ts) rather than loading
Wasm from a component:

```ts
const controller = new AbortController();
const result = await formatJsonPreview(source, controller.signal);
if (result.status === "formatted") showPreview(result.text);
controller.abort(); // Rejects unfinished work with AbortError and terminates its worker.
```

The source is immutable. `formatted` supplies a complete replacement preview;
`invalid` means the complete source is malformed; `too-large` means its formatted
output exceeds 512 Ki UTF-16 units; `unavailable` covers asset loading or runtime
failure. Every unsuccessful outcome leaves the original response usable. Invalid
source takes precedence over the output budget. The component retains its
existing original-first display, Raw preference, interaction protection, and
cached completed previews.

[jsonPreview.worker.ts](../src/components/jsonPreview.worker.ts) loads the asset
asynchronously, then performs the synchronous computation. Cancelling terminates
the worker even while Rust is running; an abort message alone could not interrupt
a synchronous Wasm call. Replacing the response or deactivating/unmounting its
inspector uses that same cancellation boundary.

## Rust core and Wasm adapter

[json-formatter](../crates/json-formatter/src/lib.rs) has no browser or Tauri
dependencies. Its public operation accepts UTF-16 units and an inclusive output
budget:

```rust
use json_formatter::format_json;

let source: Vec<u16> = r#"{"id":9007199254740993,"values":[1,2,]}"#
    .encode_utf16().collect();
let output = format_json(&source, 512 * 1024)?;
```

Validation uses an iterative container stack, followed by source-token
formatting. No payload values are decoded or serialized. This preserves comments,
trailing commas, duplicate keys, numeric notation, string escapes, and valid raw
UTF-16 units. Raw unpaired surrogates are rejected, matching the editor grammar;
escaped surrogate tokens remain valid and retain their spelling. UTF-8 input
conversion would silently replace malformed surrogates before validation and
change how output lengths are counted. Successful output is well-formed UTF-16,
so JavaScript can decode it with a native fatal UTF-16 decoder. Deep nesting does
not rely on the native or Wasm call stack. Unlike Lezer's parser complexity
heuristic, the Rust validator accepts valid deeply nested source, then reports
`too-large` when its indentation would exceed the preview budget. Generated
whitespace is checked against that budget before allocation.

[json-formatter-wasm](../crates/json-formatter-wasm/src/lib.rs) exposes a small
private ABI used only by
[jsonFormatterRuntime.ts](../src/wasm/jsonFormatterRuntime.ts):

1. `job_new(length)` allocates one owned input buffer.
2. `job_text(job)` and `job_length(job)` describe its current UTF-16 buffer.
   JavaScript copies the original text into that input.
3. `job_format(job, limit)` returns 0 for formatted, 1 for invalid, or 2 for an
   exceeded output budget. Success replaces the job's input with its output.
4. JavaScript obtains a fresh memory view, copies successful output to a string,
   then calls `job_free(job)` in a `finally` block for every outcome.

Pointers are valid only for the owning live job. Formatting can replace a buffer
and grow linear memory, so previous host views must not be reused afterward.
There is no global mutable job/result slot. Ordinary completion frees the job;
worker termination releases the complete instance during cancellation or a trap.
Only the adapter uses unsafe Rust, with ownership requirements documented on each
export. The host never exposes those pointers to components.

[jsonFormatter.ts](../src/wasm/jsonFormatter.ts) fetches Vite's emitted local asset
and compiles its bytes. This avoids depending on the native asset server's Wasm
MIME type. No external network service or generated binding CLI is required.

## Build and verification

Install stable Rust and its target once:

```sh
rustup target add wasm32-unknown-unknown
```

`pnpm dev`, `pnpm build`, and `pnpm test` first run `pnpm build:wasm`.
[build-wasm.mjs](../scripts/build-wasm.mjs) builds the locked Rust
workspace in release mode and copies the binary into `src/wasm/generated/` for
Vite. Both Cargo output and the copied asset are ignored build products. Run
`pnpm build:wasm` again after Rust changes during a running Vite session.

```sh
cargo test --manifest-path crates/Cargo.toml
cargo fmt --manifest-path crates/Cargo.toml --all -- --check
pnpm test
pnpm build
pnpm perf:formatting
```

The Wasm contract tests load the real compiled binary and compare exact text and
statuses with the TypeScript formatter. They cover malformed syntax, JSONC,
UTF-16 preservation, budgets, deep nesting, and repeated calls. Existing component
tests retain responsibility for presentation, cancellation, and stale results.
The formatting benchmark checks parity before timing and includes host input and
output copies. Its Node measurements describe computation rather than UI paint;
see [UI performance](ui-performance.md) for full application profiling.

For a real browser worker check, run `pnpm dev` and open
`http://localhost:1420/scripts/json-formatting-browser-check.html`. The isolated
synthetic page checks the actual worker/asset loading, exact JSONC output,
invalid input, output expansion, and cancellation without reading saved workspaces.

## Local measurements on 26 October 2026

Node 25.2.0, release Wasm, two warmups and seven timed samples per engine.
Warm-call timings include input and output copying; one-shot timings also include
a fresh Node worker, engine-specific imports, and Wasm binary read/compilation.

| Fixture | Warm TypeScript / Wasm median | Fresh worker TypeScript / Wasm median |
| --- | --- | --- |
| String-rich JSONC, 64 Ki units | 1.255 / 0.271 ms | 34.472 / 22.930 ms |
| String-rich JSONC, 128 Ki units | 2.246 / 0.583 ms | 34.753 / 22.760 ms |
| String-rich JSONC, 400 Ki units | 6.266 / 1.938 ms | 39.643 / 23.417 ms |
| Token-rich JSONC, 128 Ki units | 18.243 / 1.993 ms | 64.412 / 25.466 ms |
| Deep nesting exceeding the output budget | 1.498 / 0.048 ms | 32.011 / 20.623 ms |

The binary is 23,723 bytes. Its first compile/instantiate sample took 0.236 ms,
excluding disk reading. The browser worker smoke check passed all four behaviors;
these timings establish a local computation improvement, rather than browser
paint latency or native Tauri webview performance. Production workers also load
bundled JavaScript rather than Node's TypeScript loader, so their startup timings
must be measured separately before drawing UI latency conclusions.
