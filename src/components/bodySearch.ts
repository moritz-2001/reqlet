// Provides an editor-local Find panel; CodeMirror owns its query, highlights, selection, and lifetime.
import { EditorState, type StateEffect } from "@codemirror/state";
import { foldedRanges, unfoldEffect } from "@codemirror/language";
import { EditorView, keymap, runScopeHandlers, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, search, setSearchQuery, SearchQuery,
} from "@codemirror/search";

/** Literal, case-insensitive Find for editable requests and read-only responses, without replacement actions. */
export function bodySearch() {
  return [
    search({ top: true, literal: true, createPanel: view => new BodySearchPanel(view) }),
    keymap.of([
      { key: "Ctrl-f", run: openSearchPanel, scope: "editor search-panel" },
      { key: "Meta-f", run: openSearchPanel, scope: "editor search-panel" },
      { key: "Escape", run: closeSearchPanel, scope: "editor search-panel" },
      { key: "F3", run: findNext, shift: findPrevious, scope: "editor search-panel", preventDefault: true },
      { key: "Mod-g", run: findNext, shift: findPrevious, scope: "editor search-panel", preventDefault: true },
    ]),
    EditorState.transactionExtender.of(transaction => {
      if (!transaction.isUserEvent("select.search")) return null;

      // Native folding reveals only the selection head. Reveal every intersecting
      // fold so matches ending at a fold boundary or spanning nested folds stay visible.
      const selection = transaction.newSelection.main;
      const effects: StateEffect<unknown>[] = [];
      foldedRanges(transaction.startState).between(selection.from, selection.to, (from, to) => {
        if (from < selection.to && to > selection.from) effects.push(unfoldEffect.of({ from, to }));
      });
      return { effects };
    }),
  ];
}

class BodySearchPanel implements Panel {
  readonly dom = document.createElement("div");
  readonly top = true;
  private readonly input = document.createElement("input");
  private readonly status = document.createElement("span");
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  // Rebuilt only after text/query changes and released with this panel. Exact
  // counts and sparse starts avoid retaining every range for selection feedback.
  private matchIndex: SearchMatchIndex = { count: 0, blockStarts: [] };

  constructor(private readonly view: EditorView) {
    this.dom.className = "cm-body-search";
    this.dom.setAttribute("role", "search");
    this.dom.setAttribute("aria-label", "Find in body");
    this.input.type = "text";
    this.input.placeholder = "Find in body";
    this.input.setAttribute("aria-label", "Find in body");
    this.input.setAttribute("main-field", "true");
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.oninput = () => {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: this.input.value, literal: true })) });
    };
    this.status.setAttribute("role", "status");
    this.previous = searchButton("Previous", () => findPrevious(view));
    this.next = searchButton("Next", () => findNext(view));
    this.dom.append(this.input, this.previous, this.next, this.status, searchButton("Close find", () => closeSearchPanel(view)));
    this.dom.onkeydown = event => {
      if (event.isComposing) return;

      if (runScopeHandlers(view, event, "search-panel")) {
        event.preventDefault();
        event.stopPropagation();
      } else if (event.key === "Enter" && event.target === this.input
        && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        (event.shiftKey ? findPrevious : findNext)(view);
      }
    };
    this.refresh(true);
  }

  mount() {
    this.input.focus();
    this.input.select();
  }

  update(update: ViewUpdate) {
    const changed = update.docChanged || !getSearchQuery(update.startState).eq(getSearchQuery(update.state));
    if (changed || update.selectionSet) this.refresh(changed);
  }

  private refresh(rescan: boolean) {
    const query = getSearchQuery(this.view.state);
    if (this.input.value !== query.search) this.input.value = query.search;

    if (rescan) this.matchIndex = indexSearchMatches(this.view.state, query);
    this.status.textContent = matchFeedback(this.view.state, query, this.matchIndex);
    this.previous.disabled = this.next.disabled = !query.valid;
  }
}

function searchButton(label: string, action: () => boolean) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.onclick = action;
  return button;
}

interface SearchMatchIndex {
  /** Exact count from CodeMirror's non-overlapping cursor for the current document and query. */
  readonly count: number;
  /** Every block's first match offset; its zero-based match index is the array index times matchBlockSize. */
  readonly blockStarts: readonly number[];
}

const matchBlockSize = 128;

function indexSearchMatches(state: EditorState, query: SearchQuery): SearchMatchIndex {
  if (!query.valid) return { count: 0, blockStarts: [] };

  const cursor = query.getCursor(state);
  const blockStarts: number[] = [];
  let count = 0;
  for (let match = cursor.next(); !match.done; match = cursor.next()) {
    if (count % matchBlockSize === 0) blockStarts.push(match.value.from);
    count += 1;
  }
  return { count, blockStarts };
}

function matchFeedback(state: EditorState, query: SearchQuery, index: SearchMatchIndex): string {
  if (!query.valid) return "Enter text to find";
  if (!index.count) return "No matches";

  const ordinal = state.selection.main.empty ? undefined : selectedMatchOrdinal(state, query, index);
  return ordinal === undefined
    ? `${index.count} ${index.count === 1 ? "match" : "matches"}`
    : `${ordinal} of ${index.count} matches`;
}

function selectedMatchOrdinal(state: EditorState, query: SearchQuery, index: SearchMatchIndex): number | undefined {
  const selection = state.selection.main;
  let low = 0;
  let high = index.blockStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (index.blockStarts[middle]! <= selection.from) low = middle + 1;
    else high = middle;
  }
  const block = low - 1;
  if (block < 0) return undefined;

  // Restart at a canonical match, preserving non-overlapping and Unicode matching
  // semantics. An arbitrary caret offset could otherwise invent overlapping matches.
  const cursor = query.getCursor(state, index.blockStarts[block]!, selection.to);
  const end = Math.min(index.count, (block + 1) * matchBlockSize);
  for (let ordinal = block * matchBlockSize; ordinal < end; ordinal += 1) {
    const match = cursor.next();
    if (match.done || match.value.from > selection.from) return undefined;
    if (match.value.from === selection.from) return match.value.to === selection.to ? ordinal + 1 : undefined;
  }
  return undefined;
}
