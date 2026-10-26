// Exercises imported path samples through parseOpenApi and prepareRequest, including URL dot-segment normalization.
import { expect, it } from "vitest";
import { parseOpenApi } from "../src/openapi";
import { prepareRequest } from "../src/prepareRequest";

it.each([".", ".."])('replaces the direct path sample "%s" with an editable value and a preview note', example => {
  const preview = parseOpenApi(document("/pets/{id}/details", [{ name: "id", example }]));
  const request = preview.operations[0].request;

  expect(request.path).toBe("https://api.example.com/v1/pets/value/details");
  expect(prepareRequest(request).url).toBe(request.path);
  expect(preview.warnings.join(" ")).toMatch(/parameter id.*dot segment.*replaced with value/i);
});

it.each([
  { default: "." },
  { enum: [".."] },
  { const: ".." },
  { type: "array", items: { default: "." } },
])("checks schema-derived path samples after serialization: %j", schema => {
  const preview = parseOpenApi(document("/pets/{id}", [{ name: "id", schema }]));

  expect(prepareRequest(preview.operations[0].request).url).toBe("https://api.example.com/v1/pets/value");
  expect(preview.warnings.join(" ")).toMatch(/parameter id.*dot segment/i);
});

it.each([
  { example: "." },
  { schema: { default: ".." } },
])("checks content-based text path samples: %j", media => {
  const preview = parseOpenApi(document("/pets/{id}", [{ name: "id", content: { "text/plain": media } }]));

  expect(prepareRequest(preview.operations[0].request).url).toBe("https://api.example.com/v1/pets/value");
  expect(preview.warnings.join(" ")).toMatch(/parameter id.*dot segment/i);
});

it.each([
  ["/pets/{first}{second}", [{ name: "first", example: "." }, { name: "second", example: "." }], "/pets/valuevalue"],
  ["/pets/.{id}", [{ name: "id", example: "." }], "/pets/.value"],
  ["/pets/{id}.", [{ name: "id", example: "." }], "/pets/value."],
  ["/pets/%2e{id}", [{ name: "id", example: "." }], "/pets/%2evalue"],
  ["/pets/{id}%2E", [{ name: "id", example: "." }], "/pets/value%2E"],
  ["/pets/%2E{id}", [{ name: "id", example: "" }], "/pets/%2Evalue"],
  ["/pets/{id}%2e", [{ name: "id", example: "" }], "/pets/value%2e"],
] as const)("checks the complete templated segment of %s", (path, parameters, expectedPath) => {
  const preview = parseOpenApi(document(path, parameters));
  const request = preview.operations[0].request;

  expect(request.path).toBe(`https://api.example.com/v1${expectedPath}`);
  expect(prepareRequest(request).url).toBe(request.path);
  expect(preview.warnings.join(" ")).toMatch(/dot segment/i);
});

it.each([
  ["/pets\\{id}/details", "/pets/value/details"],
  ["/pets/\t{id}/details", "/pets/value/details"],
  ["/pets/{id} ", "/pets/value"],
] as const)("accounts for URL preprocessing at the boundaries of %j", (path, expectedPath) => {
  const preview = parseOpenApi(document(path, [{ name: "id", example: ".." }]));

  expect(prepareRequest(preview.operations[0].request).url).toBe(`https://api.example.com/v1${expectedPath}`);
  expect(preview.warnings.join(" ")).toMatch(/parameter id.*dot segment/i);
});

it("preserves each safe occurrence when a repeated parameter also forms a dot segment", () => {
  const preview = parseOpenApi(document("/pets/{id}/version-{id}", [{ name: "id", example: ".." }]));

  expect(prepareRequest(preview.operations[0].request).url).toBe("https://api.example.com/v1/pets/value/version-..");
  expect(preview.warnings).toHaveLength(1);
});

it.each([
  ["/pets/{id}", "a/b c%", "/pets/a%2Fb%20c%25"],
  ["/pets/{id}", "%2e", "/pets/%252e"],
  ["/pets/{id}", ".%2E", "/pets/.%252E"],
  ["/pets/{id}", "%2e%2E", "/pets/%252e%252E"],
  ["/pets/{id}", "a/..", "/pets/a%2F.."],
  ["/pets/prefix-{id}", ".", "/pets/prefix-."],
  ["/pets/{id}-suffix", "..", "/pets/..-suffix"],
  ["/pets/{id}", [".", ".."], "/pets/.,.."],
] as const)("preserves normal sample encoding for %s with %j", (path, example, expectedPath) => {
  const preview = parseOpenApi(document(path, [{ name: "id", example }]));
  const request = preview.operations[0].request;

  expect(request.path).toBe(`https://api.example.com/v1${expectedPath}`);
  expect(prepareRequest(request).url).toBe(request.path);
  expect(preview.warnings).toEqual([]);
});

it("keeps JSON content's quoting when the serialized path sample is not a dot segment", () => {
  const preview = parseOpenApi(document("/pets/{id}", [{ name: "id", content: {
    "application/json": { example: ".." },
  } }]));

  expect(prepareRequest(preview.operations[0].request).url).toBe("https://api.example.com/v1/pets/%22..%22");
  expect(preview.warnings).toEqual([]);
});

function document(path: string, parameters: readonly Readonly<Record<string, unknown>>[]): string {
  return JSON.stringify({
    openapi: "3.1.1", info: { title: "Path samples", version: "1" },
    servers: [{ url: "https://api.example.com/v1" }], paths: { [path]: { get: {
      parameters: parameters.map(parameter => ({ in: "path", required: true, ...parameter })),
      responses: { "200": { description: "OK" } },
    } } },
  });
}
