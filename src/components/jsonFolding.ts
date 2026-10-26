// Derives foldable JSON values from CodeMirror's tree and keeps collapse state in its fold field.
import { StateField, EditorState, type Extension, type StateEffect, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, keymap, type Command } from "@codemirror/view";
import {
  codeFolding, forceParsing, foldedRanges, foldEffect, syntaxTree, syntaxTreeAvailable, unfoldAll, unfoldEffect,
} from "@codemirror/language";
import type { Tree } from "@lezer/common";

/** One value's nonempty interior, excluding the source delimiters. */
export interface JsonFoldRange {
  /** Value description used by accessible controls; property names are excluded. */
  readonly kind: "object" | "array" | "string";
  /** Inclusive UTF-16 position after the opening bracket or quote. */
  readonly from: number;
  /** Exclusive UTF-16 position before the closing bracket or quote. */
  readonly to: number;
}

/** Reads a matching source/tree snapshot; editor Text avoids flattening the complete document. */
export function collectJsonFolds(text: string | Text, tree: Tree): readonly JsonFoldRange[] {
  const characterAt = sourceCharacters(text);
  // A monotonic error count lets a value detect invalid descendants while a later
  // sibling starts from the updated count and remains independently foldable.
  let errors = 0;
  const stack: FoldCandidate[] = [];
  // Parser entry order already matches source order, with a container before its children.
  const values: (JsonFoldRange | null)[] = [];
  tree.iterate({
    enter(node) {
      if (node.type.isError) errors++;
      const kind = node.name === "Object" ? "object" : node.name === "Array" ? "array"
        : node.name === "String" ? "string" : null;
      if (!kind) return;

      const range: JsonFoldRange = { kind, from: node.from + 1, to: node.to - 1 };
      const close = kind === "object" ? "}" : kind === "array" ? "]" : '"';
      const errorsBefore = errors;
      if (characterAt(node.from) !== (kind === "object" ? "{" : kind === "array" ? "[" : '"')
        || characterAt(node.to - 1) !== close) errors++;
      stack.push({ range, index: values.push(range) - 1, errorsBefore });
    },
    leave(node) {
      if (node.name !== "Object" && node.name !== "Array" && node.name !== "String") return;

      const frame = stack.pop()!;
      const range = frame.range;
      // The child after the opener is either a closer or parsed content. Whitespace
      // creates no node; comments and nested empty containers still count as content.
      const interior = node.node.firstChild?.nextSibling;
      const hasContent = range.kind === "string" || interior && interior.from < range.to;
      if (frame.errorsBefore !== errors || range.from >= range.to || !hasContent) values[frame.index] = null;
    },
  });
  return values.filter(range => range !== null);
}

/** Collapses the innermost expanded value containing the primary caret, including inline values. */
export const collapseJsonValue: Command = view => {
  if (!view.state.field(candidates, false)) return false;

  forceParsing(view, Math.min(view.state.doc.length, view.state.selection.main.head + 1), 30);
  const position = view.state.selection.main.head;
  const ranges = view.state.field(candidates).ranges;
  const range = [...ranges].reverse().find(range =>
    range.from - 1 <= position && range.to + 1 >= position && !isFolded(view.state, range));
  return range ? collapseRange(view, range) : false;
};

/** Expands the closest collapsed value at the caret without expanding its nested children. */
export const expandJsonValue: Command = view => {
  const position = view.state.selection.main.head;
  let found: { from: number; to: number } | undefined;
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    if (from - 1 <= position && to + 1 >= position && (!found || to - from < found.to - found.from)) {
      found = { from, to };
    }
  });
  if (!found) return false;

  view.dispatch({ effects: [unfoldEffect.of(found), EditorView.announce.of("Expanded JSON value")] });
  return true;
};

/** First expands a folded neighbor; an explicit selection continues through ordinary deletion. */
export function revealFoldBeforeDelete(direction: -1 | 1): Command {
  return view => {
    const selection = view.state.selection.main;
    if (view.state.readOnly || !selection.empty) return false;

    let found: { from: number; to: number } | undefined;
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      if ((direction === -1 ? to : from) === selection.head) found = { from, to };
    });
    if (!found) return false;

    view.dispatch({ effects: unfoldEffect.of(found) });
    return true;
  };
}

