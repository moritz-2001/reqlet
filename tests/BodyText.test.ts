// Exercises BodyText's real editor, toolbar, and controlled model rather than its private state.
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { foldedRanges } from "@codemirror/language";
import { diagnosticCount, forEachDiagnostic, forceLinting } from "@codemirror/lint";
import { redo, undo } from "@codemirror/commands";
import BodyText from "../src/components/BodyText.vue";
import { editorView, press, replaceText } from "./editor";

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("colors escaped source and guides without replacing its exact numbers or escapes", async () => {
  const text = '{\n  "html": "<img src=x onerror=alert(1)>",\n  "id": 9007199254740993\n}\n';
  const body = renderBody(text);
  expect(editorView(body.element).state.doc.toString()).toBe(text);
  expect(body.find("img").exists()).toBe(false);
  expect(body.findAll(".json-key").map(token => token.text())).toEqual(['"html"', '"id"']);
  expect(body.get(".json-number").text()).toBe("9007199254740993");
  expect(body.findAll(".json-indent")).toHaveLength(2);
  expect(body.emitted("update:modelValue")).toBeUndefined();
  await replaceText(body.element, '{"unfinished":');
  expect(body.emitted("update:modelValue")).toEqual([['{"unfinished":']]);
});

it("reports diagnostics for invalid, fixed, and empty bodies", async () => {
  vi.useFakeTimers();
  const body = renderBody('{"a" true}');
  forceLinting(editorView(body.element));
  await vi.advanceTimersByTimeAsync(800);
  expect(diagnosticCount(editorView(body.element).state)).toBe(1);
  await body.setProps({ contentType: "text/plain" });
  expect(diagnosticCount(editorView(body.element).state)).toBe(0);
  await body.setProps({ modelValue: '{"a":true}', contentType: "application/json" });
  forceLinting(editorView(body.element));
  await vi.advanceTimersByTimeAsync(800);
  expect(diagnosticCount(editorView(body.element).state)).toBe(0);
  await body.setProps({ modelValue: "", readonly: true });
  forceLinting(editorView(body.element));
  await vi.advanceTimersByTimeAsync(800);
  expect(diagnosticCount(editorView(body.element).state)).toBe(1);
});

it("highlights comments and accepts trailing commas without diagnostics or edits", async () => {
  vi.useFakeTimers();
  const text = '{\n  // values [ ]\n  "items": [1, /* item */],\n}';
  const body = renderBody(text);
  const view = editorView(body.element);
  forceLinting(view);
  await vi.advanceTimersByTimeAsync(800);
  expect(diagnosticCount(view.state)).toBe(0);
  expect(body.findAll('.json-comment').map(comment => comment.text())).toEqual(['// values [ ]', '/* item */']);
  expect(body.findAll('.json-key').map(token => token.text())).toEqual(['"items"']);
  expect(view.state.doc.toString()).toBe(text);
  expect(body.emitted('update:modelValue')).toBeUndefined();
});

it("locates malformed JSON after comments at its original source offset", async () => {
  vi.useFakeTimers();
  const text = '{/* 😀 note */ "value": @}';
  const body = renderBody(text);
  const view = editorView(body.element);
  forceLinting(view);
  await vi.advanceTimersByTimeAsync(800);
  const positions: number[] = [];
  forEachDiagnostic(view.state, (_diagnostic, from) => positions.push(from));
  expect(positions).toEqual([text.indexOf('@')]);
});

it("folds strings independently on a minified line and unfolds the exact clicked widget", async () => {
  const text = '{"one":"hello","two":"world"}';
  const body = renderBody(text);
  const view = editorView(body.element);
  view.dispatch({ selection: { anchor: text.indexOf('hello') + 1 } });
  await moreAction(body, "Collapse value");
  expect(body.findAll('.cm-foldPlaceholder')).toHaveLength(1);
  expect(view.state.doc.toString()).toBe(text);
  view.dispatch({ selection: { anchor: text.indexOf('world') + 1 } });
  await moreAction(body, "Collapse value");
  expect(body.findAll('.cm-foldPlaceholder')).toHaveLength(2);
  await body.findAll('.cm-foldPlaceholder')[1]!.trigger('click');
  expect(body.findAll('.cm-foldPlaceholder')).toHaveLength(1);
  expect(body.get('.cm-content').text()).toContain('world');
  expect(body.get('.cm-content').text()).not.toContain('hello');
  expect(body.emitted("update:modelValue")).toBeUndefined();
});

