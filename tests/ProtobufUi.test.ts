// Exercises source recovery, keyboard selection, and assistance feedback through public component contracts.
import { mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import ProtobufManager from '../src/components/ProtobufManager.vue';
import ProtobufBindingPicker from '../src/components/ProtobufBindingPicker.vue';
import { resolveProtobufAssistance, type ProtobufSource } from '../src/protobuf';
import { open } from '@tauri-apps/plugin-dialog';
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); document.body.replaceChildren(); });

it('moves focus into management and restores the opener on Escape', async () => {
  const wrapper = mount(ProtobufManager, { props: { sources: [], states: {} }, attachTo: document.body });
  try {
    const trigger = wrapper.get('button');
    (trigger.element as HTMLElement).focus();
    await trigger.trigger('click');
    expect(wrapper.get('dialog').element.open).toBe(true);
    expect(document.activeElement?.textContent).toBe('Add protobuf folder');
    await wrapper.get('dialog').trigger('keydown', { key: 'Escape' });
    expect(wrapper.get('dialog').element.open).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
  } finally { wrapper.unmount(); }
});

it('restores the removed identity and directory configuration with Undo', async () => {
  const wrapper = mount(ProtobufManager, { props: { sources: [source], states: {}, usage: { models: 3 } } });
  try {
    await wrapper.get('[aria-label="Remove Models"]').trigger('click');
    expect(wrapper.emitted('update:sources')?.[0]).toEqual([[]]);
    await wrapper.setProps({ sources: [] });
    await wrapper.findAll('button').find(button => button.text() === 'Undo removal')!.trigger('click');
    expect(wrapper.emitted('update:sources')?.[1]).toEqual([[source]]);
  } finally { wrapper.unmount(); }
});

it('browses dependencies without adding duplicate directories and reports picker failures', async () => {
  const wrapper = mount(ProtobufManager, { props: { sources: [source], states: {} } });
  try {
    vi.mocked(open).mockResolvedValue('/deps');
    await wrapper.get('[aria-label="Add import directory to Models"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.emitted('update:sources')?.[0]).toEqual([[source]]));
    vi.mocked(open).mockRejectedValue(new Error('Folder access denied'));
    await wrapper.get('[aria-label="Relink Models"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain('Folder access denied'));
  } finally { wrapper.unmount(); }
});

it('searches package and file names without persisting query text, then commits with Enter', async () => {
  const wrapper = mount(ProtobufBindingPicker, { props: { modelValue: binding, sources: [source], states } });
  try {
    const input = wrapper.get('[role="combobox"]');
    await input.trigger('focus');
    await input.setValue('users.proto');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(wrapper.get('[role="option"]').text()).toContain('demo.users');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([binding]);
    await input.setValue('nothing');
    expect(wrapper.get('[role="status"]').text()).toContain('No messages match');
    await input.trigger('keydown', { key: 'Escape' });
    expect(input.attributes('aria-expanded')).toBe('false');
  } finally { wrapper.unmount(); }
});

it('distinguishes ready, inactive, stale, missing-message and relink states', () => {
  const resolve = (mime = 'application/json') => resolveProtobufAssistance(binding, [source], states, mime);
  expect(resolve().status).toContain('Ready');
  expect(resolve('text/plain').context).toBeUndefined();
  expect(resolve('text/plain').status).toContain('Inactive');
  expect(resolve('application/problem+json').context).toBeDefined();
  expect(resolveProtobufAssistance(binding, [{ ...source, rootPath: null }], {}, 'application/json').status).toContain('relinking');
  expect(resolveProtobufAssistance({ ...binding, messageName: 'missing' }, [source], states, 'application/json').status).toContain('Message unavailable');
  expect(resolveProtobufAssistance(binding, [source], { models: { ...states.models, error: 'Failed' } }, 'application/json').status).toContain('previous models');
});

const source: ProtobufSource = { id: 'models', name: 'Models', rootPath: '/models', includePaths: ['/deps'] };
const binding = { sourceId: 'models', messageName: 'demo.users.Request' };
const states = { models: { loading: false, catalog: { messages: { 'demo.users.Request': [] }, enums: {}, messageFiles: { 'demo.users.Request': 'users.proto' } } } };