/** JSON-only extensions; CodeMirror owns nested folds and maps their offsets through edits. */
export function jsonFolding(): Extension {
  return [
    candidates,
    codeFolding({
      preparePlaceholder(state, range) {
        return state.field(candidates).ranges.find(candidate => candidate.from === range.from)?.kind ?? "JSON";
      },
      placeholderDOM(view, _onclick, kind: string) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cm-foldPlaceholder";
        button.textContent = "…";
        button.setAttribute("aria-label", `Expand ${kind} value`);
        button.onclick = event => {
          event.preventDefault();
          // Widgets move through edits. Resolve the current DOM position instead of retaining
          // the offsets that were used when this placeholder was first constructed.
          const position = view.posAtDOM(button);
          foldedRanges(view.state).between(position, position, (from, to) => {
            if (from === position) view.dispatch({ effects: unfoldEffect.of({ from, to }) });
          });
          view.focus();
        };
        return button;
      },
    }),
    gutter({
      class: "cm-json-fold-gutter",
      lineMarker(view, line) {
        const end = view.state.doc.lineAt(line.from).to;
        const range = rangeOnLine(view.state.field(candidates).ranges, line.from, end);
        return range ? new ValueFoldMarker(range, isFolded(view.state, range)) : null;
      },
      lineMarkerChange: update => update.docChanged || syntaxTree(update.startState) !== syntaxTree(update.state)
        || foldedRanges(update.startState) !== foldedRanges(update.state),
    }),
    EditorState.transactionExtender.of(transaction => {
      const before = transaction.startState;
      const after = transaction.state;
      if (!transaction.docChanged && syntaxTree(before) === syntaxTree(after)) return null;

      const effects: StateEffect<unknown>[] = [];
      const available = after.field(candidates, false)?.ranges;
      if (!available) return null;
      foldedRanges(before).between(0, before.doc.length, (from, to) => {
        let touched = false;
        transaction.changes.iterChangedRanges((start, end) => {
          if (start <= to && end >= from - 1) touched = true;
        });
        const mapped = { from: transaction.changes.mapPos(from, 1), to: transaction.changes.mapPos(to, -1) };
        const parsed = syntaxTreeAvailable(after, mapped.to + 1);
        if (touched || parsed && !available.some(range => range.from === mapped.from && range.to === mapped.to)) {
          effects.push(unfoldEffect.of(mapped));
        }
      });
      return { effects };
    }),
    keymap.of([
      { key: "Ctrl-Shift-[", mac: "Cmd-Alt-[", run: collapseJsonValue },
      { key: "Ctrl-Shift-]", mac: "Cmd-Alt-]", run: expandJsonValue },
      { key: "Ctrl-Alt-]", run: unfoldAll },
      { key: "Backspace", run: revealFoldBeforeDelete(-1) },
      { key: "Delete", run: revealFoldBeforeDelete(1) },
    ]),
  ];
}

// Retains derived ranges only for the current parser snapshot, never a second collapsed-ID set.
const candidates = StateField.define<{ tree: Tree; ranges: readonly JsonFoldRange[] }>({
  create(state) {
    const tree = syntaxTree(state);
    return { tree, ranges: collectJsonFolds(state.doc, tree) };
  },
  update(value, transaction) {
    const tree = syntaxTree(transaction.state);
    return !transaction.docChanged && tree === value.tree ? value
      : { tree, ranges: collectJsonFolds(transaction.newDoc, tree) };
  },
});

// Only foldable values need traversal frames. Source-order slots survive leaving
// nested values, while the shared error count detects invalid descendants.
interface FoldCandidate {
  range: JsonFoldRange;
  // A candidate reserves its source-order slot on entry and clears it if leaving
  // reveals invalid/empty content.
  index: number;
  // Capture before validating this value's delimiters; a changed count on exit
  // means either these delimiters or some descendant could not be trusted.
  errorsBefore: number;
}

// Most neighboring values share a logical line. Reuse that immutable line's
// text instead of descending CodeMirror's document tree for every delimiter.
// The cache belongs to this source snapshot and is discarded after collection.
function sourceCharacters(source: string | Text): (offset: number) => string | undefined {
  if (typeof source === "string") return offset => source[offset];

  let line = source.line(1);
  return offset => {
    if (offset < 0 || offset >= source.length) return undefined;
    if (offset < line.from || offset > line.to) line = source.lineAt(offset);
    return line.text[offset - line.from];
  };
}

class ValueFoldMarker extends GutterMarker {
  constructor(readonly valueRange: JsonFoldRange, readonly collapsed: boolean) { super(); }

  eq(other: GutterMarker) {
    return other instanceof ValueFoldMarker && this.valueRange.from === other.valueRange.from
      && this.valueRange.to === other.valueRange.to
      && this.valueRange.kind === other.valueRange.kind && this.collapsed === other.collapsed;
  }

  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    // CodeMirror hides gutters from accessibility. Toolbar commands and editor shortcuts
    // provide the keyboard/screen-reader path without a tab stop inside an aria-hidden tree.
    button.tabIndex = -1;
    button.textContent = this.collapsed ? "›" : "⌄";
    const line = view.state.doc.lineAt(this.valueRange.from).number;
    button.setAttribute("aria-label", `${this.collapsed ? "Expand" : "Collapse"} ${this.valueRange.kind} on line ${line}`);
    button.setAttribute("aria-expanded", String(!this.collapsed));
    button.onclick = () => {
      if (this.collapsed) view.dispatch({ effects: unfoldEffect.of(this.valueRange) });
      else collapseRange(view, this.valueRange);
      view.focus();
    };
    return button;
  }
}

function isFolded(state: EditorState, range: { from: number; to: number }): boolean {
  let found = false;
  foldedRanges(state).between(range.from, range.from, (from, to) => {
    if (from === range.from && to === range.to) found = true;
  });
  return found;
}

// Gutter rendering asks once per visible line. Search the ordered candidates rather
// than scanning the entire document again for each line or horizontal scroll update.
function rangeOnLine(ranges: readonly JsonFoldRange[], start: number, end: number): JsonFoldRange | undefined {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle]!.from - 1 < start) low = middle + 1;
    else high = middle;
  }
  const range = ranges[low];
  return range && range.from - 1 <= end ? range : undefined;
}

function collapseRange(view: EditorView, range: JsonFoldRange): boolean {
  const selection = view.state.selection.main;
  const hidesSelection = selection.from < range.to && selection.to > range.from;
  view.dispatch({
    effects: [foldEffect.of(range), EditorView.announce.of(`Collapsed ${range.kind} value`)],
    selection: hidesSelection ? { anchor: range.from } : undefined,
  });
  return true;
}