it("retains child folds when an ancestor closes and opens, and expands all hidden folds", async () => {
  const body = renderBody('{"items":["hello"]}');
  const view = editorView(body.element);
  view.dispatch({ selection: { anchor: 12 } });
  await moreAction(body, "Collapse value");
  view.dispatch({ selection: { anchor: 0 } });
  await moreAction(body, "Collapse value");
  expect(foldedRanges(view.state).size).toBe(2);
  await moreAction(body, "Expand value");
  expect(foldedRanges(view.state).size).toBe(1);
  expect(body.get('.cm-foldPlaceholder').attributes('aria-label')).toBe('Expand string value');
  await moreAction(body, "Expand all");
  expect(foldedRanges(view.state).size).toBe(0);
});

it("shares caret targeting between keyboard shortcuts and pointer gutter controls", async () => {
  const body = renderBody('{"items":["hello"]}');
  const view = editorView(body.element);
  view.dispatch({ selection: { anchor: 12 } });
  expect(press(view, '{', { keyCode: 219, ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
  expect(body.get('.cm-foldPlaceholder').attributes('aria-label')).toBe('Expand string value');
  expect(press(view, '}', { keyCode: 221, ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
  expect(foldedRanges(view.state).size).toBe(0);
  await body.get('.cm-json-fold-gutter button').trigger('click');
  expect(body.get('.cm-foldPlaceholder').attributes('aria-label')).toBe('Expand object value');
  expect(press(view, ']', { ctrlKey: true, altKey: true }).defaultPrevented).toBe(true);
  expect(foldedRanges(view.state).size).toBe(0);
  expect(body.emitted('update:modelValue')).toBeUndefined();
});

it("maps untouched folds through accepted edits, clears touched folds, and preserves history on echoes", async () => {
  const body = await controlledBody('{"a":"hello","b":1}');
  const view = editorView(body.element);
  view.dispatch({ selection: { anchor: 8 } });
  await moreAction(body, "Collapse value");
  view.dispatch({ changes: { from: 0, insert: ' ' }, userEvent: "input" });
  await nextTick();
  expect(foldedRanges(view.state).size).toBe(1);
  await body.get('.cm-foldPlaceholder').trigger('click');
  expect(foldedRanges(view.state).size).toBe(0);
  view.dispatch({ selection: { anchor: 9 } });
  await moreAction(body, "Collapse value");
  view.dispatch({ changes: { from: 8, to: 9, insert: 'x' }, userEvent: "input" });
  await nextTick();
  expect(foldedRanges(view.state).size).toBe(0);
  expect(undo(view)).toBe(true);
  await nextTick();
  expect(view.state.doc.toString()).toBe(' {"a":"hello","b":1}');
});

it("first reveals a folded neighbor on Delete and copies selected folded source", async () => {
  const body = await controlledBody('["hello"]');
  const view = editorView(body.element);
  view.dispatch({ selection: { anchor: 3 } });
  await moreAction(body, "Collapse value");
  expect(press(view, 'Delete').defaultPrevented).toBe(true);
  expect(foldedRanges(view.state).size).toBe(0);
  expect(view.state.doc.toString()).toBe('["hello"]');
  await moreAction(body, "Collapse value");
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  const values: Record<string, string> = {};
  const copy = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(copy, 'clipboardData', { value: { clearData() {}, setData(type: string, value: string) { values[type] = value; } } });
  view.contentDOM.dispatchEvent(copy);
  expect(values['text/plain']).toBe('["hello"]');
  press(view, 'Backspace');
  await nextTick();
  expect(view.state.doc.toString()).toBe('');
  undo(view);
  expect(view.state.doc.toString()).toBe('["hello"]');
});

it("keeps folds through Wrap and clears JSON state on MIME or document replacement", async () => {
  const body = renderBody('{"a":"hello"}');
  const view = editorView(body.element);
  await moreAction(body, "Collapse value");
  await moreAction(body, "Wrap lines");
  expect(foldedRanges(view.state).size).toBe(1);
  expect(body.find('.cm-lineNumbers').exists()).toBe(false);
  expect(body.find('.cm-json-fold-gutter').exists()).toBe(true);
  await body.setProps({ contentType: 'text/plain' });
  expect(foldedRanges(view.state).size).toBe(0);
  expect(body.find('.cm-json-fold-gutter').exists()).toBe(false);
  expect(body.find('.json-key').exists()).toBe(false);
  await body.setProps({ contentType: 'Application/Problem+JSON; charset=utf-8' });
  await moreAction(body, "Collapse value");
  await body.setProps({ modelValue: '{"new":true}' });
  expect(foldedRanges(view.state).size).toBe(0);
  expect(undo(view)).toBe(false);
  expect(view.state.doc.toString()).toBe('{"new":true}');
});

it("preserves local indentation as one undoable Enter with the inner-line caret on redo", async () => {
  const original = '{\n    "items": []\n}';
  const body = await controlledBody(original);
  const view = editorView(body.element);
  view.dispatch({ selection: { anchor: original.indexOf('[') + 1 } });
  expect(press(view, 'Enter').defaultPrevented).toBe(true);
  await nextTick();
  const result = '{\n    "items": [\n        \n    ]\n}';
  expect(view.state.doc.toString()).toBe(result);
  expect(view.state.selection.main.head).toBe(result.indexOf('\n    ]'));
  expect(body.emitted('update:modelValue')).toEqual([[result]]);
  undo(view);
  await nextTick();
  expect(view.state.doc.toString()).toBe(original);
  redo(view);
  await nextTick();
  expect(view.state.doc.toString()).toBe(result);
  expect(view.state.selection.main.head).toBe(result.indexOf('\n    ]'));
});

it("replaces selections using retained-source indentation and respects a differing parent replacement", async () => {
  const body = await controlledBody('{\n\t"a": [1]\n}');
  const view = editorView(body.element);
  view.dispatch({ selection: { anchor: 1, head: view.state.doc.length - 1 } });
  press(view, 'Enter');
  await nextTick();
  expect(view.state.doc.toString()).toBe('{\n  \n}');
  await body.setProps({ 'onUpdate:modelValue': () => { void body.setProps({ modelValue: 'parent replacement' }); } });
  press(view, 'Enter');
  await nextTick();
  expect(view.state.doc.toString()).toBe('parent replacement');
  expect(undo(view)).toBe(false);
});

it("formats as one undoable edit while keeping source tokens intact", async () => {
  const text = '{"id":9007199254740993,"text":"\\u0061"}';
  const body = await controlledBody(text);
  const view = editorView(body.element);
  await moreAction(body, 'Collapse value');
  await button(body, 'Format JSON').trigger('click');
  expect(view.state.doc.toString()).toContain('\n  "id": 9007199254740993');
  expect(view.state.doc.toString()).toContain('"\\u0061"');
  expect(foldedRanges(view.state).size).toBe(0);
  expect(body.emitted('update:modelValue')).toHaveLength(1);
  undo(view);
  await nextTick();
  expect(view.state.doc.toString()).toBe(text);
});

it("preserves comments and trailing commas through formatting and undo", async () => {
  const text = '{/* heading */"id":9007199254740993,"items":[1,],// keep\n}';
  const body = await controlledBody(text);
  const view = editorView(body.element);
  await button(body, 'Format JSON').trigger('click');
  const formatted = view.state.doc.toString();
  expect(formatted).toContain('/* heading */');
  expect(formatted).toContain('// keep');
  expect(formatted).toContain('"id": 9007199254740993');
  expect(formatted).toMatch(/1,\s*\]/);
  expect(formatted).toMatch(/\],\s*\/\/ keep\s*\}/);
  expect(body.emitted('update:modelValue')).toHaveLength(1);
  expect(undo(view)).toBe(true);
  await nextTick();
  expect(view.state.doc.toString()).toBe(text);
});

it("folds read-only JSONC previews without edits and copies the original line endings", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const original = '{\r\n// response\r\n"id":9007199254740993,"text":"\\u0061",\r\n}';
  const body = renderBody(original, true);
  const view = editorView(body.element);
  expect(view.state.doc.toString()).toContain('\n  "id": 9007199254740993');
  expect(view.state.doc.toString()).toContain('// response');
  expect(button(body, 'Pretty').attributes('aria-pressed')).toBe('true');
  await button(body, 'Raw').trigger('click');
  expect(view.state.doc.toString()).toBe(original.replace(/\r\n/g, '\n'));
  expect(view.contentDOM.getAttribute('contenteditable')).toBe('false');
  press(view, 'Enter');
  press(view, 'Backspace');
  await moreAction(body, 'Collapse value');
  expect(foldedRanges(view.state).size).toBe(1);
  await button(body, 'Pretty').trigger('click');
  expect(foldedRanges(view.state).size).toBe(0);
  expect(view.state.doc.toString()).toContain('\n  "id": 9007199254740993');
  await button(body, 'Copy body').trigger('click');
  expect(writeText).toHaveBeenCalledWith(original);
  await button(body, 'Raw').trigger('click');
  expect(view.state.doc.toString()).toBe(original.replace(/\r\n/g, '\n'));
  expect(body.emitted('update:modelValue')).toBeUndefined();
});

it("clears folds on raw/pretty transitions even when the source is already formatted", async () => {
  const body = renderBody('{\n  "text": "hello"\n}', true);
  const view = editorView(body.element);
  await moreAction(body, 'Collapse value');
  await button(body, 'Raw').trigger('click');
  expect(foldedRanges(view.state).size).toBe(0);
  await moreAction(body, 'Collapse value');
  await button(body, 'Pretty').trigger('click');
  expect(foldedRanges(view.state).size).toBe(0);
  expect(body.emitted('update:modelValue')).toBeUndefined();
});

it("keeps folds when the already-selected response presentation is chosen again", async () => {
  const body = renderBody('{"text":"hello"}', true);
  const view = editorView(body.element);
  for (const presentation of ['Pretty', 'Raw']) {
    await button(body, presentation).trigger('click');
    await moreAction(body, 'Collapse value');
    expect(foldedRanges(view.state).size).toBe(1);
    await button(body, presentation).trigger('click');
    expect(foldedRanges(view.state).size).toBe(1);
  }
});

it("remembers the response view through incoming bodies and invalid or non-JSON content", async () => {
  const body = renderBody('{"first":true}', true);
  const view = editorView(body.element);
  expect(body.get('[role="group"]').attributes('aria-label')).toBe('Body presentation');
  expect(view.state.doc.toString()).toBe('{\n  "first": true\n}');
  await button(body, 'Raw').trigger('click');
  await body.setProps({ modelValue: '{"next":true}' });
  expect(view.state.doc.toString()).toBe('{"next":true}');
  expect(button(body, 'Raw').attributes('aria-pressed')).toBe('true');
  await button(body, 'Pretty').trigger('click');
  await body.setProps({ modelValue: '{broken' });
  expect(view.state.doc.toString()).toBe('{broken');
  expect(button(body, 'Raw').attributes('aria-pressed')).toBe('true');
  await button(body, 'Pretty').trigger('click');
  expect(body.get('[role="status"]').text()).toBe('Cannot format invalid JSON. Your text is unchanged.');
  await body.setProps({ modelValue: '{"fixed":true}' });
  expect(view.state.doc.toString()).toBe('{\n  "fixed": true\n}');
  await body.setProps({ contentType: 'text/plain' });
  expect(view.state.doc.toString()).toBe('{"fixed":true}');
  expect(body.find('[role="group"]').exists()).toBe(false);
  await body.setProps({ contentType: 'application/json' });
  expect(view.state.doc.toString()).toBe('{\n  "fixed": true\n}');
  expect(body.emitted('update:modelValue')).toBeUndefined();
});

it("finds literal text with highlighted matches, wrapping navigation, and no read-only edits", async () => {
  const text = String.raw`{"one":"[.*]","two":"[.*]","escape":"\n"}`;
  const body = renderBody(text, true);
  const view = editorView(body.element);
  await button(body, 'Find').trigger('click');
  const find = body.get<HTMLInputElement>('.cm-body-search input');
  expect(document.activeElement).toBe(find.element);
  await find.setValue('[.*]');
  expect(body.get('.cm-body-search [role=status]').text()).toBe('2 matches');
  expect(body.findAll('.cm-searchMatch')).toHaveLength(2);
  await find.trigger('keydown', { key: 'Enter' });
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('[.*]');
  expect(body.get('.cm-body-search [role=status]').text()).toBe('1 of 2 matches');
  await find.trigger('keydown', { key: 'Enter', shiftKey: true });
  expect(body.get('.cm-body-search [role=status]').text()).toBe('2 of 2 matches');
  await button(body, 'Next').trigger('click');
  expect(body.get('.cm-body-search [role=status]').text()).toBe('1 of 2 matches');
  await button(body, 'Previous').trigger('click');
  expect(body.get('.cm-body-search [role=status]').text()).toBe('2 of 2 matches');
  await find.setValue(String.raw`\n`);
  expect(body.get('.cm-body-search [role=status]').text()).toBe('1 match');
  await find.setValue('missing');
  expect(body.get('.cm-body-search [role=status]').text()).toBe('No matches');
  await find.trigger('keydown', { key: 'Enter' });
  expect(view.state.doc.toString()).toContain('"one": "[.*]"');
  expect(body.emitted('update:modelValue')).toBeUndefined();
});

it("reports exact match positions across many results and distinguishes partial or reversed selections", async () => {
  const body = renderBody("needle ".repeat(300));
  await body.setProps({ contentType: "text/plain" });
  const view = editorView(body.element);
  await button(body, "Find").trigger("click");
  await body.get('.cm-body-search input').setValue("NEEDLE");
  expect(body.get('.cm-body-search [role=status]').text()).toBe("300 matches");

  for (const index of [0, 127, 128, 255, 256, 299]) {
    view.dispatch({ selection: { anchor: index * 7, head: index * 7 + 6 } });
    expect(body.get('.cm-body-search [role=status]').text()).toBe(`${index + 1} of 300 matches`);
  }
  await button(body, "Next").trigger("click");
  expect(body.get('.cm-body-search [role=status]').text()).toBe("1 of 300 matches");
  await button(body, "Previous").trigger("click");
  expect(body.get('.cm-body-search [role=status]').text()).toBe("300 of 300 matches");

  view.dispatch({ selection: { anchor: 128 * 7 + 6, head: 128 * 7 } });
  expect(body.get('.cm-body-search [role=status]').text()).toBe("129 of 300 matches");
  await button(body, "Previous").trigger("click");
  expect(body.get('.cm-body-search [role=status]').text()).toBe("128 of 300 matches");
  await button(body, "Next").trigger("click");
  expect(body.get('.cm-body-search [role=status]').text()).toBe("129 of 300 matches");

  for (const selection of [
    { anchor: 128 * 7 },
    { anchor: 128 * 7, head: 128 * 7 + 5 },
    { anchor: 128 * 7 + 1, head: 128 * 7 + 7 },
  ]) {
    view.dispatch({ selection });
    expect(body.get('.cm-body-search [role=status]').text()).toBe("300 matches");
  }
});

it("keeps canonical match counts for Unicode expansion and overlapping literal text", async () => {
  const body = renderBody("ﬃ ".repeat(260));
  await body.setProps({ contentType: "text/plain" });
  const view = editorView(body.element);
  await button(body, "Find").trigger("click");
  const input = body.get('.cm-body-search input');
  await input.setValue("f");
  expect(body.get('.cm-body-search [role=status]').text()).toBe("260 matches");
  view.dispatch({ selection: { anchor: 129 * 2, head: 129 * 2 + 1 } });
  expect(body.get('.cm-body-search [role=status]').text()).toBe("130 of 260 matches");

  await body.setProps({ modelValue: "aaa ".repeat(260) });
  await input.setValue("aa");
  view.dispatch({ selection: { anchor: 128 * 4, head: 128 * 4 + 2 } });
  expect(body.get('.cm-body-search [role=status]').text()).toBe("129 of 260 matches");
  view.dispatch({ selection: { anchor: 128 * 4 + 1, head: 128 * 4 + 3 } });
  expect(body.get('.cm-body-search [role=status]').text()).toBe("260 matches");
});

it("reveals a found value at its fold boundary and its ancestors while retaining unrelated folds", async () => {
  const text = '{"items":["hello"],"other":"stay"}';
  const body = renderBody(text, true);
  await button(body, 'Raw').trigger('click');
  const view = editorView(body.element);
  for (const anchor of [text.indexOf('hello'), text.indexOf('stay'), 0]) {
    view.dispatch({ selection: { anchor } });
    await moreAction(body, 'Collapse value');
  }
  expect(foldedRanges(view.state).size).toBe(3);
  await button(body, 'Find').trigger('click');
  const find = body.get('.cm-body-search input');
  await find.setValue('hello');
  await find.trigger('keydown', { key: 'Enter' });
  expect(foldedRanges(view.state).size).toBe(1);
  expect(body.get('.cm-content').text()).toContain('hello');
  expect(body.get('.cm-content').text()).not.toContain('stay');
  expect(body.emitted('update:modelValue')).toBeUndefined();
});

it("scopes Ctrl/Cmd+F to its body editor and closes Find with Escape while restoring editor focus", async () => {
  const first = renderBody('first body', true);
  const second = renderBody('second body', true);
  expect(press(editorView(second.element), 'f', { ctrlKey: true }).defaultPrevented).toBe(true);
  await nextTick();
  expect(first.find('.cm-body-search').exists()).toBe(false);
  const find = second.get('.cm-body-search input');
  await find.setValue('BODY');
  expect(second.get('.cm-body-search [role=status]').text()).toBe('1 match');
  await find.trigger('keydown', { key: 'Escape' });
  expect(second.find('.cm-body-search').exists()).toBe(false);
  expect(document.activeElement).toBe(editorView(second.element).contentDOM);
  expect(press(editorView(first.element), 'f', { metaKey: true }).defaultPrevented).toBe(true);
  await nextTick();
  expect(first.find('.cm-body-search').exists()).toBe(true);
  expect(second.find('.cm-body-search').exists()).toBe(false);
});

it("retains the Find query through wrapping, raw/pretty previews, and response replacement", async () => {
  const body = renderBody('{"message":"needle","again":"needle"}', true);
  const view = editorView(body.element);
  await button(body, 'Find').trigger('click');
  await body.get('.cm-body-search input').setValue('needle');
  await moreAction(body, "Wrap lines");
  expect(document.activeElement).toBe(body.get('[aria-label="More body actions"]').element);
  for (const label of ['Pretty', 'Raw']) {
    await button(body, label).trigger('click');
    expect(editorView(body.element)).toBe(view);
    expect(body.get<HTMLInputElement>('.cm-body-search input').element.value).toBe('needle');
    expect(body.get('.cm-body-search [role=status]').text()).toBe('2 matches');
    await button(body, 'Next').trigger('click');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('needle');
  }
  await body.setProps({ modelValue: '{"updated":"needle"}' });
  expect(body.get<HTMLInputElement>('.cm-body-search input').element.value).toBe('needle');
  expect(body.get('.cm-body-search [role=status]').text()).toBe('1 match');
  await button(body, 'Close find').trigger('click');
  expect(body.find('.cm-body-search').exists()).toBe(false);
  expect(body.find('.cm-searchMatch').exists()).toBe(false);
  expect(body.emitted('update:modelValue')).toBeUndefined();
});

it("leaves modified Enter available to parent shortcuts and does not intercept composition keys", async () => {
  const body = renderBody('{"value":"match"}', true);
  const view = editorView(body.element);
  await button(body, 'Find').trigger('click');
  const find = body.get('.cm-body-search input');
  await find.setValue('match');
  const parentKeydown = vi.fn();
  body.element.addEventListener('keydown', parentKeydown);

  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifiers });
    find.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(parentKeydown).toHaveBeenLastCalledWith(event);
    expect(view.state.selection.main.empty).toBe(true);
  }
  const escape = new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true, isComposing: true,
  });
  find.element.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(false);
  expect(parentKeydown).toHaveBeenLastCalledWith(escape);
  expect(body.find('.cm-body-search').exists()).toBe(true);
});

