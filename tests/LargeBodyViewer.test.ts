// Exercises bounded raw response browsing, whole-response Find, and original-text actions through their interfaces.
import { afterEach, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, KeepAlive, nextTick, ref } from "vue";
import BodyText from "../src/components/BodyText.vue";
import * as formatting from "../src/components/formatJson";
import {
  findLargeBodyMatch, largeBodyPage, largeBodyPageCount, LARGE_BODY_PAGE_SIZE, LARGE_BODY_THRESHOLD,
  type LargeBodyRange,
} from "../src/components/largeBody";
import { editorView, press } from "./editor";

afterEach(() => {
  for (const body of mounted.splice(0)) body.unmount();
  searchWorkers.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("opens large read-only JSON as bounded raw pages without running whole-response formatting", async () => {
  const format = vi.spyOn(formatting, "formatJson");
  const original = `{"message":"${"x".repeat(1024 * 1024)}"}`;
  const body = renderBody(original);
  expect(body.get('[aria-label="Large response viewer"]').text()).toContain("JSON formatting, highlighting and folding are disabled");
  expect(body.find('[aria-label="Response body presentation"]').exists()).toBe(false);
  expect(body.findAll('button').some(button => button.text() === "Format JSON")).toBe(false);
  expect(format).not.toHaveBeenCalled();
  expect(editorView(body.element).state.doc.toString()).toBe(original.slice(0, largeBodyPage(original, 0).to));
  expect(editorView(body.element).state.doc.length).toBeLessThanOrEqual(LARGE_BODY_PAGE_SIZE);
  expect(button(body, "Previous page").attributes("disabled")).toBeDefined();
  await button(body, "Next page").trigger("click");
  const second = largeBodyPage(original, 1);
  expect(editorView(body.element).state.doc.toString()).toBe(original.slice(second.from, second.to));
  expect(body.get(".page-position").text()).toContain(`Source positions ${second.from.toLocaleString()}–${second.to.toLocaleString()}`);
  await button(body, "Previous page").trigger("click");
  await body.setProps({ presentation: "pretty" });
  expect(format).not.toHaveBeenCalled();
  expect(body.emitted("update:modelValue")).toBeUndefined();
  expect(body.emitted("update:presentation")).toBeUndefined();
});

it("reconstructs the original source with bounded pages without splitting Unicode pairs or CRLF", () => {
  const original = "a".repeat(LARGE_BODY_PAGE_SIZE - 2) + "😀" + "b".repeat(LARGE_BODY_PAGE_SIZE - 3) + "\r\n" + "tail";
  const pages = Array.from({ length: largeBodyPageCount(original) }, (_, index) => largeBodyPage(original, index));
  expect(pages.map(range => original.slice(range.from, range.to)).join("")).toBe(original);
  for (const range of pages) {
    expect(range.to - range.from).toBeLessThanOrEqual(LARGE_BODY_PAGE_SIZE);
    expect(original[range.to - 1]).not.toBe("\r");
    expect(original.charCodeAt(range.to - 1)).not.toBe(0xd83d);
  }
});

it("searches literal text across chunks in both directions and wraps without counting matches", async () => {
  const first = LARGE_BODY_PAGE_SIZE - 2;
  const second = LARGE_BODY_PAGE_SIZE * 2 + 7;
  const text = "x".repeat(first) + "[Needle]" + "x".repeat(second - first - 8) + "[NEEDLE]" + "x".repeat(100);
  const signal = new AbortController().signal;
  expect(await findLargeBodyMatch(text, "[needle]", 0, 1, signal)).toEqual({ from: first, to: first + 8 });
  expect(await findLargeBodyMatch(text, "[needle]", first + 8, 1, signal)).toEqual({ from: second, to: second + 8 });
  expect(await findLargeBodyMatch(text, "[needle]", second + 8, 1, signal)).toEqual({ from: first, to: first + 8 });
  expect(await findLargeBodyMatch(text, "[needle]", second, -1, signal)).toEqual({ from: first, to: first + 8 });
  expect(await findLargeBodyMatch(text, "[needle]", first, -1, signal)).toEqual({ from: second, to: second + 8 });
  expect(await findLargeBodyMatch(text, "not present", 0, 1, signal)).toBeNull();
  const controller = new AbortController();
  const pending = findLargeBodyMatch(text, "not present", 0, 1, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

it("finds and selects a whole-response match spanning a page, and cancels stale queries", async () => {
  const offset = LARGE_BODY_PAGE_SIZE * 2 - 4;
  const original = "x".repeat(offset) + "Needle😀" + "x".repeat(LARGE_BODY_THRESHOLD);
  const body = renderBody(original);
  expect(press(editorView(body.element), "f", { metaKey: true }).defaultPrevented).toBe(true);
  await nextTick();
  const input = body.get<HTMLInputElement>('[aria-label="Find in entire response"] input');
  await input.setValue("missing");
  await input.setValue("needle😀");
  await vi.waitFor(() => expect(body.get(".search-feedback").text()).toContain(`Match at source positions ${offset.toLocaleString()}`));
  await nextTick();
  expect(body.get(".page-position").text()).toContain("Match view");
  const view = editorView(body.element);
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("Needle😀");
  expect(view.state.doc.length).toBeLessThanOrEqual(LARGE_BODY_PAGE_SIZE);
  expect(body.get(".search-feedback").text()).toContain("total matches are not counted");
  await button(body, "Previous").trigger("click");
  await vi.waitFor(() => expect(body.get(".search-feedback").text()).toContain("Match at source positions"));
  await body.setProps({ modelValue: "z".repeat(LARGE_BODY_THRESHOLD + 1) });
  await vi.waitFor(() => expect(body.get(".search-feedback").text()).toBe("No matches in the entire response."));
  expect(body.emitted("update:modelValue")).toBeUndefined();
  await button(body, "Close find").trigger("click");
  expect(body.find('[role="search"]').exists()).toBe(false);
  expect(document.activeElement).toBe(editorView(body.element).contentDOM);
});

it("loads one worker source across query changes and search/page navigation, then releases it when Find closes", async () => {
  vi.stubGlobal("Worker", SearchWorker);
  const secondOffset = LARGE_BODY_PAGE_SIZE + 7;
  const original = "Needle" + "x".repeat(secondOffset - 6) + "NEEDLE" + "x".repeat(LARGE_BODY_THRESHOLD);
  const body = renderBody(original);
  await openFind(body);
  expect(searchWorkers).toHaveLength(0);
  const input = body.get<HTMLInputElement>('[aria-label="Find in entire response"] input');
  await input.setValue("needle");
  const worker = searchWorkers[0]!;
  expect(worker.messages[0]).toEqual({ type: "load", text: original });
  completeSearch(worker, { from: 0, to: 6 });
  await flushPromises();
  expect(body.get(".search-feedback").text()).toContain("Match at source positions 0–6");

  await button(body, "Next").trigger("click");
  expect(worker.findRequests()[1]).toMatchObject({ query: "needle", from: 6, direction: 1 });
  completeSearch(worker, { from: secondOffset, to: secondOffset + 6 });
  await flushPromises();
  expect(editorView(body.element).state.selection.main.from).toBe(secondOffset - largeBodyPage(original, 1).from);
  await button(body, "Previous").trigger("click");
  expect(worker.findRequests()[2]).toMatchObject({ query: "needle", from: secondOffset, direction: -1 });
  completeSearch(worker, { from: 0, to: 6 });
  await flushPromises();

  await input.setValue("missing");
  expect(worker.findRequests()[3]).toMatchObject({ query: "missing", direction: 1 });
  completeSearch(worker, null);
  await flushPromises();
  await button(body, "Next page").trigger("click");
  await button(body, "Previous page").trigger("click");
  expect(worker.findRequests()).toHaveLength(4);
  expect(worker.messages.filter(message => message.type === "load")).toEqual([{ type: "load", text: original }]);
  expect(worker.terminated).toBe(false);
  expect(searchWorkers).toHaveLength(1);

  await button(body, "Close find").trigger("click");
  expect(worker.terminated).toBe(true);
  expect(body.find('[role="search"]').exists()).toBe(false);
  await openFind(body);
  expect(searchWorkers).toHaveLength(2);
  expect(searchWorkers[1]!.messages[0]).toEqual({ type: "load", text: original });
  completeSearch(searchWorkers[1]!, null);
  await flushPromises();
  expect(body.get(".search-feedback").text()).toBe("No matches in the entire response.");
});

it("releases replaced response workers, ignores their late matches, and releases pending work when unmounted", async () => {
  vi.stubGlobal("Worker", SearchWorker);
  const body = renderBody("Needle" + "x".repeat(LARGE_BODY_THRESHOLD));
  await openFind(body);
  await body.get<HTMLInputElement>('[aria-label="Find in entire response"] input').setValue("needle");
  const oldWorker = searchWorkers[0]!;
  const replacement = "z".repeat(LARGE_BODY_THRESHOLD) + "NEEDLE";
  await body.setProps({ modelValue: replacement });
  expect(oldWorker.terminated).toBe(true);
  expect(searchWorkers).toHaveLength(2);
  const worker = searchWorkers[1]!;
  expect(worker.messages[0]).toEqual({ type: "load", text: replacement });
  expect(worker.findRequests()[0]).toMatchObject({ query: "needle", from: 0, direction: 1 });
  completeSearch(oldWorker, { from: 0, to: 6 });
  await flushPromises();
  expect(body.get(".search-feedback").text()).toBe("Searching the entire response…");
  completeSearch(worker, { from: LARGE_BODY_THRESHOLD, to: LARGE_BODY_THRESHOLD + 6 });
  await flushPromises();
  const view = editorView(body.element);
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("NEEDLE");
  await button(body, "Next").trigger("click");
  expect(body.get(".search-feedback").text()).toBe("Searching the entire response…");
  body.unmount();
  mounted.splice(mounted.indexOf(body), 1);
  expect(worker.terminated).toBe(true);
  completeSearch(worker, { from: LARGE_BODY_THRESHOLD, to: LARGE_BODY_THRESHOLD + 6 });
  await flushPromises();
});

it.each(["searching", "empty", "closed"] as const)(
  "releases hidden KeepAlive search work and restarts only an open nonempty Find (%s)",
  async state => {
    vi.stubGlobal("Worker", SearchWorker);
    const visible = ref(true);
    const source = ref("Needle" + "x".repeat(LARGE_BODY_THRESHOLD));
    const host = mount(defineComponent({
      components: { BodyText, KeepAlive },
      setup: () => ({ visible, source }),
      template: '<KeepAlive><BodyText v-if="visible" :model-value="source" label="Response body" readonly /></KeepAlive>',
    }), { attachTo: document.body });
    try {
      let body = host.findComponent(BodyText);
      await openFind(body);
      if (state !== "empty") {
        await body.get<HTMLInputElement>('[aria-label="Find in entire response"] input').setValue("needle");
        if (state === "closed") await button(body, "Close find").trigger("click");
      }
      const oldWorker = searchWorkers[0];
      visible.value = false;
      await flushPromises();
      if (oldWorker) expect(oldWorker.terminated).toBe(true);
      const hiddenSource = "z".repeat(LARGE_BODY_THRESHOLD) + "NEEDLE";
      source.value = hiddenSource;
      await flushPromises();
      expect(searchWorkers).toHaveLength(state === "empty" ? 0 : 1);
      if (oldWorker) {
        completeSearch(oldWorker, { from: 0, to: 6 });
        await flushPromises();
      }

      visible.value = true;
      await flushPromises();
      body = host.findComponent(BodyText);
      if (state === "searching") {
        expect(searchWorkers).toHaveLength(2);
        const worker = searchWorkers[1]!;
        expect(worker.messages[0]).toEqual({ type: "load", text: hiddenSource });
        expect(body.get(".search-feedback").text()).toBe("Searching the entire response…");
        completeSearch(worker, { from: LARGE_BODY_THRESHOLD, to: LARGE_BODY_THRESHOLD + 6 });
        await flushPromises();
        const view = editorView(body.element);
        expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("NEEDLE");
      } else {
        expect(searchWorkers).toHaveLength(state === "empty" ? 0 : 1);
        expect(body.find('[role="search"]').exists()).toBe(state === "empty");
      }
    } finally {
      host.unmount();
      expect(searchWorkers.every(worker => worker.terminated)).toBe(true);
    }
  },
);

it("keeps complete Unicode pairs at search chunk edges while finding actual lone surrogates", async () => {
  const text = "x".repeat(LARGE_BODY_PAGE_SIZE - 1) + "😀" + "x".repeat(LARGE_BODY_PAGE_SIZE - 1);
  const signal = new AbortController().signal;
  for (const query of ["\ud83d", "\ude00"]) {
    for (const from of [0, LARGE_BODY_PAGE_SIZE, text.length]) {
      for (const direction of [1, -1] as const) {
        expect(await findLargeBodyMatch(text, query, from, direction, signal)).toBeNull();
      }
    }
  }

  const withLoneSurrogates = text + "\ud83dX\ude00";
  for (const direction of [1, -1] as const) {
    expect(await findLargeBodyMatch(withLoneSurrogates, "\ud83d", 0, direction, signal))
      .toEqual({ from: text.length, to: text.length + 1 });
    expect(await findLargeBodyMatch(withLoneSurrogates, "\ude00", 0, direction, signal))
      .toEqual({ from: text.length + 2, to: text.length + 3 });
  }
});

it("uses the original complete response for Copy and UTF-8 download while wrapping just one page", async () => {
  const original = "😀\r\n" + "x".repeat(LARGE_BODY_THRESHOLD);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const createObjectURL = vi.fn().mockReturnValue("blob:response-test");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const body = renderBody(original);
  await button(body, "Copy body").trigger("click");
  expect(writeText).toHaveBeenCalledWith(original);
  await body.setProps({ contentType: "application/json;charset=iso-8859-1" });
  await button(body, "Download body").trigger("click");
  const blob = createObjectURL.mock.calls[0]![0] as Blob;
  expect(blob.size).toBe(new TextEncoder().encode(original).length);
  expect(blob.type).toBe("application/json;charset=utf-8");
  const trigger = body.get('[aria-label="More body actions"]');
  await trigger.trigger("click");
  const menu = new DOMWrapper(document.getElementById(trigger.attributes("aria-controls"))!);
  expect(menu.findAll("button").map(button => button.text())).toEqual(["Wrap lines"]);
  await menu.get("button").trigger("click");
  expect(body.find(".cm-lineNumbers").exists()).toBe(false);
  expect(editorView(body.element).state.doc.length).toBeLessThanOrEqual(LARGE_BODY_PAGE_SIZE);
  body.unmount();
  mounted.splice(mounted.indexOf(body), 1);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:response-test");
});

it("keeps editable bodies on the existing editor and restores small JSON presentation after a large response", async () => {
  const original = "x".repeat(LARGE_BODY_THRESHOLD + 1);
  const body = renderBody(original, false, "text/plain");
  expect(body.find('[aria-label="Large response viewer"]').exists()).toBe(false);
  expect(body.get(".cm-content").attributes("aria-readonly")).toBe("false");
  await body.setProps({ readonly: true, contentType: "application/json" });
  expect(body.find('[aria-label="Large response viewer"]').exists()).toBe(true);
  await body.setProps({ modelValue: '{"small":true}' });
  expect(body.find('[aria-label="Large response viewer"]').exists()).toBe(false);
  expect(editorView(body.element).state.doc.toString()).toBe('{\n  "small": true\n}');
  expect(button(body, "Pretty").attributes("aria-pressed")).toBe("true");
});

type BodyWrapper = ReturnType<typeof mount<typeof BodyText>>;
const mounted: BodyWrapper[] = [];
type SearchFindRequest = { type: "find"; id: number; query: string; from: number; direction: 1 | -1 };
type SearchRequest = { type: "load"; text: string } | SearchFindRequest | { type: "cancel"; id: number };
type SearchReply = { id: number; status: "found"; match: LargeBodyRange } | { id: number; status: "not-found" };
const searchWorkers: SearchWorker[] = [];

class SearchWorker {
  messages: SearchRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<SearchReply>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor() { searchWorkers.push(this); }
  postMessage(message: SearchRequest) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(reply: SearchReply) { this.onmessage?.(new MessageEvent("message", { data: reply })); }
  findRequests(): SearchFindRequest[] { return this.messages.filter(message => message.type === "find"); }
}

function renderBody(modelValue: string, readonly = true, contentType = "application/json") {
  const body = mount(BodyText, { attachTo: document.body,
    props: { modelValue, readonly, contentType, label: "Response body" } });
  mounted.push(body);
  return body;
}
function button(body: BodyWrapper, label: string) {
  return body.findAll("button").find(button => button.text() === label)!;
}

async function openFind(body: BodyWrapper) {
  expect(press(editorView(body.element), "f", { metaKey: true }).defaultPrevented).toBe(true);
  await nextTick();
}

function completeSearch(worker: SearchWorker, match: LargeBodyRange | null) {
  const requests = worker.findRequests();
  const id = requests[requests.length - 1]!.id;
  worker.reply(match ? { id, status: "found", match } : { id, status: "not-found" });
}
