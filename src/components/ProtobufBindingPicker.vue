<!-- ProtobufBindingPicker owns only search/focus; committed bindings remain parent-owned. -->
<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import type { ProtobufMessageBinding, ProtobufSource, ProtobufSourceState } from '../protobuf';
const props = defineProps<{
  /** Committed selection; absence disables assistance. */
  modelValue?: ProtobufMessageBinding;
  /** Workspace-owned source configurations. */
  sources: readonly ProtobufSource[];
  /** Shared runtime catalogs, indexed by source identity. */
  states: Record<string, ProtobufSourceState>;
}>();
const emit = defineEmits<{
  /** Commits a source or message choice, never intermediate search text. */
  'update:modelValue': [value: ProtobufMessageBinding | undefined];
}>();
const id = useId();
const query = ref('');
const expanded = ref(false);
const active = ref(0);
const catalog = computed(() => props.states[props.modelValue?.sourceId ?? '']?.catalog);
const results = computed(() => Object.keys(catalog.value?.messages ?? {}).sort().filter(name => {
  const text = `${name} ${catalog.value?.messageFiles?.[name] ?? ''}`.toLowerCase();
  return query.value.toLowerCase().split(/\s+/).every(word => text.includes(word));
}));
watch(query, () => { active.value = 0; });
watch(() => [props.modelValue?.sourceId, props.modelValue?.messageName], () => { query.value = ''; expanded.value = false; });
function select(name: string) {
  if (props.modelValue) emit('update:modelValue', { ...props.modelValue, messageName: name });
  expanded.value = false;
}
function navigate(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    expanded.value = false;
    event.preventDefault();
    event.stopPropagation();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    expanded.value = true;
    active.value = results.value.length ? (active.value + (event.key === 'ArrowDown' ? 1 : -1) + results.value.length) % results.value.length : 0;
    event.preventDefault();
    document.getElementById(`${id}-${active.value}`)?.scrollIntoView?.({ block: 'nearest' });
  } else if (event.key === 'Enter' && expanded.value) {
    if (results.value[active.value]) select(results.value[active.value]!);
    event.preventDefault();
    event.stopPropagation();
  }
}
</script>
<template>
  <div class="binding-picker">
    <label>Protobuf source
      <select class="ui-input" :value="modelValue?.sourceId ?? ''" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value ? { sourceId: ($event.target as HTMLSelectElement).value, messageName: '' } : undefined)">
        <option value="">None</option>
        <option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option>
        <option v-if="modelValue && !sources.some(source => source.id === modelValue?.sourceId)" :value="modelValue.sourceId">Unavailable protobuf source</option>
      </select>
    </label>
    <template v-if="modelValue">
      <label :for="`${id}-search`">Protobuf message</label>
      <input class="ui-input" :id="`${id}-search`" v-model="query" role="combobox" aria-autocomplete="list" :aria-expanded="expanded" :aria-controls="`${id}-results`" :aria-activedescendant="expanded && results.length ? `${id}-${active}` : undefined" :placeholder="modelValue.messageName || 'Search messages or files…'" autocomplete="off" @focus="expanded = true" @input="expanded = true" @blur="expanded = false" @keydown="navigate">
      <ul v-if="expanded" :id="`${id}-results`" role="listbox" aria-label="Protobuf messages">
        <li v-for="(name, index) in results" :id="`${id}-${index}`" :key="name" role="option" :aria-selected="index === active" @mousedown.prevent @click="select(name)">
          <strong>{{ name.split('.').pop() }}</strong>
          <small>{{ name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : 'No package' }} · {{ catalog?.messageFiles?.[name] ?? 'Source file unavailable' }}</small>
        </li>
        <li v-if="!results.length" role="status">No messages match. Check the source or try another search.</li>
      </ul>
    </template>
  </div>
</template>
<style scoped>
.binding-picker { display: grid; gap: 6px; padding: 8px 0; min-width: 0; }
select, input { width: 100%; }
ul { max-height: 180px; overflow: auto; margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-control-border); }
li { padding: 6px; cursor: pointer; overflow-wrap: anywhere; }
li[aria-selected="true"] { background: #22314a; }
small { display: block; color: #aab8cc; }
</style>
