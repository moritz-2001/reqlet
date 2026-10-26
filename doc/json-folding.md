# JSON folding

Status: implemented for editable requests and read-only responses.

Objects, arrays, and string values can collapse without changing their source.
All values start expanded. Delimiters stay visible: `{…}`, `[…]`, and `"…"`.
Property names remain visible. Empty strings and containers with no content
have no fold control. Single-line/minified JSON, comments, and trailing commas
are supported. Brackets and quotes inside comments do not create foldable JSON
values; comment text remains part of its enclosing container's source.

## Controls

- The gutter arrow toggles the outermost eligible value opening on that logical
  line. It is a pointer shortcut; keyboard and screen-reader users have the
  toolbar and editor commands below.
- **Collapse value** targets the innermost expanded value containing the primary
  caret. Place the caret inside a particular string or nested value to target it
  on a minified line. The toolbar retains that target while it takes focus.
- **Expand value** opens the nearest folded value at the primary caret.
- **Expand all** opens every range, including hidden nested folds.
- A collapsed `…` is a button whose accessible name describes its value kind.
  Clicking or keyboard-activating it expands that exact range, even when several
  strings are collapsed on the same line.

| Command | macOS | Windows/Linux |
| --- | --- | --- |
| Collapse value | Cmd+Alt+[ | Ctrl+Shift+[ |
| Expand value | Cmd+Alt+] | Ctrl+Shift+] |
| Expand all | Ctrl+Alt+] | Ctrl+Alt+] |

Commands return focus to the editor. Folding announces the action through
CodeMirror's live region. Wrap keeps fold controls and hides line numbers.
Unwrapped line numbers retain logical source numbering across collapsed lines.

## Source and editing semantics

Folding never emits `update:modelValue`, changes character counts, or enters
undo history. Copy body always copies the original parent body. Selecting across
folded content and copying includes its complete source, never the ellipsis.

If collapsing would hide a selection, the caret moves to the opening interior
boundary. Moving the caret into hidden content reveals that fold. Backspace or
Delete beside a placeholder first expands it without removing content; an
explicit selection spanning a fold can delete or replace all selected source.
Undo restores that source. Read-only views allow selection, copy, and folding,
but reject editing and document-changing commands.

Child folds survive closing and reopening an ancestor. Ordinary edits elsewhere
map folded positions through the change. Edits touching a value's delimiters or
interior unfold it, and invalidated ranges are removed when syntax becomes
available. A malformed sibling does not prevent valid values from folding.
Incomplete/error-containing values receive no new fold control. Untouched folds
remain while background parsing has not yet reached them.

Wrap, focus changes, and request-tab switches preserve folds. Changing JSON mode
or read-only mode clears them. External body replacements, Format JSON, and
Pretty / Raw presentation changes also clear them. Undoing a format restores source without
restoring old folds. App caches editors by request ID in KeepAlive, including
across closing and reopening; folds follow that existing cache lifetime and reset
when the editor is actually destroyed or the application reloads.

## Implementation boundary

[BodyText.vue](../src/components/BodyText.vue) retains its public props/events and
owns actions and response previews. [TextEditor.vue](../src/components/TextEditor.vue)
adapts them to CodeMirror. [jsonFolding.ts](../src/components/jsonFolding.ts)
contains the pure `collectJsonFolds(text, tree)` policy, derived candidate field,
gutter, exact-range placeholder buttons, caret commands, and edit cleanup.
CodeMirror's fold field is the only store of collapsed ranges; there are no
stable JSON paths, decoded-value trees, or parallel Vue fold IDs.

The source can be a string or CodeMirror's immutable `Text`; the candidate field
passes `state.doc` directly and reads only the opening and closing characters of
possible values. It does not flatten the document or slice every container's
interior. A collection-local cache reuses the current immutable logical line,
avoiding repeated document-tree lookups for neighboring delimiters. Parser
children establish whether a container contains content,
including comments and nested empty values. Whitespace alone creates no child.
Candidates retain parser entry order, so source ordering needs no separate sort.
Candidate discovery still traverses the available syntax tree when the source or
tree changes; this is not an incremental fold index.

The tree must describe the same LF-normalized source. `JsonFoldRange` holds a
value kind and half-open UTF-16 interior offsets, excluding source delimiters.
For example, with a tree from CodeMirror's JSON language:

```ts
import { jsonLanguage } from "../src/components/jsonLanguage";
import { collectJsonFolds } from "../src/components/jsonFolding";

const source = '{"items":["hello"]}';
const folds = collectJsonFolds(source, jsonLanguage.parser.parse(source));
// Object interior, array interior, then the string's "hello" interior.
const hiddenSource = folds.map(range => source.slice(range.from, range.to));
```

The example's import assumes a module next to this document. Runtime editor
queries reuse `syntaxTree(state)` and bounded parsing instead of reparsing per
fold. Diagnostics validate complete JSONC source through
[jsonLint.ts](../src/components/jsonLint.ts) and the shared [json.ts](../src/json.ts)
operations. Folding and local indentation use the same generated grammar;
formatting retains comments and trailing commas. See
[JSON comments](json-comments.md) for parser and validation interfaces, and
[JSON editor architecture](json-highlighting.md) for ownership and synchronization.

## Verification

[Fold tests](../tests/jsonFolding.test.ts) cover exact ranges, property-name
exclusion, empty values, escaped delimiters, duplicate keys, UTF-16 positions,
malformed siblings, comments, trailing commas, partial trees, and deep input.
[BodyText tests](../tests/BodyText.test.ts)
cover independent strings, exact widgets, nested fold lifetime, mapped and touched
ranges, deletion/copy, mode switches, source-preserving previews, undo/redo, and
parent updates. [App tests](../tests/App.test.ts) cover cache lifetime.

Run `pnpm test` and `pnpm build`. Check real browser/Tauri input, keyboard
shortcuts, IME, both scroll axes, Wrap, split resizing, cached panels, read-only
selection, and forced colors. CodeMirror virtualizes visible content and parses
incrementally, while the JSONC linter and public model still process complete
source strings. Profile those boundaries separately for large-body performance.
