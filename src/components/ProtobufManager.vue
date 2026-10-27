<!-- ProtobufManager edits shared source configuration in a focus-managed dialog; App owns loading. -->
<script setup lang="ts">
import { open as browse } from '@tauri-apps/plugin-dialog';
import { nextTick, onBeforeUnmount, ref, useId } from 'vue';
import type { ProtobufSource, ProtobufSourceState } from '../protobuf';
const props = defineProps<{
  /** Workspace-owned configurations; updates replace the complete list. */
  sources: readonly ProtobufSource[];
  /** Shared loading results; prior catalogs may survive failed reloads. */
  states: Record<string, ProtobufSourceState>;
  /** Number of saved and draft bindings for each source; omitted hides usage counts. */
  usage?: Record<string, number>;
  /** Allows a shared workspace menu to open this manager without a duplicate header button. */
  hideTrigger?: boolean;
}>();
const emit = defineEmits<{ 'update:sources': [sources: ProtobufSource[]]; reload: [id: string] }>();
const id = useId();
const dialog = ref<HTMLDialogElement>();
const addButton = ref<HTMLButtonElement>();
const error = ref('');
// One recoverable removal preserves identity and position; later removals replace this snapshot.
const removed = ref<{ source: ProtobufSource; index: number }>();
let opener: HTMLElement | undefined;
async function open() {
  if (dialog.value?.open) return;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  dialog.value?.showModal();
  await nextTick();
  addButton.value?.focus();
}
function close() {
  dialog.value?.close();
  if (opener?.isConnected) opener.focus();
}
defineExpose({ open });
onBeforeUnmount(close);
async function choose(source?: ProtobufSource, dependencyIndex?: number) {
  try {
    const path = await browse({ directory: true, multiple: false });
    if (!path) return;
    if (source && dependencyIndex !== undefined) {
      const paths = [...source.includePaths];
      paths[dependencyIndex] = path;
      update(source, { includePaths: [...new Set(paths)] });
    } else {
      const next = source ? { ...source, rootPath: path } : { id: crypto.randomUUID(), name: path.split(/[\\/]/).pop() || 'Protobuf', rootPath: path, includePaths: [] };
      emit('update:sources', source ? props.sources.map(s => s.id === source.id ? next : s) : [...props.sources, next]);
    }
    error.value = '';
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
function update(source: ProtobufSource, changes: Partial<ProtobufSource>) {
  emit('update:sources', props.sources.map(s => s.id === source.id ? { ...source, ...changes } : s));
}
function remove(source: ProtobufSource) {
  removed.value = { source: { ...source, includePaths: [...source.includePaths] }, index: props.sources.findIndex(s => s.id === source.id) };
  emit('update:sources', props.sources.filter(s => s.id !== source.id));
}
function undo() {
  if (!removed.value) return;
  const sources = [...props.sources];
  if (!sources.some(source => source.id === removed.value!.source.id)) sources.splice(removed.value.index, 0, removed.value.source);
  emit('update:sources', sources);
  removed.value = undefined;
}
function status(source: ProtobufSource) {
  const state = props.states[source.id];
  if (!source.rootPath) return 'Needs relinking';
  if (state?.loading) return state.catalog ? 'Reloading · using previous models' : 'Loading…';
  if (state?.error) return state.catalog ? 'Using previous models · reload failed' : 'Failed to load';
  if (state?.catalog?.loadDiagnostics?.length) return `Partially loaded · ${Object.keys(state.catalog.messages).length} messages`;
  return state?.catalog ? `Ready · ${Object.keys(state.catalog.messages).length} messages` : 'Not loaded';
}
</script>
<template>
  <button v-if="!hideTrigger" type="button" class="ui-button protobuf-trigger" @click="open">Protobuf models</button>
  <dialog ref="dialog" class="protobuf-manager" :aria-labelledby="`${id}-heading`" @cancel.prevent="close" @keydown.esc.stop.prevent="close" @click.self="close">
    <header><h2 :id="`${id}-heading`">Protobuf models</h2><button class="ui-button" type="button" aria-label="Close protobuf models" @click="close">Close</button></header>
    <button class="ui-button" ref="addButton" type="button" @click="choose()">Add protobuf folder</button>
    <p v-if="!sources.length">Add a local folder containing .proto files, then select a message in a request’s Body panel.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="removed" role="status">Removed {{ removed.source.name }}. Request selections are preserved. <button class="ui-button" type="button" @click="undo">Undo removal</button></p>
    <section v-for="source in sources" :key="source.id" :aria-label="source.name">
      <h3>{{ source.name }}</h3>
      <label>Source name<input class="ui-input" :aria-label="`Name for ${source.name}`" :value="source.name" @change="update(source, { name: ($event.target as HTMLInputElement).value.trim() || source.name })"></label>
      <p v-if="usage">Used by {{ usage[source.id] ?? 0 }} request(s).</p>
      <p role="status">{{ status(source) }}</p>
      <p class="path">{{ source.rootPath ?? 'Choose the local folder to restore this imported source.' }}</p>
      <div class="actions">
        <button class="ui-button" type="button" :aria-label="`Relink ${source.name}`" @click="choose(source)">Relink</button>
        <button class="ui-button" type="button" :aria-label="`Reload ${source.name}`" :disabled="!source.rootPath || states[source.id]?.loading" @click="emit('reload', source.id)">Reload</button>
        <button class="ui-button" type="button" :aria-label="`Remove ${source.name}`" @click="remove(source)">Remove</button>
      </div>
      <details>
        <summary>Import directories ({{ source.includePaths.length }})</summary>
        <p>Dependencies outside the project folder. Choose absolute local directories.</p>
        <div v-for="(path, index) in source.includePaths" :key="index" class="dependency">
          <span class="path">{{ path }}</span>
          <button class="ui-button" type="button" :aria-label="`Browse import directory ${index + 1} for ${source.name}`" @click="choose(source, index)">Browse</button>
          <button class="ui-button" type="button" :aria-label="`Remove import directory ${index + 1} from ${source.name}`" @click="update(source, { includePaths: source.includePaths.filter((_, i) => i !== index) })">Remove</button>
          <span v-if="states[source.id]?.error?.includes(path)" role="alert">Cannot load this directory. Browse to an accessible folder.</span>
        </div>
        <button class="ui-button" type="button" :aria-label="`Add import directory to ${source.name}`" @click="choose(source, source.includePaths.length)">Add import directory</button>
      </details>
      <details v-if="states[source.id]?.error"><summary>Load diagnostics</summary><pre>{{ states[source.id]?.error }}</pre><p>Check the project folder and import directories, then Reload.</p></details>
      <details v-if="states[source.id]?.catalog?.loadDiagnostics?.length"><summary>Files that could not be loaded ({{ states[source.id]?.catalog?.loadDiagnostics?.length }})</summary><pre v-for="diagnostic in states[source.id]?.catalog?.loadDiagnostics" :key="diagnostic">{{ diagnostic }}</pre><p>Fix the affected files or import directories, then Reload. Other messages remain available.</p></details>
    </section>
  </dialog>
</template>
<style scoped>
.protobuf-manager { width: min(560px, calc(100vw - 48px)); max-height: calc(100vh - 64px); box-sizing: border-box; overflow: auto; background: #141b26; color: var(--color-text); border: 1px solid #3b4860; border-radius: 10px; padding: 18px; font: inherit; }
.protobuf-manager::backdrop { background: #0008; }
header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
h2 { font-size: 18px; } h3 { font-size: 15px; }
section { border-top: 1px solid #3b4860; margin-top: 14px; padding-top: 4px; }

summary:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }
.protobuf-trigger { white-space: nowrap; }
label { display: grid; gap: 4px; } .actions, .dependency { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0; }
.path { overflow-wrap: anywhere; min-width: 0; flex: 1; } details { margin-top: 10px; } summary { cursor: pointer; } pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
</style>
