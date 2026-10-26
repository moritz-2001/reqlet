<!-- LargeBodyViewer browses bounded raw response pages and owns cancellable whole-response Find. -->
<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, useId, watch } from "vue";
import TextEditor from "./TextEditor.vue";
import type { TextEditorHandle } from "./textEditor";
import {
  largeBodyMatchPage, largeBodyPage, largeBodyPageCount, largeBodyPageIndex,
  LARGE_BODY_QUERY_LIMIT, type LargeBodyRange,
} from "./largeBody";
import { createLargeBodySearch, type LargeBodySearch } from "./largeBodySearch";

const props = defineProps<{
  /** Exact original response; only a bounded source slice enters CodeMirror. */
  modelValue: string;
  /** Controls wrapping of the current page without enabling whole-response parsing. */
  wrap: boolean;
  /** Accessible body heading owned by BodyText. */
  labelledBy: string;
  /** BodyText's action feedback, also described by the page editor. */
  describedBy: string;
  /** Original MIME value used for the optional UTF-8 text download. */
  contentType?: string;
}>();

const id = useId();
const root = ref<HTMLElement>();
const editor = ref<TextEditorHandle>();
const pageIndex = ref(0);
// A cross-boundary match temporarily shifts the window so the complete literal is visible.
// Previous/Next page always return to the fixed, non-overlapping source pages.
const matchWindow = ref<LargeBodyRange>();
const pageCount = computed(() => largeBodyPageCount(props.modelValue));
const page = computed(() => matchWindow.value ?? largeBodyPage(props.modelValue, pageIndex.value));
const pageText = computed(() => props.modelValue.slice(page.value.from, page.value.to));
const findOpen = ref(false);
const findInput = ref<HTMLInputElement>();
const query = ref("");
const match = ref<LargeBodyRange>();
const searching = ref(false);
const searchFeedback = ref("Enter text to search the entire response.");
const downloadFeedback = ref("");
// The controller invalidates both pending chunk work and its eventual DOM selection.
// Closing Find, replacing the response, deactivating, or unmounting aborts that work.
let searchController: AbortController | undefined;
// Find's first query copies this response into a worker once. Query changes and
// page navigation retain it; closing Find, hiding, or replacing the body releases it.
let searchSession: LargeBodySearch | undefined;
// Hidden KeepAlive editors may receive a new response; defer searching it until reactivation.
let active = true;
const downloads = new Map<string, ReturnType<typeof setTimeout>>();

async function findText() {
  const opening = !findOpen.value;
  findOpen.value = true;
  if (opening && query.value) void search(1, true);
  await nextTick();
  findInput.value?.focus();
  findInput.value?.select();
}

