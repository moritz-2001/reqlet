// Verifies the Wasm formatter's public result contract against the source-preserving TypeScript formatter.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatJson, JsonFormatLimitError } from "../src/components/formatJson.ts";
import { createJsonFormatter } from "../src/wasm/jsonFormatterRuntime.ts";

const previewBudget = 512 * 1024;
const wasmBytes = await readFile(new URL("../src/wasm/generated/json_formatter.wasm", import.meta.url));
const module = await WebAssembly.compile(wasmBytes);
const formatWasm = createJsonFormatter(module);

test("preserves tokens, duplicate keys, comments, and JSONC separators exactly", () => {
  const sources = [
    '{"items":[1,{"empty":[]}],"meta":{}}',
    String.raw`{"id":9007199254740993,"id":9007199254740994,"number":1.2300e+40,"zero":-0,"text":"\u0061\n\"{x},:[]\\"}`,
    '// request\n{"items":[1,2,],/* keep */"id":9007199254740993,}// end  ',
    '[1 // value  \n,2,]',
    '{"a":1 // value\n,"b":2}',
    '{"a" // key\n: // value\n1,}',
    '{/* before */"a":/* value */1/* after */}',
    '// before\r\n[/* one\r\n  two */1,] // end  ',
    '/* before */ [] /* after */',
    '[/* empty */]',
    '{/* empty */}',
    '[1,/* after comma */2/* before comma */,/* trailing */]',
    '{"a"/* key */:/* colon */1,/* comma */"b":2,/* trailing */}',
    '[1/* inline */,\n/* multiline */2e3,]',
    '[1,\n// own line\n/* followed */2,]',
    '[1,// first\r// second\r\n2,]',
    '{"𝄞":"😀 café 日本語","text":"\u2028\u2029"}',
    String.raw`["\ud800","\udfff","\uD83D\uDE00","\/","\b\f\n\r\t",1E-09,-123.4500]`,
    ...['"  hello  "', "null", "true", "false", "42", "{}", "[]"].map(source => ` \n${source}\t`),
  ];
  for (const source of sources) {
    const expected = referenceResult(source, previewBudget);
    assert.equal(expected.status, "formatted", `Fixture must be valid: ${JSON.stringify(source)}`);
    assert.deepEqual(formatWasm(source, previewBudget), expected, JSON.stringify(source));
    assert.deepEqual(formatWasm(expected.text, previewBudget), expected, "Formatting must be idempotent");
  }
});

test("rejects malformed grammar before checking the formatted-output budget", () => {
  const sources = [
    "", " ", "// only", "/**/", "/* unfinished", "/*/", "/* open **", "undefined", "NaN", "Infinity",
    "{} {}", "true false", "null0", "truex", "FALSE", "[", "{", "[1", '{"unfinished":',
    "[,1]", "[1,,]", "[1 2]", "[1,2", "[1}", "{]", "{,}", "{true:1}", '{"a" 1}',
    '{"a":}', '{"a":1,,}', '{"a":1 "b":2}', "01", "-01", "+1", ".1", "1.", "1e", "1e+", "--1",
    '"\ud800"', '"\udfff"', '/* \ud800 */ 1', '// \udfff\n1',
    '"unterminated', '"line\nfeed"', '"tab\there"', '"\u0000"', String.raw`"\q"`, String.raw`"\u123"`,
    '[0,1,2,3,4,5,6,7,8,9,INVALID]',
    // A valid long prefix followed by invalid syntax must never become "too-large".
    '["' + "x".repeat(64 * 1024) + '",] trailing',
  ];
  for (const source of sources) {
    for (const budget of [0, 1, previewBudget]) {
      assert.equal(referenceResult(source, budget).status, "invalid", JSON.stringify(source));
      assert.deepEqual(formatWasm(source, budget), { status: "invalid" }, JSON.stringify(source));
    }
  }
});

test("uses inclusive UTF-16 budgets and never returns a partial formatted body", () => {
  const sources = [
    '"😀"', String.raw`"\ud800"`, String.raw`"\udfff"`, "0", "[]", "[] // end  ", "// before\n{}",
    String.raw`{"id":9007199254740993,"text":"😀\u0061",/* exact */"values":[1.2300e+40,],}`,
    '["' + "😀".repeat(300) + '"]',
  ];
  for (const source of sources) {
    const text = formatJson(source);
    for (const budget of [0, 1, text.length - 1, text.length, text.length + 1, previewBudget]) {
      assert.deepEqual(
        formatWasm(source, budget), referenceResult(source, budget),
        `${JSON.stringify(source)}, budget ${budget}`,
      );
    }
    assert.deepEqual(formatWasm(source, text.length), { status: "formatted", text });
    assert.deepEqual(formatWasm(source, text.length - 1), { status: "too-large" });
  }
});

