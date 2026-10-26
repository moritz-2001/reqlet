// Test drivers use CodeMirror's public DOM lookup and transaction interface, never component internals.
import { EditorView } from "@codemirror/view";
import { nextTick } from "vue";

export function editorView(element: Element): EditorView {
  const surface = element.matches('.cm-editor') ? element : element.querySelector('.cm-editor');
  if (!surface) throw new Error("Expected a mounted editor");
  return EditorView.findFromDOM(surface as HTMLElement)!;
}

export async function replaceText(element: Element, text: string) {
  const view = editorView(element);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input" });
  await nextTick();
}

export function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}) {
  view.focus();
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  view.contentDOM.dispatchEvent(event);
  return event;
}