async function search(direction: 1 | -1, restart = false) {
  cancelSearch();
  if (!active) {
    searchFeedback.value = "Search paused while this response is hidden.";
    return;
  }
  if (!findOpen.value || !query.value) {
    match.value = undefined;
    searchFeedback.value = "Enter text to search the entire response.";
    return;
  }
  if (query.value.length > LARGE_BODY_QUERY_LIMIT) {
    match.value = undefined;
    searchFeedback.value = `Use at most ${LARGE_BODY_QUERY_LIMIT.toLocaleString()} characters in a search.`;
    return;
  }

  const controller = new AbortController();
  searchController = controller;
  const from = !restart && match.value
    ? direction === 1 ? match.value.to : match.value.from
    : direction === 1 ? page.value.from : page.value.to;
  searching.value = true;
  searchFeedback.value = "Searching the entire response…";
  try {
    searchSession ??= createLargeBodySearch(props.modelValue);
    const found = await searchSession.find(query.value, from, direction, controller.signal);
    if (controller.signal.aborted) return;

    match.value = found ?? undefined;
    searching.value = false;
    if (!found) {
      searchFeedback.value = "No matches in the entire response.";
      return;
    }
    pageIndex.value = largeBodyPageIndex(props.modelValue, found.from);
    const fixed = largeBodyPage(props.modelValue, pageIndex.value);
    matchWindow.value = found.to > fixed.to ? largeBodyMatchPage(props.modelValue, found) : undefined;
    searchFeedback.value = `Match at source positions ${found.from.toLocaleString()}–${found.to.toLocaleString()}. Search wraps; total matches are not counted.`;
    await nextTick();
    if (!controller.signal.aborted) {
      // CodeMirror normalizes CR/CRLF to LF; translate only this bounded page's offsets.
      const relative = (offset: number) => pageText.value.slice(0, offset - page.value.from).replace(/\r\n?/g, "\n").length;
      const startsInsideCrLf = props.modelValue[found.from] === "\n" && props.modelValue[found.from - 1] === "\r";
      editor.value?.revealRange(relative(found.from) - Number(startsInsideCrLf), relative(found.to));
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      searching.value = false;
      searchFeedback.value = `Could not search this response: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    if (searchController === controller) searchController = undefined;
  }
}

function cancelSearch() {
  searchController?.abort();
  searchController = undefined;
  searching.value = false;
}

function releaseSearch() {
  cancelSearch();
  searchSession?.dispose();
  searchSession = undefined;
}

function changePage(direction: 1 | -1) {
  cancelSearch();
  matchWindow.value = undefined;
  match.value = undefined;
  pageIndex.value = Math.min(pageCount.value - 1, Math.max(0, pageIndex.value + direction));
  if (query.value) searchFeedback.value = "Choose Next or Previous to search from this page.";
}

function closeFind() {
  releaseSearch();
  findOpen.value = false;
  root.value?.querySelector<HTMLElement>(".cm-content")?.focus();
}

function handleShortcut(event: KeyboardEvent) {
  if (event.isComposing || event.altKey) return;

  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    event.stopPropagation();
    void findText();
  } else if (findOpen.value && (event.key === "F3" || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g")) {
    event.preventDefault();
    event.stopPropagation();
    void search(event.shiftKey ? -1 : 1);
  } else if (findOpen.value && event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeFind();
  }
}

function handleFindKey(event: KeyboardEvent) {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.key !== "Enter") return;

  event.preventDefault();
  event.stopPropagation();
  void search(event.shiftKey ? -1 : 1);
}

function downloadBody() {
  try {
    const mime = props.contentType?.split(";")[0]?.trim() || "text/plain";
    const url = URL.createObjectURL(new Blob([props.modelValue], { type: `${mime};charset=utf-8` }));
    const link = document.createElement("a");
    link.href = url;
    link.download = props.contentType?.split(";")[0]?.trim().endsWith("json") ? "response-body.json" : "response-body.txt";
    document.body.appendChild(link);
    try { link.click(); }
    finally { link.remove(); }
    // Allow the browser to consume the download before releasing its Blob ownership.
    downloads.set(url, setTimeout(() => releaseDownload(url), 1000));
    downloadFeedback.value = "Download started for the original response text as UTF-8.";
  } catch {
    downloadFeedback.value = "Could not download the response. Copy body is still available.";
  }
}

function releaseDownload(url: string) {
  clearTimeout(downloads.get(url));
  URL.revokeObjectURL(url);
  downloads.delete(url);
}

watch(query, () => { match.value = undefined; void search(1, true); }, { flush: "sync" });
watch(() => props.modelValue, () => {
  releaseSearch();
  pageIndex.value = 0;
  matchWindow.value = undefined;
  match.value = undefined;
  downloadFeedback.value = "";
  if (findOpen.value) void search(1, true);
});
onActivated(() => {
  active = true;
  if (findOpen.value && query.value) void search(1, true);
});
onDeactivated(() => {
  active = false;
  releaseSearch();
  if (query.value) searchFeedback.value = "Search paused while this response is hidden.";
});
onBeforeUnmount(() => {
  releaseSearch();
  for (const url of downloads.keys()) releaseDownload(url);
});

// BodyText shares only Find with the raw viewer; editing and JSON-fold commands
// remain exclusive to TextEditor rather than becoming misleading no-op methods.
const commands: Pick<TextEditorHandle, "findText"> = { findText };
defineExpose(commands);
</script>

<template>
  <section ref="root" class="large-body-viewer" aria-label="Large response viewer" @keydown.capture="handleShortcut">
    <div :id="`${id}-notice`" class="large-body-notice">
      <details>
        <summary>Large response · Raw pages</summary>
        <p>JSON formatting, highlighting and folding are disabled. Find searches the entire response; Copy body copies the original text.</p>
      </details>
      <button class="ui-button ui-button--compact" type="button" @click="downloadBody">Download body</button>
    </div>
    <nav class="large-body-pages" aria-label="Response pages">
      <button class="ui-button ui-button--compact" type="button" :disabled="pageIndex === 0" @click="changePage(-1)">Previous page</button>
      <span class="page-position" role="status" :title="`Source positions ${page.from.toLocaleString()}–${page.to.toLocaleString()} of ${modelValue.length.toLocaleString()} (UTF-16 units, zero-based, end exclusive)`">
        {{ matchWindow ? 'Match view' : `Page ${pageIndex + 1} of ${pageCount}` }}
        <span class="ui-visually-hidden"> · Source positions {{ page.from.toLocaleString() }}–{{ page.to.toLocaleString() }} of {{ modelValue.length.toLocaleString() }}</span>
      </span>
      <button class="ui-button ui-button--compact" type="button" :disabled="pageIndex === pageCount - 1" @click="changePage(1)">Next page</button>
    </nav>
    <div v-if="findOpen" class="large-body-search" role="search" aria-label="Find in entire response">
      <input ref="findInput" v-model="query" class="ui-input ui-input--compact" type="text" aria-label="Find in entire response" placeholder="Find in entire response" title="Case-insensitive literal search; limited to 4,096 UTF-16 code units." autocomplete="off" spellcheck="false" @keydown="handleFindKey" />
      <div class="large-body-search-actions">
        <button class="ui-button ui-button--compact" type="button" :disabled="!query || query.length > LARGE_BODY_QUERY_LIMIT" @click="search(-1)">Previous</button>
        <button class="ui-button ui-button--compact" type="button" :disabled="!query || query.length > LARGE_BODY_QUERY_LIMIT" @click="search(1)">Next</button>
        <button v-if="searching" class="ui-button ui-button--compact" type="button" @click="cancelSearch(); searchFeedback = 'Search cancelled.'">Cancel search</button>
        <button class="ui-button ui-button--compact" type="button" @click="closeFind">Close find</button>
      </div>
      <p class="search-feedback" role="status" :title="searchFeedback">{{ searchFeedback }}</p>
    </div>
    <TextEditor ref="editor" :model-value="pageText" :readonly="true" :json="false" :wrap="wrap" :labelled-by="labelledBy" :described-by="`${describedBy} ${id}-notice`" placeholder="Empty body" />
    <p v-if="downloadFeedback" class="download-feedback" role="status">{{ downloadFeedback }}</p>
  </section>
</template>

<style scoped>
.large-body-viewer { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; overflow-y: auto; }
.large-body-viewer > .text-editor { flex: 1 0 160px; min-height: 160px; resize: none; }
.large-body-notice, .large-body-pages, .large-body-search { flex-shrink: 0; padding: 7px 10px; border-bottom: 1px solid var(--body-text-border, var(--color-control-border)); }
.large-body-notice { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.large-body-notice details { flex: 1 1 150px; font-size: 11px; line-height: 1.5; color: var(--body-text-muted, var(--color-muted)); }
.large-body-notice summary { cursor: pointer; }
.large-body-notice p { margin: 6px 0 0; }
.large-body-notice button, .large-body-pages button { flex-shrink: 0; }
.large-body-pages { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 6px; }
.page-position { font-size: 11px; color: var(--body-text-muted, var(--color-muted)); overflow-wrap: anywhere; }
.large-body-search { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.large-body-search input { flex: 1 1 160px; min-width: 0; }
.large-body-search-actions { display: flex; gap: 5px; }
.search-feedback, .download-feedback { flex-basis: 100%; margin: 0; font-size: 11px; color: var(--body-text-muted, var(--color-muted)); overflow-wrap: anywhere; }
.search-feedback { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.download-feedback { flex: 0 0 auto; padding: 6px 10px; }
</style>
