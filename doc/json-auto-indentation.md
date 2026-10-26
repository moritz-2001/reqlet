# JSON automatic indentation

Status: implemented in [jsonIndentation.ts](../src/components/jsonIndentation.ts)
and the Enter command in [textEditor.ts](../src/components/textEditor.ts).

Enter in an editable JSON body should preserve the indentation already used in
that part of the document, including tabs and arbitrary space widths. Use two
spaces only when no existing indentation unit can be inferred.

## Interface and ownership

[BodyText.vue](../src/components/BodyText.vue) keeps its props and
`update:modelValue` event. The parent owns body content. TextEditor applies the
pure edit and caret through CodeMirror transactions. There is no extra Vue body
draft or persistent indentation preference.

`src/components/jsonIndentation.ts` exposes this pure operation:

```ts
import type { Tree } from "@lezer/common";

/** One source edit produced by inserting a JSON line break. */
export interface JsonNewlineEdit {
  /** Inclusive UTF-16 offset of the replacement in the original body. */
  readonly from: number;
  /** Exclusive UTF-16 offset; equal to from for a simple insertion. */
  readonly to: number;
  /** Replacement text, including newlines and inferred indentation. */
  readonly insert: string;
  /** Collapsed UTF-16 selection position in the resulting body. */
  readonly caret: number;
}

export function jsonNewlineEdit(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  tree: Tree,
): JsonNewlineEdit;
```

The tree comes from the shared [JSON language](../src/components/jsonLanguage.ts)
for the exact LF-normalized source. The editor requests available syntax within
a bounded parse budget; when structure is unavailable it continues the current
line's whitespace prefix.
The pure helper uses parser nodes and leaf ranges, not an application tokenizer
or bracket-recovery parser. Selected text is removed from evidence; a temporary
retained-source parse uses the same `jsonLanguage.parser`. The helper returns an
edit descriptor without retaining mutable body state.

Each invocation indexes logical line starts and their whitespace prefixes once.
Parser-node lookups use that index instead of repeatedly scanning backwards for
newlines. This keeps long minified lines from making indentation quadratic while
preserving the same document-wide ranking of local and following style evidence.
The index belongs only to the retained source for this edit; it is never cached
across source replacements or selection removal.

```ts
import { jsonLanguage } from "../src/components/jsonLanguage";
import { jsonNewlineEdit } from "../src/components/jsonIndentation";

const source = '{\n    "items": []\n}';
const position = source.indexOf("[") + 1;
const edit = jsonNewlineEdit(source, position, position, jsonLanguage.parser.parse(source));
const replacement = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
// replacement: '{\n    "items": [\n        \n    ]\n}'
// Dispatch the replacement and edit.caret as one undoable editor operation.
```

## Indentation policy

1. For an ordinary continuation, preserve the current logical line's exact
   leading whitespace. After a comma, continue at the same level. Soft wrapping
   does not create logical lines.
2. Infer a unit from parent/child relationships: a child on a later line must
   extend its parent's whitespace prefix. The added suffix is one unit. Do not
   assume that a deeply indented line's entire prefix represents one level.
3. Prefer evidence inside the active container, then its nearest enclosing
   containers, then the closest usable example elsewhere. Within each scope,
   rank by source distance from the caret and prefer preceding evidence on a
   tie. Local style wins in mixed documents. Ignore blank, closing-only, and
   comment-only lines as indentation evidence.
4. Without a usable parent/child example, use a nearby content line at known
   depth only if repeating one exact whitespace unit explains its indentation.
   Otherwise use two spaces. Never convert existing tabs or spaces.
5. After an opener, add one inferred unit to the container's base prefix. For
   inline nested containers, account for the newly entered levels rather than
   the opener's character column. Prefer established child indentation when
   available. After a completed container, continue at its outer indentation.
6. Before a matching closer, indent the new closing line to the container's
   established base prefix. Between an empty pair, insert two newlines with the
   caret on the indented inner line. Apply this also to pairs containing only
   horizontal whitespace, replacing that gap to avoid trailing spaces.
