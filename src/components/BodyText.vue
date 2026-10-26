<!-- BodyText owns body actions and presentation modes; TextEditor owns editing, selection, and folds. -->
<script setup lang="ts">
import type { ProtobufContext } from "../protobuf";
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, useId, watch, type CSSProperties } from "vue";
import { formatJson, JsonFormatLimitError } from "./formatJson";
import { formatJsonPreview, type JsonPreviewResult } from "./jsonPreview";
import TextEditor from "./TextEditor.vue";
import LargeBodyViewer from "./LargeBodyViewer.vue";
import { LARGE_BODY_THRESHOLD } from "./largeBody";
import type { TextEditorHandle } from "./textEditor";
import { bodyText, type BodySource } from "../bodyDocument";

const props = withDefaults(defineProps<{
  /** Parent-owned source; immutable revisions avoid copying large editable bodies. */
  modelValue: BodySource;
  /** Retains immutable document revisions in the parent instead of emitting complete strings on edits. */
  incremental?: boolean;
  /** Resolved runtime model; omitted disables protobuf assistance. */
  protobufContext?: ProtobufContext;
  /** Accessible name shown above the body. */
  label: string;
  /** MIME type enabling JSON features; omitted means plain text. */
  contentType?: string;
  /** Prevents body edits while retaining selection, folding, and copy. */
  readonly?: boolean;
  /** Uses a denser toolbar while surrounding pane headings supply visible context. */
  compact?: boolean;
  /** Optional owner-controlled response view; omitted starts with Pretty and remembers local choices. */
  presentation?: "pretty" | "raw";
}>(), { readonly: false, compact: false });

const emit = defineEmits<{
  /** Supplies the complete source revision after editing or explicit formatting. */
  "update:modelValue": [value: BodySource];
  /** Reports an explicit response presentation choice without modifying the original body. */
  "update:presentation": [value: "pretty" | "raw"];
}>();

defineSlots<{
  /** Domain-specific controls beside body actions; the caller owns their labels and edits. */
  toolbar?(): unknown;
}>();

const editorId = useId();
const editor = ref<TextEditorHandle>();
const largeViewer = ref<Pick<TextEditorHandle, "findText">>();
const toolbar = ref<HTMLElement>();
const wrap = ref(false);
// A parent may retain this choice while the response editor unmounts between executions.
const localPresentation = ref<"pretty" | "raw">("pretty");
const requestedPresentation = computed(() => props.presentation ?? localPresentation.value);
const feedback = ref("");
const moreTrigger = ref<HTMLButtonElement>();
const moreMenu = ref<HTMLDivElement>();
const moreOpen = ref(false);
// Read the CSS overflow decisions only when opening More. The menu is teleported
// outside the body's size container, so it cannot inherit its container queries.
const overflowActions = ref<string[]>([]);
// The menu escapes bounded, scrolling body panes; viewport coordinates keep it beside its trigger.
const morePosition = ref<CSSProperties>({});
const isJson = computed(() => {
  const mime = props.contentType?.split(";")[0]?.trim().toLowerCase();
  return mime === "application/json" || mime?.endsWith("+json") === true;
});
const largeResponse = computed(() => props.readonly && props.modelValue.length > LARGE_BODY_THRESHOLD);
// Tiny previews stay synchronous. Larger sources first display plain original text;
// only the current worker's result can supply a formatted replacement.
const previewSource = computed(() => props.readonly && isJson.value && !largeResponse.value
  && props.modelValue.length > 64 * 1024 ? bodyText(props.modelValue) : undefined);
