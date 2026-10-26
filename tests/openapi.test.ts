// Exercises OpenAPI import through previews, portable collections, and executable request snapshots.
import { describe, expect, it, vi } from "vitest";
import { createOpenApiCollection, parseOpenApi } from "../src/openapi";
import { remapCollection } from "../src/interchange";
import { prepareRequest } from "../src/prepareRequest";
import type { CollectionNode } from "../src/components/collectionTree";

describe("OpenAPI request import", () => {
  it.each(["3.0.3", "3.1.0"])("imports OpenAPI %s operations into a named collection grouped by their first tag", version => {
    const preview = parseOpenApi(document({ openapi: version, paths: {
      "/pets": {
        get: { summary: "List pets", operationId: "listPets", tags: ["Pets", "Public"] },
        post: { operationId: "createPet", tags: ["Pets"] },
      },
      "/health": { get: {} },
    } }));

    expect(preview.title).toBe("Pet service");
    expect(preview.operations).toMatchObject([
      { method: "GET", path: "/pets", name: "List pets", tag: "Pets" },
      { method: "POST", path: "/pets", name: "createPet", tag: "Pets" },
      { method: "GET", path: "/health", name: "GET /health" },
    ]);
    const imported = createOpenApiCollection(preview);
    expect(imported.collection).toHaveLength(1);
    expect(imported.collection[0]).toMatchObject({ kind: "folder", name: "Pet service" });
    const folders = allNodes(imported.collection).filter(node => node.kind === "folder");
    expect(folders.map(node => node.name)).toEqual(["Pet service", "Pets", "Other"]);
    expect(Object.values(imported.requests).map(request => prepareRequest(request).url)).toEqual([
      "https://api.example.com/v1/pets", "https://api.example.com/v1/pets", "https://api.example.com/v1/health",
    ]);
  });

  it("reads YAML with inline collections, comments, quoted scalars, and a multiline body example", () => {
    const preview = parseOpenApi(`openapi: 3.1.0
info: {title: 'YAML service', version: '1'}
servers:
  - url: https://api.example.com # the import must not fetch this URL
paths:
  /messages:
    post:
      summary: Send message
      tags: [Messages]
      requestBody:
        content:
          text/plain:
            example: |-
              Hello: world
              # part of the body
`);

    expect(preview.title).toBe("YAML service");
    expect(prepareRequest(preview.operations[0].request)).toMatchObject({
      method: "POST", url: "https://api.example.com/messages", body: "Hello: world\n# part of the body",
      headers: [{ name: "Content-Type", value: "text/plain" }],
    });
  });

  it("uses operation, path, and root servers in that order, expanding the first server's variable defaults", () => {
    const preview = parseOpenApi(document({
      servers: [
        { url: "https://{region}.example.com/{version}", variables: { region: { default: "eu" }, version: { default: "v2" } } },
        { url: "https://ignored.example.com" },
      ],
      paths: {
        "/root": { get: {} },
        "/path": {
          servers: [{ url: "https://path.example.com/base/" }],
          get: {}, post: { servers: [{ url: "https://operation.example.com/own" }] },
        },
      },
    }));

    expect(preview.operations.map(operation => prepareRequest(operation.request).url)).toEqual([
      "https://eu.example.com/v2/root", "https://path.example.com/base/path", "https://operation.example.com/own/path",
    ]);
  });

  it("applies an explicit base URL to every selected operation, including relative or missing specification servers", () => {
    const relative = document({ servers: [{ url: "/api" }], paths: {
      "/pets": { get: {}, post: { servers: [{ url: "https://production.example.com" }] } },
    } });
    expect(parseOpenApi(relative, { baseUrl: "http://localhost:8080/dev/" }).operations.map(operation => operation.request.path))
      .toEqual(["http://localhost:8080/dev/pets", "http://localhost:8080/dev/pets"]);
    expect(parseOpenApi(document({ servers: [] }), { baseUrl: "https://override.example.com" }).operations[0].request.path)
      .toBe("https://override.example.com/pets");
  });

  it("inherits parameters, lets operation parameters replace matching names and locations, and encodes path samples once", () => {
    const preview = parseOpenApi(document({ paths: {
      "/pets/{id}": {
        parameters: [
          { in: "path", name: "id", required: true, example: "a/b c%", schema: { type: "string" } },
          { in: "query", name: "tag", required: true, example: "inherited" },
          { in: "header", name: "X-Client", required: true, schema: { default: "desktop" } },
          { in: "query", name: "optional", schema: { default: "editable" } },
        ],
        get: { parameters: [
          { in: "query", name: "tag", required: true, example: "cats & dogs" },
          { in: "header", name: "tag", required: true, example: "different location" },
        ] },
      },
    } }));
    const request = preview.operations[0].request;
    const prepared = prepareRequest(request);

    expect(prepared.url).toBe("https://api.example.com/v1/pets/a%2Fb%20c%25?tag=cats+%26+dogs");
    expect(prepared.headers).toContainEqual({ name: "X-Client", value: "desktop" });
    expect(prepared.headers).toContainEqual({ name: "tag", value: "different location" });
    expect(request.query).toContainEqual({ name: "optional", value: "editable", enabled: false });
    expect(request.query.filter(entry => entry.name === "tag")).toHaveLength(1);
  });

  it("chooses parameter examples before schema defaults and uses named examples, defaults, and enum samples", () => {
    const preview = parseOpenApi(document({ paths: { "/pets": { get: { parameters: [
      { in: "query", name: "direct", required: true, example: "example", schema: { default: "default" } },
      { in: "query", name: "named", required: true, examples: { first: { value: "named value" } } },
      { in: "query", name: "default", required: true, schema: { type: "integer", default: 12 } },
      { in: "query", name: "enum", required: true, schema: { type: "string", enum: ["first", "second"] } },
    ] } } } }));

    const parameters = new URL(prepareRequest(preview.operations[0].request).url).searchParams;
    expect([...parameters]).toEqual([
      ["direct", "example"], ["named", "named value"], ["default", "12"], ["enum", "first"],
    ]);
  });

  it("resolves escaped local JSON pointers in path items, parameters, request bodies, and schemas", () => {
    const preview = parseOpenApi(document({
      openapi: "3.1.0",
      paths: { "/pets/{id}": { $ref: "#/components/pathItems/Pet~1item~0v1" } },
      components: {
        pathItems: { "Pet/item~v1": { post: {
          parameters: [{ $ref: "#/components/parameters/PetId" }], requestBody: { $ref: "#/components/requestBodies/Pet" },
        } } },
        parameters: { PetId: { name: "id", in: "path", required: true, example: "kitten", schema: { type: "string" } } },
        requestBodies: { Pet: { content: { "application/json": { schema: { $ref: "#/components/schemas/Pet~1record~0v1" } } } } },
        schemas: { "Pet/record~v1": { type: "object", properties: {
          name: { type: "string", default: "Milo" }, age: { type: "integer", enum: [2, 3] },
        } } },
      },
    }));
    const prepared = prepareRequest(preview.operations[0].request);

    expect(prepared.url).toBe("https://api.example.com/v1/pets/kitten");
    expect(JSON.parse(prepared.body)).toEqual({ name: "Milo", age: 2 });
    expect(prepared.headers).toContainEqual({ name: "Content-Type", value: "application/json" });
  });

  it("preserves OpenAPI 3.1 schema siblings beside a local reference", () => {
    const preview = parseOpenApi(document({ openapi: "3.1.0",
      paths: { "/pets": { post: { requestBody: { content: { "application/json": { schema: {
        type: "object", properties: {
          example: { $ref: "#/components/schemas/Text", example: "sibling example", default: "sibling default" },
          default: { $ref: "#/components/schemas/Text", default: "sibling default" },
          readOnly: { $ref: "#/components/schemas/Text", readOnly: true },
          object: { $ref: "#/components/schemas/Object", properties: {
            added: { type: "string", default: "added" }, replaced: { type: "string", default: "sibling property" },
          } },
        },
      } } } } } } },
      components: { schemas: {
        Text: { type: "string", default: "referenced default" },
        Object: { type: "object", properties: {
          inherited: { type: "string", default: "inherited" }, replaced: { type: "string", default: "referenced property" },
        } },
      } },
    }));

    expect(JSON.parse(preview.operations[0].request.body)).toEqual({
      example: "sibling example", default: "sibling default",
      object: { inherited: "inherited", replaced: "sibling property", added: "added" },
    });
  });

  it("warns when OpenAPI 3.0 reference siblings cannot participate in sample generation", () => {
    const preview = parseOpenApi(document({
      paths: { "/pets": { post: { requestBody: { content: { "application/json": { schema: {
        $ref: "#/components/schemas/Text", default: "ignored sibling",
      } } } } } } },
      components: { schemas: { Text: { type: "string", default: "referenced default" } } },
    }));

    expect(JSON.parse(preview.operations[0].request.body)).toBe("referenced default");
    expect(preview.warnings.join(" ")).toMatch(/sibling.*ignored|sibling.*unsupported/i);
  });

  it("generates a bounded example for recursive schemas and explains the omitted recursion", () => {
    const preview = parseOpenApi(document({
      paths: { "/nodes": { post: { requestBody: { content: { "application/json": {
        schema: { $ref: "#/components/schemas/Node" },
      } } } } } },
      components: { schemas: { Node: { type: "object", properties: {
        name: { type: "string", default: "root" }, child: { $ref: "#/components/schemas/Node" },
      } } } },
    }));

    expect(JSON.parse(preview.operations[0].request.body)).toMatchObject({ name: "root" });
    expect(preview.operations[0].request.body.length).toBeLessThan(1000);
    expect(preview.warnings.join(" ")).toMatch(/recurs|cycl|depth/i);
  });

  it("bounds total generated output when a small schema graph repeatedly references the next level", () => {
    const schemas = Object.fromEntries(Array.from({ length: 8 }, (_, level) => [
      `Level${level}`, level === 7 ? { type: "string", default: "leaf" } : {
        type: "object", properties: Object.fromEntries(Array.from({ length: 25 }, (_, field) => [
          `field${field}`, { $ref: `#/components/schemas/Level${level + 1}` },
        ])),
      },
    ]));
    const preview = parseOpenApi(document({
      paths: { "/tree": { post: { requestBody: { content: { "application/json": {
        schema: { $ref: "#/components/schemas/Level0" },
      } } } } } },
      components: { schemas },
    }));

    expect(JSON.parse(preview.operations[0].request.body)).toBeTypeOf("object");
    expect(preview.operations[0].request.body.length).toBeLessThan(200_000);
    expect(preview.warnings.join(" ")).toMatch(/truncat|limit|budget|complex|large/i);
  });

  it("rejects a small schema whose repeated string defaults exceed the generated sample size limit", () => {
    const text = document({
      paths: { "/large": { post: { requestBody: { content: { "application/json": { schema: {
        type: "object", properties: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
          `field${index}`, { $ref: "#/components/schemas/Text" },
        ])),
      } } } } } } },
      components: { schemas: { Text: { type: "string", default: "x".repeat(24_000) } } },
    });

    expect(text.length).toBeLessThan(40_000);
    expect(() => parseOpenApi(text)).toThrow(/sample.*limit|sample.*size|body.*limit|body.*exceed/i);
  });

  it("counts repeated array values toward the sample size limit even when their schema is shared", () => {
    const schema = Array.from({ length: 5 }).reduce<Record<string, unknown>>(
      items => ({ type: "array", minItems: 3, items }), { $ref: "#/components/schemas/Text" },
    );
    const text = document({
      paths: { "/large": { post: { requestBody: { content: { "application/json": { schema } } } } } },
      components: { schemas: { Text: { type: "string", default: "x".repeat(10_000) } } },
    });

    expect(text.length).toBeLessThan(15_000);
    expect(() => parseOpenApi(text)).toThrow(/sample.*limit|sample.*size|body.*limit|body.*exceed/i);
  });

  it("preserves false, zero, and null samples while omitting read-only fields from a generated request body", () => {
    const preview = parseOpenApi(document({ openapi: "3.1.0", paths: { "/pets": { post: { requestBody: { content: {
      "application/json": { schema: { type: "object", properties: {
        enabled: { type: "boolean", default: false }, count: { type: "integer", default: 0 },
        nickname: { type: ["string", "null"], default: null },
        tags: { type: "array", items: { type: "string", enum: ["pet"] } },
        id: { type: "integer", readOnly: true, default: 123 },
        password: { type: "string", writeOnly: true, default: "editable" },
      } } },
    } } } } } }));

    expect(JSON.parse(preview.operations[0].request.body)).toEqual({
      enabled: false, count: 0, nickname: null, tags: ["pet"], password: "editable",
    });
  });

  it("prefers explicit JSON media examples to generated schemas and retains placeholder-looking samples literally", () => {
    const preview = parseOpenApi(document({ paths: { "/messages": { post: {
      parameters: [
        { name: "token", in: "query", required: true, example: "{{token}}" },
        { name: "X-Token", in: "header", required: true, example: "{{token}}" },
      ],
      requestBody: { content: { "application/json": {
        example: { message: "{{token}}" }, schema: { type: "object", properties: { ignored: { default: "schema" } } },
      } } },
    } } } }));
    const request = preview.operations[0].request;
    const prepared = prepareRequest(request, {
      id: "development", name: "Development", variables: [{ name: "token", value: "environment secret", enabled: true }],
    });

    expect(request.inputMode).toBe("literal");
    expect(JSON.parse(prepared.body)).toEqual({ message: "{{token}}" });
    expect(new URL(prepared.url).searchParams.get("token")).toBe("{{token}}");
    expect(prepared.headers).toContainEqual({ name: "X-Token", value: "{{token}}" });
  });

  it("uses a local named media example without interpreting its contents as an environment template", () => {
    const preview = parseOpenApi(document({
      paths: { "/messages": { post: { requestBody: { content: { "application/json": {
        examples: { sample: { $ref: "#/components/examples/Message" } },
      } } } } } },
      components: { examples: { Message: { value: { message: "{{literal}}" } } } },
    }));

    expect(JSON.parse(prepareRequest(preview.operations[0].request).body)).toEqual({ message: "{{literal}}" });
  });

  it("creates URL-encoded text bodies from form schema samples", () => {
    const preview = parseOpenApi(document({ paths: { "/forms": { post: { requestBody: { content: {
      "application/x-www-form-urlencoded": { schema: { type: "object", properties: {
        message: { type: "string", default: "hello & goodbye" }, count: { type: "integer", default: 2 },
      } } },
    } } } } } }));
    const prepared = prepareRequest(preview.operations[0].request);

    expect([...new URLSearchParams(prepared.body)]).toEqual([["message", "hello & goodbye"], ["count", "2"]]);
    expect(prepared.headers).toContainEqual({ name: "Content-Type", value: "application/x-www-form-urlencoded" });
  });

  it.each([
    [{ type: "http", scheme: "basic" }, { type: "basic", username: "", password: "" }],
    [{ type: "http", scheme: "bearer" }, { type: "bearer", token: "" }],
    [{ type: "apiKey", in: "header", name: "X-API-Key" }, { type: "api-key", location: "header", name: "X-API-Key", value: "" }],
    [{ type: "apiKey", in: "query", name: "api_key" }, { type: "api-key", location: "query", name: "api_key", value: "" }],
  ])("imports inherited authentication as an editable hint with empty credentials: %j", (scheme, auth) => {
    const preview = parseOpenApi(document({
      security: [{ credential: [] }], components: { securitySchemes: { credential: scheme } },
      paths: { "/private": { get: {} }, "/public": { get: { security: [] } } },
    }));

    expect(preview.operations[0].request.auth).toEqual(auth);
    expect(preview.operations[1].request.auth).toEqual({ type: "none" });
    expect(preview.warnings.join(" ")).toMatch(/credential|authentication|token|key/i);
  });

  it("lets operation authentication replace the root requirement", () => {
    const preview = parseOpenApi(document({
      security: [{ bearer: [] }], components: { securitySchemes: {
        bearer: { type: "http", scheme: "bearer" }, basic: { type: "http", scheme: "basic" },
      } },
      paths: { "/pets": { get: { security: [{ basic: [] }] } } },
    }));

    expect(preview.operations[0].request.auth).toEqual({ type: "basic", username: "", password: "" });
  });

  it.each([
    { security: [{ bearer: [] }, { key: [] }], warning: /alternative/i },
    { security: [{ bearer: [], key: [] }], warning: /combined|all.*represent|only one/i },
  ])("explains the approximation when importing one authentication hint from $security", ({ security, warning }) => {
    const preview = parseOpenApi(document({
      security, components: { securitySchemes: {
        bearer: { type: "http", scheme: "bearer" }, key: { type: "apiKey", in: "header", name: "X-Key" },
      } },
    }));

    expect(preview.operations[0].request.auth).toEqual({ type: "bearer", token: "" });
    expect(preview.warnings.join(" ")).toMatch(warning);
  });

  it("keeps an empty first security alternative unauthenticated", () => {
    const preview = parseOpenApi(document({
      security: [{}, { bearer: [] }], components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    }));

    expect(preview.operations[0].request.auth).toEqual({ type: "none" });
  });

  it("warns about unsupported references, content, authentication, and serialization without fetching anything", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Import must not use the network"));
    try {
      const preview = parseOpenApi(document({
        security: [{ login: [] }], components: { securitySchemes: { login: { type: "oauth2", flows: {} } } },
        paths: {
          "/external": { get: { parameters: [{ $ref: "https://schemas.example.com/parameters.json#/token" }] } },
          "/multipart": { post: { requestBody: { content: { "multipart/form-data": { schema: { type: "object" } } } } } },
          "/binary": { post: { requestBody: { content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } } } },
          "/object": { get: { parameters: [{ name: "filter", in: "query", style: "deepObject", schema: { type: "object" } }] } },
        },
      }));
      const warnings = preview.warnings.join(" ");

      expect(preview.operations).toHaveLength(4);
      expect(warnings).toMatch(/external|https:\/\/schemas/i);
      expect(warnings).toMatch(/multipart/i);
      expect(warnings).toMatch(/binary|octet-stream/i);
      expect(warnings).toMatch(/oauth2/i);
      expect(warnings).toMatch(/deepObject|serializ|object parameter/i);
      expect(preview.operations.every(operation => operation.request.body === "")).toBe(true);
      expect(preview.operations.every(operation => operation.request.auth.type === "none")).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("omits unsupported parameter media content with an explanation", () => {
    const preview = parseOpenApi(document({ paths: { "/pets": { get: { parameters: [{
      name: "payload", in: "query", required: true,
      content: { "application/octet-stream": { example: "unsupported binary sample" } },
    }] } } } }));

    expect(preview.operations[0].request.query).toEqual([]);
    expect(preview.warnings.join(" ")).toMatch(/parameter.*unsupported.*content|parameter.*unsupported.*media/i);
  });

  it("replaces an unusable external path sample with an editable value rather than an empty segment", () => {
    const preview = parseOpenApi(document({ paths: { "/pets/{id}": { get: { parameters: [{
      name: "id", in: "path", required: true, schema: { $ref: "https://schemas.example.com/PetId.json" },
    }] } } } }));

    expect(prepareRequest(preview.operations[0].request).url).toBe("https://api.example.com/v1/pets/value");
    expect(preview.warnings.join(" ")).toMatch(/external reference/i);
    expect(preview.warnings.join(" ")).toMatch(/no usable sample|replace.*value/i);
  });
});