7. Before a closer in a non-empty container, insert just the closing line. When
   splitting leading whitespace, consume the remaining indentation on that line
   instead of duplicating it. Never consume unrelated content or later lines.

For selections, derive context from the retained prefix and suffix, excluding
selected text. Selected braces must not influence nesting or style inference.
Replace the selection and only adjacent horizontal whitespace required above.
Preserve all other source characters, including numeric tokens and string escapes.

Malformed and incomplete JSON remains editable. Use the nearest consistent
container context; fall back to the current line's prefix when brackets conflict.
Inside a string, insert a newline with the current prefix without applying
bracket or empty-pair rules. This does not repair invalid string input. Apply the
same prefix continuation inside line/block comments, including unfinished block
comments, without adding comment delimiters. Comment contents supply no bracket
structure or indentation-style evidence. Trailing commas use ordinary container
context. See [JSON comments](json-comments.md) for complete-source validation.

Examples (`|` is the caret):

- Four-space document: `    "items": [|` continues with eight spaces.
- Tab-indented document: a property with one tab continues inside its new array
  with two tabs.
- `        "a": 1,|` retains eight spaces on the next line.
- An otherwise empty `{|}` uses two spaces on its new inner line.
- Brackets in `"text": "[{}]"` supply no structural indentation evidence.

## Editor integration

[insertJsonNewline](../src/components/textEditor.ts) is the single Enter command
installed in editable JSON mode. It skips composition and read-only mode, reads
selection from the current editor state, and requests its syntax tree with a
30ms budget. It dispatches the source edit, caret, and scroll intent through
CodeMirror history. A selection-only checkpoint is batched into that view update
so redo restores the inner-line caret rather than mapping to the insertion's end.
The parent receives one complete body replacement and one Undo removes the edit.

Equal parent echoes preserve history; a differing parent replacement resets it
and cannot restore a stale caret. Plain text uses CodeMirror's normal keymap.
Competing JSON Enter handlers and reindent-on-input are not enabled, preserving
mixed local styles. Paste, IME, and other native editor input paths stay with
CodeMirror. There is no execCommand, range-replacement fallback, intermediate
input suppression, or redo text heuristic.

## Verification and completion

Pure tests cover tabs; two-, four-, and unusual space widths; mixed local styles;
only deeply indented evidence; blank lines; inline nesting; arrays and objects;
commas; empty and non-empty pairs; whitespace around the caret; closing brackets;
partial and mismatched JSON; escaped quotes and brackets in strings; line/block
comments, unfinished block comments, and trailing commas; multiline
selections removing structural tokens; and UTF-16 offsets after non-BMP characters.
Assert exact edits and caret positions, preserving source outside the edit.
Large minified-prefix regressions also cover inline nesting, following child
evidence, and selection removal without imposing machine-dependent time limits.

Run `pnpm perf:indentation` for a reproducible policy microbenchmark, or pass
fixture sizes in KiB, for example `pnpm perf:indentation 32 128 512`. It measures
the pure edit function with pre-parsed real JSON language trees, two warmups and
seven samples per layout. Parsing, complete-model emission, Vue, and browser
rendering are excluded; use the UI harness for complete interaction latency.

Component tests cover accepted parent updates, differing parent replacements,
repeated Enter, selection replacement, IME exclusion, plain text, JSON MIME
variants, read-only mode, mode switches, one emitted update, final caret position,
and highlight text matching the accepted body. jsdom alone does not establish
real input/IME event ordering or caret visibility.

Manually check single-edit undo/redo, IME, held Enter, long and wrapped lines,
both scroll axes, and typing after indentation in browser and Tauri. Completion
requires preserving existing indentation, editing incomplete JSON, and verified
caret and editor history behavior. Format JSON keeps its current explicit
two-space formatting policy; making that command style-aware is separate work.