test("supports unbounded and fractional limits and rejects invalid budgets", () => {
  for (const source of ['"😀"', '{"a":[1,2,3]}']) {
    for (const budget of [Infinity, 3.9, 4.1]) {
      assert.deepEqual(formatWasm(source, budget), referenceResult(source, budget));
    }
  }
  for (const budget of [-1, -Infinity, NaN]) {
    assert.throws(() => formatWasm("[]", budget), RangeError);
  }
});

test("handles deeply nested JSON without recursive stack overflow and bounds expansion", () => {
  for (const depth of [1, 128, 1000]) {
    const source = "[".repeat(depth) + "0" + "]".repeat(depth);
    assert.deepEqual(formatWasm(source, previewBudget), referenceResult(source, previewBudget), `Depth ${depth}`);
  }
  const veryDeepSource = "[".repeat(10000) + "0" + "]".repeat(10000);
  assert.deepEqual(formatWasm(veryDeepSource, previewBudget), { status: "too-large" });

  const source = "[".repeat(1000) + "0" + "]".repeat(1000);
  const length = 2 * 1000 ** 2 + 4 * 1000 + 1;
  assert.deepEqual(formatWasm(source, length), { status: "formatted", text: formatJson(source) });
});

test("remains independent across growing inputs, invalid input, and bounded requests", () => {
  const sources = [
    '"' + "large 😀 value ".repeat(5000) + '"',
    '"small"',
    '{"broken":',
    "[".repeat(1000) + "0" + "]".repeat(1000),
    '{"a":1,/* keep */"a":2,}',
    "false",
    "[]",
  ];
  for (let repetition = 0; repetition < 3; repetition += 1) {
    for (const source of sources) {
      for (const budget of [0, previewBudget, 4, previewBudget]) {
        assert.deepEqual(formatWasm(source, budget), referenceResult(source, budget));
      }
    }
  }
});

test("matches varied deterministic JSONC documents and their exact output limits", () => {
  for (let seed = 1; seed <= 120; seed += 1) {
    const source = generatedJsonc(seed);
    const expected = referenceResult(source, previewBudget);
    assert.equal(expected.status, "formatted", `Generated fixture ${seed} must be valid`);
    assert.deepEqual(formatWasm(source, previewBudget), expected, `Generated fixture ${seed}`);
    assert.deepEqual(formatWasm(source, expected.text.length), expected, `Exact budget for fixture ${seed}`);
    assert.deepEqual(
      formatWasm(source, expected.text.length - 1), { status: "too-large" },
      `Short budget for fixture ${seed}`,
    );
  }
});

function referenceResult(source, maxLength) {
  try {
    return { status: "formatted", text: formatJson(source, maxLength) };
  } catch (error) {
    if (error instanceof JsonFormatLimitError) return { status: "too-large" };
    if (error instanceof SyntaxError) return { status: "invalid" };
    throw error;
  }
}

function generatedJsonc(seed) {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const gap = () => ["", " ", "\n", "\r\n", "/* keep */", " // keep  \n"][next() % 6];
  const scalar = () => [
    "null", "true", "false", "-0", "9007199254740993", "1.2300e+40",
    '"😀"', String.raw`"\u0061\n"`, String.raw`"\ud800"`,
  ][next() % 9];
  const value = depth => {
    if (depth === 0 || next() % 3 === 0) return scalar();

    const object = next() % 2 === 0;
    const entries = Array.from({ length: next() % 4 }, () => {
      const item = value(depth - 1);
      return object ? `"same"${gap()}:${gap()}${item}` : item;
    });
    const body = entries.map((entry, index) => {
      const comma = index < entries.length - 1 || next() % 2 ? "," : "";
      return `${gap()}${entry}${comma}`;
    }).join("");
    return `${object ? "{" : "["}${body}${gap()}${object ? "}" : "]"}`;
  };
  return `${gap()}${value(4)}${gap()}`;
}
