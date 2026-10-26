<!-- KeyValueEditor edits ordered parent-owned rows and hands keyboard focus to accepted additions/removals. -->
<script setup lang="ts">
import { shallowRef, toRaw, useTemplateRef, watch } from "vue";
import type { Environment, KeyValueEntry, RequestInputMode } from "../request";
import { previewRequestField } from "../prepareRequest";
import VariableInput from "./VariableInput.vue";
import VirtualRows from "./VirtualRows.vue";

const props = defineProps<{
  /** Ordered rows owned by the parent; disabled and duplicate rows remain in place. */
  modelValue: readonly KeyValueEntry[];
  /** Visible heading for this group of editable rows. */
  label: string;
  /** Singular accessible description, such as header or query parameter. */
  entryLabel: string;
  /** Enables request placeholder assistance; absent for plain environment-variable definitions. */
  resolveVariables?: boolean;
  /** Active request scope; omitted resolves only literal values. */
  environment?: Environment;
  /** Captured history and disabled rows remain literal until normal request editing resumes. */
  captured?: boolean;
  /** Literal definitions validate syntax without resolving environment placeholders. */
  inputMode?: RequestInputMode;
  /** Header rows additionally enforce the transport's header-name and value rules. */
  headers?: boolean;
  /** Resolved name replaced by authentication; its saved value still resolves but is never sent. */
  replacedHeader?: string;
}>();

const emit = defineEmits<{
  /** Complete replacement after adding, editing, toggling, or removing a row. */
  "update:modelValue": [entries: KeyValueEntry[]];
  /** Opens the selected request environment for a field-local variable issue. */
  "edit-environment": [];
}>();

const editor = useTemplateRef<HTMLElement>("editor");
const addButton = useTemplateRef<HTMLButtonElement>("addButton");
const rows = useTemplateRef<{ reveal(index: number): Promise<void> | undefined }>("rows");
// Unchanged record identities retain their inputs through insertions/removals. A newly edited
// record keeps the vacant key at its previous position, preserving selection while typing.
const rowKeys = shallowRef<readonly number[]>(props.modelValue.map((_, index) => index));
let nextRowKey = props.modelValue.length;
watch(() => props.modelValue, (entries, previous) => {
  const available = new Map<KeyValueEntry, number[]>();
  previous.forEach((entry, index) => {
    const raw = toRaw(entry);
    const keys = available.get(raw);
    if (keys) keys.push(rowKeys.value[index]!);
    else available.set(raw, [rowKeys.value[index]!]);
  });
  const next = entries.map(entry => available.get(toRaw(entry))?.shift());
  const used = new Set(next.filter(key => key !== undefined));
  rowKeys.value = next.map((key, index) => {
    if (key !== undefined) return key;

    const previousKey = rowKeys.value[index];
    if (previousKey !== undefined && !used.has(previousKey)) {
      used.add(previousKey);
      return previousKey;
    }
    return nextRowKey++;
  });
}, { flush: "sync" });
// Focus belongs to an emitted replacement, never a coincidentally similar row at the same index.
// The first parent update consumes it; moving focus elsewhere cancels the eventual handoff.
let pendingFocus: {
  entries: readonly KeyValueEntry[];
  index: number | undefined;
  origin: Element | null;
} | undefined;

watch(() => props.modelValue, async entries => {
  const intent = pendingFocus;
  pendingFocus = undefined;
  if (!intent || !acceptedRows(entries, intent.entries)) return;

  const document = editor.value?.ownerDocument;
  const active = document?.activeElement;
  const removedOrigin = intent.origin && !intent.origin.isConnected && active === document?.body;
  if (active !== intent.origin && !removedOrigin) return;

  if (intent.index !== undefined) await rows.value?.reveal(intent.index);
  if (document?.activeElement !== active && document?.activeElement !== document?.body) return;

  const input = intent.index === undefined ? addButton.value : rowNameInput(intent.index);
  input?.focus({ preventScroll: true });
  input?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}, { flush: "post" });

defineExpose({ revealInvalid });

/** Only offscreen validation requires deferred work; mounted fields retain native synchronous validation. */
function revealInvalid(): Promise<HTMLInputElement | undefined> | undefined {
  if (!props.resolveVariables || props.captured || props.modelValue.length <= 80) return;

  for (let index = 0; index < props.modelValue.length; index++) {
    const entry = props.modelValue[index]!;
    if (!entry.enabled) continue;

    const invalidName = previewRequestField(entry.name, props.headers ? "header-name" : "text", props.environment, props.inputMode).error;
    const invalidValue = previewRequestField(entry.value, valueKind(entry), props.environment, props.inputMode).error;
    if (!invalidName && !invalidValue) continue;

    if (rowElement(index)) return;

    return rows.value?.reveal(index)?.then(() =>
      rowElement(index)?.querySelectorAll<HTMLInputElement>(".variable-input input")[invalidName ? 0 : 1]);
  }
}

function updateRow(index: number, changes: Partial<KeyValueEntry>) {
  emit("update:modelValue", props.modelValue.map((entry, row) => row === index ? { ...entry, ...changes } : entry));
}

function addRow() {
  const entries = [...props.modelValue, { name: "", value: "", enabled: true }];
  pendingFocus = { entries, index: entries.length - 1, origin: editor.value?.ownerDocument.activeElement ?? null };
  emit("update:modelValue", entries);
}

