// Defines BodyText's editor commands and the shared CodeMirror presentation and JSON Enter behavior.
import { EditorSelection, Transaction, type Extension } from "@codemirror/state";
import { Decoration, EditorView, MatchDecorator, ViewPlugin, type Command } from "@codemirror/view";
import { HighlightStyle, ensureSyntaxTree, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { jsonNewlineEdit } from "./jsonIndentation";

/** Operations that preserve editor transaction/history invariants without exposing CodeMirror. */
export interface TextEditorHandle {
  /** Replaces text as one undoable editable operation; equal text and read-only mode are no-ops. */
  replaceDocument(text: string): void;
  /** Collapses the innermost eligible value at the retained primary caret. */
  collapseValue(): void;
  /** Expands the closest collapsed value at the retained primary caret. */
  expandValue(): void;
  /** Expands every collapsed range, including children hidden by an ancestor. */
  expandAll(): void;
  /** Opens this editor's Find panel and focuses its literal search query. */
  findText(): void;
  /** Selects and scrolls a displayed-text range into view without changing text or taking focus. */
  revealRange(from: number, to: number): void;
}

/** Preserves local whitespace policy as one document and selection transaction. */
export const insertJsonNewline: Command = view => {
  if (view.state.readOnly || view.composing) return false;

  const selection = view.state.selection.main;
  const source = view.state.doc.toString();
  const tree = ensureSyntaxTree(view.state, view.state.doc.length, 30);
  const prefix = view.state.doc.lineAt(selection.from).text.match(/^[ \t]*/)![0];
  const edit = tree ? jsonNewlineEdit(source, selection.from, selection.to, tree) : {
    from: selection.from, to: selection.to,
    insert: `\n${prefix}`, caret: selection.from + prefix.length + 1,
  };
  const transaction = view.state.update({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: EditorSelection.cursor(edit.caret),
    annotations: Transaction.userEvent.of("input"),
    scrollIntoView: true,
  });
  // History derives redo selection from the last selection checkpoint. Recording the
  // final caret avoids mapping the pre-edit caret to the end of an empty-pair insertion.
  // Batch the selection-only checkpoint with the edit so the parent receives one update.
  view.dispatch([transaction, transaction.state.update({ selection: transaction.state.selection })]);
  return true;
};

/** JSON syntax colors and visible indentation guides, independent of raw/pretty presentation. */
export function jsonPresentation(): Extension {
  const indentation = new MatchDecorator({
    regexp: /^[ \t]+/gm,
    decoration: Decoration.mark({ class: "json-indent" }),
  });
  return [
    syntaxHighlighting(HighlightStyle.define([
      { tag: tags.propertyName, class: "json-key" },
      { tag: tags.string, class: "json-string" },
      { tag: tags.number, class: "json-number" },
      { tag: tags.bool, class: "json-boolean" },
      { tag: tags.null, class: "json-null" },
      { tag: tags.comment, class: "json-comment" },
      { tag: tags.punctuation, class: "json-punctuation" },
      { tag: tags.invalid, class: "json-invalid" },
    ])),
    ViewPlugin.fromClass(class {
      decorations;
      constructor(view: EditorView) { this.decorations = indentation.createDeco(view); }
      update(update: Parameters<MatchDecorator["updateDeco"]>[0]) {
        this.decorations = indentation.updateDeco(update, this.decorations);
      }
    }, { decorations: plugin => plugin.decorations }),
  ];
}

/** Shares font metrics and theme variables with the surrounding BodyText panel. */
export const editorTheme = EditorView.theme({
  "&": {
    flex: "1", minWidth: "0", minHeight: "0",
    color: "var(--body-text-color, var(--color-text))", backgroundColor: "var(--body-text-background, var(--color-surface))",
  },
  "&.cm-focused": { outline: "none", boxShadow: "inset 0 0 0 2px var(--color-focus)" },
  ".cm-scroller": {
    flex: "1", overflow: "auto", fontSize: "13px", lineHeight: "22px",
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  },
  ".cm-content": {
    padding: "12px 0", fontVariantLigatures: "none", caretColor: "var(--body-text-color, var(--color-text))",
  },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": { backgroundColor: "#00000012", color: "var(--body-text-muted, var(--color-muted))", border: "0" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px" },
  ".cm-json-fold-gutter button": {
    color: "inherit", background: "transparent", border: "0",
    padding: "0 3px", font: "inherit", cursor: "pointer",
  },
  ".cm-foldPlaceholder": {
    color: "var(--body-text-muted, var(--color-muted))", background: "#8baaff18",
    border: "1px solid var(--body-text-border, var(--color-control-border))", borderRadius: "3px",
    padding: "0 4px", font: "inherit", lineHeight: "18px", cursor: "pointer",
  },
  "button:focus-visible": { outline: "2px solid var(--color-focus)", outlineOffset: "1px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { background: "#25466e" },
  ".cm-cursor": { borderLeftColor: "var(--body-text-color, var(--color-text))" },
  ".cm-placeholder": { color: "var(--body-text-muted, var(--color-muted))" },
  ".cm-panels": { color: "inherit", backgroundColor: "var(--body-text-background, var(--color-surface))" },
  ".cm-body-search": { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px", padding: "8px 12px" },
  ".cm-body-search input": {
    flex: "1 1 140px", minWidth: "80px", padding: "5px 7px", color: "inherit", font: "inherit",
    background: "transparent", border: "1px solid var(--body-text-border, var(--color-interactive-border))", borderRadius: "4px",
  },
  ".cm-body-search button": {
    padding: "5px 7px", color: "inherit", font: "inherit", background: "transparent",
    border: "1px solid var(--body-text-border, var(--color-interactive-border))", borderRadius: "4px", cursor: "pointer",
  },
  ".cm-body-search button:disabled": { cursor: "default", opacity: "0.5" },
  ".cm-body-search [role=status]": { fontSize: "12px", color: "var(--body-text-muted, var(--color-muted))" },
  ".cm-searchMatch": { backgroundColor: "#eec78f35", outline: "1px solid #eec78f80" },
  ".cm-searchMatch-selected": { backgroundColor: "#8baaff55", outline: "1px solid var(--color-focus)" },
  ".json-key": { color: "var(--json-key, #9abaff)" },
  ".json-string": { color: "var(--json-string, #9fe3bc)" },
  ".json-number": { color: "var(--json-number, #eec78f)" },
  ".json-boolean": { color: "var(--json-boolean, #c5a8ff)" },
  ".json-null": { color: "var(--json-null, #efa7bc)" },
  ".json-comment": { color: "var(--body-text-muted, var(--color-muted))" },
  ".json-punctuation": { color: "var(--json-punctuation, #a6b3c6)" },
  ".json-invalid": { color: "var(--json-invalid, #ff9c9c)" },
  ".json-indent": {
    backgroundImage: "linear-gradient(to right, var(--json-guide, #ffffff1c) 1px, transparent 1px)",
    backgroundSize: "2ch 100%",
  },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--json-bracket-background, #8baaff30)", outline: "1px solid var(--json-key, #9abaff)",
  },
  ".cm-tooltip": {
    background: "var(--body-text-background, var(--color-surface))", color: "inherit",
    border: "1px solid var(--body-text-border, var(--color-control-border))",
  },
  "@media (forced-colors: active)": {
    ".cm-content span": { color: "CanvasText" },
    "button": { color: "ButtonText", borderColor: "ButtonText" },
    ".cm-cursor": { borderLeftColor: "CanvasText" },
  },
}, { dark: true });