// Completed previews survive Raw/Pretty changes and tab deactivation. A different
// source releases that cache; unfinished work is cancelled while the tab is hidden.
const previewResult = ref<{ source: string; result: JsonPreviewResult }>();
const currentPreview = computed(() => previewResult.value?.source === previewSource.value ? previewResult.value?.result : undefined);
const previewPending = ref(false);
const previewActive = ref(true);
// Once the user starts selecting/searching original text, automatic formatting
// must not replace that document. An explicit Pretty choice releases this hold.
const previewInteracted = ref(false);
watch(previewSource, () => { previewInteracted.value = false; }, { flush: "sync" });
watch([previewSource, previewActive, requestedPresentation], ([source, active, presentation], _previous, cleanup) => {
  if (previewResult.value?.source !== source) previewResult.value = undefined;
  previewPending.value = false;
  if (source === undefined || !active || presentation === "raw" || currentPreview.value) return;

  previewPending.value = true;
  const controller = new AbortController();
  cleanup(() => controller.abort());
  void formatJsonPreview(source, controller.signal).then(result => {
    if (controller.signal.aborted) return;
    previewResult.value = { source, result };
    previewPending.value = false;
  }, () => { /* Replaced/unmounted previews are cancelled without changing current presentation. */ });
}, { immediate: true, flush: "sync" });
const immediatePreview = computed<JsonPreviewResult | undefined>(() => {
  if (!props.readonly || !isJson.value || largeResponse.value || previewSource.value !== undefined) return undefined;
  try { return { status: "formatted", text: formatJson(bodyText(props.modelValue), LARGE_BODY_THRESHOLD) }; }
  catch (error) { return { status: error instanceof JsonFormatLimitError ? "too-large" : "invalid" }; }
});
const formattedText = computed(() => {
  const result = previewSource.value === undefined ? immediatePreview.value : currentPreview.value;
  return result?.status === "formatted" ? result.text : undefined;
});
const pretty = computed(() => !largeResponse.value && !previewInteracted.value && requestedPresentation.value === "pretty"
  && formattedText.value !== undefined);
const displayedText = computed(() => pretty.value ? formattedText.value! : props.modelValue);
const visibleFeedback = computed(() => feedback.value || (previewPending.value ? "Preparing formatted preview…"
  : previewInteracted.value && currentPreview.value?.status === "formatted" ? "Formatted preview ready. Choose Pretty to view it." : ""));
const editorJson = computed(() => isJson.value && (previewSource.value === undefined
  || requestedPresentation.value === "raw" || currentPreview.value !== undefined));
onActivated(() => { previewActive.value = true; });
onDeactivated(() => { previewActive.value = false; });

watch(() => [props.modelValue, props.contentType, props.readonly], () => {
  feedback.value = "";
});

function setPresentation(presentation: "pretty" | "raw") {
  if (largeResponse.value) return;
  if (presentation === "pretty" && previewPending.value) return;
  if (presentation === "pretty" && previewSource.value !== undefined && !currentPreview.value) {
    previewInteracted.value = false;
    localPresentation.value = presentation;
    emit("update:presentation", presentation);
    return;
  }
  if (presentation === "pretty" && formattedText.value === undefined) {
    const result = previewSource.value === undefined ? immediatePreview.value : currentPreview.value;
    feedback.value = result?.status === "unavailable"
      ? "Formatted preview is unavailable. Showing the original text."
      : result?.status === "too-large" ? "Formatted preview would be too large. Showing the original text."
      : "Cannot format invalid JSON. Your text is unchanged.";
    return;
  }
  const heldPreview = previewInteracted.value;
  previewInteracted.value = false;
  if (presentation === requestedPresentation.value && !heldPreview) return;

  // Even an already-pretty body changes presentation mode and must start expanded.
  // The fold command focuses the editor; a view choice must keep keyboard focus
  // on its toolbar control (or the restored More trigger) instead.
  const activeControl = document.activeElement;
  editor.value?.expandAll();
  if (activeControl instanceof HTMLElement) activeControl.focus({ preventScroll: true });
  localPresentation.value = presentation;
  emit("update:presentation", presentation);
  feedback.value = presentation === "pretty"
    ? "Formatted preview. The original body is preserved."
    : "Showing the original body.";
}

function preservePreviewSelection(event: Event) {
  if (previewPending.value && event.target instanceof Element && event.target.closest(".cm-editor")) {
    previewInteracted.value = true;
  }
}

function formatBody() {
  if (props.readonly) return;
  try {
    editor.value?.replaceDocument(formatJson(bodyText(props.modelValue)));
  } catch {
    feedback.value = "Cannot format invalid JSON. Your text is unchanged.";
  }
}