it("updates match feedback after accepted edits without breaking undo history", async () => {
  const body = await controlledBody('{"value":"match"}');
  const view = editorView(body.element);
  await button(body, 'Find').trigger('click');
  await body.get('.cm-body-search input').setValue('match');
  expect(body.get('.cm-body-search [role=status]').text()).toBe('1 match');
  await replaceText(body.element, '{"value":"different"}');
  expect(body.get('.cm-body-search [role=status]').text()).toBe('No matches');
  expect(undo(view)).toBe(true);
  await nextTick();
  expect(body.get('.cm-body-search [role=status]').text()).toBe('1 match');
});

it("refreshes many-result match positions after accepted edits and undo", async () => {
  const source = "needle ".repeat(260);
  const body = await controlledBody(source);
  await body.setProps({ contentType: "text/plain" });
  const view = editorView(body.element);
  await button(body, "Find").trigger("click");
  await body.get('.cm-body-search input').setValue("needle");
  view.dispatch({ selection: { anchor: 259 * 7, head: 259 * 7 + 6 } });
  expect(body.get('.cm-body-search [role=status]').text()).toBe("260 of 260 matches");
  view.dispatch({ changes: { from: 0, insert: "needle " }, userEvent: "input" });
  await nextTick();
  expect(body.get('.cm-body-search [role=status]').text()).toBe("261 of 261 matches");

  expect(undo(view)).toBe(true);
  await nextTick();
  expect(body.get('.cm-body-search [role=status]').text()).toBe("260 of 260 matches");
  expect(view.state.doc.toString()).toBe(source);
});

