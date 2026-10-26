// Verifies the URL parameter projection preserves source syntax instead of normalizing the saved address.
import { expect, it } from "vitest";
import { inspectUrlQuery } from "../src/urlQuery";

it("preserves encoding, duplicate order, empty names, flags, and literal equals signs", () => {
  const source = "https://example.com/?tag=a+b&tag=%2f&flag&empty=&=unnamed&equation=a=b&&#fragment?ignored=yes";
  expect(inspectUrlQuery(source)).toEqual({
    start: source.indexOf("?") + 1,
    end: source.indexOf("#"),
    parameters: [
      { name: "tag", value: "a+b" },
      { name: "tag", value: "%2f" },
      { name: "flag", value: undefined },
      { name: "empty", value: "" },
      { name: "", value: "unnamed" },
      { name: "equation", value: "a=b" },
    ],
  });
});

it("keeps placeholders opaque even when their names contain URL delimiters", () => {
  const source = "{{base?url#&=}}/items?{{name&part}}={{value#part=}}&literal={{value?part}}#fragment";
  const query = inspectUrlQuery(source)!;
  expect(query.parameters).toEqual([
    { name: "{{name&part}}", value: "{{value#part=}}" },
    { name: "literal", value: "{{value?part}}" },
  ]);
  expect(source.slice(query.start, query.end)).toBe("{{name&part}}={{value#part=}}&literal={{value?part}}");
});

it("interprets delimiters inside braces according to the request input mode", () => {
  const source = "https://example.com/?value={{first&second}}";
  expect(inspectUrlQuery(source, "template")?.parameters).toEqual([
    { name: "value", value: "{{first&second}}" },
  ]);
  expect(inspectUrlQuery(source, "literal")?.parameters).toEqual([
    { name: "value", value: "{{first" },
    { name: "second}}", value: undefined },
  ]);
});

it("retains ordinary query and fragment boundaries inside literal braces", () => {
  const source = "https://example.com/{{query?value=first#fragment}}";
  expect(inspectUrlQuery(source, "template")).toBeUndefined();
  const query = inspectUrlQuery(source, "literal")!;
  expect(query.parameters).toEqual([{ name: "value", value: "first" }]);
  expect(source.slice(query.start, query.end)).toBe("value=first");
});

it.each(["https://example.com/", "{{baseUrl}}/items", "https://example.com/#fragment?ignored=1"])(
  "does not invent a query for %s", source => {
    expect(inspectUrlQuery(source)).toBeUndefined();
  },
);

it.each(["https://example.com/?", "https://example.com/?&&#fragment"])(
  "does not invent parameters from empty query segments in %s", source => {
    expect(inspectUrlQuery(source)?.parameters).toEqual([]);
  },
);
