# Body text component

[BodyText.vue](../src/components/BodyText.vue) edits or displays HTTP body text.
It accepts the same interface for requests and responses. Its parent owns content
and HTTP behavior; the component owns presentation state.

```vue
<script setup lang="ts">
import { ref } from "vue";
import BodyText from "../src/components/BodyText.vue";

const requestBody = ref('{"message":"hello"}');
const responseBody = ref("");
</script>

<template>
  <BodyText
    v-model="requestBody"
    content-type="application/json"
    label="Request body"
  />
  <BodyText
    :model-value="responseBody"
    content-type="application/json"
    label="Response body"
    readonly
  />
</template>
```

The import path above assumes an example component next to this document;
adjust it to the caller's location.

## Contract

| Prop | Meaning |
| --- | --- |
| `modelValue: BodySource` | Parent-owned string or immutable body document. Zero length is an empty body. |
| `incremental?: boolean` | Defaults to false. Publishes immutable document revisions for editable sources instead of complete strings. |
| `label: string` | Visible heading and accessible name of the editor; compact mode preserves it as an accessible label. |
| `contentType?: string` | MIME type enabling JSON actions. Omitted means plain text. |
| `readonly?: boolean` | Defaults to false. Blocks content edits while allowing selection, scrolling, folding, and copying. |
| `compact?: boolean` | Defaults to false. Uses a denser toolbar and hides the visible editor heading when surrounding request/response panes already provide context. |
| `presentation?: "pretty" \| "raw"` | Optional parent-owned read-only JSON view. Omitted means the component starts in Pretty and retains its local choice. |

Typing emits `update:modelValue` with the complete source revision: a string by
default or an immutable `BodyDocument` in incremental mode. RequestEditor opts
in so model updates share text storage rather than flattening every edit. See
[editable body documents](body-document.md) for ownership and snapshot examples.
Invalid and partial
JSON remain editable; content type does not restrict input. The parent must apply
emitted changes, normally through `v-model`. CodeMirror owns its transactional editing document; no extra Vue draft mirrors it.

JSON actions recognize `application/json` and MIME types ending in `+json`,
ignoring case and parameters. JSON tools accept line/block comments and trailing
commas; see [JSON comments](json-comments.md) for syntax and sending behavior.
**Format JSON** explicitly replaces editable text.
Read-only valid JSON up to 512 Ki UTF-16 units defaults to **Pretty**. Sources
above 64 Ki units first display plain original text while
[jsonPreview.worker.ts](../src/components/jsonPreview.worker.ts) formats with
Rust/Wasm outside the UI thread; see [JSON formatting computation](wasm-json-formatting.md).
[jsonPreview.ts](../src/components/jsonPreview.ts) owns each
worker's cancellation and cleanup. Raw preference skips that work, and replacing,
deactivating, or unmounting an inspector cancels unfinished previews. Reactivation
resumes work; a completed preview remains cached for the same source.
If the user starts selecting or searching the original text before formatting
finishes, it stays in place until an explicit Pretty choice, preserving selection.
Formatted previews also have a 512 Ki-unit output budget so deeply nested input
cannot expand into a much larger editor document; the complete original remains
available when the budget is exceeded. Explicit editable Format JSON remains
unbounded. The explicit **Pretty / Raw**
button group exposes its selected state with `aria-pressed`; **Raw** restores the
original view. Choosing either view keeps keyboard focus on its toolbar control,
or on More when selected from that menu. Neither action emits a body edit. Content replacements and MIME
changes clear action feedback while retaining the user's presentation choice.
Invalid JSON falls back to raw text, and choosing Pretty reports an inline message
without changing content. Non-JSON bodies remain literal text without this toggle.

Owners that temporarily unmount the editor can retain the choice with
`v-model:presentation="responsePresentation"`, initialized to `"pretty"`.
`update:presentation` is emitted only after an explicit successful choice.
[ResponseInspector](../src/components/ResponseInspector.vue) owns this value so
a new send, failure, or cancellation does not reset the next response's view.

The optional `toolbar` slot inserts caller-owned controls before the body actions:

```vue
<BodyText v-model="body" label="Request body" :content-type="mime" compact>
  <template #toolbar>
    <label class="ui-visually-hidden" for="body-mime">Content type</label>
    <select id="body-mime" v-model="mime" class="ui-input">
      <option value="application/json">application/json</option>
      <option value="text/plain">text/plain</option>
    </select>
  </template>
</BodyText>
```

The caller retains ownership of these controls, including accessible labels,
stable unique IDs, and updates. BodyText owns their toolbar placement and wrapping.

The toolbar keeps formatting, Find, and Copy body visible in wide panes.
At 560px or narrower, Find and Copy move into **More body actions** (⋯).
At 280px or narrower, formatting or Pretty/Raw also moves into More. These
thresholds use the body container's width, so dragging a divider behaves the
same as narrowing the window. More always remains reachable, and context controls
wrap when necessary. The menu also contains Wrap lines and JSON folding commands.
It opens beside its trigger outside the editor's scroll and clip
boundaries, stays within the viewport, and closes on selection, outside interaction,
Escape, or a viewport change. Arrow keys and Home/End move between its actions;
Escape restores trigger focus, while fold commands return focus to the editor.
Read-only semantics are exposed on the editor rather than a repeated mode label.
There is no permanent footer: action feedback appears only when there is a message,
with a live region retained for assistive technology.