it.each([false, true])("shows only primary actions in the toolbar (compact: %s)", async compact => {
  const body = renderBody('{"value":"text"}', true);
  await body.setProps({ compact });
  expect(body.get(".body-actions").findAll("button").map(button => button.text())).toEqual([
    "Pretty", "Raw", "Find", "Copy body", "⋯",
  ]);
  expect(body.text()).not.toContain("Editable");
  expect(body.text()).not.toContain("Read only");
  expect(body.text()).not.toContain("characters");
  expect(body.get('[role="status"]').text()).toBe('');
  expect(body.find('[role="menu"]').exists()).toBe(false);
  expect(body.get('.cm-content').attributes('aria-readonly')).toBe('true');

  const view = editorView(body.element);
  const menu = await openMore(body);
  expect(menu.get('[role="menuitemcheckbox"]').attributes('aria-checked')).toBe('false');
  expect(document.activeElement).toBe(menu.get('[role="menuitemcheckbox"]').element);
  await menu.get('[role="menuitemcheckbox"]').trigger('keydown', { key: 'ArrowDown' });
  const collapse = menu.findAll('button').find(button => button.text() === 'Collapse value')!;
  expect(document.activeElement).toBe(collapse.element);
  await collapse.trigger('click');
  expect(document.getElementById(menu.attributes('id'))).toBeNull();
  expect(body.get(".cm-foldPlaceholder").isVisible()).toBe(true);
  expect(document.activeElement).toBe(view.contentDOM);
  expect(body.emitted("update:modelValue")).toBeUndefined();
});

