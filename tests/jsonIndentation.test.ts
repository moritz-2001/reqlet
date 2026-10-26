// Tests exact newline replacements and caret positions through the pure JSON editing interface.
import { expect, it } from "vitest";
import { jsonNewlineEdit } from "../src/components/jsonIndentation";
import { jsonLanguage } from "../src/components/jsonLanguage";

it.each([
  ["empty object", "{|}", "{\n  |\n}"],
  ["empty array", "[|]", "[\n  |\n]"],
  ["spaced empty pair", "{  | \t}", "{\n  |\n}"],
  ["four spaces", '{\n    "a": 1,\n    "items": [|]}', '{\n    "a": 1,\n    "items": [\n        |\n    ]}'],
  ["tabs", '{\n\t"items": [|]}', '{\n\t"items": [\n\t\t|\n\t]}'],
  ["three spaces", '{\n   "items": [|]}', '{\n   "items": [\n      |\n   ]}'],
  ["comma continuation", '{\n        "a": 1,|\n}', '{\n        "a": 1,\n        |\n}'],
  ["blank line continuation", '{\n    |\n}', '{\n    \n    |\n}'],
  ["closing nonempty container", '{\n    "a": 1|}', '{\n    "a": 1\n|}'],
  ["spaced closer", '{\n    "a": 1|  }', '{\n    "a": 1\n|}'],
  ["after inline closer", '{"a": [1]|}', '{"a": [1]\n|}'],
  ["after nested closer", '{\n    "a": [1]|\n}', '{\n    "a": [1]\n    |\n}'],
  ["inline nesting", '{"a":[{|}]}', '{"a":[{\n      |\n    }]}'],
  ["deep evidence", '{"a":{\n        "b":1,\n        "c":[|]}}', '{"a":{\n        "b":1,\n        "c":[\n            |\n        ]}}'],
  ["unfinished input", '{\n    "items": [|', '{\n    "items": [\n        |'],
  ["mismatched input", '{\n    "a": [}\n    |', '{\n    "a": [}\n    \n    |'],
  ["string brackets", '{\n    "a":"[{}]",|\n}', '{\n    "a":"[{}]",\n    |\n}'],
  ["within string", '{\n    "a":"[|{}]"}', '{\n    "a":"[\n    |{}]"}'],
  ["unfinished string", '{\n    "a":"[|', '{\n    "a":"[\n    |'],
  ["escaped quote", '{\n    "a":"\\\"[|]"}', '{\n    "a":"\\\"[\n    |]"}'],
  ["UTF-16 offsets", '{\n\t"😀": [|]}', '{\n\t"😀": [\n\t\t|\n\t]}'],
  ["split indentation", '{\n  |  "a":1}', '{\n  \n    |"a":1}'],
  ["empty document", "|", "\n|"],
  ["document starts with newline", "|\n{}", "\n|\n{}"],
  ["inline comma", '{"a":1,|', '{"a":1,\n  |'],
  ["container following closers", '{\n    "a": [\n    ], "b": {|}\n}', '{\n    "a": [\n    ], "b": {\n        |\n    }\n}'],
  ["local mixed style", '{\n  "a": {\n      "b": 1,\n      "c": [|]\n  }\n}', '{\n  "a": {\n      "b": 1,\n      "c": [\n          |\n      ]\n  }\n}'],
  ["existing children", '{\n    "items": [|\n\t\t1\n    ]\n}', '{\n    "items": [\n\t\t|\n\t\t1\n    ]\n}'],
  ["unrelated numbers unchanged", '{\n    "n":9007199254740993,"s":"\\u0061",|\n}', '{\n    "n":9007199254740993,"s":"\\u0061",\n    |\n}'],
  ["line comment brackets", '{\n    // [|]\n    "a": 1,\n}', '{\n    // [\n    |]\n    "a": 1,\n}'],
  ["line comment end", '{\n    // [|\n    "a": 1,\n}', '{\n    // [\n    |\n    "a": 1,\n}'],
  ["block comment brackets", '{\n    /* [|] */\n    "a": 1,\n}', '{\n    /* [\n    |] */\n    "a": 1,\n}'],
  ["block comment indentation", '{\n    /* note\n  [|]\n    */\n}', '{\n    /* note\n  [\n  |]\n    */\n}'],
  ["unfinished block comment", '{\n    /* [|', '{\n    /* [\n    |'],
  ["comments excluded from indentation evidence", '{\n        // prose\n    "items": [|],\n}', '{\n        // prose\n    "items": [\n        |\n    ],\n}'],
  ["trailing commas", '{\n    "items": [1,|],\n}', '{\n    "items": [1,\n    |],\n}'],
])("inserts a line using %s", (_name, before, after) => {
  expectNewline(before, after);
});

it.each([
  ['{«"a": [1]»}', '{\n  |\n}'],
  ['{\n    "a": 1,«\n    "b": {\n        "c": [»\n}', '{\n    "a": 1,\n    |\n}'],
  ['{«\n\t"a":1\n»}', '{\n  |\n}'],
  ['{\n    "a": «1, "b": 2»}', '{\n    "a": \n|}'],
])("excludes selected content from the new context: %s", (before, after) => {
  expectNewline(before, after);
});

it("preserves inline nesting after a long minified prefix", () => {
  const prefix = '{"items":[' + '{"id":123,"tags":["a","b"]},'.repeat(5000) + '{"next":[';
  expectNewline(prefix + '|]}]}', prefix + '\n        |\n      ]}]}');
});

it("uses child indentation on later lines after a long minified prefix", () => {
  const prefix = '{"items":[' + '{"id":123},'.repeat(2000) + '{"next":[';
  expectNewline(prefix + '|\n            1\n         ]}]}', prefix + '\n            |\n            1\n         ]}]}');
});

it("excludes a large selected prefix from nesting and indentation evidence", () => {
  const selected = '{"id":123,"tags":["a","b"]},'.repeat(5000);
  expectNewline('{"items":[«' + selected + '»]}', '{"items":[\n    |\n  ]}');
});

function expectNewline(before: string, after: string) {
  const selected = before.includes("«");
  const from = before.indexOf(selected ? "«" : "|");
  const to = selected ? before.indexOf("»") - 1 : from;
  const source = before.replace(/[|«»]/g, "");
  const edit = jsonNewlineEdit(source, from, to, jsonLanguage.parser.parse(source));
  const result = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
  expect(result).toBe(after.replace("|", ""));
  expect(edit.caret).toBe(after.indexOf("|"));
  expect(edit.from).toBeLessThanOrEqual(from);
  expect(edit.to).toBeGreaterThanOrEqual(to);
}
