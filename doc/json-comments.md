# JSON comments and trailing commas

JSON body tools accept `//` line comments, `/* ... */` block comments, and one
trailing comma after the final property or array element. Comments can appear
between JSON tokens, including between a property name, colon, and value.

```jsonc
{
  // Keep this identifier exact.
  "id": 9007199254740993,
  "items": ["first", "second",],
  /* Optional settings can stay documented beside the payload. */
}
```

Other JSON5 extensions are unsupported. Property names and strings still require
double quotes. Leading or repeated commas, unquoted names, single-quoted strings,
and non-JSON values remain invalid. Text resembling a comment inside a string stays
part of that string.
Empty, whitespace-only, and comment-only documents do not contain a JSON value.

## Editing, formatting, and copying

[BodyText.vue](../src/components/BodyText.vue) enables JSON tools for
`application/json` and MIME types ending in `+json`, ignoring case and parameters.
Comments receive their own syntax color. Folding and indentation use the same
syntax tree, so brackets and property-like text inside comments do not become
JSON structure. Protobuf completion ignores commented properties and offers no
suggestions inside comments. Enter inside a comment continues the current line's
indentation without adding comment delimiters.

**Format JSON** and read-only **Pretty** retain comments, trailing commas,
duplicate keys, numeric spelling, and string escapes. Formatting changes spacing
between tokens and uses two-space indentation; it preserves comment contents,
including their internal line breaks and trailing spaces. A comma following a
line comment stays on a later line so the comment cannot consume it. Formatting
is idempotent and an editable format is one undoable body replacement.

**Copy body** retains the original parent-owned source, including comments,
trailing commas, and original line endings, even while a Pretty preview is shown.
Editing normalizes the editor document to LF, as described in
[the editor architecture](json-highlighting.md).

An unfinished block comment remains one comment token while typing. Its braces
and quotes stay opaque to highlighting, indentation, and completion. Complete-body
validation still requires `*/`: linting reports an error, formatting refuses the
source, and strict projection does not discard an unfinished comment.

## Shared source interfaces

[json.ts](../src/json.ts) exposes three pure operations:

```ts
import { parseJsonSource, stripJsonComments, toStrictJson } from "../src/json";

const source = '{\n  // An exact identifier.\n  "id": 9007199254740993,\n}';
const tree = parseJsonSource(source); // Validates complete JSONC; retains source ranges.
const strict = toStrictJson(source);  // Replaces the comment and final comma with spaces.

console.assert(tree.length === source.length);
console.assert(strict.length === source.length);
console.assert(strict.includes("9007199254740993"));

const template = '{"count":{{count}}, /* {{unused}} */}';
const active = stripJsonComments(template); // Masks comments before template resolution.
const resolved = active.replace("{{count}}", "2");
toStrictJson(resolved); // Validates the resolved value and masks the trailing comma.
```

The example assumes a module next to this document. `parseJsonSource(text)`
returns a Lezer tree for the original source and throws `SyntaxError` at an
invalid source position. It rejects recovered syntax and unfinished block
comments. It does not decode values into JavaScript objects.

`toStrictJson(text)` validates the same syntax, then replaces comments and
trailing commas with whitespace. It preserves UTF-16 length, CR/LF positions,
ordinary whitespace, strings, number notation, property order, and duplicate
keys. Strict JSON is returned unchanged. Neither operation serializes parsed
values, so large integer tokens remain exact. Use this operation when a consumer
requires strict JSON; use [formatJson](../src/components/formatJson.ts) when the
displayed source should retain its comments.

`stripJsonComments(text)` masks complete comments without requiring valid JSON.
It uses the tolerant parser so callers can resolve bare template values before
validation. It preserves offsets and line endings, leaves trailing commas and
unfinished block comments unchanged, and does not establish that the result is
valid JSON. Validate resolved source with `toStrictJson` when preparing a body.

## Parser and editor integration

[grammar.grammar](../src/json/grammar.grammar) defines the shared syntax and
preserves the existing `Object`, `Array`, `Property`, `PropertyName`, and value
node names. `LineComment` and `BlockComment` are named skipped tokens. The
generated [parser.ts](../src/json/parser.ts) is checked in; after changing the
grammar, run:

```sh
pnpm generate:json
```

[jsonLanguage.ts](../src/components/jsonLanguage.ts) exports `jsonLanguage` and
`json()` for CodeMirror, adding syntax tags, bracket metadata, and language
configuration to that parser. Runtime folding and completion read the editor's
incremental tree; indentation reparses retained selections with this same
language. The editor accepts incomplete syntax for continued typing.

[jsonLint.ts](../src/components/jsonLint.ts) supplies `jsonParseLinter()` to
CodeMirror's standard lint UI. It validates the complete source through
`parseJsonSource` and reports one error using original document offsets. Linting,
formatting, and request projection therefore share complete-source validation,
while editor parsing remains tolerant. No additional Vue document or parsed-value
store is introduced.

## Request preparation

For **Template** input mode, [prepareRequest](../src/prepareRequest.ts) projects
valid JSONC to strict JSON before sending a JSON body. The MIME decision uses
the effective resolved Content-Type, including explicit headers and
authentication-provided headers, with the configured body content type as the
fallback. A non-JSON body keeps its normal text behavior.

Preparation masks complete comments before environment resolution, then validates
the resolved source and masks trailing commas. Bare template values such as
`"count": {{count}}` can resolve to JSON values, while variables inside complete
comments remain inactive for the resulting valid JSON body. The saved source
stays unchanged.

Invalid JSON remains sendable for API validation testing. If the resolved result
is malformed, preparation falls back to normal environment resolution of the
original source, retaining its comments and commas. Normal variable-resolution
errors still apply to that fallback.

**Literal** input mode preserves the body source exactly, including comments and
trailing commas. Choose Template mode when JSONC should be normalized for sending.
Captured history requests and unedited history drafts replay their captured
body directly. Send, destination preview, and active cURL export share the same
preparation path; the low-level transports receive its final body text.

## Verification

[Source-operation tests](../tests/json.test.ts) cover validation, tolerant comment
masking, and strict projection. [Parser tests](../tests/jsonLanguage.test.ts) cover
JSONC syntax, semantic nodes, comment boundaries, malformed input, and UTF-16
ranges. [Formatter tests](../tests/formatJson.test.mjs)
cover exact tokens, comments around separators, trailing commas, and idempotency.
[BodyText tests](../tests/BodyText.test.ts) exercise highlighting, linting,
formatting, and model synchronization through the real editor. Folding,
indentation, completion, and preparation have their own public-contract tests.
Run `pnpm test` and `pnpm build`; regenerate the parser only when its grammar
changes.
