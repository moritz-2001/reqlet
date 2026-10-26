# Editable body documents

[BodyDocument](../src/bodyDocument.ts) is one immutable revision of an editable
request body. `RequestData.body` accepts either a string or a `BodyDocument`.
Imports and restored records start with strings; RequestEditor enables
BodyText's `incremental` mode, so editing publishes documents backed by
CodeMirror's persistent `Text`. Unchanged text nodes are shared between revisions.
No editor view, selection, fold state, or undo history enters the workspace.

The parent accepts each revision immediately. There is no delayed body mirror:
Send, duplication, tab eviction, and persistence always have the current source.
Documents are marked raw so Vue observes revision replacement without traversing
the shared text nodes. Document identity acts as the revision token.

```ts
import { bodyText } from "../src/bodyDocument";

// Length checks and ordinary metadata edits do not flatten the body.
const hasBody = request.body.length > 0;

// A string boundary explicitly captures the current immutable revision.
const capturedSource = bodyText(request.body);
```

`bodyText` materializes and caches the complete source once per revision. It is
used by request preparation, explicit formatting, copying, and changed-record
persistence. Later revisions cannot change a captured string. JSON serialization
also materializes a document through `toJSON()`, retaining existing portable
collection and legacy workspace formats. IndexedDB receives ordinary string
bodies; its structured clone must never receive the document's internal storage.

Standalone BodyText/TextEditor callers retain string updates by default. Opt in
with `incremental` and accept `BodySource` values through `update:modelValue`:

```vue
<BodyText v-model="source" incremental label="Request body" />
```

Here `source` is a `ref<BodySource>`. A differing external source resets the
editor's transient history as before; an equal parent echo preserves selection,
folds, and undo. Creating an editor from a live document shares its text root.
LF normalization happens when a string enters the editor; untouched string
bodies retain their original line endings for copy/export.

This boundary removes whole-body conversion from ordinary model updates.
Complete JSON linting, formatting, indentation, and match counting still have
their own costs; incremental body publication does not make those operations
constant-time. Legacy synchronous localStorage saves also serialize the whole
workspace. Production uses the asynchronous record-based repository.

[Body document tests](../tests/bodyDocument.test.ts) cover large immutable
revisions, parent echoes, undo, editor recreation, Send snapshots, and JSON
interchange. [Application execution tests](../tests/App.execution.test.ts) verify
that Send immediately uses the newest editor revision.
