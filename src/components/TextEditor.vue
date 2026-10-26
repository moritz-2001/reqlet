<!-- TextEditor adapts parent-owned text to CodeMirror; all editing and fold state belongs to its view. -->
<script setup lang="ts">
import type { ProtobufContext } from "../protobuf";
import { onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, isolateHistory } from "@codemirror/commands";
import { bracketMatching, unfoldAll } from "@codemirror/language";
import { json } from "./jsonLanguage";
import { jsonParseLinter } from "./jsonLint";
import { linter, lintKeymap } from "@codemirror/lint";
import { getSearchQuery, openSearchPanel, searchPanelOpen, setSearchQuery, type SearchQuery } from "@codemirror/search";
import { protobufCompletion } from "./protobufCompletion";
import { bodySearch } from "./bodySearch";
import { collapseJsonValue, expandJsonValue, jsonFolding } from "./jsonFolding";
import { editorTheme, insertJsonNewline, jsonPresentation, type TextEditorHandle } from "./textEditor";
import { BodyDocument, bodyEditorText, isBodyDocument, type BodySource } from "../bodyDocument";

const props = defineProps<{
  /** Parent-owned displayed body; the editor normalizes line endings to LF. */
  modelValue: BodySource;
  /** Emits immutable document revisions instead of flattening the full source after every edit. */
  incremental?: boolean;
  /** Resolved runtime model; omitted disables protobuf assistance. */
  protobufContext?: ProtobufContext;
  /** Blocks user document changes while retaining keyboard selection and folds. */
  readonly: boolean;
  /** Soft-wraps lines without changing source or discarding folds. */
  wrap: boolean;
  /** Enables JSON with comments/trailing commas, folds, indentation, colors, and diagnostics. */
  json: boolean;
  /** ID of BodyText's heading, used as the content surface's accessible name. */
  labelledBy: string;
  /** ID of BodyText's action feedback, associated with the editing surface. */
  describedBy: string;
  /** Empty-document hint supplied by BodyText. */
  placeholder: string;
}>();

const emit = defineEmits<{
  /** LF-normalized source revision after a user document change, never after folding. */
  "update:modelValue": [text: BodySource];
}>();

const host = ref<HTMLDivElement>();
// One view owns history, selection, folds, and its transactional document. No Vue draft mirrors it.
let view: EditorView | undefined;
// An equal parent value acknowledges our controlled edit. Documents retain the
// exact immutable text root, so acknowledging an edit never flattens it.
let emittedText: BodySource | undefined;
// Reconfigure presentation without recreating history or folds during Wrap changes.
const assistance = new Compartment();
const language = new Compartment();
const wrapping = new Compartment();
const editing = new Compartment();
let observer: ResizeObserver | undefined;

onMounted(() => {
  view = new EditorView({ parent: host.value, state: createState(props.modelValue) });
  observer = new ResizeObserver(() => view?.requestMeasure());
  observer.observe(host.value!);
});

onActivated(() => view?.requestMeasure());
onBeforeUnmount(() => {
  observer?.disconnect();
  view?.destroy();
  view = undefined;
});

watch(() => [props.modelValue, props.json, props.readonly] as const, ([text], previous) => {
  if (!view) return;
  const echo = text === emittedText;
  emittedText = undefined;
  const replaced = !echo && (isBodyDocument(text)
    ? text.text !== view.state.doc : normalize(text) !== view.state.doc.toString());
  if (!replaced) {
    if (props.json !== previous[1] || props.readonly !== previous[2]) {
      unfoldAll(view);
      view.dispatch({ effects: [
        language.reconfigure(jsonExtensions()),
        editing.reconfigure(editingExtensions()),
      ] });
    }
    return;
  }

  // The watcher runs after Vue accepts a model update, outside CodeMirror's dispatch.
  // A different parent document starts fresh history; ordinary equal echoes do nothing.
  const anchor = Math.min(view.state.selection.main.head, isBodyDocument(text) ? text.length : normalize(text).length);
  const query = getSearchQuery(view.state);
  const finding = searchPanelOpen(view.state);
  const focused = view.root.activeElement;
  const editorFocused = focused !== null && view.dom.contains(focused);
  view.setState(createState(text, anchor, query));
  if (finding) {
    openSearchPanel(view);
    // A new response or raw/pretty preview preserves Find without taking focus
    // away from a toolbar button or another request field.
    if (!editorFocused && focused instanceof HTMLElement) focused.focus();
  }
}, { flush: "post" });

