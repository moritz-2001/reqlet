<!-- VariableInput keeps placeholders editable while sharing resolution, local validation, and accessible name completion. -->
<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef, watchEffect } from "vue";
import { previewRequestField, type RequestFieldKind } from "../prepareRequest";
import type { Environment, RequestInputMode } from "../request";
import { variableCompletion } from "../requestVariables";

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  /** Unresolved text owned by the parent; choosing a variable inserts its placeholder. */
  modelValue: string;
  /** Selected variable scope; omitted means placeholders report missing definitions. */
  environment?: Environment;
  /** Shared transport rule used for this input; text only resolves variables. */
  kind?: RequestFieldKind;
  /** Bypasses resolution and validation for captured inputs, disabled rows, or plain data editors. */
  literal?: boolean;
  /** Literal request definitions skip environment expansion while retaining field validation. */
  inputMode?: RequestInputMode;
  /** Masks the input and suppresses all resolved-value previews, including title attributes. */
  secret?: boolean;
  /** Adds the resolved value as a hover preview when placeholders are present. */
  preview?: boolean;
  /** Whether typing an opening placeholder offers enabled variable names. */
  suggestions?: boolean;
}>(), { kind: "text", literal: false, secret: false, preview: false, suggestions: true });

const emit = defineEmits<{
  /** Replacement text with unresolved placeholders preserved. */
  "update:modelValue": [value: string];
  /** Opens the parent workspace's environment editor to correct the current scope. */
  "edit-environment": [];
}>();

const fieldId = useId();
const input = useTemplateRef<HTMLInputElement>("input");
const focused = ref(false);
const caret = ref(0);
// Escape dismisses only this completion session; a subsequent edit or focus offers names again.
const dismissed = ref(false);
const selectedIndex = ref(0);
// Empty fields stay quiet until the user leaves them or Send triggers native validation.
const revealEmptyError = ref(false);
const result = computed(() => props.literal
  ? { value: props.modelValue, error: null, environmentError: false }
  : previewRequestField(props.modelValue, props.kind, props.environment, props.inputMode));
const usesVariables = computed(() => !props.literal && props.inputMode !== "literal");
const completion = computed(() => usesVariables.value && props.suggestions && focused.value && !dismissed.value
  ? variableCompletion(props.modelValue, caret.value, props.environment) : undefined);
const showError = computed(() => result.value.error && (props.modelValue !== "" || revealEmptyError.value) && !completion.value);
const activeIndex = computed(() => Math.min(selectedIndex.value, (completion.value?.names.length ?? 1) - 1));
const previewTitle = computed(() => props.preview && !props.secret && usesVariables.value && props.modelValue.includes("{{")
  ? result.value.value ?? undefined : undefined);

// Native validity lets RequestEditor reveal and focus the exact invalid field, including hidden settings panels.
watchEffect(() => { input.value?.setCustomValidity(result.value.error ?? ""); }, { flush: "post" });

function updateValue(event: Event) {
  const target = event.target as HTMLInputElement;
  caret.value = target.selectionStart ?? target.value.length;
  dismissed.value = false;
  selectedIndex.value = 0;
  revealEmptyError.value = true;
  emit("update:modelValue", target.value);
}

function syncCaret() {
  caret.value = input.value?.selectionStart ?? props.modelValue.length;
}

function focusInput() {
  focused.value = true;
  dismissed.value = false;
  selectedIndex.value = 0;
  syncCaret();
}

async function chooseVariable(name: string, restoreFocus = true) {
  const range = completion.value;
  if (!range) return;

  const placeholder = `{{${name}}}`;
  const value = props.modelValue.slice(0, range.start) + placeholder + props.modelValue.slice(range.end);
  const position = range.start + placeholder.length;
  dismissed.value = true;
  emit("update:modelValue", value);
  await nextTick();
  if (restoreFocus) input.value?.focus();
  input.value?.setSelectionRange(position, position);
  caret.value = position;
}

function handleKeydown(event: KeyboardEvent) {
  const options = completion.value?.names;
  if (!options || event.ctrlKey || event.metaKey || event.altKey) return;

  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp":
      event.preventDefault();
      selectedIndex.value = (activeIndex.value + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
      void nextTick(() => {
        input.value?.ownerDocument.getElementById(`${fieldId}-option-${activeIndex.value}`)
          ?.scrollIntoView?.({ block: "nearest" });
      });
      break;
    case "Enter":
      event.preventDefault();
      event.stopPropagation();
      void chooseVariable(options[activeIndex.value]);
      break;
    case "Tab":
      void chooseVariable(options[activeIndex.value], false);
      break;
    case "Escape":
      event.preventDefault();
      event.stopPropagation();
      dismissed.value = true;
      break;
  }
}
</script>

<template>
  <div class="variable-input">
    <input class="ui-input"
      ref="input"
      v-bind="$attrs"
      :value="modelValue"
      :type="secret ? 'password' : 'text'"
      :title="secret ? undefined : previewTitle"
      :role="suggestions && usesVariables ? 'combobox' : undefined"
      :aria-autocomplete="suggestions && usesVariables ? 'list' : undefined"
      :aria-expanded="suggestions && usesVariables ? !!completion : undefined"
      :aria-controls="completion ? `${fieldId}-options` : undefined"
      :aria-activedescendant="completion ? `${fieldId}-option-${activeIndex}` : undefined"
      :aria-invalid="result.error ? true : undefined"
      :aria-describedby="[$attrs['aria-describedby'], showError && `${fieldId}-error`].filter(Boolean).join(' ') || undefined"
      autocomplete="off"
      spellcheck="false"
      @input="updateValue"
      @focus="focusInput"
      @blur="focused = false; revealEmptyError = true"
      @invalid="revealEmptyError = true"
      @click="syncCaret"
      @select="syncCaret"
      @keyup="['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes($event.key) && syncCaret()"
      @keydown="handleKeydown"
    />
    <ul v-if="completion" :id="`${fieldId}-options`" class="variable-options" role="listbox" aria-label="Environment variables">
      <li v-for="(name, index) in completion.names" :id="`${fieldId}-option-${index}`" :key="name"
        role="option" :aria-selected="index === activeIndex" @mousedown.prevent @click="chooseVariable(name)">
        <code v-text="'{{' + name + '}}'" />
      </li>
    </ul>
    <div v-if="showError" :id="`${fieldId}-error`" class="field-error" role="status">
      <span>{{ result.error }}</span>
      <button class="ui-button ui-button--link" v-if="result.environmentError" type="button" @click="emit('edit-environment')">Edit environment</button>
    </div>
  </div>
</template>

<style scoped>
.variable-input { position: relative; min-width: 0; width: 100%; }
input { width: 100%; }

.variable-options {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  box-sizing: border-box;
  min-width: 100%;
  max-height: 180px;
  overflow: auto;
  margin: 0;
  padding: 4px;
  color: var(--color-text);
  background: #182335;
  border: 1px solid #4a6286;
  border-radius: 6px;
  box-shadow: 0 8px 24px #0007;
  list-style: none;
  font-size: 12px;
}
.variable-options li { padding: 6px 8px; cursor: pointer; border-radius: 3px; white-space: nowrap; }
.variable-options li[aria-selected="true"], .variable-options li:hover { background: #314569; }
.field-error { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; margin-top: 5px; color: var(--color-danger); font-size: 11px; line-height: 1.4; }

</style>
