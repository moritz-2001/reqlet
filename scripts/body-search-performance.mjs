// Compares large-response Find latency with the legacy scanner and a persistent Wasm worker, including body setup.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const binaryUrl = new URL("../src/wasm/generated/body_search.wasm", import.meta.url);
const warmups = 1;
const repetitions = 5;

if (isMainThread) await benchmark();
else await searchInWorker();

async function benchmark() {
  const { findLargeBodyMatch } = await import("../src/components/largeBody.ts");
  const signal = new AbortController().signal;
  const sizes = process.argv.includes("--quick") ? [1, 8] : [1, 8, 64];

  console.log("Large response search in Node; body sizes are UTF-16 code units, not UTF-8 bytes.");
  console.log(`Legacy calls include cooperative yields; Wasm calls include persistent worker messages. ${warmups} warmup, median of ${repetitions} samples. Browser/UI latency is not measured.`);

  for (const mebi of sizes) {
    const source = bodyFixture(mebi * 1024 * 1024);
    const requests = [
      { label: "late-ascii", query: "end-needle", from: 0, direction: 1 },
      { label: "missing-ascii", query: "absent-response-search-marker", from: 0, direction: 1 },
      { label: "late-unicode-fold", query: "final-ſignal-𐐨", from: 0, direction: 1 },
      { label: "backward-to-start", query: "begin-needle", from: source.length, direction: -1 },
      { label: "dense-backward", query: "e", from: source.length, direction: -1 },
      { label: "missing-single-unit", query: "~", from: 0, direction: 1 },
      { label: "overlapping-prefix-miss", query: "aaaaaaaaaaaaaaaaab", from: 0, direction: 1 },
    ];
    const firstRequest = requests[0];
    const firstExpected = await findLargeBodyMatch(source, firstRequest.query, firstRequest.from, firstRequest.direction, signal);
    const setup = await startWorker(source, firstRequest);
    const worker = setup.session;
    assert.deepEqual(setup.result, firstExpected, `${mebi} Mi first request parity`);
    console.log(JSON.stringify({
      phase: "first-worker-search",
      inputUnits: source.length,
      inputToResultMs: rounded(setup.elapsed),
      workerLoadMs: rounded(setup.timings.loadMs),
      workerBodyCopyMs: rounded(setup.timings.bodyCopyMs),
      workerFirstFindMs: rounded(setup.timings.findMs),
      note: "One first-search sample per body; wall time includes a fresh Node worker, source cloning, imports, binary read/compile, yielded UTF-16 copy, scan, and reply. Body generation is excluded.",
    }));

    try {
      for (const request of requests) {
        const expected = await findLargeBodyMatch(source, request.query, request.from, request.direction, signal);
        assert.deepEqual(await worker.find(request), expected, `${mebi} Mi ${request.label} parity`);
        const timings = { javascript: [], wasmWorker: [] };
        for (let sample = 0; sample < warmups + repetitions; sample += 1) {
          const engines = sample % 2 === 0 ? ["javascript", "wasmWorker"] : ["wasmWorker", "javascript"];
          for (const engine of engines) {
            const start = performance.now();
            const result = engine === "javascript"
              ? await findLargeBodyMatch(source, request.query, request.from, request.direction, signal)
              : await worker.find(request);
            const elapsed = performance.now() - start;
            assert.deepEqual(result, expected, `${mebi} Mi ${request.label} ${engine} timed result`);
            if (sample >= warmups) timings[engine].push(elapsed);
          }
        }
        console.log(JSON.stringify({
          phase: "warm-find",
          inputUnits: source.length,
          fixture: request.label,
          result: expected,
          javascript: summary(timings.javascript),
          wasmWorker: summary(timings.wasmWorker),
          note: "The worker retains one body copy; subsequent calls send only the query and navigation boundary.",
        }));
      }
    } finally {
      await worker.close();
    }
  }
}

async function searchInWorker() {
  const started = performance.now();
  const [{ createBodySearcher }, bytes] = await Promise.all([
    import("../src/wasm/bodySearcherRuntime.ts"),
    readFile(binaryUrl),
  ]);
  const module = await WebAssembly.compile(bytes);
  const loaded = performance.now();
  const searcher = await createBodySearcher(module, workerData.source);
  workerData.source = undefined;
  const copied = performance.now();
  const signal = new AbortController().signal;
  const first = workerData.firstRequest;
  const result = await searcher.find(first.query, first.from, first.direction, signal);
  parentPort.postMessage({ type: "ready", result, timings: {
    loadMs: loaded - started,
    bodyCopyMs: copied - loaded,
    findMs: performance.now() - copied,
  } });

  parentPort.on("message", async ({ id, query, from, direction }) => {
    try {
      parentPort.postMessage({ id, result: await searcher.find(query, from, direction, signal) });
    } catch (error) {
      parentPort.postMessage({ id, error: String(error) });
    }
  });
  parentPort.on("close", () => searcher.dispose());
}

function startWorker(source, firstRequest) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const worker = new Worker(new URL(import.meta.url), { workerData: { source, firstRequest } });
    const pending = new Map();
    let nextId = 0;
    worker.on("message", message => {
      if (message.type === "ready") {
        resolve({
          result: message.result,
          timings: message.timings,
          elapsed: performance.now() - start,
          session: {
            find(request) {
              return new Promise((resolveFind, rejectFind) => {
                const id = ++nextId;
                pending.set(id, { resolve: resolveFind, reject: rejectFind });
                worker.postMessage({ id, ...request });
              });
            },
            close: () => worker.terminate(),
          },
        });
        return;
      }

      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    });
    worker.on("error", error => {
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    });
    worker.on("exit", code => {
      const error = new Error(`Search worker exited with code ${code}.`);
      if (code !== 0) reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    });
  });
}

function bodyFixture(targetLength) {
  const start = '{"begin":"BEGIN-NEEDLE","rows":[';
  const end = '","last":"END-NEEDLE FINAL-SIGNAL-𐐀"}]}';
  const paddingStart = '{"padding":"';
  const row = '{"id":9007199254740993,"enabled":true,"tags":["api","response"],"description":"café 😀 aaaaaaaaaaaaaaaa data payload","metadata":{"kind":"request","value":42}},';
  const remaining = targetLength - start.length - paddingStart.length - end.length;
  const rows = Math.floor(remaining / row.length);
  return start + row.repeat(rows) + paddingStart + " ".repeat(remaining - rows * row.length) + end;
}

function summary(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    medianMs: rounded(sorted[Math.floor(sorted.length / 2)]),
    minMs: rounded(sorted[0]),
    maxMs: rounded(sorted[sorted.length - 1]),
  };
}

function rounded(value) {
  return Number(value.toFixed(3));
}
