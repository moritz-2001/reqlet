# JSON editor architecture

[TextEditor.vue](../src/components/TextEditor.vue) is the internal CodeMirror 6
adapter used by [BodyText.vue](../src/components/BodyText.vue) for JSON and plain
text. BodyText keeps its controlled public interface and owns MIME detection,
Wrap, explicit formatting, response previews, original-body copy, and feedback.
The editor owns selection, focus, history, viewport, fold state, and standard
lint UI. Its immutable document root can be shared with the parent workspace
through [BodyDocument](body-document.md), without copying the source or retaining
the editor view. Request metadata stays outside both components.

## Document flow and commands

TextEditor receives displayed source through `modelValue` and emits a complete
`update:modelValue` revision after each user document update. With `incremental`,
that value is an immutable BodyDocument sharing CodeMirror's text root; ordinary
string mode retains the standalone component contract. Equal parent
echoes cause no transaction and preserve selection, folds, and history. A differing
parent replacement creates a fresh editor state without emitting it back; folds
and history reset, and the caret is clamped to the new document. Parent updates
run after the current editor dispatch completes. Callers must accept synchronous
`v-model` updates; this is not a collaborative synchronization protocol.

[TextEditorHandle](../src/components/textEditor.ts) exposes only operations used
by BodyText's toolbar:

```ts
// `editor` is a Vue template ref to TextEditorHandle.
editor.value?.replaceDocument(formatJson(body)); // One undoable explicit format.
editor.value?.collapseValue();                  // Innermost value at the caret.
editor.value?.expandValue();                    // Closest folded value at the caret.
editor.value?.expandAll();                      // Includes hidden nested folds.
```

`replaceDocument` does nothing for equal text or in read-only mode. It isolates
the format transaction in history and clears folds. The fold commands retain the
editor selection while the toolbar has focus, then return focus to the editor.
They emit no body updates. No mutable state or CodeMirror handles cross this
component boundary.

The editor normalizes CRLF and lone CR to LF. All syntax ranges and selections
use UTF-16 positions into that exact document. Copy body continues to use the
parent's original text, including original line endings and raw content while a
pretty response preview is displayed. Both preview transitions reset editor
state. Formatting retains [formatJson.ts](../src/components/formatJson.ts), which
changes whitespace without serializing parsed values or rewriting exact tokens.

## Parsing and presentation

`json()` from [jsonLanguage.ts](../src/components/jsonLanguage.ts) installs the
shared generated JSON parser with line/block comments and trailing commas.
CodeMirror's tolerant incremental syntax tree supplies structural queries,
syntax highlighting, bracket matching, folding, and protobuf completion.
Named comment nodes keep their contents opaque to these structural operations.
An unfinished block comment remains one token while editing; complete-source
validation still rejects it. See [JSON comments](json-comments.md) for the grammar,
regeneration command, validation APIs, and request preparation behavior.

[jsonPresentation and editorTheme](../src/components/textEditor.ts) map syntax
tags to the existing color variables and decorate leading whitespace with
indentation guides. Guides use CodeMirror's visible-range match decorator.
CodeMirror owns content rendering, line numbers, both scroll axes, soft wrapping,
and selection drawing; there is no textarea overlay or scroll synchronization.
Wrap hides line numbers but retains fold controls.

Forced-colors presentation uses system colors. The editor-root media rule lives
in TextEditor.vue because style-mod expands a nested `&` inside `@media` into
the media text, producing invalid CSS. Descendant overrides remain in
`editorTheme`. [Theme tests](../tests/textEditorTheme.test.ts) mount the generated
stylesheet and check for CSS parser errors without suppressing diagnostics.

The view uses compartments to reconfigure wrapping and JSON/read-only behavior.
Wrap preserves history and folds. JSON/read-only changes clear folds. Read-only
mode combines the state-level `readOnly` facet with a non-editable, keyboard
focusable content surface, retaining selection and folding commands. A
ResizeObserver and Vue activation hook request remeasurement after resizing or
restoring a cached panel. Unmount destroys the editor and disconnects the observer.

## Diagnostics

JSON mode installs `linter(jsonParseLinter())`, using the source from
[jsonLint.ts](../src/components/jsonLint.ts) and CodeMirror's standard timing and
presentation. Validation calls `parseJsonSource` from [json.ts](../src/json.ts),
accepting comments and trailing commas while reporting one source-position error
for invalid or incomplete syntax. Empty, whitespace-only, comment-only, and
unterminated-comment documents are invalid. Plain text mode removes lint state.
Keyboard users can open the standard lint panel with Ctrl+Shift+M and move to the
next diagnostic with F8.

The linter validates the full source separately from the editor's incremental
parse, using the same grammar and complete-source checks as formatting and body
projection. Complete source strings are emitted through the public model, and
fold discovery/local indentation inspect syntax and source. Rendering is
virtualized, but not every operation is incremental.

## Folding and indentation

[jsonFolding.ts](../src/components/jsonFolding.ts) derives nonempty, complete,
error-free object, array, and string-value interiors from the language tree.
It excludes property names and uses CodeMirror's fold state/effects as the only
collapsed-range storage. Its derived candidate field refreshes when either the
document or available syntax tree changes. Gutter lookup uses ordered ranges.
A transaction extender unfolds touched or invalidated ranges and maps untouched
ones through edits. A valid sibling remains foldable while another is malformed;
untouched folds persist while background parsing has not reached them.

Tree availability is bounded: caret commands request at most 30ms of additional
parse work. Incomplete or recovered subtrees cannot become new folds. The
iterative source/tree traversal handles deep input without application recursion;
at extreme depth, folding follows the trustworthy subtrees Lezer supplies.
See [JSON folding](json-folding.md) for controls, copying, and fold lifetime.

[jsonIndentation.ts](../src/components/jsonIndentation.ts) retains our pure local
style inference over CodeMirror's syntax tree. [insertJsonNewline](../src/components/textEditor.ts)
applies its edit and caret through editor history, with a selection checkpoint
batched into the same view update so redo restores the inner-line caret. There
is one body emission and one undoable document operation. No native insertText,
range-replacement fallback, intermediate-input guard, or custom redo heuristic
remains. See [automatic indentation](json-auto-indentation.md).

## Verification

[Fold policy tests](../tests/jsonFolding.test.ts) use the real JSON parser and
assert application ranges, malformed-sibling behavior, partial trees, and deep
input. [Indentation tests](../tests/jsonIndentation.test.ts) retain exact local
style and caret contracts. [BodyText tests](../tests/BodyText.test.ts) exercise
real editor transactions, rendered controls, JSONC linting, formatting history,
source copy, nested folds, selection, and model synchronization.
[App tests](../tests/App.test.ts) cover drafts and the request-ID editor cache.
Run `pnpm test` and `pnpm build`. Real browser and Tauri checks establish layout,
native input/IME behavior, focus, scrolling, and platform shortcuts beyond jsdom.