it("opens More from the keyboard and focuses actions after they become visible", async () => {
  const body = renderBody('{"value":"text"}');
  const visibilityOnFocus: string[] = [];
  document.body.addEventListener('focusin', event => {
    visibilityOnFocus.push(window.getComputedStyle(event.target as HTMLElement).visibility);
  }, { once: true });
  const trigger = body.get('[aria-label="More body actions"]');
  await trigger.trigger('keydown', { key: 'ArrowUp' });
  await flushPromises();
  expect(visibilityOnFocus).toEqual(['visible']);
  const menu = document.getElementById(trigger.attributes('aria-controls'))!;
  expect(document.activeElement?.textContent).toBe('Expand all');
  expect(menu.contains(document.activeElement)).toBe(true);
});

it("keeps overflowed formatting, Find, and Copy available through More", async () => {
  const body = await controlledBody('{"value":"needle"}');
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  // jsdom has no container layout; emulate the controls hidden by the pane's
  // container query, then exercise their public commands through the menu.
  for (const label of ['Format JSON', 'Find', 'Copy body']) button(body, label).element.style.display = 'none';

  let menu = await openMore(body);
  expect(document.activeElement?.textContent).toBe('Format JSON');
  await menu.findAll('button').find(button => button.text() === 'Format JSON')!.trigger('click');
  expect(editorView(body.element).state.doc.toString()).toBe('{\n  "value": "needle"\n}');
  expect(body.get('[aria-label="More body actions"]').attributes('aria-expanded')).toBe('false');

  menu = await openMore(body);
  await menu.findAll('button').find(button => button.text() === 'Find')!.trigger('click');
  expect(document.activeElement).toBe(body.get('.cm-body-search input').element);
  await body.get('.cm-body-search input').setValue('needle');
  expect(body.get('.cm-body-search [role=status]').text()).toBe('1 match');

  menu = await openMore(body);
  await menu.findAll('button').find(button => button.text() === 'Copy body')!.trigger('click');
  expect(writeText).toHaveBeenCalledWith('{\n  "value": "needle"\n}');
  expect(document.activeElement).toBe(body.get('[aria-label="More body actions"]').element);
});

