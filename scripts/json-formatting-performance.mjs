// Compares complete TypeScript and Wasm formatting calls, including JS/Wasm string copies and cold worker startup.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const previewBudget = 512 * 1024;
const warmups = 2;
const repetitions = 7;
const binaryUrl = new URL("../src/wasm/generated/json_formatter.wasm", import.meta.url);

if (isMainThread) await benchmark();
else await formatInWorker();

async function benchmark() {
  const [typescript, { createJsonFormatter }] = await Promise.all([
    import("../src/components/formatJson.ts"),
    import("../src/wasm/jsonFormatterRuntime.ts"),
  ]);
  const formatTypeScript = typeScriptFormatter(typescript);
  const bytes = await readFile(binaryUrl);
  const coldStart = performance.now();
  const module = await WebAssembly.compile(bytes);
  const compiledAt = performance.now();
  const formatWasm = createJsonFormatter(module);
  const instantiatedAt = performance.now();
  const fixtures = [64, 128, 400].map(kib => ({
    name: `data-${kib}Ki`,
    source: dataFixture(kib * 1024),
  }));
  fixtures.push({ name: "tokens-128Ki", source: tokenFixture(128 * 1024) });
  fixtures.push({ name: "deep-expansion-limit", source: "[".repeat(1000) + "0" + "]".repeat(1000) });

  console.log("JSON formatting in Node: complete calls include input/output copying; UTF-16 code-unit sizes.");
  console.log(`${warmups} warmups, median of ${repetitions} samples per engine; milliseconds. Browser/UI latency is not measured.`);
  console.log(JSON.stringify({
    phase: "first-module-setup",
    wasmBytes: bytes.length,
    compileMs: rounded(compiledAt - coldStart),
    instantiateMs: rounded(instantiatedAt - compiledAt),
    totalMs: rounded(instantiatedAt - coldStart),
    note: "One first setup sample in this process; excludes reading the binary from disk.",
  }));

  for (const fixture of fixtures) {
    const expected = formatTypeScript(fixture.source, previewBudget);
    assert.deepEqual(formatWasm(fixture.source, previewBudget), expected, `${fixture.name}: parity before timing`);
    assert.equal(expected.status, fixture.name === "deep-expansion-limit" ? "too-large" : "formatted");

    // Alternating engine order reduces the systematic advantage of always running second.
    const timings = { typescript: [], wasm: [] };
    for (let sample = 0; sample < warmups + repetitions; sample += 1) {
      const engines = sample % 2 === 0 ? ["typescript", "wasm"] : ["wasm", "typescript"];
      for (const engine of engines) {
        const start = performance.now();
        const result = engine === "wasm"
          ? formatWasm(fixture.source, previewBudget)
          : formatTypeScript(fixture.source, previewBudget);
        const elapsed = performance.now() - start;
        assert.deepEqual(result, expected, `${fixture.name}: ${engine} timed result`);
        if (sample >= warmups) timings[engine].push(elapsed);
      }
    }
    console.log(JSON.stringify({
      phase: "warm-call",
      fixture: fixture.name,
      inputUnits: fixture.source.length,
      outputUnits: expected.status === "formatted" ? expected.text.length : null,
      status: expected.status,
      typescript: summary(timings.typescript),
      wasm: summary(timings.wasm),
    }));

    if (!process.argv.includes("--no-workers")) {
      const workerTimings = { typescript: [], wasm: [] };
      for (let sample = 0; sample < warmups + repetitions; sample += 1) {
        const engines = sample % 2 === 0 ? ["typescript", "wasm"] : ["wasm", "typescript"];
        for (const engine of engines) {
          const measured = await oneShotWorker(engine, fixture.source);
          assert.deepEqual(measured.result, expected, `${fixture.name}: ${engine} worker parity`);
          if (sample >= warmups) workerTimings[engine].push(measured.elapsed);
        }
      }
      console.log(JSON.stringify({
        phase: "one-shot-node-worker",
        fixture: fixture.name,
        typescript: summary(workerTimings.typescript),
        wasm: summary(workerTimings.wasm),
        note: "Includes a fresh Node worker, module imports, input/output cloning, and Wasm binary read/compile/instantiate. Node startup differs from browser workers.",
      }));
    }
  }
}

async function formatInWorker() {
  let result;
  if (workerData.engine === "wasm") {
    const [{ createJsonFormatter }, bytes] = await Promise.all([
      import("../src/wasm/jsonFormatterRuntime.ts"),
      readFile(binaryUrl),
    ]);
    const module = await WebAssembly.compile(bytes);
    result = createJsonFormatter(module)(workerData.source, previewBudget);
  } else {
    const typescript = await import("../src/components/formatJson.ts");
    const formatTypeScript = typeScriptFormatter(typescript);
    result = formatTypeScript(workerData.source, previewBudget);
  }
  parentPort.postMessage(result);
}

function oneShotWorker(engine, source) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const worker = new Worker(new URL(import.meta.url), { workerData: { engine, source } });
    worker.once("message", result => {
      const elapsed = performance.now() - start;
      // Termination mirrors the preview's one-request ownership but is outside the measured response latency.
      void worker.terminate();
      resolve({ result, elapsed });
    });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0) reject(new Error(`Formatting worker exited with code ${code}`));
    });
  });
}

function typeScriptFormatter({ formatJson, JsonFormatLimitError }) {
  return (source, budget) => {
    try {
      return { status: "formatted", text: formatJson(source, budget) };
    } catch (error) {
      if (error instanceof JsonFormatLimitError) return { status: "too-large" };
      if (error instanceof SyntaxError) return { status: "invalid" };
      throw error;
    }
  };
}

function dataFixture(targetLength) {
  const rows = [];
  let length = '{"items":[]}'.length;
  while (length < targetLength) {
    const row = `/* row ${rows.length} */{"id":9007199254740993,"ratio":1.2300e+40,"enabled":true,"tags":["api","preview"],"description":"${"café 😀 payload ".repeat(120)}","metadata":{"kind":"response","optional":null}}`;
    if (length + row.length + 1 > targetLength) break;
    rows.push(row);
    length += row.length + 1;
  }
  return `{"items":[${rows.join(",")}]}`;
}

function tokenFixture(targetLength) {
  const row = '{"id":123,"count":42,"flags":[true,false,null],"scores":[1,2,3,4,5],"nested":{"x":1,"y":2},"id":-0},';
  return `[${row.repeat(Math.floor((targetLength - 4) / row.length))}{}]`;
}

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: rounded(sorted[Math.floor(sorted.length / 2)]),
    minMs: rounded(sorted[0]),
    maxMs: rounded(sorted[sorted.length - 1]),
  };
}

function rounded(value) {
  return Number(value.toFixed(3));
}
