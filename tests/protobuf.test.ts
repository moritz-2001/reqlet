// Exercises protobuf completion and portable configuration through their public contracts.
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { json } from '../src/components/jsonLanguage';
import { acceptCompletion, CompletionContext, completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import BodyText from '../src/components/BodyText.vue';
import { editorView, press } from './editor';
import { completeProtobuf } from '../src/components/protobufCompletion';
import { createRequest } from '../src/request';
import { prepareRequest } from '../src/prepareRequest';
import { importCollection, serializeCollection } from '../src/interchange';
import type { ProtobufContext, ProtoField } from '../src/protobuf';

describe('protobuf JSON completion', () => {
  it('offers canonical names in incomplete JSON and suppresses original aliases', () => {
    expect(complete('{|')?.options.map(o => o.label)).toContain('firstName');
    expect(complete('{"fir|}')?.options.map(o => o.label)).toContain('firstName');
    expect(complete('{"first_name":"x", |}')?.options.map(o => o.label)).not.toContain('firstName');
  });
  it('traverses nested, repeated and map message values', () => {
    for (const text of ['{"child": {|}}', '{"items":[{|}]}', '{"lookup":{"key":{|}}}']) {
      expect(complete(text)?.options.map(o => o.label)).toEqual(['enabled']);
    }
    expect(complete('{"lookup":{|}}')).toBeNull();
  });
  it('completes enum values and avoids environment placeholders', () => {
    expect(complete('{"role":"A|"}')?.options.map(o => o.label)).toEqual(['ADMIN', 'USER']);
    expect(complete('{"firstName":"{{na|"}')).toBeNull();
    expect(complete('{"firstName":"{{name", "child": {|}}')?.options.map(o => o.label)).toEqual(['enabled']);
  });
  it('waits until the caret has passed the property separator before completing values', () => {
    expect(complete('{"role" |: "ADMIN"}')).toBeNull();
  });
  it('ignores comments while completing fields and values in JSON with trailing commas', () => {
    expect(complete('{// firstName\n|}')?.options.map(option => option.label)).toContain('firstName');
    expect(complete('{/* firstName */|}')?.options.map(option => option.label)).toContain('firstName');
    expect(complete('{/* {{ environment syntax in prose */|}')?.options.map(option => option.label)).toContain('firstName');
    expect(complete('{"child": {/* note */ "enabled": t|,},}')?.options.map(option => option.label)).toEqual(['true', 'false']);
    expect(complete('{// fi|rstName\n}')).toBeNull();
    expect(complete('{// firstName|\n}')).toBeNull();
    expect(complete('{/* fi|rstName */}')).toBeNull();
    expect(complete('{/* firstName|')).toBeNull();
  });
  it('preserves JSON transport and relinks portable model bindings', () => {
    const request = { ...createRequest(), protobuf: { sourceId: 'models', messageName: 'Request' } };
    expect(prepareRequest(request)).toEqual(prepareRequest(createRequest()));
    const text = serializeCollection({ r: request }, [{ kind: 'request', id: 'r', name: request.name, requestType: 'GET' }], [{ id: 'models', name: 'Models', rootPath: '/private/models', includePaths: ['/private/deps'] }]);
    expect(text).not.toContain('/private');
    const imported = importCollection(text);
    expect(imported.protobufSources?.[0]?.rootPath).toBeNull();
    expect(Object.values(imported.requests)[0]?.protobuf?.sourceId).toBe(imported.protobufSources?.[0]?.id);
  });
});

it('accepts completion as an undoable edit and reconfigures without replacing the editor', async () => {
  const body = mount(BodyText, { props: { modelValue: '{}', label: 'Request', contentType: 'application/json', protobufContext: model }, attachTo: document.body });
  try {
    const view = editorView(body.element);
    view.dispatch({ selection: { anchor: 1 } });
    await showCompletion(view);
    expect(acceptCompletion(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('{"child": {}}');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('{}');
    await body.setProps({ protobufContext: { ...model } });
    await nextTick();
    expect(editorView(body.element)).toBe(view);
  } finally { body.unmount(); }
});

it('opens suggestions automatically while typing an incomplete field name', async () => {
  const body = mount(BodyText, { props: { modelValue: '{"fi}', label: 'Request', contentType: 'application/json', protobufContext: model }, attachTo: document.body });
  try {
    const view = editorView(body.element);
    view.focus();
    view.dispatch({ changes: { from: 4, insert: 'r' }, selection: { anchor: 5 }, userEvent: 'input.type' });
    await vi.waitFor(() => expect(currentCompletions(view.state).map(option => option.label)).toContain('firstName'));
    await new Promise(resolve => setTimeout(resolve, 100));
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('{"firstName": ""}');
  } finally { body.unmount(); }
});

it('opens suggestions through the installed Ctrl+Space keymap', async () => {
  const body = mount(BodyText, { props: { modelValue: '{}', label: 'Request', contentType: 'application/json', protobufContext: model }, attachTo: document.body });
  try {
    const view = editorView(body.element);
    view.dispatch({ selection: { anchor: 1 } });
    expect(press(view, ' ', { ctrlKey: true, code: 'Space' }).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(currentCompletions(view.state).map(option => option.label)).toContain('firstName'));
  } finally { body.unmount(); }
});

it.each([
  ['{"role":"A|"}', '{"role":"ADMIN"}', 'ADMIN'],
  ['{"role":"|"}', '{"role":"ADMIN"}', 'ADMIN'],
  ['{"role":"U|SER"}', '{"role":"USER"}', 'USER'],
  ['{"role":|}', '{"role":"ADMIN"}', 'ADMIN'],
  ['{"role": |"ADMIN"}', '{"role": "ADMIN"}', 'ADMIN'],
  ['{"child":{"enabled":tr|ue}}', '{"child":{"enabled":true}}', 'true'],
  ['{"roles":["A|"]}', '{"roles":["ADMIN"]}', 'ADMIN'],
  ['{"roles":[|]}', '{"roles":["ADMIN"]}', 'ADMIN'],
  ['{"roles":["ADMIN","U|SER"]}', '{"roles":["ADMIN","USER"]}', 'USER'],
  ['{"flags":[tr|ue]}', '{"flags":[true]}', 'true'],
  ['{"flags":[|]}', '{"flags":[false]}', 'false'],
  ['{"roleLookup":{"owner":"A|"}}', '{"roleLookup":{"owner":"ADMIN"}}', 'ADMIN'],
  ['{"flagLookup":{"active":tr|ue}}', '{"flagLookup":{"active":true}}', 'true'],
  ['{"first|Name":"x"}', '{"firstName":"x"}', 'firstName'],
])('accepts visible completion inside %s without duplicating surrounding text', async (input, expected, label) => {
  const text = input.replace('|', '');
  const wrapper = mount(BodyText, { props: { modelValue: text, label: 'Request', contentType: 'application/json', protobufContext: model }, attachTo: document.body });
  try {
    const view = editorView(wrapper.element);
    view.dispatch({ selection: { anchor: input.indexOf('|') } });
    await showCompletion(view);
    expect(currentCompletions(view.state).map(option => option.label)).toContain(label);
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe(expected);
    expect(JSON.parse(view.state.doc.toString())).toEqual(JSON.parse(expected));
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(text);
  } finally { wrapper.unmount(); }
});

it('retains the current oneof field while excluding populated siblings', () => {
  const context = { messageName: 'Choice', catalog: { messages: { Choice: [field('first', 'string', { oneof: 'choice' }), field('second', 'string', { oneof: 'choice' })] }, enums: {} } };
  const state = EditorState.create({ doc: '{"first":"x"}', extensions: [json()] });
  expect(completeProtobuf(new CompletionContext(state, 4, true), context)?.options.map(option => option.label)).toContain('first');
});

it('keeps oneof alternatives available when null is followed by a comment', () => {
  const context = { messageName: 'Choice', catalog: { messages: { Choice: [field('first', 'string', { oneof: 'choice' }), field('second', 'string', { oneof: 'choice' })] }, enums: {} } };
  const text = '{"first": null /* unset */, }';
  const state = EditorState.create({ doc: text, extensions: [json()] });
  expect(completeProtobuf(new CompletionContext(state, text.indexOf('}'), true), context)?.options.map(option => option.label))
    .toContain('second');
});

const field = (name: string, type = 'string', extra = {}): ProtoField => ({ name, jsonName: name, type, repeated: false, documentation: '', ...extra });
const model: ProtobufContext = { messageName: 'Request', catalog: { messages: {
  Request: [
    field('first_name', 'string', { jsonName: 'firstName' }), field('child', 'Child'),
    field('items', 'Child', { repeated: true }), field('lookup', 'Entry', { mapValue: 'Child' }),
    field('role', 'Role'), field('roles', 'Role', { repeated: true }), field('flags', 'bool', { repeated: true }),
    field('roleLookup', 'RoleEntry', { mapValue: 'Role' }), field('flagLookup', 'FlagEntry', { mapValue: 'bool' }),
  ],
  Child: [field('enabled', 'bool')],
}, enums: { Role: ['ADMIN', 'USER'] } } };

function complete(text: string) {
  const pos = text.indexOf('|');
  const state = EditorState.create({ doc: text.replace('|', ''), extensions: [json()] });
  return completeProtobuf(new CompletionContext(state, pos, true), model);
}

async function showCompletion(view: EditorView) {
  view.focus();
  startCompletion(view);
  await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'));
  // CodeMirror intentionally ignores acceptance keys for 75 ms after the popup opens.
  await new Promise(resolve => setTimeout(resolve, 100));
}
