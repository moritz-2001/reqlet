<!-- Records reproducible OpenAPI import edge cases through the public parser and request-preparation interfaces. -->
# OpenAPI support test findings

Tested on **2026-10-26** through `parseOpenApi` and `prepareRequest`. The three
primary findings below have been fixed and now have normal passing regression
tests. Original observations and source line references describe the implementation
before the fixes; the secondary findings remain open.

These findings supplement the [supported import contract](openapi-import.md).
Generated samples are explicitly not guaranteed to satisfy a schema; the
diagnostic findings below concern missing explanations of known approximations.

## Verification and retained coverage

After the fixes, `npm test` passed **839 tests**: 832 Vitest tests and 7 Node
tests, with no expected failures. `npm run build` passed TypeScript checks and
the production build. The five OpenAPI parser regression suites pass 115 tests.

Before the fixes, the existing automated suite passed **776 tests**, comprising
769 Vitest tests and 7 Node tests. The production build also passed. Browser checks against that
build sent GET and POST requests to a local loopback server; both returned HTTP
200, with URL encoding, query values, headers, and literal JSON verified. Imported
definitions persisted after reloading the application.
This execution check used the browser fetch transport; the native desktop
transport was not exercised in this run.

[openapi.edge-cases.test.ts](../tests/openapi.edge-cases.test.ts) retains
**ordinary regression coverage** for all three fixes. The former `it.fails`
markers were removed. Dedicated form body, schema reference, and path sample
suites cover the surrounding serialization and resolution cases.
The passing suite does not establish full OpenAPI compliance.

Run the focused coverage with:

```sh
./node_modules/.bin/vitest run tests/openapi*.test.ts tests/ImportExport.test.ts tests/App.storage.test.ts
```

The original focused run had **72 passed, 3 expected failures**. All three
expected failures are now required to pass normally.

## Reproduction setup

The following helper produces complete OpenAPI documents. The snippets can be
placed in a Vitest file under `tests/` with these imports and helper:

```ts
import { parseOpenApi } from "../src/openapi";
import { prepareRequest } from "../src/prepareRequest";

function description(
  operation: object,
  path = "/example",
  method = "post",
  components: object = {},
): string {
  return JSON.stringify({
    openapi: "3.1.1", info: { title: "Example", version: "1" },
    servers: [{ url: "https://api.example.com/v1" }],
    paths: { [path]: { [method]: {
      responses: { "200": { description: "OK" } }, ...operation,
    } } }, components,
  });
}

function bodyOperation(schema: unknown, mediaType = "application/json"): object {
  return { requestBody: { content: { [mediaType]: { schema } } } };
}
```

## Object-valued form fields lose their owning field name

**Fixed:** `importBody` serializes default object fields as JSON under their
original field name. Explicit serialization settings continue to use the
parameter-style mapping, preserving the caller's requested expansion.

```ts
const preview = parseOpenApi(description(bodyOperation({
  type: "object", properties: {
    address: { type: "object", properties: {
      city: { type: "string", default: "Berlin" },
    } },
  },
}, "application/x-www-form-urlencoded")));
const request = prepareRequest(preview.operations[0].request);
// Observed: request.body === "city=Berlin"; preview.warnings === [].
```

