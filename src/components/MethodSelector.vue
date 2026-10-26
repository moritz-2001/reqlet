<!-- MethodSelector edits a parent-owned HTTP method with keyboard and pointer suggestions, including custom names. -->
<script setup lang="ts">
import {
  computed, nextTick, onBeforeUnmount, onDeactivated, ref, useId,
  useTemplateRef, watch, watchEffect, type CSSProperties,
} from "vue";
import { previewRequestField } from "../prepareRequest";

const props = withDefaults(defineProps<{
  /** Editable method text; custom names and incomplete edits are preserved until request preparation. */
  modelValue: string;
  /** Skips local validation while replaying captured inputs unchanged. */
  literal?: boolean;
}>(), { literal: false });

const emit = defineEmits<{
  /** Replacement text from typing or an explicitly chosen standard method. */
  "update:modelValue": [value: string];
}>();

const id = useId();
const root = useTemplateRef<HTMLElement>("root");
const input = useTemplateRef<HTMLInputElement>("input");
const control = useTemplateRef<HTMLElement>("control");
const menu = useTemplateRef<HTMLElement>("menu");
const open = ref(false);
// Opening the picker offers every method; only typing filters the suggestions.
const filtering = ref(false);
// Navigation highlights an option without changing the parent-owned method until selection.
const activeIndex = ref(0);
const revealEmptyError = ref(false);
// The menu leaves the editor's clipped scrollports; its fixed position is valid until the viewport or anchor scrolls.
const menuPosition = ref<CSSProperties>({});
const normalizedMethod = computed(() => props.modelValue.trim().toUpperCase());
const methods = [
  { name: "GET", description: "Retrieve a resource" },
  { name: "POST", description: "Submit data" },
  { name: "PUT", description: "Replace a resource" },
  { name: "PATCH", description: "Update a resource" },
  { name: "DELETE", description: "Delete a resource" },
  { name: "HEAD", description: "Retrieve headers only" },
  { name: "OPTIONS", description: "Inspect supported methods" },
];
const results = computed(() => filtering.value
  ? methods.filter(method => method.name.startsWith(normalizedMethod.value)) : methods);
const activeOptionId = computed(() => open.value && results.value[activeIndex.value]
  ? `${id}-option-${activeIndex.value}` : undefined);
const error = computed(() => props.literal ? null : previewRequestField(props.modelValue, "method").error);
const showError = computed(() => error.value && (props.modelValue !== "" || revealEmptyError.value));

// Send discovers invalid inputs through native validity and can focus this exact field.
watchEffect(() => { input.value?.setCustomValidity(error.value ?? ""); }, { flush: "post" });
watch(activeOptionId, async optionId => {
  await nextTick();
  if (optionId) document.getElementById(optionId)?.scrollIntoView?.({ block: "nearest" });
});
watch(open, expanded => {
  if (expanded) {
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    window.addEventListener("resize", closeOptions);
    window.addEventListener("scroll", closeOnScroll, true);
  } else {
    removeListeners();
  }
});
onDeactivated(closeOptions);
onBeforeUnmount(removeListeners);

function openOptions(direction = 1) {
  const anchor = control.value?.getBoundingClientRect();
  if (!anchor) return;

  const margin = 8;
  const gap = 6;
  const width = Math.min(300, window.innerWidth - margin * 2);
  const below = window.innerHeight - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const showBelow = below >= 300 || below >= above;
  menuPosition.value = {
    left: `${Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(0, showBelow ? below : above)}px`,
    ...(showBelow ? { top: `${anchor.bottom + gap}px` } : { bottom: `${window.innerHeight - anchor.top + gap}px` }),
  };
  filtering.value = false;
  const current = methods.findIndex(method => method.name === normalizedMethod.value);
  activeIndex.value = current >= 0 ? current : direction > 0 ? 0 : methods.length - 1;
  open.value = true;
}

function closeOptions() {
  open.value = false;
}

function toggleOptions() {
  if (open.value) closeOptions();
  else openOptions();
  input.value?.focus();
}

function updateValue(event: Event) {
  if (!open.value) openOptions();

  filtering.value = true;
  activeIndex.value = 0;
  revealEmptyError.value = true;
  emit("update:modelValue", (event.target as HTMLInputElement).value);
}

function chooseMethod(name: string) {
  closeOptions();
  if (name !== props.modelValue) emit("update:modelValue", name);
  input.value?.focus();
}

function handleKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    if (!open.value) {
      openOptions(direction);
      return;
    }

    const count = results.value.length;
    if (count) activeIndex.value = (activeIndex.value + direction + count) % count;
  } else if (event.key === "Enter" && open.value) {
    event.preventDefault();
    event.stopPropagation();
    const method = results.value[activeIndex.value];
    if (method) chooseMethod(method.name);
    else closeOptions();
  } else if (event.key === "Escape" && open.value) {
    event.preventDefault();
    event.stopPropagation();
    closeOptions();
  } else if (event.key === "Tab") {
    closeOptions();
  }
}