function findBody() {
  (largeResponse.value ? largeViewer.value : editor.value)?.findText();
}

async function copyBody() {
  try {
    await navigator.clipboard.writeText(bodyText(props.modelValue));
    feedback.value = "Original body copied.";
  } catch {
    feedback.value = "Could not copy. Select the text and copy it manually.";
  }
}

async function toggleMore() {
  if (moreOpen.value) {
    closeMore(true);
    return;
  }

  overflowActions.value = Array.from(toolbar.value?.querySelectorAll<HTMLElement>("[data-body-action]") ?? [])
    .filter(action => window.getComputedStyle(action).display === "none")
    .map(action => action.dataset.bodyAction!);
  morePosition.value = { top: "0px", left: "0px", visibility: "hidden" };
  moreOpen.value = true;
  await nextTick();
  const trigger = moreTrigger.value;
  const menu = moreMenu.value;
  if (!trigger || !menu) return;

  const anchor = trigger.getBoundingClientRect();
  const bounds = menu.getBoundingClientRect();
  const margin = 8;
  const below = anchor.bottom + 4;
  const top = below + bounds.height <= window.innerHeight - margin
    ? below : Math.max(margin, anchor.top - bounds.height - 4);
  // Teleport leaves the editor's ancestors, so carry its public theme overrides with the menu.
  const theme = window.getComputedStyle(trigger);
  const themeVariables = ["--body-text-color", "--body-text-background", "--body-text-border"];
  morePosition.value = {
    ...Object.fromEntries(themeVariables.map(name => [name, theme.getPropertyValue(name)])),
    top: `${top}px`,
    left: `${Math.max(margin, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - margin))}px`,
    maxHeight: `${Math.max(0, window.innerHeight - top - margin)}px`,
  };
  await nextTick();
  if (moreOpen.value && moreMenu.value === menu) menu.querySelector<HTMLButtonElement>("button")?.focus();
}

async function openMoreFromKeyboard(event: KeyboardEvent) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

  event.preventDefault();
  if (!moreOpen.value) await toggleMore();
  const buttons = moreMenu.value?.querySelectorAll<HTMLButtonElement>("button");
  const target = event.key === "ArrowUp" ? buttons?.[buttons.length - 1] : buttons?.[0];
  target?.focus();
}

function closeMore(restoreFocus = false) {
  moreOpen.value = false;
  overflowActions.value = [];
  if (restoreFocus) moreTrigger.value?.focus();
}

function toggleWrap() {
  wrap.value = !wrap.value;
  closeMore(true);
}

function foldBody(command: "collapseValue" | "expandValue" | "expandAll") {
  closeMore();
  editor.value?.[command]();
}

function navigateMore(event: KeyboardEvent) {
  if (event.key === "Escape") {
    closeMore(true);
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.key === "Tab") {
    closeMore(true);
    // Forward Tab resumes after the trigger; backward Tab returns to the trigger.
    if (event.shiftKey) event.preventDefault();
    return;
  }

  const buttons = Array.from(moreMenu.value?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : event.key === "ArrowDown" ? (current + 1) % buttons.length
    : event.key === "ArrowUp" ? (current + buttons.length - 1) % buttons.length : undefined;
  if (next === undefined) return;

  buttons[next]?.focus();
  event.preventDefault();
}

function dismissMore(event: Event) {
  const target = event.target as Node | null;
  if (target && (moreTrigger.value?.contains(target) || moreMenu.value?.contains(target))) return;

  closeMore();
}

function closeOnViewportChange(event: Event) {
  // Scrolling a tall menu should remain usable; scrolling its anchor's pane invalidates its position.
  if (event.type === "scroll" && event.target instanceof Node && moreMenu.value?.contains(event.target)) return;

  closeMore();
}

watch(moreOpen, open => {
  const method = open ? "addEventListener" : "removeEventListener";
  document[method]("pointerdown", dismissMore);
  document[method]("focusin", dismissMore);
  window[method]("resize", closeOnViewportChange);
  window[method]("scroll", closeOnViewportChange, true);
});
onDeactivated(() => closeMore());
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", dismissMore);
  document.removeEventListener("focusin", dismissMore);
  window.removeEventListener("resize", closeOnViewportChange);
  window.removeEventListener("scroll", closeOnViewportChange, true);
});
</script>

