// Exercises the shared JSON language through syntax nodes and original UTF-16 source ranges.
import { expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { json, jsonLanguage } from "../src/components/jsonLanguage";

it.each([
  'null', 'true', 'false', '42', '-1.25e+3', '"escaped \\u0061 \\""',
  '{}', '[]', '{"items": [null, true, 1, "value"], "nested": {"key": 2}}',
])("accepts ordinary JSON: %s", source => {
  expect(errorRanges(jsonLanguage.parser.parse(source))).toEqual([]);
});

it.each([
  '// before\n{"items": [1, 2,],}\n// after',
  '/* before */ { /* key */ "items" /* colon */ : /* value */ [ /* first */ 1 /* comma */, /* closer */ ], /* end */ }',
  '["https://example.test/a/*b*/", /* ignored ] } */ false,]',
  '{"number": 9007199254740993, "escaped": "\\u0061",}',
  '{ /* empty */ }', '[// empty\n]',
  '/**/ {"first": /***/ 1, /* repeated *** stars * inside */}',
])("accepts comments and trailing commas: %s", source => {
  expect(errorRanges(jsonLanguage.parser.parse(source))).toEqual([]);
});

it.each([
  '', ' ', '// only a comment', '/* only a comment */',
  '{,}', '[,]', '{,"first": 1}', '[, 1]', '[1,,]', '{"first": 1,,}',
  '{"first" true}', '[1 2]', '{"first": 1', '/* unterminated',
  '{"first": /* unterminated }', '{unquoted: 1}', '{"first": undefined}',
])("keeps malformed JSON invalid: %s", source => {
  expect(errorRanges(jsonLanguage.parser.parse(source)).length).toBeGreaterThan(0);
});

it("retains comment ranges and semantic nodes in an editor's exact source", () => {
  const source = '{"😀": 1, // ignored [}\n "items": [/* ignored {] */ "value",],}';
  const state = EditorState.create({ doc: source, extensions: [json()] });
  const tree = syntaxTree(state);
  const nodes: { name: string; source: string; from: number; to: number }[] = [];
  tree.iterate({
    enter(node) {
      if (["PropertyName", "LineComment", "BlockComment", "String"].includes(node.name)) {
        nodes.push({ name: node.name, source: state.sliceDoc(node.from, node.to), from: node.from, to: node.to });
      }
    },
  });
  expect(errorRanges(tree)).toEqual([]);
  expect(tree.length).toBe(source.length);
  expect(nodes.map(node => [node.name, node.source])).toEqual([
    ["PropertyName", '"😀"'],
    ["LineComment", "// ignored [}"],
    ["PropertyName", '"items"'],
    ["BlockComment", "/* ignored {] */"],
    ["String", '"value"'],
  ]);
  for (const node of nodes) {
    expect(node.from).toBe(source.indexOf(node.source));
    expect(node.to).toBe(node.from + node.source.length);
  }
});

it.each(['/* note', '{/* ["value", { nested', '{/* note *', '{/* note ***'])
  ("keeps unfinished block comments opaque until their closing delimiter: %s", source => {
    const comments: string[] = [];
    const values: string[] = [];
    jsonLanguage.parser.parse(source).iterate({
      enter(node) {
        if (node.name === "BlockComment") comments.push(source.slice(node.from, node.to));
        if (["Array", "PropertyName", "String"].includes(node.name)) values.push(node.name);
      },
    });
    expect(comments).toEqual([source.slice(source.indexOf('/*'))]);
    expect(values).toEqual([]);
  });

function errorRanges(tree: Tree): { from: number; to: number }[] {
  const errors: { from: number; to: number }[] = [];
  tree.iterate({ enter(node) { if (node.type.isError) errors.push({ from: node.from, to: node.to }); } });
  return errors;
}