describe("OpenAPI collection conversion", () => {
  it("selects operations by stable unique identity and converts repeatedly without mutating the preview", () => {
    const text = document({ paths: {
      "/pets": { get: { operationId: "duplicate", tags: ["Pets"] }, post: { operationId: "duplicate", tags: ["Pets"] } },
      "/health": { get: {} },
    } });
    const preview = parseOpenApi(text);
    const original = structuredClone(preview);
    const selection = [preview.operations[1].id];
    const first = createOpenApiCollection(preview, selection);
    const second = createOpenApiCollection(preview, selection);

    expect(new Set(preview.operations.map(operation => operation.id)).size).toBe(3);
    expect(parseOpenApi(text)).toEqual(preview);
    expect(first).toEqual(second);
    expect(Object.values(first.requests)).toHaveLength(1);
    expect(Object.values(first.requests)[0].method).toBe("POST");
    expect(allNodes(first.collection).filter(node => node.kind === "request")).toHaveLength(1);
    Object.values(first.requests)[0].query.push({ name: "edited", value: "later", enabled: true });
    expect(preview).toEqual(original);
    expect(second).toEqual(createOpenApiCollection(preview, selection));
    expect(Object.values(createOpenApiCollection(preview, []).requests)).toHaveLength(0);
  });

  it("rejects stale selection identities rather than silently dropping a requested operation", () => {
    const preview = parseOpenApi(document());

    expect(() => createOpenApiCollection(preview, [preview.operations[0].id, "GET /removed"]))
      .toThrow(/selected|preview|operation/i);
  });

  it("can merge the same imported collection twice with disjoint folder and request identities", () => {
    const imported = createOpenApiCollection(parseOpenApi(document()));
    const source = structuredClone(imported);
    const first = remapCollection(imported);
    const firstIds = allNodes(first.collection).map(node => node.id);
    const second = remapCollection(imported, firstIds);
    const secondIds = allNodes(second.collection).map(node => node.id);

    expect(firstIds.every(id => !secondIds.includes(id))).toBe(true);
    for (const collection of [first, second]) {
      const requestNodes = allNodes(collection.collection).filter(node => node.kind === "request");
      expect(requestNodes.map(node => node.id).sort()).toEqual(Object.keys(collection.requests).sort());
      expect(prepareRequest(Object.values(collection.requests)[0]).url).toBe("https://api.example.com/v1/pets");
    }
    expect(imported).toEqual(source);
  });
});