function removeRow(index: number) {
  const entries = props.modelValue.filter((_, row) => row !== index);
  const origin = editor.value?.ownerDocument.activeElement ?? null;
  const row = rowElement(index);
  pendingFocus = row?.contains(origin) ? {
    entries,
    index: entries.length ? Math.min(index, entries.length - 1) : undefined,
    origin,
  } : undefined;
  emit("update:modelValue", entries);
}

function acceptedRows(actual: readonly KeyValueEntry[], expected: readonly KeyValueEntry[]) {
  return actual.length === expected.length && actual.every((entry, index) => toRaw(entry) === toRaw(expected[index]));
}

function rowNameInput(index: number) {
  return rowElement(index)?.querySelector<HTMLInputElement>(".variable-input input");
}

function rowElement(index: number) {
  return editor.value?.querySelector<HTMLElement>(`[data-entry-index="${index}"]`);
}

function rowKey(_entry: KeyValueEntry, index: number) {
  return rowKeys.value[index]!;
}

async function handleRowKeydown(event: KeyboardEvent, index: number) {
  if (props.modelValue.length <= 80 || event.key !== "Tab" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;

  const controls = rowElement(index)?.querySelectorAll<HTMLElement>('input, button');
  if (!controls?.length) return;
  if (event.target !== controls[event.shiftKey ? 0 : controls.length - 1]) return;

  const targetIndex = index + (event.shiftKey ? -1 : 1);
  if (targetIndex < 0 || targetIndex >= props.modelValue.length) return;

  event.preventDefault();
  await rows.value?.reveal(targetIndex);
  const targets = rowElement(targetIndex)?.querySelectorAll<HTMLElement>('input, button');
  targets?.[event.shiftKey ? targets.length - 1 : 0]?.focus({ preventScroll: true });
}

function valueKind(entry: KeyValueEntry) {
  if (!props.headers) return "text";
  if (props.replacedHeader) {
    const resolvedName = previewRequestField(entry.name, "text", props.environment, props.inputMode).value;
    if (resolvedName?.toLowerCase() === props.replacedHeader.toLowerCase()) return "text";
  }
  return "header-value";
}
</script>

<template>
  <section ref="editor" class="key-value-editor" :aria-label="label">
    <div class="row-heading">
      <h3>{{ label }}</h3>
      <button ref="addButton" class="ui-button" type="button" @click="addRow">Add {{ entryLabel }}</button>
    </div>
    <p v-if="modelValue.length === 0" class="empty-rows">No {{ label.toLowerCase() }}.</p>
    <VirtualRows ref="rows" :items="modelValue" :row-key="rowKey" :estimated-height="46" :max-height="360">
      <template #default="{ index, item: entry }">
        <div class="entry-row" :data-entry-index="index"
          :class="{ disabled: !entry.enabled }" role="group" :aria-label="`${entryLabel} ${index + 1} of ${modelValue.length}`"
          @keydown="handleRowKeydown($event, index)">
          <input
            type="checkbox"
            :checked="entry.enabled"
            :aria-label="`Enable ${entryLabel} ${index + 1}`"
            @change="updateRow(index, { enabled: ($event.target as HTMLInputElement).checked })"
          />
          <VariableInput
            :model-value="entry.name"
            :environment="environment"
            :literal="!resolveVariables || captured || !entry.enabled"
            :input-mode="inputMode"
            :kind="headers ? 'header-name' : 'text'"
            :aria-label="`${entryLabel} ${index + 1} name`"
            placeholder="Name"
            @update:model-value="updateRow(index, { name: $event })"
            @edit-environment="emit('edit-environment')"
          />
          <VariableInput
            :model-value="entry.value"
            :environment="environment"
            :literal="!resolveVariables || captured || !entry.enabled"
            :input-mode="inputMode"
            :kind="valueKind(entry)"
            :aria-label="`${entryLabel} ${index + 1} value`"
            placeholder="Value"
            @update:model-value="updateRow(index, { value: $event })"
            @edit-environment="emit('edit-environment')"
          />
          <button class="ui-button" type="button" :aria-label="`Remove ${entryLabel} ${index + 1}`" @click="removeRow(index)">Remove</button>
        </div>
      </template>
    </VirtualRows>
  </section>
</template>

<style scoped>
.key-value-editor {
  min-width: 0;
}

.row-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

h3 {
  margin: 0;
  color: #b2bfd1;
  font-size: 12px;
  font-weight: 600;
}

.empty-rows {
  margin: 8px 0 0;
  color: var(--color-muted);
  font-size: 12px;
}

.entry-row {
  display: grid;
  grid-template-columns: auto minmax(80px, 1fr) minmax(80px, 1.5fr) auto;
  align-items: start;
  gap: 8px;
  margin-top: 8px;
}

.disabled :deep(input[type="text"]) {
  color: var(--color-muted);
}

input[type="checkbox"] {
  accent-color: var(--color-focus);
}

input[type="checkbox"]:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }

@media (max-width: 600px) {
  .entry-row {
    grid-template-columns: auto minmax(60px, 1fr) auto;
  }

  .entry-row .variable-input:nth-child(3) {
    grid-column: 2;
    grid-row: 2;
  }

  .entry-row button {
    grid-column: 3;
    grid-row: 1 / 3;
  }

}
</style>
