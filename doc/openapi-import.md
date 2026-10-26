# OpenAPI import

OpenAPI import turns a local OpenAPI 3.0 or 3.1 document into editable HTTP
requests. It accepts pasted JSON or YAML and files loaded into the import editor.
It does not fetch a document or execute any generated request.

## Review and import

Open **Workspace tools → Import / Export**, paste the document or load a file,
and choose **Import** to create a preview. Automatic format detection recognizes
OpenAPI; selecting **OpenAPI 3.0 / 3.1 (JSON or YAML)** explicitly exposes
**Preview OpenAPI** and uses the same parser. Review the operation list and notes,
then select individual operations or use **Select all** and **Select none**.
**Import selected operations** adds the selection to Collections under the API
title, grouped by each operation's first tag. Operations without a tag appear
under **Other**. Request names use the operation summary, then `operationId`,
then the method and path as fallbacks.

Changing the document, input format, or server override invalidates the preview
and clears its selection. Preview again after those changes. Imported requests
are independent definitions: another import adds a new collection with fresh
identities rather than updating the earlier import.

Generated requests use **Literal text** input mode. For example, a source example
containing `{{token}}` stays literal even when the selected environment defines
`token`. After import, choose **Advanced → Input values → Environment template**
to opt into variable expansion. Review the generated URL, parameter values, body,
and credentials before sending; generated examples are starter inputs and are
not guaranteed to satisfy the API's schema.

## Servers and generated inputs

For each operation, the importer uses the first server at the most specific
available level: operation, path item, then document. Server variables use their
declared defaults. An absolute HTTP(S) **server override** replaces the selected
server for every operation. Missing servers and relative server URLs require an
override. A readable error asks for one; the importer never assumes a local server.

Path parameters are replaced with encoded sample values in the editable URL.
If substituted samples would form a `.` or `..` URL segment, the importer uses
the editable `value` placeholder and adds a preview note so URL normalization
cannot silently select another endpoint.
Header and query parameters become editable rows; optional rows start disabled
so they do not silently alter the request. Operation parameters override inherited
path parameters with the same name and location. The preview reports parameter
representations that cannot be preserved. Request bodies use examples, defaults,
or schema-derived starter values for supported JSON, text, and URL-encoded form
media types. Generated schema samples omit read-only fields and bound recursive
expansion; notes identify truncated or approximated values.

Object-valued form fields default to JSON under their original field name. An
explicit `style`, `explode`, or `allowReserved` setting selects parameter-style
serialization for that field. OpenAPI 3.1 local references to boolean schemas
behave like inline schemas: `true` generates an empty object, while `false`
has no generated sample; an omitted request body is reported in the preview.

Supported authentication hints are HTTP Basic, HTTP Bearer, and API keys in a
header or query parameter. Credentials start empty, and notes explain what must
be filled in. Unsupported security combinations and serialization features are
reported rather than treated as complete request support.

The [OpenAPI 3.1.1 specification](https://spec.openapis.org/oas/v3.1.1.html)
defines the document objects and mapping semantics; the limits below describe
the subset this importer can express as editable HTTP requests.

## Interfaces and ownership

[`openapi.ts`](../src/openapi.ts) owns the pure parsing and conversion boundary.
`parseOpenApi(text, { baseUrl? })` parses JSON or YAML, resolves supported local
references, and returns an `OpenApiPreview` with a title, operations, and warnings.
Each operation exposes its preview identity, method, source path, name, tag, and
generated `RequestData`. Selection identities combine the uppercase method and
original templated path; they do not depend on `operationId`. Parsing does not
modify the workspace.
[`openapiValues.ts`](../src/openapiValues.ts) builds bounded samples and shares
reference resolution and diagnostics through `OpenApiValueContext`. Its
`resolve` operation accepts only object references; `resolveSchema` also retains
boolean schema targets, so schema support does not weaken other reference checks.

`createOpenApiCollection(preview, selectedOperationIds?)` converts all operations,
or an explicit selection of their identities, into the existing
[`CollectionImport`](../src/interchange.ts) contract. An omitted selection includes
all operations. Call `remapCollection` before merging to reserve fresh identities
against current request and folder identities. An empty selection returns an
empty collection; the panel disables importing it. Identities that are no longer
in the preview produce an error.

```ts
import { createOpenApiCollection, parseOpenApi } from "./openapi";
import { remapCollection } from "./interchange";

const preview = parseOpenApi(documentText, {
  baseUrl: "https://api.example.com/v1",
});
const selectedIds = preview.operations
  .filter(operation => operation.method === "GET")
  .map(operation => operation.id);
const collection = createOpenApiCollection(preview, selectedIds);

// Include both request and folder identities already present in the workspace.
const imported = remapCollection(collection, occupiedIds);
const nextRequests = { ...existingRequests, ...imported.requests };
const nextCollection = [...existingNodes, ...imported.collection];
```

[`ImportExport.vue`](../src/components/ImportExport.vue) owns only the import
editor, preview, selection, and feedback. It discards a preview when its source
inputs change and emits the fully prepared collection on explicit import.
[`App.vue`](../src/App.vue) owns the workspace merge, using the same event as cURL
and portable collection imports. The importer does not change HTTP execution,
environment resolution, history, or schema bindings.

## Limits

Supported documents are OpenAPI 3.0 and 3.1. Swagger/OpenAPI 2 and OpenAPI 3.2 are
not supported. References must be local to the supplied document; remote fetching
and external reference files are unsupported. Malformed input produces a readable
error. Unsupported references and request features produce an error or a preview
note, depending on whether a usable operation can still be generated.

Multipart and binary bodies, complex authentication, and parameter encodings that
the current HTTP request model cannot represent are unsupported. Import does not
create OAuth flows, response validation, a schema synchronization relationship,
or a complete OpenAPI validator. Review notes and fill in missing values in the
ordinary request editor before sending.

Input complexity and generated example size are bounded. Recursive YAML aliases
are rejected; recursive local schema references generate bounded samples with
notes. Webhooks and callbacks are not imported as callable requests.

[`openapi.test.ts`](../tests/openapi.test.ts) verifies parser, generated-input,
selection, and collection contracts. [`openapi.edge-cases.test.ts`](../tests/openapi.edge-cases.test.ts)
guards the form field, boolean schema reference, and dot-segment fixes; the
dedicated form body, schema reference, and path sample suites cover related cases.
[`ImportExport.test.ts`](../tests/ImportExport.test.ts)
exercises preview review, invalidation, file loading, selection, and merge intents;
[`App.storage.test.ts`](../tests/App.storage.test.ts) covers imported definitions
through the application and workspace reload.
