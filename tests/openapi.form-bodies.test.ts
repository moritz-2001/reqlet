// Verifies default object form encoding and explicit serialization through prepared HTTP bodies.
import { expect, it } from "vitest";
import { parseOpenApi } from "../src/openapi";
import { prepareRequest } from "../src/prepareRequest";

it.each([undefined, {}, { "x-note": "keep defaults" }])(
  "keeps nested and empty object examples under their form field names with encoding %j",
  configuration => {
    const preview = parseOpenApi(formDocument({
      address: { city: "Berlin", extra: { note: "hello & goodbye" } }, empty: {}, active: false, count: 0,
    }, { address: configuration }));
    const request = prepareRequest(preview.operations[0].request);

    expect([...new URLSearchParams(request.body)]).toEqual([
      ["address", '{"city":"Berlin","extra":{"note":"hello & goodbye"}}'],
      ["empty", "{}"], ["active", "false"], ["count", "0"],
    ]);
    expect(request.headers).toContainEqual({ name: "Content-Type", value: "application/x-www-form-urlencoded" });
    expect(preview.warnings).toEqual([]);
  },
);

it.each([
  { configuration: { style: "form" }, expected: [["city", "Berlin"]] },
  { configuration: { explode: true }, expected: [["city", "Berlin"]] },
  { configuration: { explode: false }, expected: [["address", "city,Berlin"]] },
  { configuration: { allowReserved: false }, expected: [["city", "Berlin"]] },
  { configuration: { style: "deepObject", explode: true }, expected: [["address[city]", "Berlin"]] },
])("honors explicit form field serialization $configuration", ({ configuration, expected }) => {
  const preview = parseOpenApi(formDocument({ address: { city: "Berlin" } }, { address: configuration }));

  expect([...new URLSearchParams(prepareRequest(preview.operations[0].request).body)]).toEqual(expected);
  expect(preview.warnings).toEqual([]);
});

it("preserves repeated primitive array fields beside default object fields", () => {
  const preview = parseOpenApi(formDocument({ tags: ["cat", "dog"], address: { city: "Berlin" } }));

  expect([...new URLSearchParams(prepareRequest(preview.operations[0].request).body)]).toEqual([
    ["tags", "cat"], ["tags", "dog"], ["address", '{"city":"Berlin"}'],
  ]);
});

function formDocument(example: Record<string, unknown>, encoding?: Record<string, unknown>): string {
  return JSON.stringify({
    openapi: "3.1.1", info: { title: "Form examples", version: "1" },
    servers: [{ url: "https://api.example.com/v1" }],
    paths: { "/profile": { post: {
      requestBody: { content: { "application/x-www-form-urlencoded": { example, encoding } } },
      responses: { "200": { description: "OK" } },
    } } },
  });
}