watch(() => props.wrap, () => {
  view?.dispatch({ effects: wrapping.reconfigure(wrapExtensions()) });
});

function createState(text: BodySource, anchor = 0, query?: SearchQuery) {
  const state = EditorState.create({
    doc: bodyEditorText(text), selection: { anchor },
    extensions: [
      assistance.of(assistanceExtensions()),
      editorTheme, history(), drawSelection(), bodySearch(),
      EditorState.tabSize.of(2),
      language.of(jsonExtensions()), wrapping.of(wrapExtensions()), editing.of(editingExtensions()),
      EditorView.contentAttributes.of({
        role: "textbox", "aria-multiline": "true", "aria-labelledby": props.labelledBy,
        "aria-describedby": props.describedBy, tabindex: "0", spellcheck: "false",
        autocapitalize: "off", autocorrect: "off",
      }),
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        emittedText = props.incremental ? new BodyDocument(update.state.doc) : update.state.doc.toString();
        emit("update:modelValue", emittedText);
      }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...lintKeymap]),
    ],
  });
  return query ? state.update({ effects: setSearchQuery.of(query) }).state : state;
}

function jsonExtensions() {
  return props.json ? [
    json(), jsonPresentation(), bracketMatching(), jsonFolding(),
    keymap.of([{ key: "Enter", run: insertJsonNewline }]),
    linter(jsonParseLinter()),
  ] : [];
}

watch(() => [props.protobufContext, props.json, props.readonly], () => {
  view?.dispatch({ effects: assistance.reconfigure(assistanceExtensions()) });
});
function assistanceExtensions() {
  return props.protobufContext && props.json && !props.readonly ? [protobufCompletion(props.protobufContext)] : [];
}

function wrapExtensions() {
  return props.wrap ? [EditorView.lineWrapping] : [lineNumbers()];
}

function editingExtensions() {
  return [
    EditorState.readOnly.of(props.readonly), EditorView.editable.of(!props.readonly),
    EditorView.contentAttributes.of({ "aria-readonly": String(props.readonly) }),
    placeholder(props.placeholder),
  ];
}

function normalize(text: string) { return text.replace(/\r\n?/g, "\n"); }

const commands: TextEditorHandle = {
  replaceDocument(text) {
    if (!view || props.readonly || normalize(text) === view.state.doc.toString()) return;

    unfoldAll(view);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: normalize(text) },
      selection: { anchor: 0 },
      annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")],
    });
  },
  collapseValue() { if (view) { collapseJsonValue(view); view.focus(); } },
  expandValue() { if (view) { expandJsonValue(view); view.focus(); } },
  expandAll() { if (view) { unfoldAll(view); view.focus(); } },
  findText() { if (view) openSearchPanel(view); },
  revealRange(from, to) {
    if (!view) return;

    const anchor = Math.max(0, Math.min(from, view.state.doc.length));
    const head = Math.max(anchor, Math.min(to, view.state.doc.length));
    view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
  },
};
defineExpose(commands);
</script>

<template>
  <div ref="host" class="text-editor" />
</template>

<style scoped>
.text-editor {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: var(--body-editor-min-height, 320px);
  overflow: hidden;
  resize: var(--body-editor-resize, vertical);
}

/* Keep the editor-root media rule here: style-mod expands a nested `&` to
   the enclosing @media text rather than CodeMirror's generated root selector.
   Descendant forced-color rules remain with editorTheme in textEditor.ts. */
@media (forced-colors: active) {
  .text-editor :deep(.cm-editor) {
    color: CanvasText;
    background-color: Canvas;
  }
}
</style>
