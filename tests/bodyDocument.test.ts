// Verifies immutable body revisions through editing, snapshots, interchange, and editor recreation.
import { mount } from "@vue/test-utils";
import { expect, it } from "vitest";
import { BodyDocument, bodyEditorText, bodyText, isBodyDocument, type BodySource } from "../src/bodyDocument";
import { createRequest } from "../src/request";
import { prepareRequest } from "../src/prepareRequest";
import TextEditor from "../src/components/TextEditor.vue";
import { editorView, press } from "./editor";

it("publishes immutable revisions for a large body and accepts parent echoes without resetting undo or selection", async () => {
  const original = 'x'.repeat(2 * 1024 * 1024);
  const editor = renderEditor(original);
  const view = editorView(editor.element);
  view.dispatch({ changes: { from: original.length, insert: "first" }, selection: { anchor: original.length + 5 }, userEvent: "input" });
  const first = lastBody(editor);
  expect(isBodyDocument(first)).toBe(true);
  expect(first.length).toBe(original.length + 5);
  await editor.setProps({ modelValue: first });
  expect(editorView(editor.element)).toBe(view);
  expect(view.state.selection.main.head).toBe(original.length + 5);

  view.dispatch({ changes: { from: view.state.doc.length, insert: "second" }, userEvent: "input" });
  const second = lastBody(editor);
  expect(second).not.toBe(first);
  expect(bodyText(first)).toBe(original + "first");
  expect(bodyText(second)).toBe(original + "firstsecond");
  await editor.setProps({ modelValue: second });
  press(view, "z", { ctrlKey: true });
  expect(lastBody(editor).length).toBe(first.length);
  expect(bodyText(lastBody(editor)).endsWith("first")).toBe(true);
  await editor.setProps({ modelValue: lastBody(editor) });
  press(view, "z", { ctrlKey: true });
  expect(lastBody(editor).length).toBe(original.length);
  editor.unmount();
});

it("restores the current document after its editor is destroyed", () => {
  const editor = renderEditor("before\r\nedit");
  const view = editorView(editor.element);
  view.dispatch({ changes: { from: view.state.doc.length, insert: " after" }, userEvent: "input" });
  const document = lastBody(editor);
  editor.unmount();

  const reopened = renderEditor(document);
  expect(editorView(reopened.element).state.doc.toString()).toBe("before\nedit after");
  reopened.unmount();
});

it("captures exact current strings for Send and JSON export while retaining independent earlier revisions", () => {
  const source = new BodyDocument(bodyEditorText('{"number":9007199254740993,"value":"{{token}}"}'));
  const request = { ...createRequest(), method: "POST", path: "https://example.test/", body: source, inputMode: "literal" as const };
  const captured = prepareRequest(request);
  const exported = JSON.parse(JSON.stringify(request));
  expect(typeof captured.body).toBe("string");
  expect(captured.body).toBe('{"number":9007199254740993,"value":"{{token}}"}');
  expect(exported.body).toBe(captured.body);

  request.body = new BodyDocument(source.text.replace(0, source.length, bodyEditorText("later")));
  expect(bodyText(request.body)).toBe("later");
  expect(captured.body).toBe(exported.body);
});

function renderEditor(modelValue: BodySource) {
  return mount(TextEditor, { props: {
    modelValue, incremental: true, readonly: false, wrap: false, json: false,
    labelledBy: "label", describedBy: "feedback", placeholder: "Body",
  } });
}

function lastBody(editor: ReturnType<typeof renderEditor>): BodySource {
  return editor.emitted("update:modelValue")!.at(-1)![0] as BodySource;
}
