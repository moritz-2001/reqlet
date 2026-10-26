// Exercises JSONC validation and strict-wire conversion through the public source operations.
import { expect, it } from "vitest";
import { parseJsonSource, stripJsonComments, toStrictJson } from "../src/json";

it("converts comments and trailing commas without changing payload tokens or source positions", () => {
  const source = String.raw`// 🧪 sample
{"id":9007199254740993,"id":1.2300e+40,"text":"\u0061 // /* ,} ]", /* note */ "items":[true,null,],}
/* end */`;
  const strict = toStrictJson(source);
  expect(() => JSON.parse(strict)).not.toThrow();
  expect(strict).toContain('"id":9007199254740993,"id":1.2300e+40');
  expect(strict).toContain(String.raw`"text":"\u0061 // /* ,} ]"`);
  expect(strict).not.toContain("note");
  expect(strict).not.toContain("sample");
  expect(strict.length).toBe(source.length);
  expect(strict.indexOf('"items"')).toBe(source.indexOf('"items"'));
  expect(strict.match(/\n/g)?.length).toBe(source.match(/\n/g)?.length);
  expect(parseJsonSource(source).length).toBe(source.length);
});

it("leaves ordinary JSON and its exact whitespace unchanged", () => {
  const source = ' \r\n{"a":1,"a":-0,"b":["https://example.com",1e40]}\t';
  expect(toStrictJson(source)).toBe(source);
});

it("masks complete comments before bare template values are resolved", () => {
  const source = '{"count":{{count}}, /* {{disabled}} */ "url":"http://example.com"}';
  const stripped = stripJsonComments(source);
  expect(stripped).toContain('{{count}}');
  expect(stripped).not.toContain('{{disabled}}');
  expect(stripped).toContain('"http://example.com"');
  expect(stripped.length).toBe(source.length);
  expect(stripJsonComments('true /* unfinished')).toBe('true /* unfinished');
});

it.each([
  ['[1, /* trailing */]', [1]],
  ['{"a":1, // trailing\r\n}', { a: 1 }],
  ['{/* empty */}', {}],
  ['[// empty\r\n]', []],
  ['/* scalar */ false // end', false],
  ['{"a"/* key */:/* value */1}', { a: 1 }],
])("normalizes JSONC %s into strict JSON", (source, value) => {
  expect(JSON.parse(toStrictJson(source))).toEqual(value);
});

it.each([
  "", "// no value", "/* no value */", "/* unfinished", '[1, /* unfinished]', "true/*/", "true/*",
  "[,1]", "[,]", "[1,,]", '{,"a":1}', '{"a":,}', '{"a":1,,}',
  '{"a":1 "b":2}', "[true false]", "[1/* gap */2]", "1/* gap */2",
  "undefined", "01", '{a:1}', "{'a':1}", '"bad\\x00"', '"unfinished', "{} {}",
])("rejects malformed JSONC without silently repairing %s", source => {
  expect(() => toStrictJson(source)).toThrow(SyntaxError);
  expect(() => parseJsonSource(source)).toThrow(/at position \d+/);
});