<template>
  <section class="body-text" :class="{ compact }" :aria-labelledby="`${editorId}-label`"
    @pointerdown.capture="preservePreviewSelection" @keydown.capture="preservePreviewSelection" @focusin.capture="preservePreviewSelection">
    <header ref="toolbar" class="body-toolbar">
      <div class="body-heading">
        <label :id="`${editorId}-label`">{{ label }}</label>
      </div>
      <div v-if="$slots.toolbar" class="body-context"><slot name="toolbar" /></div>
      <div class="body-actions">
        <div v-if="isJson && readonly && !largeResponse" class="presentation-toggle" data-body-action="presentation" role="group" :aria-label="`${label} presentation`">
          <button class="ui-button ui-button--subtle" type="button" :aria-pressed="pretty" :disabled="previewPending" @click="setPresentation('pretty')">Pretty</button>
          <button class="ui-button ui-button--subtle" type="button" :aria-pressed="!pretty" @click="setPresentation('raw')">Raw</button>
        </div>
        <button class="ui-button ui-button--subtle" v-else-if="isJson && !readonly" data-body-action="format" type="button" @click="formatBody">Format JSON</button>
        <button class="ui-button ui-button--subtle" data-body-action="find" type="button" title="Find in body (⌘/Ctrl+F)" @click="findBody">Find</button>
        <button class="ui-button ui-button--subtle" data-body-action="copy" type="button" title="Copy the original body text" @click="copyBody">Copy body</button>
        <button
          ref="moreTrigger"
          type="button"
          class="ui-button ui-button--subtle more-trigger"
          aria-label="More body actions"
          title="More body actions"
          aria-haspopup="menu"
          :aria-expanded="moreOpen"
          :aria-controls="`${editorId}-more`"
          @click="toggleMore"
          @keydown="openMoreFromKeyboard"
        >⋯</button>
      </div>
    </header>
    <LargeBodyViewer
      v-if="largeResponse"
      ref="largeViewer"
      :model-value="bodyText(modelValue)"
      :content-type="contentType"
      :wrap="wrap"
      :labelled-by="`${editorId}-label`"
      :described-by="`${editorId}-feedback`"
    />
    <TextEditor
      v-else
      :protobuf-context="protobufContext"
      ref="editor"
      :model-value="displayedText"
      :incremental="incremental"
      :readonly="readonly"
      :json="editorJson"
      :wrap="wrap"
      :labelled-by="`${editorId}-label`"
      :described-by="`${editorId}-feedback`"
      :placeholder="readonly ? 'Empty body' : 'Enter a request body…'"
      @update:model-value="emit('update:modelValue', $event)"
    />
    <p :id="`${editorId}-feedback`" role="status" class="body-feedback" :class="{ 'ui-visually-hidden': !visibleFeedback }">{{ visibleFeedback }}</p>
    <Teleport to="body">
      <div
        v-if="moreOpen"
        :id="`${editorId}-more`"
        ref="moreMenu"
        class="body-more-menu"
        role="menu"
        :aria-label="`${label} actions`"
        :style="morePosition"
        @keydown="navigateMore"
      >
        <template v-if="overflowActions.includes('presentation')">
          <button type="button" role="menuitemradio" :aria-checked="pretty" :disabled="previewPending" tabindex="-1" @click="closeMore(true); setPresentation('pretty')">Pretty</button>
          <button type="button" role="menuitemradio" :aria-checked="!pretty" tabindex="-1" @click="closeMore(true); setPresentation('raw')">Raw</button>
        </template>
        <button v-if="overflowActions.includes('format')" type="button" role="menuitem" tabindex="-1" @click="closeMore(true); formatBody()">Format JSON</button>
        <button v-if="overflowActions.includes('find')" type="button" role="menuitem" tabindex="-1" @click="closeMore(); findBody()">Find</button>
        <button v-if="overflowActions.includes('copy')" type="button" role="menuitem" tabindex="-1" @click="closeMore(true); copyBody()">Copy body</button>
        <button type="button" role="menuitemcheckbox" :aria-checked="wrap" tabindex="-1" @click="toggleWrap">
          <span class="wrap-check" aria-hidden="true">{{ wrap ? '✓' : '' }}</span>Wrap lines
        </button>
        <template v-if="isJson && !largeResponse">
          <button type="button" role="menuitem" tabindex="-1" title="Collapse the value at the editor caret" @click="foldBody('collapseValue')">Collapse value</button>
          <button type="button" role="menuitem" tabindex="-1" @click="foldBody('expandValue')">Expand value</button>
          <button type="button" role="menuitem" tabindex="-1" @click="foldBody('expandAll')">Expand all</button>
        </template>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.body-text {
  container: body-text / inline-size;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--body-text-color, var(--color-text));
  background: var(--body-text-background, var(--color-surface));
  border: 1px solid var(--body-text-border, var(--color-control-border));
  border-radius: 8px;
}

