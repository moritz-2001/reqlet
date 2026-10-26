# UI performance

The performance boundaries are pure JSON editing policies, controlled editor
updates, deferred presentation, debounced persistence, and bounded navigation
DOM. Functional regressions belong in the existing component/repository tests;
wall-clock measurements use production browser runs or the explicit benchmark.

## Reproducing measurements

`pnpm perf:indentation 32 128 512` measures `jsonNewlineEdit` with already-parsed
real syntax trees. It performs two warmups and reports the median, minimum, and
maximum of seven samples for each size/layout. Parsing, Vue, CodeMirror
transactions, and rendering are excluded; these numbers describe the indentation
policy rather than end-to-end Enter latency.

Build a production UI and serve it with the isolated fixture harness:

```sh
pnpm build
pnpm perf:ui dist 17428 /tmp/reqlet-ui-performance.jsonl
```

Open `http://127.0.0.1:17428/?mib=0.4&run=response-1` in the browser. This
loopback origin deliberately seeds synthetic IndexedDB data on each load; use
the harness port rather than an origin containing real work.

Optional fixture parameters exercise more than response display:

| Parameter | Default | Purpose |
| --- | --- | --- |
| `mib` | 1 | Synthetic response size, bounded by the server to 64 MiB. |
| `requests` | 2 | Up to 5,000 saved definitions; extra requests live in initially collapsed groups of 100. |
| `history` | 0 | Up to 100 independent small captures restored through the real repository. |
| `bodymib` | 0 | Up to 2 MiB of editable minified JSON in the active request only. |
| `tabs` | 2 | Up to the saved-definition count restored as open tabs. |
| `fields` | 0 | Up to 5,000 editable headers in the active request. |
| `run` | manual | Label written alongside every measurement. |

For example, use
`http://127.0.0.1:17428/?mib=0.2&requests=2000&history=100&bodymib=0.125&run=workspace-1`.
Then type in the request, press Enter, search collections/body text, open and page
QuickOpen, drag the divider/collection rows, and send the request. The fixture
does not mock application timing, transport, storage, editors, or UI actions.

The fixture seeds separate version-2 editable records, matching production
restoration and saves. The harness writes action-to-two-animation-frame timings, observed long tasks,
timer gaps, initial response visibility, and deferred preview completion to JSONL.
`editor-key:*` timings begin in the capture phase before editor key handlers;
they cover keyboard interaction as well as model publication and paint.
`response-visible` measures the first body display, which can be original text
while formatting is pending. `preview-ready` measures when that work settles;
invalid/over-budget previews keep the original view. `startup-after-seed` excludes
fixture creation but includes application import, repository restoration, and mount.
The harness waits for Vue's completed mount before scheduling the two paint
frames. Earlier startup samples could stop before asynchronous restoration
finished and are not comparable to the startup comparison below.
Inspect task traces for attribution: overlapping activity can affect these timings,
and timer gaps are not equivalent to long-task duration.

## Measurements on 2026-10-26

Measurements were taken locally; browser runs used Chrome 155 at 1280 × 720.
The single browser samples establish useful checks rather than distributions or
native Tauri-webview guarantees. Transport duration is included in visibility.

| Scenario | Original | Updated |
| --- | --- | --- |
| 512 KiB minified JSON indentation policy | 27,611 ms, single sample | 17.33 ms, seven-sample median |
| 0.4 MiB response first visible body | 134.3 ms | 55.6 ms |
| Observed longest task in that response window | 116 ms | None reported above the browser's long-task threshold |

The response comparison deliberately measures the new original-text-first flow
against eager Pretty rendering. Updated formatting settled at 137 ms; this
fixture exceeds the formatted-output budget and remains Raw. A separate 0.2 MiB
response, with 2,000 definitions and 100 restored captures, appeared at 56.5 ms
and completed a valid Pretty preview at 114.7 ms. Those workspace fixtures mounted
22 collection rows while collapsed; QuickOpen rendered 50 of 2,000 results and
successfully paged to results 51–100. Real pointer checks confirmed divider resizing
and collection movement on release.

## Startup comparison on 2026-10-26

Startup now overlaps App loading with storage restoration, batches record reads
within the IndexedDB adapter, and loads the OpenAPI/YAML parser when previewing
an import. The storage and synchronous parser interfaces are unchanged.
The native HTTP client initializes on a blocking worker on first use rather than
before opening the window; that preparation remains cancellable and precedes
the transport timeout.

| Measurement | Before | After |
| --- | --- | --- |
| 2,000 definitions, 100 captures, two tabs: browser startup median | 131.2 ms | 86.1 ms |
| Two definitions, no captures, two tabs: browser startup median | 38.4 ms | 35.5 ms |
| `pnpm dev` to Vite ready, warm median | 671.4 ms | 445.6 ms |
| Initial production JavaScript, uncompressed | 836.9 kB | 723.9 kB |