[formatJson](../src/components/formatJson.ts) changes whitespace only, preserving
large numeric IDs, exponent notation, duplicate keys, string escapes, comments,
and trailing commas. Shared [JSONC validation](../src/json.ts) checks complete
source without decoding and serializing values.

Enter in an editable JSON body preserves the current indentation. Opening a
container adds one unit inferred from nearby parent/child lines, preferring the
active container and its ancestors. Tabs, arbitrary space widths, and local
differences are retained; two spaces are the fallback when no style is evident.
Closing brackets align to their container, and Enter between an empty pair
creates an indented inner line with the caret ready to type. Selected text is
replaced normally and excluded from indentation evidence. Brackets in strings
and comments are ignored, and unfinished JSON remains editable. Inside comments,
Enter continues the current prefix without adding comment delimiters.
Composition input, paste, plain-text bodies, and read-only views keep their native
editing behavior.

The newline and indentation form one undoable document operation in CodeMirror,
with one model update and caret restoration on redo. Format JSON is also undoable
and keeps its explicit two-space policy. See
[JSON automatic indentation](json-auto-indentation.md) for the pure edit
interface, inference rules, and verification details.

**Copy body** always copies the original `modelValue`, including when a formatted
response preview is visible. A failed clipboard write reports a manual-copy
fallback. Clipboard availability depends on the browser or desktop webview.

**Find** opens a search panel within the current body. Ctrl+F or Cmd+F while the
body editor has focus opens the same panel without searching another request or
the surrounding application. Queries match literal text without case sensitivity,
so punctuation and backslash sequences are searched as written. Visible matches
are highlighted; feedback reports the match count, selected match, or No matches.
Enter/Shift+Enter in the query field and Next/Previous navigate with wrapping.
Escape or Close find closes the panel and returns focus to the body when needed.
Navigation reveals folds intersecting the match, retaining unrelated folds.

Search works in read-only responses without changing text or emitting model
updates. It searches the displayed raw or pretty document and keeps its query
through preview changes, wrapping, and incoming response replacements. Each
cached editor owns its own query and panel lifetime. [bodySearch.ts](../src/components/bodySearch.ts)
adapts CodeMirror's search state and commands with a compact Find-only panel;
`TextEditorHandle.findText()` opens it without exposing the editor view to callers.
The panel computes the exact count only when its query or document changes and
retains one numeric checkpoint per 128 matches. Selection feedback searches at
most one checkpoint block; ordinary caret movement does not rescan the body.

Larger read-only responses use [bounded raw pages](large-responses.md), avoiding
whole-response formatting, highlighting, folding, and match counting. Find then
searches the entire original response in a retained, cancellable Wasm worker and
selects each result in its page. Worker failure retains the cooperative JavaScript
fallback. See [response search computation](wasm-response-search.md) for session
ownership, Unicode matching, and performance measurements.
Copy and Download retain the complete original text. This mode is
chosen before formatting is evaluated and does not change the parent's saved
Pretty/Raw preference. Returning to a small response restores that preference.

## Presentation and limits

- CodeMirror owns text input, selection, undo history, scrolling, and visible
  content rendering. Wrapping hides line numbers but keeps folding controls.
- Objects, arrays, and string values collapse through gutter arrows, caret-aware
  toolbar actions, keyboard commands, and accessible placeholder buttons. Keys
  remain visible; copying retains complete source. See
  [JSON folding](json-folding.md) for commands, editing semantics, and lifetime.
- Browser editing normalizes line endings to LF; Copy body preserves the parent's
  original text.
- The JSON language extension supplies syntax colors and bracket matching.
  Leading whitespace has guides at two-column intervals. Incomplete JSON remains
  editable; complete error-free sibling values can still fold.
- The JSONC linter uses shared complete-source validation and reports one error
  with original source offsets through CodeMirror's standard timing and UI.
  Empty, whitespace-only, comment-only, and unfinished-comment source is invalid.
- The editor is labeled and keyboard focusable in both modes. Read-only mode
  retains selection and fold commands. Forced colors retain visible editor text.
- For small responses and editable bodies, the language parser is incremental and rendering is virtualized. JSONC
  linting validates the full document. Incremental model events share immutable
  text revisions; standalone string mode still emits complete strings.
  Find counts matches in the complete document and highlights the visible viewport.
  See [editor architecture](json-highlighting.md).

Style overrides are available through `--body-text-color`,
`--body-text-background`, `--body-text-border`, and `--body-text-muted`.
Syntax colors use `--json-key`, `--json-string`, `--json-number`, `--json-boolean`,
`--json-null`, `--json-punctuation`, `--json-comment`, and `--json-invalid`.
Decorations use `--json-guide` and `--json-bracket-background`. Diagnostics use
CodeMirror's standard lint styling.
For a parent that supplies a bounded height, set `--body-editor-min-height: 0px`
and `--body-editor-resize: none` to fill that space with an independently scrolling
editor. The defaults are `320px` and `vertical`, keeping standalone editors
usable without a window layout. [RequestEditor.vue](../src/components/RequestEditor.vue)
uses these overrides to share the available window height between body panes.

## Verification

Run `pnpm test` for formatter, indentation/folding policy, and component contracts, and `pnpm build` for Vue/TypeScript
checking and bundling. Tests import the TypeScript helper directly using Node's
built-in type stripping; use Node 22.18 or newer.

The frontend preview in [App.vue](../src/App.vue) exercises editable requests,
read-only response previews, wrapping, and content-type switching without Tauri
or an HTTP server.