describe("OpenAPI diagnostics", () => {
  it.each([
    ["{", /JSON|YAML|parse|document/i],
    ["[]", /object|document/i],
    [document({ openapi: "2.0" }), /3\.0|3\.1|version/i],
    [document({ openapi: "3.2.0" }), /3\.0|3\.1|version/i],
    [document({ paths: {} }), /operation/i],
    [document({ paths: { "/pets": { parameters: [] } } }), /operation/i],
    [document({ paths: { "/pets": { get: { parameters: [{ $ref: "#/components/parameters/Missing" }] } } } }), /reference|Missing|resolve/i],
    [document({ paths: { "/pets": { $ref: "#/paths/~1pets" } } }), /reference|cycl|recurs/i],
    ["openapi: 3.1.0\ninfo: [unterminated", /YAML|parse|flow|document/i],
    ["openapi: 3.1.0\ninfo: *unknown", /YAML|alias|unknown|document/i],
    ["openapi: 3.1.0\nx-recursive: &recursive {again: *recursive}", /YAML|alias|recurs/i],
  ])("rejects malformed or unsupported documents: %s", (text, message) => {
    expect(() => parseOpenApi(text)).toThrow(message);
  });

  it.each([
    [], [{ url: "/relative" }], [{ url: "https://user:password@example.com" }],
    [{ url: "ftp://example.com" }], [{ url: "https://{region}.example.com", variables: { region: {} } }],
  ].map(servers => ({ servers })))("requires a usable absolute server or explicit base URL override: $servers", ({ servers }) => {
    expect(() => parseOpenApi(document({ servers }))).toThrow(/server|base URL|HTTP|default/i);
  });

  it.each(["/relative", "ftp://example.com", "https://user:password@example.com", "not a URL"])("rejects an invalid explicit base URL: %s", baseUrl => {
    expect(() => parseOpenApi(document(), { baseUrl })).toThrow(/base URL|HTTP|credential/i);
  });
});

function document(changes: Record<string, unknown> = {}): string {
  return JSON.stringify({
    openapi: "3.0.3", info: { title: "Pet service", version: "1" },
    servers: [{ url: "https://api.example.com/v1" }], paths: { "/pets": { get: {} } }, ...changes,
  });
}

function allNodes(nodes: readonly CollectionNode[]): CollectionNode[] {
  return nodes.flatMap(node => node.kind === "folder" ? [node, ...allNodes(node.children)] : [node]);
}
