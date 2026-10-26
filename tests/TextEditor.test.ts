// Exercises TextEditor's range-reveal command through the public selection and focus behavior.
import { mount } from "@vue/test-utils";
import { expect, it } from "vitest";
import TextEditor from "../src/components/TextEditor.vue";
import { editorView } from "./editor";

it("reveals a read-only range without changing the document or taking focus", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  const editor = mount(TextEditor, {
    attachTo: document.body,
    props: { modelValue: "first\r\nneedle\r\nlast", readonly: true, wrap: false, json: false,
      labelledBy: "label", describedBy: "feedback", placeholder: "Empty" },
  });
  const view = editorView(editor.element);
  opener.focus();
  editor.vm.revealRange(6, 12);
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("needle");
  expect(document.activeElement).toBe(opener);
  expect(view.state.doc.toString()).toBe("first\nneedle\nlast");
  expect(editor.emitted("update:modelValue")).toBeUndefined();

  editor.vm.revealRange(-1, Number.MAX_SAFE_INTEGER);
  expect(view.state.selection.main.from).toBe(0);
  expect(view.state.selection.main.to).toBe(view.state.doc.length);
  editor.unmount();
  opener.remove();
});
