// Verifies boolean schema references through parseOpenApi, including contexts that still require object targets.
import { describe, expect, it } from "vitest";
import { parseOpenApi } from "../src/openapi";

describe("OpenAPI boolean schema references", () => {
  it.each([true, false])("samples direct and chained references to %s like their inline schema", schema => {
    const inline = preview(schema);
    const direct = preview({ $ref: "#/components/schemas/Target" }, { Target: schema });
    const chained = preview({ $ref: "#/components/schemas/Alias" }, {
      Alias: { $ref: "#/components/schemas/Target" }, Target: schema,
    });

    expect(direct.operations[0].request.body).toBe(inline.operations[0].request.body);
    expect(chained.operations[0].request.body).toBe(inline.operations[0].request.body);
    expect(direct.warnings).toEqual(inline.warnings);
    expect(chained.warnings).toEqual(inline.warnings);
    expect(inline.operations[0].request.body).toBe(schema ? "{}" : "");
  });

  it.each([true, false])("preserves inline behavior for nested %s schemas", schema => {
    const shapes = [
      (child: unknown) => ({ type: "object", properties: { value: child } }),
      (child: unknown) => ({ type: "array", items: child }),
      (child: unknown) => ({ type: "object", additionalProperties: child }),
      (child: unknown) => ({ allOf: [child] }),
      (child: unknown) => ({ anyOf: [child, { type: "string" }] }),
      (child: unknown) => ({ oneOf: [child, { type: "string" }] }),
    ];
    for (const shape of shapes) {
      const inline = preview(shape(schema));
      const referenced = preview(shape({ $ref: "#/components/schemas/Target" }), { Target: schema });

      expect(referenced.operations[0].request.body).toBe(inline.operations[0].request.body);
      expect(referenced.warnings).toEqual(inline.warnings);
    }
  });

  it.each([
    [{ type: "integer", minimum: 5 }, 5],
    [{ default: false }, false],
    [{ examples: [0] }, 0],
    [{ example: null }, null],
    [{ const: "constant" }, "constant"],
    [{ enum: ["choice"] }, "choice"],
    [{ type: "array", items: { default: "item" } }, ["item"]],
    [{ allOf: [{ type: "object", properties: { added: { default: "value" } } }] }, { added: "value" }],
  ])("retains supported sibling keywords beside a true schema reference: %j", (siblings, expected) => {
    const result = preview({ $ref: "#/components/schemas/Any", ...siblings }, { Any: true });

    expect(JSON.parse(result.operations[0].request.body)).toEqual(expected);
    expect(result.warnings).toEqual([]);
  });

  it("combines true reference siblings across a chain and omits referenced read-only properties", () => {
    const result = preview({ type: "object", properties: {
      visible: { $ref: "#/components/schemas/Extended", properties: { added: { default: "outer" } } },
      hidden: { $ref: "#/components/schemas/ReadOnly", default: "omit me" },
    } }, {
      Any: true,
      Extended: { $ref: "#/components/schemas/Any", type: "object", properties: { base: { default: "inner" } } },
      ReadOnly: { $ref: "#/components/schemas/Any", readOnly: true },
    });

    expect(JSON.parse(result.operations[0].request.body)).toEqual({ visible: { base: "inner", added: "outer" } });
    expect(result.warnings).toEqual([]);
  });

  it("keeps a false target unsampleable even when chained siblings provide a default", () => {
    const result = preview({ $ref: "#/components/schemas/Alias", default: "outer" }, {
      Alias: { $ref: "#/components/schemas/Never", example: "inner" }, Never: false,
    });

    expect(result.operations[0].request.body).toBe("");
    expect(result.warnings.join(" ")).toMatch(/no usable request body example or schema sample/i);
  });

  it("still generates declared dictionary values through object references", () => {
    const result = preview({ type: "object", additionalProperties: { $ref: "#/components/schemas/Value" } }, {
      Value: { type: "string", default: "value" },
    });

    expect(JSON.parse(result.operations[0].request.body)).toEqual({ key: "value" });
  });

  it.each([null, 42, "text", [], [true]])("rejects non-schema reference targets: %j", target => {
    expect(() => preview({ $ref: "#/components/schemas/Target" }, { Target: target })).toThrow(/schema must be an object/i);
  });

  it.each([true, false])("continues requiring object reference targets outside schemas, including %s", target => {
    const source = document({ parameters: [{ $ref: "#/components/schemas/Target" }] }, { Target: target });

    expect(() => parseOpenApi(source)).toThrow(/parameter must be an object/i);
  });

  it("continues rejecting boolean named-example reference targets", () => {
    const source = document({ requestBody: { content: { "application/json": {
      examples: { invalid: { $ref: "#/components/schemas/Target" } }, schema: true,
    } } } }, { Target: true });

    expect(() => parseOpenApi(source)).toThrow(/example invalid must be an object/i);
  });
});

function preview(schema: unknown, schemas: Record<string, unknown> = {}) {
  return parseOpenApi(document({ requestBody: { content: { "application/json": { schema } } } }, schemas));
}

function document(operation: Record<string, unknown>, schemas: Record<string, unknown>): string {
  return JSON.stringify({ openapi: "3.1.1", info: { title: "Schema references", version: "1" },
    servers: [{ url: "https://api.example.com/v1" }], paths: { "/example": { post: operation } },
    components: { schemas },
  });
}