Expected: retain `address` and serialize its object value as JSON, producing
`address=%7B%22city%22%3A%22Berlin%22%7D`. This is the default behavior illustrated by
the [OpenAPI 3.1.1 form body example](https://spec.openapis.org/oas/v3.1.1.html#example-url-encoded-form-with-json-values).
If this representation is unsupported, a preview note should explain the
approximation. The observed body instead changes the submitted field structure.

Affected code: [openapi.ts](../src/openapi.ts), lines 314–320, passes an empty
encoding configuration to `queryParameter`; its default `form`/`explode: true`
behavior expands the object's properties into separate top-level fields.

## Referenced boolean schemas reject an otherwise usable import

**Fixed:** `OpenApiValueContext.resolveSchema` accepts boolean targets, including
chained references and OpenAPI 3.1 sibling keywords. The separate `resolve`
operation keeps non-schema references restricted to objects.

```ts
const preview = parseOpenApi(description(
  bodyOperation({ $ref: "#/components/schemas/Any" }),
  "/example", "post", { schemas: { Any: true } },
));
// Observed: throws "POST /example body schema must be an object."
```

Changing the body schema to inline `true` succeeds and generates `{}`. Referencing
`false` also throws, whereas inline `false` leaves an empty body with a note.
The [OpenAPI 3.1.1 Schema Object](https://spec.openapis.org/oas/v3.1.1.html#schema-object)
explicitly permits these boolean schemas. Expected: local references preserve
the inline behavior instead of rejecting the whole import.

Affected code: [openapi.ts](../src/openapi.ts), line 401, requires every resolved
target to be an object. [openapiValues.ts](../src/openapiValues.ts), lines 73–75,
handles booleans only before reference resolution.

## Dot-segment path samples change the request destination

**Fixed:** path substitution replaces contributing samples with the editable
`value` placeholder and emits a preview note when they would form normalizing
dot segments. Normal path samples keep their existing encoding.

```ts
const preview = parseOpenApi(description({ parameters: [{
  name: "id", in: "path", required: true,
  schema: { type: "string" }, example: "..",
}] }, "/pets/{id}", "get"));
const imported = preview.operations[0].request;
const prepared = prepareRequest(imported);
// Observed: imported.path === "https://api.example.com/v1/pets/..".
// Observed: prepared.url === "https://api.example.com/v1/"; warnings === [].
```

With `example: "."`, preparation produces `/v1/pets/`. Normal URL processing
removes these segments, so the generated request no longer addresses the sampled
identifier. Expected: diagnose the unrepresentable sample and retain a usable
editable replacement, or otherwise preserve its intended path semantics. Encoding
the dots as `%2E` alone does not solve normalization by the browser URL API.

Affected code: [openapi.ts](../src/openapi.ts), lines 230–232 and 252–256, encodes
path samples with `encodeURIComponent`, which leaves literal dots unchanged.

## Remaining secondary diagnostics and content cases

Each row uses the reproduction helper above. These are narrower gaps than the
functional issues above and do not imply a guarantee of schema-valid samples.

| Input | Observed | Expected follow-up | Affected code |
| --- | --- | --- | --- |
| `description(bodyOperation({type: "string", minLength: 500}))` | JSON string sample has 256 characters; warnings empty. | Add a note that the sample length was capped. | [openapiValues.ts](../src/openapiValues.ts), line 178. |
| `description(bodyOperation({type: "array", minItems: 5, items: {type: "integer"}}))` | Sample has 3 items; warnings empty. | Add a note that the sample item count was capped. | [openapiValues.ts](../src/openapiValues.ts), line 116. |
| `description({parameters: [{name: "X-Name", in: "header", required: true, content: {"text/plain": {example: "a\r\nb"}}}]}, "/example", "get")` | Header is retained without a warning; `prepareRequest` rejects its line breaks. | Apply the existing invalid-header diagnostic to content-based parameters too. This is an unusable HTTP example, so reporting the limitation is sufficient. | [openapi.ts](../src/openapi.ts), lines 216–220; compare line 237. |
| `description({parameters: [{name: "payload", in: "query", required: true, content: {"application/x-www-form-urlencoded": {example: {term: "cat dog", page: 1}}}}]}, "/example", "get")` | Query row value is `{"term":"cat dog","page":1}`; warnings empty. | Serialize according to the declared media type, or report that this parameter content representation is unsupported. | [openapi.ts](../src/openapi.ts), line 216. |

The last case follows the parameter's declared media representation rather than
its schema-style serialization settings; see
[OpenAPI 3.1.1 parameter content](https://spec.openapis.org/oas/v3.1.1.html#fixed-fields-for-use-with-content).
The current implementation selects form media as supported, then silently uses
its general object-to-JSON conversion.
