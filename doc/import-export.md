# Import and export

The header's **Workspace tools → Import / Export** panel accepts pasted cURL,
portable collection JSON, and OpenAPI 3.0/3.1 JSON or YAML. Loading a file fills the
text editor for review. Automatic format detection recognizes these inputs;
**OpenAPI 3.0 / 3.1** can also be selected explicitly.

File loading announces progress and temporarily disables importing. The paste
field remains editable; if its text changes before the read completes, those
edits are kept and the older file result is discarded with a status message.
Choose the file again to explicitly replace the edited text.

cURL and portable collections import through **Import**. OpenAPI first creates an
operation preview; choose the operations and use **Import selected operations** to add their
requests and folders. Changing the source, format, or server override clears the
preview and selection, so imported definitions always match the reviewed inputs.
The OpenAPI parser and YAML support load only when creating the first preview.
The panel announces that load; edits or closing the panel cancel the pending
preview, while cURL and portable collection imports remain immediately available.
See [OpenAPI import](openapi-import.md) for server resolution, examples, supported
parameters, and limitations. Importing never sends requests. Every imported
identity is replaced, including folder identities, so importing the same file
repeatedly cannot overwrite existing data.

Exports require explicitly selecting **Include credentials and request data in
exports**. Collection JSON includes saved credentials, headers, URLs and bodies.
It preserves environment placeholders, but does not include environment definitions,
execution history or layout. Active cURL export resolves the selected environment,
authentication and query parameters exactly as execution does. Exported cURL can
therefore contain resolved secrets. Clipboard failures leave the export text visible
for manual copying. Collection downloads use a browser Blob and need no filesystem
plugin. Collection downloads are named `reqlet-collection.json`; their format
marker remains `api-tool-collection` for compatibility with existing exports.

Every request has an input mode, shown below its name and editable under
**Advanced → Input values**. **Environment template** resolves `{{variables}}`
in URL, headers, query parameters, authentication, body, and the default content
type. Existing requests use this mode when `inputMode` is absent.
**Literal text** sends placeholder-looking text unchanged while retaining HTTP
field validation. All cURL and OpenAPI imports use literal mode, even when a selected
environment happens to contain matching names. Editing or saving the imported
request does not change its mode. Collection JSON and workspace reloads preserve
the mode; choosing Environment template explicitly opts into substitution.

## Portable format and interfaces

[`interchange.ts`](../src/interchange.ts) owns the conversion boundary.
`serializeCollection(requests, nodes)` produces a document with
`kind: "api-tool-collection"`, `version: 1`, `requests`, and `collection`.
`parseCollectionDocument(text)` checks this envelope and validates every request,
folder and reference through [`workspaceValidation.ts`](../src/workspaceValidation.ts).
`importCollection(text, occupiedIds)` additionally allocates new identities.
`remapCollection(imported, occupiedIds, allocateId?)` supports the same safe merge
for other validated sources, including selected OpenAPI operations from
[`openapi.ts`](../src/openapi.ts); an injected allocator enables deterministic tests.
None of these operations changes the source collection.

```ts
const imported = importCollection(fileText, Object.keys(existingRequests));
const nextRequests = { ...existingRequests, ...imported.requests };
const nextCollection = [...existingNodes, ...imported.collection];
```

Pass current folder identities as well as request identities in `occupiedIds` when
merging a complete workspace. The component does this automatically.

## cURL subset

`importCurl(text)` returns one `RequestData`; `exportCurl(httpRequest)` exports an
already prepared snapshot. Supported input options are `-X` / `--request`, `-H` /
`--header`, `-d` / `--data`, `--data-raw`, `--data-binary`, `-u` / `--user`, `--url`,
`--max-time`, `-G` / `--get`, `-I` / `--head`, `-g` / `--globoff`, `-L` / `--location`, and
`--no-location`. Short attached values, long `--option=value`, single
and double quotes, escaped characters, and backslash line continuations work.
Repeated headers retain their order. Repeated data arguments join with `&`.
Data infers POST and `application/x-www-form-urlencoded`; `--get` moves data into
the URL. An explicit method takes precedence. Timeouts use seconds in cURL and
milliseconds in the workspace.

The parser never invokes a shell. It rejects unsupported flags, multiple URLs,
file/stdin bodies, header files, shell operators, substitutions, variable expansion,
URL globbing unless explicitly disabled with `--globoff`, and unclosed quotes with readable errors. Use single quotes around
literal dollar signs or backticks. `--data-raw '@literal'` is supported because it
has no file meaning. Empty headers use cURL's `Name;` form; `Name:` header suppression
is rejected because the workspace cannot represent that behavior. Interactive
password prompting is unsupported, so `--user` requires `username:password`.
Export uses POSIX quoting, including safe embedded apostrophes, and `--data-raw`
so payloads beginning with `@` remain literal.

For example, this body remains `{{token}}` after import, send, and cURL export,
whether or not the active environment defines `token`:

```sh
curl --data-raw '{{token}}' --header 'X-Token: {{token}}' https://example.com
```

Redirects remain disabled unless `--location` opts in. The supported subset also
accepts `--max-redirs 10` and `--proto-redir '=https'`, matching the tool's redirect
limit and HTTPS protection. `--location-trusted` is rejected. Exporting redirects
requires HTTPS and representable GET, HEAD, or POST behavior; same-origin-only
redirects and custom credential headers that must be stripped after an origin
change cannot be faithfully expressed by cURL and produce an explanation.
HEAD export uses `--head` so cURL expects no response body. HEAD requests with
a body, and imported `--head` combined with data or a different explicit method,
are rejected because their behavior cannot be preserved.

The `RequestData.inputMode` contract is optional `"template" | "literal"`.
`prepareRequest(request, environment?)` applies that mode uniformly and returns
the resolved `HttpRequest` consumed by execution and `exportCurl`. An execution
snapshot contains concrete values, so reimporting its cURL output never resolves
its placeholder-looking bytes a second time. Export adds `--globoff` when its
URL contains braces or brackets outside the authority so cURL also preserves
those bytes as literal URL text.