Browser timings use five repeated loads per fixture after warmup at 1280 × 720
in Chrome 155. Use `?requests=2000&history=100&tabs=2&run=startup-large-1`
with the harness above, and repeat with `requests=2&history=0` for the smaller
fixture. These measure loading through the first mounted workspace paint, after
fixture creation; they exclude native process and window creation. The small
fixture difference is only a few milliseconds and is sensitive to frame timing.
The large fixture still produced occasional 52–53 ms tasks during restoration.

Development timings use three process launches of
`pnpm run dev --host 127.0.0.1 --port 17435`, stopping each owned process after
Vite prints its local URL. Calling `node scripts/build-wasm.mjs` directly in
the development script removes a nested package-manager launch while preserving
Cargo's build and freshness checks. Vite itself stayed around 111–127 ms; native
compilation and webview loading are outside this measurement. A native source
rebuild still took 5.48 s locally, versus about 177 ms for a cached Cargo build.

Native client construction alone took a 5.07 ms median across ten fresh-process
samples (4.40–5.81 ms), now deferred to first execution. This is separate from
the browser and development measurements. Raw startup samples and measurement
boundaries are in [startup-measurements.json](ui-performance/startup-measurements.json).

## Resource and interaction limits

- JSON Enter indexes lines once, preserving global/local indentation evidence.
  It still traverses the available syntax tree; it is not a constant-time operation.
- Folding uses immutable editor text and parser-derived ranges, avoiding complete
  document copies, interior substrings, and sorting. Candidate derivation still
  traverses the available tree when it changes.
- Editable request updates publish immutable BodyDocument revisions sharing
  CodeMirror's persistent text. Equal parent echoes share the same root; Send,
  copy/export, and changed-record saves materialize strings explicitly.
- Read-only JSON sources above 64 Ki UTF-16 units format in a cancellable worker.
  Its [Rust/Wasm formatter](wasm-json-formatting.md) now avoids building a full
  Lezer tree; the comparison benchmark includes the JS/Wasm input/output copies.
  Previews have a separate 512 Ki-unit output budget. Raw mode skips formatting;
  selection/search begun during preparation prevents automatic document replacement.
- Read-only bodies above 512 Ki units use the existing paged viewer before JSON
  work. Full transport buffering and native IPC remain proportional to body size.
- Template target metadata updates immediately; complete body validation waits for
  200 ms without edits. Send and export always validate synchronously.
- Autosave batches typing after 200 ms of quiet, with a one-second deadline unless
  an earlier write is still running. `flush()` bypasses timers. Saves validate the
  workspace but retain detached unchanged records and atomically write only changed
  definitions/drafts with compact metadata. Legacy localStorage saves remain whole-document.
- Collection DOM contains only expanded matching branches; more than 200 visible
  entries use a viewport window. Large key/value and header tables, URL parameter
  tables, horizontal tab strips, and tab pickers also bound mounted entries.
  QuickOpen pages retain at most 50 options. Logical keyboard targets, edited
  rows, and pointer capture survive viewport changes.
- Collection pointer work is coalesced into animation frames with invalidated
  geometry caches; release remeasures/revalidates. Pane sizes persist once after
  completed drags, while cancellation discards local preview state.

Further work should follow representative traces: background request tooling,
incremental validation, other deferred tools, and native webview profiles remain
candidates. Include multiple repetitions and report
input-to-paint p95 when comparing interactive behavior.

## Incremental bodies and windowed workspace verification

The incremental-model, changed-record storage, and windowed-list changes were
checked in a production Chrome 155 browser at 1280 × 720 with 2,000 definitions,
2,000 restored tabs, 100 captures, 2,000 headers, and a 2 MiB editable JSON body.
Collection filtering exposed all 2,000 logical requests while mounting only the
viewport window. Scrolling reached request 1,999; adding header 2,001 revealed and
focused its input while retaining bounded table rows. Tests additionally exercise
3,000 expanded collection rows, offscreen validation, tab navigation and reorder,
dynamic-height measurement, and record migration/concurrent-save conflicts.

This combined stress fixture still recorded a 125 ms task during a JSON typing
interaction. Removing full-string model publication does not bound full-document
linting, folding, search counts, or global metadata traversal. These changes do
not establish a lag-free guarantee or a native-webview timing distribution.

`pnpm perf:formatting` compares the current TypeScript formatter with Rust/Wasm
using exact output/status parity before timing. It reports warm complete calls
and one-shot Node workers; see [JSON formatting computation](wasm-json-formatting.md)
for measured results and their limits.

`pnpm perf:search` compares cooperative JavaScript large-response Find with the
persistent SIMD Wasm worker. The worker retains one source copy while Find is
open and yields between 256 Ki-unit scans. First-search copying and warm query
latencies are reported separately. Results vary by query; see
[response search computation](wasm-response-search.md) for the full comparison,
memory ownership, and cold setup cost.
