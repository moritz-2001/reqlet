# Large response search computation

Large-response Find keeps one immutable response in a worker-owned Wasm buffer.
Vue owns the query, current page, visible selection, and feedback. The worker
retains source units across query changes and Next/Previous, and returns only
half-open UTF-16 match offsets. Opening a large response alone does no search work.

## Session interface and ownership

[createLargeBodySearch](../src/components/largeBodySearch.ts) creates a lazy
session without copying the response. Its first valid query starts the worker:

```ts
const search = createLargeBodySearch(response.body);
const controller = new AbortController();
const match = await search.find("request-id", 0, 1, controller.signal);
// Continue forward from match.to; backward from match.from.
controller.abort(); // Cancels this query while retaining the response.
search.dispose(); // Cancels all work and releases the complete worker/response copy.
```

`find` supersedes unfinished work, rejects cancelled queries with `AbortError`,
and ignores stale worker replies. Empty/over-limit queries and empty bodies
return `null` without allocating a worker. Queries are limited to 4,096 UTF-16
units. Forward navigation accepts match starts at or after `from`; backward
navigation accepts match ends at or before `from`, including overlapping matches.
Each direction wraps once, including matches crossing the original navigation
boundary. Source positions and line endings are never normalized by search.

[LargeBodyViewer.vue](../src/components/LargeBodyViewer.vue) retains the session
while Find is open. Query changes, Cancel search, and page navigation abort only
the current query. Closing Find, replacing the response, deactivating a cached
editor, or unmounting releases the session. Reactivation creates a new session
only when an open Find panel still has a query. The editor receives one bounded
page containing the selected match, with the existing CRLF-to-editor offset
translation.

[largeBodySearch.worker.ts](../src/components/largeBodySearch.worker.ts) receives
the source once, then only small query/generation messages. Source copying yields
between 256 Ki-unit blocks, and scans yield between 256 Ki candidate ranges so
the worker can receive cancellation and replacement queries. The latest query's
controller prevents stale replies; terminating the worker releases everything
immediately when its session closes.
A single response-owned MessageChannel schedules these task boundaries and is
closed on disposal; pending waits are resolved so suspended scans can free their
query handles rather than retaining unresolved promises.

If a worker cannot start, its asset cannot load, or execution fails, the session
switches permanently to the existing cooperative JavaScript
[findLargeBodyMatch](../src/components/largeBody.ts). It retains the same query
and cancellation contract, without retrying a failed worker on every keystroke.
Fallback also receives a session-owned controller, so superseding/disposal does
not depend on the caller aborting its own signal.

## Pure Rust core

[body-search](../crates/body-search/src/lib.rs) compiles a `SearchQuery` once and
borrows the unchanged UTF-16 source for each bounded `find_in_range` call.
Forward ranges bound candidate starts `[from, to)`; backward ranges bound candidate
ends `(from, to]`. Bounded context includes matches crossing chunk boundaries,
while complete-source scalar inspection prevents matching a lone surrogate
against half of a valid pair.

Matching uses Unicode 17 default simple case folding from the official
[CaseFolding data](https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt), with
common and simple mappings only. It includes Kelvin sign, long s, final sigma,
sharp-s case pairs, and supplementary-plane letters. It does not expand `ß` to
`ss`, apply Turkish locale rules, or normalize combining sequences. This matches
the existing escaped `/giu` literal contract for that Unicode version. Older
webview engines may differ for newly introduced Unicode case pairs.

The pinned input and Unicode license are retained in the crate. Regenerate its
fold table with `python3 crates/body-search/generate_simple_fold.py`; normal
builds require no network or generator. Public Rust types document each owned
table and its relationship to forward/reverse matching.

Wasm uses SIMD to filter eight UTF-16 candidate anchors at a time, then verifies
the complete literal and scalar boundaries. Bounded comparison work falls back
to linear forward/reverse KMP matching for repetitive or adversarial input.
Native builds use a folded-unit Horspool skip table with the same KMP fallback.
Only the search asset requires SIMD128; unsupported engines use the JavaScript
fallback. Vector loads are bounded by validated source ranges, with scalar tails;
the small unsafe SIMD section documents that bounds proof directly in source.

The [Wasm adapter](../crates/body-search-wasm/src/lib.rs) owns source/query input
buffers and compiled-query handles. Its private `scan_range` ABI packs start/end
offsets into one 64-bit result, with all bits set for no match. The
[runtime bridge](../src/wasm/bodySearcherRuntime.ts) releases short-lived query
handles in `finally` blocks and recreates memory views after allocations.
Disposal invalidates pending scans before freeing the source; the core retains
no borrowed source references between calls.

## Memory and performance boundary

An active Find session adds one UTF-16 Wasm response copy (two bytes per source
unit), plus small query tables. The worker's temporary JavaScript source clone
can be collected after initialization; returned search closures retain only its
length. Closing or hiding the session releases the entire worker rather than
keeping large buffers in cached editors. This remains bounded in-memory search,
with the existing 64 MiB transport limit and paged display contract.

The first query includes worker startup, source cloning, asset loading, and the
initial copy into Wasm. Repeated queries reuse that copy. `pnpm perf:search`
measures those phases separately and compares persistent-worker query latency
with the existing cooperative JavaScript scanner at 1, 8, and 64 Mi source units.
It checks result parity before timing and includes short, long, Unicode,
overlapping, forward, backward, and missing-query scenarios. Node timings do not
measure browser paint or native webview latency.

### Local measurements on 26 October 2026

Node 25.2.0, Unicode 17, release Wasm with SIMD; one warmup and five timed samples.
The persistent worker uses 256 Ki-unit scan ranges and one reused MessageChannel.
Both engines perform the same queries on a 64 Mi UTF-16-unit synthetic response;
warm worker times include request/reply messages and range computation.

| Query | JavaScript median | Wasm worker median |
| --- | --- | --- |
| Late ASCII match | 8.753 ms | 15.062 ms |
| Missing ASCII literal | 30.987 ms | 14.972 ms |
| Late Unicode match | 13.891 ms | 15.142 ms |
| Backward match near the beginning | 8.617 ms | 17.798 ms |
| Dense backward match | 0.134 ms | 0.016 ms |
| Missing single character | 22.301 ms | 15.198 ms |
| Repeated-prefix miss | 15.779 ms | 17.044 ms |

The first worker result took 142.074 ms in one sample, including 87.024 ms copying
the body into Wasm and 16.740 ms for the first scan. Those setup costs recur when
Find closes/reopens or its editor is deactivated, because sessions intentionally
release their large source buffers. Repeated missing-literal searches improved
by about 2× and dense backward navigation by about 8× in these fixtures. Other
found-match patterns remain slower than native JavaScript regex. The change moves
search computation off the UI thread; it does not establish a universal latency
improvement, and native webview/browser paint performance remains unmeasured.

## Verification

`pnpm test` builds the actual Wasm binary and checks it against the JavaScript
oracle, including every pinned simple-fold mapping, chunk/wrap boundaries,
overlaps, surrogate halves, query limits, cancellation, and disposal. Session
tests cover permanent fallback and stale replies; rendered component tests cover
worker reuse, close/reopen, response replacement, and KeepAlive lifetime.

For an actual browser worker check, run `pnpm dev` and open
`http://localhost:1420/scripts/body-search-browser-check.html`. The isolated
synthetic page verifies real Wasm replies, Unicode positions, source reuse,
wraparound, cancellation, and worker release without reading saved workspaces.
