// Guards the three OpenAPI import fixes through parser previews and prepared HTTP requests.
import { expect, it } from "vitest";
import { parseOpenApi } from "../src/openapi";
import { prepareRequest } from "../src/prepareRequest";

it("keeps an object form field under its declared name", () => {
  const preview = parseOpenApi(document({ "/profile": { post: {
    responses: { "200": { description: "OK" } },
    requestBody: { content: {
      "application/x-www-form-urlencoded": { schema: { type: "object", properties: {
        address: { type: "object", properties: { city: { type: "string", default: "Berlin" } } },
      } } },
    } },
  } } }));

  expect([...new URLSearchParams(prepareRequest(preview.operations[0].request).body)])
    .toEqual([["address", '{"city":"Berlin"}']]);
});

it("accepts a reference to an OpenAPI 3.1 boolean schema", () => {
  const source = document({ "/example": { post: {
    responses: { "200": { description: "OK" } },
    requestBody: { content: {
      "application/json": { schema: { $ref: "#/components/schemas/Any" } },
    } },
  } } }, { schemas: { Any: true } });
  const preview = parseOpenApi(source);

  expect(JSON.parse(prepareRequest(preview.operations[0].request).body)).toEqual({});
  expect(preview.warnings).toEqual([]);
});

it("keeps a dot-segment sample from silently changing the operation destination", () => {
  const preview = parseOpenApi(document({ "/pets/{id}": { get: {
    responses: { "200": { description: "OK" } },
    parameters: [{ name: "id", in: "path", required: true, example: "..", schema: { type: "string" } }],
  } } }));

  expect(prepareRequest(preview.operations[0].request).url).toBe("https://api.example.com/v1/pets/value");
  expect(preview.warnings.join(" ")).toMatch(/dot|path.*replac/i);
});

function document(paths: Record<string, unknown>, components?: Record<string, unknown>): string {
  return JSON.stringify({ openapi: "3.1.1", info: { title: "Edge cases", version: "1" },
    servers: [{ url: "https://api.example.com/v1" }], paths, components });
}