it("keeps response presentation choices available when the toggle overflows", async () => {
  const original = '{"value":true}';
  const body = renderBody(original, true);
  body.get<HTMLElement>('[aria-label="Body presentation"]').element.style.display = 'none';
  const menu = await openMore(body);
  const choices = menu.findAll('[role="menuitemradio"]');
  expect(choices.map(choice => choice.attributes('aria-checked'))).toEqual(['true', 'false']);
  await choices[1]!.trigger('click');
  expect(editorView(body.element).state.doc.toString()).toBe(original);
  expect(body.emitted('update:modelValue')).toBeUndefined();
  expect(body.emitted('update:presentation')).toEqual([['raw']]);
});

it("dismisses More with Escape, outside interaction, and focus leaving the menu", async () => {
  const body = renderBody('{"value":"text"}');
  const trigger = body.get('[aria-label="More body actions"]');
  let menu = await openMore(body);
  await menu.trigger('keydown', { key: 'Escape' });
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger.element);

  menu = await openMore(body);
  await body.get('.body-heading').trigger('pointerdown');
  expect(document.getElementById(menu.attributes('id'))).toBeNull();
  expect(trigger.attributes('aria-expanded')).toBe('false');

  await openMore(body);
  button(body, 'Find').element.focus();
  await nextTick();
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(button(body, 'Find').element);
});

