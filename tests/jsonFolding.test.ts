// Tests our source-preserving fold policy using the real CodeMirror JSON parser.
import { expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import { jsonLanguage } from '../src/components/jsonLanguage';
import { collectJsonFolds } from '../src/components/jsonFolding';

it('finds root, nested, and inline values while leaving delimiters and property names visible', () => {
  const text = '{"items":["hello"],"empty":"","object":{},"array":[ ]}';
  const tree = jsonLanguage.parser.parse(text);
  const ranges = collectJsonFolds(text, tree);
  expect(ranges.map(range => [range.kind, text.slice(range.from, range.to)])).toEqual([
    ['object', '"items":["hello"],"empty":"","object":{},"array":[ ]'],
    ['array', '"hello"'], ['string', 'hello'],
  ]);
  expect(tree.toString()).toBe(jsonLanguage.parser.parse(text).toString());
});

it.each(['{}', '[]', '[ \n\t]', '""', 'null', 'true', '42', ''])('does not offer empty or non-foldable values: %s', text => {
  expect(collectJsonFolds(text, jsonLanguage.parser.parse(text))).toEqual([]);
});

it('counts comments and nested empty containers as content, but excludes empty whitespace containers', () => {
  const text = '{"comments":[ /* note */ ],"nested":[{}],"empty":[ \n\t],"spaces":"  "}';
  const ranges = collectJsonFolds(text, jsonLanguage.parser.parse(text));
  expect(ranges.map(range => [range.kind, text.slice(range.from, range.to)])).toEqual([
    ['object', '"comments":[ /* note */ ],"nested":[{}],"empty":[ \n\t],"spaces":"  "'],
    ['array', ' /* note */ '], ['array', '{}'], ['string', '  '],
  ]);
});

it('keeps the same source-ordered folds for an immutable editor document', () => {
  const text = '{\n "items":["😀",{}, /* note */ [1]],\n "empty":[ ], "last":"value"\n}';
  const tree = jsonLanguage.parser.parse(text);
  const document = Text.of(text.split('\n'));
  expect(collectJsonFolds(document, tree)).toEqual(collectJsonFolds(text, tree));
});

it('keeps UTF-16 offsets, escaped quotes and brackets, duplicate keys, and exact numbers', () => {
  const text = '{"😀":"\\\"[{}]\\u0061","id":9007199254740993,"😀":"second"}';
  const ranges = collectJsonFolds(text, jsonLanguage.parser.parse(text));
  expect(ranges.filter(range => range.kind === 'string').map(range => text.slice(range.from, range.to)))
    .toEqual(['\\\"[{}]\\u0061', 'second']);
  for (const range of ranges) {
    expect(text[range.from - 1]).toMatch(/["{\[]/);
    expect(text[range.to]).toMatch(/["}\]]/);
  }
});

it('folds JSON with comments and trailing commas without reading comment brackets as values', () => {
  const text = '{// ["comment"]\n"items":["hello",/* {"comment":[]} */],}';
  const ranges = collectJsonFolds(text, jsonLanguage.parser.parse(text));
  expect(ranges.map(range => [range.kind, text.slice(range.from, range.to)])).toEqual([
    ['object', '// ["comment"]\n"items":["hello",/* {"comment":[]} */],'],
    ['array', '"hello",/* {"comment":[]} */'],
    ['string', 'hello'],
  ]);
});

it('excludes incomplete/error-containing containers while keeping valid siblings foldable', () => {
  const text = '{"ok":["hello"],"broken":[}';
  const ranges = collectJsonFolds(text, jsonLanguage.parser.parse(text));
  expect(ranges.map(range => [range.kind, text.slice(range.from, range.to)]))
    .toEqual([['array', '"hello"'], ['string', 'hello']]);
  expect(collectJsonFolds('"unfinished', jsonLanguage.parser.parse('"unfinished'))).toEqual([]);
});

it('does not treat a partial parse as a complete outer container', () => {
  const text = '{"first":[1],"last":[2]}';
  const prefix = text.slice(0, text.indexOf(',"last"'));
  const ranges = collectJsonFolds(text, jsonLanguage.parser.parse(prefix));
  expect(ranges.map(range => text.slice(range.from, range.to))).toEqual(['1']);
});

it('walks deep JSON without recursive application traversal', () => {
  const text = '['.repeat(10000) + '1' + ']'.repeat(10000);
  const ranges = collectJsonFolds(text, jsonLanguage.parser.parse(text));
  // Extreme depth may trigger Lezer recovery. Our policy still safely traverses the
  // resulting tree and exposes only the complete, error-free subtrees it supplies.
  expect(ranges.length).toBeGreaterThan(0);
  for (const range of ranges) {
    expect(text[range.from - 1]).toBe('[');
    expect(text[range.to]).toBe(']');
    expect(range.from).toBeLessThan(range.to);
  }
});
