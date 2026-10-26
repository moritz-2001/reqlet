// Verifies the formatter's public contract: readable JSON without changing payload tokens.
import assert from "node:assert/strict";
import test from "node:test";
import { formatJson, JsonFormatLimitError } from "../src/components/formatJson.ts";
import { toStrictJson } from "../src/json.ts";

test("formats nested JSON, including empty containers", () => {
  assert.equal(formatJson('{"items":[1,{"empty":[]}],"meta":{}}'), `{
  "items": [
    1,
    {
      "empty": []
    }
  ],
  "meta": {}
}`);
});

test("preserves large IDs, number notation, and string escapes exactly", () => {
  const body = String.raw`{"id":9007199254740993,"number":1.2300e+40,"zero":-0,"text":"\u0061\n\"{x},:[]\\"}`;
  const formatted = formatJson(body);
  assert.ok(formatted.includes("9007199254740993"));
  assert.ok(formatted.includes("1.2300e+40"));
  assert.ok(formatted.includes('"zero": -0'));
  assert.ok(formatted.includes(String.raw`"\u0061\n\"{x},:[]\\"`));
  assert.deepEqual(JSON.parse(formatted), JSON.parse(body));
});

test("accepts scalar JSON and leaves string whitespace intact", () => {
  for (const body of ['"  hello  "', "null", "true", "42", "{}", "[]"]) {
    assert.equal(formatJson(` \n${body}\t`), body);
  }
});

test("rejects invalid or empty JSON", () => {
  for (const body of ["", " ", '{"unfinished":', "[,1]", "[1,,]", "/* unfinished", "undefined", "{} {}"]) {
    assert.throws(() => formatJson(body), SyntaxError);
  }
});

test("preserves comments and trailing commas while formatting nested JSONC", () => {
  const source = '// request\n{"items":[1,2,],/* keep */"id":9007199254740993,}// end  ';
  assert.equal(formatJson(source), `// request
{
  "items": [
    1,
    2,
  ], /* keep */ "id": 9007199254740993,
} // end  `);
});

test("keeps separators after line comments outside the comment and preserves comment text", () => {
  const sources = [
    '[1 // value  \n,2,]',
    '{"a":1 // value\n,"b":2}',
    '{"a" // key\n: // value\n1,}',
    '{/* before */"a":/* value */1/* after */}',
    '// before\r\n[/* one\r\n  two */1,] // end  ',
  ];
  for (const source of sources) {
    const formatted = formatJson(source);
    assert.deepEqual(JSON.parse(toStrictJson(formatted)), JSON.parse(toStrictJson(source)));
    assert.equal(formatJson(formatted), formatted);
    assert.deepEqual(
      formatted.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g),
      source.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g),
    );
  }
});

test("formatting an already formatted body is idempotent", () => {
  const formatted = formatJson('{"message":"hello","nested":[true,null]}');
  assert.equal(formatJson(formatted), formatted);
});

test("accepts the exact output budget and preserves payload tokens and comments", () => {
  const source = String.raw`{"id":9007199254740993,"text":"😀\u0061",/* exact */"values":[1.2300e+40,],}`;
  const formatted = formatJson(source);
  assert.equal(formatJson(source, formatted.length), formatted);
  assert.throws(() => formatJson(source, formatted.length - 1), JsonFormatLimitError);
  assert.ok(formatted.includes('9007199254740993'));
  assert.ok(formatted.includes(String.raw`"😀\u0061"`));
  assert.ok(formatted.includes('/* exact */'));
  assert.ok(formatted.includes('1.2300e+40,'));
});

test("counts UTF-16 output positions and rejects complete tokens that exceed the budget", () => {
  assert.equal(formatJson('"😀"', 4), '"😀"');
  assert.throws(() => formatJson('"😀"', 3), JsonFormatLimitError);
  assert.throws(() => formatJson('1', 0), JsonFormatLimitError);
});

test("does not charge discarded trailing whitespace against an exact budget", () => {
  const source = '[] // end';
  assert.equal(formatJson(source, source.length), source);
  assert.throws(() => formatJson(source, source.length - 1), JsonFormatLimitError);
});

test("bounds deeply nested preview expansion while leaving explicit formatting unbounded", () => {
  const depth = 1000;
  const source = '['.repeat(depth) + '0' + ']'.repeat(depth);
  const formatted = formatJson(source);
  assert.equal(source.length, 2001);
  assert.equal(formatted.length, 2 * depth ** 2 + 4 * depth + 1);
  assert.equal(formatted.replace(/\s/g, ''), source);
  assert.throws(() => formatJson(source, 512 * 1024), JsonFormatLimitError);
});