it("keeps keyboard focus on the presentation control after changing the response view", async () => {
  const body = renderBody('{"value":"text"}', true);
  const raw = button(body, "Raw");
  raw.element.focus();
  await raw.trigger("click");
  expect(editorView(body.element).state.doc.toString()).toBe('{"value":"text"}');
  expect(document.activeElement).toBe(raw.element);

  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => element.hasAttribute("data-body-action")
    ? { display: "none" } as CSSStyleDeclaration : getStyle(element));
  const menu = await openMore(body);
  const pretty = menu.findAll("button").find(action => action.text() === "Pretty")!;
  pretty.element.focus();
  await pretty.trigger("click");
  expect(editorView(body.element).state.doc.toString()).toBe('{\n  "value": "text"\n}');
  expect(document.activeElement).toBe(body.get('[aria-label="More body actions"]').element);
});

it("positions More within the viewport and keeps scrolling its own actions usable", async () => {
  vi.stubGlobal('innerWidth', 640);
  vi.stubGlobal('innerHeight', 400);
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.getAttribute('aria-label') === 'More body actions') return new DOMRect(600, 370, 28, 22);
    if (this.getAttribute('role') === 'menu') return new DOMRect(0, 0, 180, 148);
    return bounds.call(this);
  });
  const body = renderBody('{"value":"text"}');
  const menu = await openMore(body);
  const left = Number.parseFloat(menu.element.style.left);
  const top = Number.parseFloat(menu.element.style.top);
  expect(left).toBeGreaterThanOrEqual(0);
  expect(left + 180).toBeLessThanOrEqual(window.innerWidth);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top + 148).toBeLessThanOrEqual(370);
  await menu.trigger('scroll');
  expect(body.get('[aria-label="More body actions"]').attributes('aria-expanded')).toBe('true');
  window.dispatchEvent(new Event('resize'));
  await nextTick();
  expect(body.get('[aria-label="More body actions"]').attributes('aria-expanded')).toBe('false');
});