.body-toolbar, .body-heading, .body-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.body-toolbar {
  flex-wrap: wrap;
  justify-content: space-between;
  flex-shrink: 0;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--body-text-border, var(--color-control-border));
}

.body-context {
  display: flex;
  flex: 1 1 180px;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.body-heading > label {
  font-size: 12px;
  font-weight: 600;
}

.body-actions {
  flex-wrap: nowrap;
  gap: 6px;
}

/* Toolbar actions inherit the existing body theme; teleported menu rows use the same values. */
.body-actions .ui-button { color: var(--body-text-color, var(--color-text)); border-color: var(--body-text-border, var(--color-interactive-border)); }

.body-more-menu button:hover { background: var(--color-hover); }
.body-more-menu button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }

.presentation-toggle { display: inline-flex; }
.presentation-toggle button { border-radius: 0; }
.presentation-toggle button:first-child { border-radius: 6px 0 0 6px; }
.presentation-toggle button:last-child { margin-left: -1px; border-radius: 0 6px 6px 0; }
.presentation-toggle button[aria-pressed="true"] { color: var(--color-text); background: var(--color-selected); border-color: var(--color-selected-border); position: relative; }

.body-feedback:not(.ui-visually-hidden) {
  flex-shrink: 0;
  margin: 0;
  padding: 6px 12px;
  color: var(--body-text-muted, var(--color-muted));
  font-size: 11px;
  border-top: 1px solid var(--body-text-border, var(--color-control-border));
}

/* Labels remain available to assistive technology; surrounding request/response
   headings supply the visible context when a compact body has a bounded height. */
.compact .body-heading {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.compact .body-toolbar { padding: 6px 8px; }
.compact .body-actions { gap: 5px; }
.compact .body-actions button { padding: 5px 7px; font-size: 12px; white-space: nowrap; }
.compact .body-feedback:not(.ui-visually-hidden) { padding: 4px 8px; }
.more-trigger { min-width: 28px; font-weight: 700; }

/* The editor pane, rather than the window, determines which actions fit. More
   exposes the hidden controls using the same commands and presentation state. */
@container body-text (max-width: 560px) {
  [data-body-action="find"], [data-body-action="copy"] { display: none; }
}

@container body-text (max-width: 280px) {
  [data-body-action="format"], [data-body-action="presentation"] { display: none; }
  .body-context { flex-basis: 100%; }
  .body-actions { margin-left: auto; }
}

.body-more-menu {
  position: fixed;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: min(168px, calc(100vw - 16px));
  max-width: calc(100vw - 16px);
  padding: 5px;
  overflow-y: auto;
  color: var(--body-text-color, var(--color-text));
  background: var(--body-text-background, #172131);
  border: 1px solid var(--body-text-border, var(--color-control-border));
  border-radius: 7px;
  box-shadow: 0 5px 15px #0008;
}

.body-more-menu button {
  color: inherit;
  background: transparent;
  font: inherit;
  font-size: var(--control-font-size);
  border: 1px solid transparent;
  border-radius: var(--control-radius);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 5px 8px;
  text-align: left;
}

.wrap-check { width: 12px; }
</style>