function dismissOutside(event: Event) {
  const target = event.target as Node | null;
  if (target && !root.value?.contains(target) && !menu.value?.contains(target)) closeOptions();
}

function closeOnScroll(event: Event) {
  if (event.target instanceof Node && menu.value?.contains(event.target)) return;

  closeOptions();
}

function removeListeners() {
  document.removeEventListener("pointerdown", dismissOutside);
  document.removeEventListener("focusin", dismissOutside);
  window.removeEventListener("resize", closeOptions);
  window.removeEventListener("scroll", closeOnScroll, true);
}
</script>

<template>
  <div ref="root" class="method-selector">
    <label :for="`${id}-input`">Method</label>
    <div ref="control" class="method-control" :data-method="normalizedMethod">
      <input
        :id="`${id}-input`"
        ref="input"
        class="ui-input"
        :value="modelValue"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        :aria-expanded="open"
        :aria-controls="open ? `${id}-options` : undefined"
        :aria-activedescendant="activeOptionId"
        :aria-invalid="error ? true : undefined"
        :aria-describedby="showError ? `${id}-error` : undefined"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        @click="!open && openOptions()"
        @input="updateValue"
        @keydown="handleKeydown"
        @blur="closeOptions(); revealEmptyError = true"
        @invalid="revealEmptyError = true"
      />
      <button type="button" class="method-toggle" tabindex="-1" aria-label="Show HTTP methods"
        aria-haspopup="listbox" :aria-expanded="open" :aria-controls="open ? `${id}-options` : undefined"
        @mousedown.prevent @click="toggleOptions">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" :class="{ expanded: open }">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
    </div>
    <div v-if="showError" :id="`${id}-error`" class="method-error" role="status">{{ error }}</div>

    <Teleport to="body">
      <div v-if="open" ref="menu" class="method-menu" :style="menuPosition">
        <div class="menu-heading">HTTP methods</div>
        <ul :id="`${id}-options`" role="listbox" aria-label="HTTP methods">
          <li v-for="(method, index) in results" :id="`${id}-option-${index}`" :key="method.name"
            role="option" :aria-selected="method.name === normalizedMethod" :data-active="index === activeIndex"
            :data-method="method.name" @pointermove="activeIndex = index" @mousedown.prevent @click="chooseMethod(method.name)">
            <strong>{{ method.name }}</strong>
            <span>{{ method.description }}</span>
            <svg v-if="method.name === normalizedMethod" class="selected-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="m3 8 3 3 7-7" />
            </svg>
          </li>
        </ul>
        <p v-if="!results.length" class="custom-method" role="status">No standard match. You can enter a custom method.</p>
        <p class="menu-hint">Type a custom method or choose with ↑ ↓ and Enter</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.method-selector { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
label { color: #b2bfd1; font-size: 12px; }
.method-control { position: relative; }
.method-control input {
  width: 100%;
  padding-right: 29px;
  color: var(--method-color);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
}

.method-toggle {
  position: absolute;
  top: 1px;
  right: 1px;
  bottom: 1px;
  display: grid;
  place-items: center;
  width: 26px;
  padding: 0;
  color: var(--color-muted);
  background: transparent;
  border: 0;
  border-radius: 0 var(--control-radius) var(--control-radius) 0;
  cursor: pointer;
}

.method-toggle:hover { color: var(--color-text); background: var(--color-hover); }
svg { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.method-toggle svg.expanded { transform: rotate(180deg); }
.method-error { color: var(--color-danger); font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
.method-menu {
  position: fixed;
  z-index: 50;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 4px;
  color: var(--color-text);
  background: var(--color-panel);
  border: 1px solid var(--color-interactive-border);
  border-radius: 8px;
  box-shadow: 0 12px 32px #0007;
}

.menu-heading { flex-shrink: 0; padding: 6px 8px 8px; color: var(--color-muted); font-size: 11px; }
ul { min-height: 0; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
li { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 7px 8px; border-radius: 4px; cursor: pointer; }
li[data-active="true"] { background: var(--color-selected); outline: 1px solid var(--color-selected-border); outline-offset: -1px; }
li strong { flex: 0 0 62px; color: var(--method-color); font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
li span { flex: 1; font-size: 11px; }
.selected-check { flex-shrink: 0; color: var(--color-muted); }
.menu-hint { flex-shrink: 0; margin: 4px 4px 0; padding: 9px 4px 5px; color: var(--color-muted); border-top: 1px solid var(--color-border); font-size: 10px; }
.custom-method { margin: 4px 8px 8px; font-size: 12px; line-height: 1.5; }
[data-method] { --method-color: var(--color-text); }
[data-method="GET"] { --method-color: #9fe3bc; }
[data-method="POST"] { --method-color: #f3d38b; }
[data-method="PUT"] { --method-color: #9bb8ff; }
[data-method="PATCH"] { --method-color: #c9acff; }
[data-method="DELETE"] { --method-color: var(--color-danger); }
[data-method="HEAD"] { --method-color: #8edce5; }
[data-method="OPTIONS"] { --method-color: #bfc9dc; }
</style>