it("offers wrapping for plain text and preserves it when the menu closes", async () => {
  const body = renderBody('plain body');
  await body.setProps({ contentType: 'text/plain' });
  const menu = await openMore(body);
  expect(menu.findAll('button').map(button => button.text())).toEqual(['Wrap lines']);
  await menu.get('button').trigger('click');
  expect(body.find('.cm-lineNumbers').exists()).toBe(false);
  expect((await openMore(body)).get('[role="menuitemcheckbox"]').attributes('aria-checked')).toBe('true');
  expect(body.emitted('update:modelValue')).toBeUndefined();
});

it("shows action feedback only when there is a message to announce", async () => {
  const body = renderBody('invalid JSON');
  expect(body.get('[role="status"]').text()).toBe('');
  await button(body, 'Format JSON').trigger('click');
  expect(body.get('[role="status"]').isVisible()).toBe(true);
  expect(body.get('[role="status"]').text()).toBe('Cannot format invalid JSON. Your text is unchanged.');
  expect(body.emitted('update:modelValue')).toBeUndefined();
  await body.setProps({ modelValue: '{"valid":true}' });
  expect(body.get('[role="status"]').text()).toBe('');
});

type BodyWrapper = ReturnType<typeof mount<typeof BodyText>>;
const mounted: BodyWrapper[] = [];
function renderBody(modelValue: string, readonly = false) {
  const body = mount(BodyText, { attachTo: document.body,
    props: { modelValue, readonly, contentType: 'application/json', label: 'Body' } });
  mounted.push(body);
  return body;
}
function button(body: BodyWrapper, label: string) {
  return body.findAll('button').find(button => button.text() === label)!;
}
async function openMore(body: BodyWrapper) {
  const trigger = body.get('[aria-label="More body actions"]');
  await trigger.trigger('click');
  return new DOMWrapper(document.getElementById(trigger.attributes('aria-controls'))!);
}
async function moreAction(body: BodyWrapper, label: string) {
  const menu = await openMore(body);
  await menu.findAll('button').find(button => button.text() === label)!.trigger('click');
}
async function controlledBody(modelValue: string) {
  const body = renderBody(modelValue);
  await body.setProps({ 'onUpdate:modelValue': value => { void body.setProps({ modelValue: value }); } });
  return body;
}
