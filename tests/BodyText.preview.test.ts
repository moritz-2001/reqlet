// Verifies that deferred previews keep original responses usable and never apply stale formatting.
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { defineComponent, KeepAlive, ref } from "vue";
import BodyText from "../src/components/BodyText.vue";
import { formatJson } from "../src/components/formatJson";
import type { JsonPreviewResult } from "../src/components/jsonPreview";
import { editorView } from "./editor";

afterEach(() => {
  for (const body of mounted.splice(0)) body.unmount();
  workers.length = 0;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("displays original text before formatting finishes and then shows the source-preserving preview", async () => {
  vi.stubGlobal("Worker", PreviewWorker);
  const source = largeJson("first");
  const body = render(source);
  expect(editorView(body.element).state.doc.toString()).toBe(source);
  expect(body.get('[role="status"]').text()).toBe("Preparing formatted preview…");
  expect(workers[0]!.source).toBe(source);
  const formatted = formatJson(source);
  workers[0]!.complete({ status: "formatted", text: formatted });
  await flushPromises();

  expect(editorView(body.element).state.doc.toString()).toBe(formatted);
  expect(body.get('button[aria-pressed="true"]').text()).toBe("Pretty");
  expect(workers[0]!.terminated).toBe(true);
  expect(body.emitted("update:modelValue")).toBeUndefined();
});

it("honors Raw chosen during formatting without changing its saved preference on completion", async () => {
  vi.stubGlobal("Worker", PreviewWorker);
  const source = largeJson("raw");
  const body = render(source);
  await body.findAll("button").find(button => button.text() === "Raw")!.trigger("click");
  workers[0]!.complete({ status: "formatted", text: formatJson(source) });
  await flushPromises();

  expect(editorView(body.element).state.doc.toString()).toBe(source);
  expect(body.emitted("update:presentation")).toEqual([["raw"]]);
  await body.findAll("button").find(button => button.text() === "Pretty")!.trigger("click");
  expect(workers).toHaveLength(2);
  workers[1]!.complete({ status: "formatted", text: formatJson(source) });
  await flushPromises();
  expect(editorView(body.element).state.doc.toString()).toBe(formatJson(source));
});

it("does not start a formatting worker when the owner requests Raw", () => {
  vi.stubGlobal("Worker", PreviewWorker);
  const source = largeJson("raw");
  const body = mount(BodyText, { props: {
    modelValue: source, label: "Response body", readonly: true, contentType: "application/json", presentation: "raw",
  } });
  mounted.push(body);
  expect(workers).toHaveLength(0);
  expect(editorView(body.element).state.doc.toString()).toBe(source);
});

it("keeps a selected original range stable when formatting finishes during inspection", async () => {
  vi.stubGlobal("Worker", PreviewWorker);
  const source = largeJson("selected");
  const body = render(source);
  const view = editorView(body.element);
  view.focus();
  view.dispatch({ selection: { anchor: 3, head: 7 } });
  workers[0]!.complete({ status: "formatted", text: formatJson(source) });
  await flushPromises();
  expect(view.state.doc.toString()).toBe(source);
  expect(view.state.selection.main).toMatchObject({ from: 3, to: 7 });
  expect(body.get('[role="status"]').text()).toContain("Choose Pretty");
  await body.findAll("button").find(button => button.text() === "Pretty")!.trigger("click");
  expect(view.state.doc.toString()).toBe(formatJson(source));
});

it("cancels hidden work and resumes on activation without applying a stale preview", async () => {
  vi.stubGlobal("Worker", PreviewWorker);
  const visible = ref(true);
  const source = largeJson("cached");
  const host = mount(defineComponent({
    components: { BodyText, KeepAlive }, setup: () => ({ visible, source }),
    template: '<KeepAlive><BodyText v-if="visible" :model-value="source" content-type="application/json" label="Cached" readonly /></KeepAlive>',
  }));
  try {
    const view = editorView(host.element);
    const original = workers[0]!;
    visible.value = false;
    await flushPromises();
    expect(original.terminated).toBe(true);
    original.complete({ status: "formatted", text: "stale" });
    await flushPromises();
    expect(view.state.doc.toString()).toBe(source);

    visible.value = true;
    await flushPromises();
    expect(workers).toHaveLength(2);
    workers[1]!.complete({ status: "formatted", text: formatJson(source) });
    await flushPromises();
    expect(view.state.doc.toString()).toBe(formatJson(source));
  } finally {
    host.unmount();
  }
});

it("keeps small but deeply nested sources raw when whitespace expansion exceeds the preview budget", async () => {
  const source = "[".repeat(1000) + "0" + "]".repeat(1000);
  const body = render(source);
  expect(editorView(body.element).state.doc.length).toBe(source.length);
  expect(editorView(body.element).state.doc.toString()).toBe(source);
  await body.findAll("button").find(button => button.text() === "Pretty")!.trigger("click");
  expect(body.get('[role="status"]').text()).toContain("would be too large");
});

it("keeps medium sources raw when the worker reports excessive formatting expansion", async () => {
  vi.stubGlobal("Worker", PreviewWorker);
  const source = largeJson("bounded");
  const body = render(source);
  workers[0]!.complete({ status: "too-large" });
  await flushPromises();
  expect(editorView(body.element).state.doc.toString()).toBe(source);
  await body.findAll("button").find(button => button.text() === "Pretty")!.trigger("click");
  expect(body.get('[role="status"]').text()).toContain("would be too large");
  expect(body.emitted("update:modelValue")).toBeUndefined();
});

it("cancels replaced and unmounted previews and ignores their late results", async () => {
  vi.stubGlobal("Worker", PreviewWorker);
  const body = render(largeJson("old"));
  const old = workers[0]!;
  const current = largeJson("current");
  await body.setProps({ modelValue: current });
  expect(old.terminated).toBe(true);
  old.complete({ status: "formatted", text: '{"stale":true}' });
  await flushPromises();
  expect(editorView(body.element).state.doc.toString()).toBe(current);
  expect(body.get('[role="status"]').text()).toBe("Preparing formatted preview…");

  body.unmount();
  mounted.splice(mounted.indexOf(body), 1);
  expect(workers[1]!.terminated).toBe(true);
  workers[1]!.complete({ status: "formatted", text: "ignored" });
  await flushPromises();
});

it("keeps original text available when JSON is invalid or workers cannot run", async () => {
  vi.stubGlobal("Worker", PreviewWorker);
  const source = largeJson("invalid").slice(0, -1);
  const body = render(source);
  workers[0]!.complete({ status: "invalid" });
  await flushPromises();
  await body.findAll("button").find(button => button.text() === "Pretty")!.trigger("click");
  expect(body.get('[role="status"]').text()).toContain("Cannot format invalid JSON");
  expect(editorView(body.element).state.doc.toString()).toBe(source);

  vi.stubGlobal("Worker", class { constructor() { throw new Error("Unavailable"); } });
  const unavailable = render(largeJson("unavailable"));
  await flushPromises();
  await unavailable.findAll("button").find(button => button.text() === "Pretty")!.trigger("click");
  expect(unavailable.get('[role="status"]').text()).toContain("Formatted preview is unavailable");
  expect(editorView(unavailable.element).state.doc.toString()).toBe(largeJson("unavailable"));
});

const mounted: ReturnType<typeof mount<typeof BodyText>>[] = [];
const workers: PreviewWorker[] = [];

class PreviewWorker {
  source = "";
  terminated = false;
  onmessage: ((event: MessageEvent<JsonPreviewResult>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor() { workers.push(this); }
  postMessage(source: string) { this.source = source; }
  terminate() { this.terminated = true; }
  complete(result: JsonPreviewResult) { this.onmessage?.(new MessageEvent("message", { data: result })); }
}

function render(modelValue: string) {
  const body = mount(BodyText, { attachTo: document.body, props: {
    modelValue, label: "Response body", readonly: true, contentType: "application/json",
  } });
  mounted.push(body);
  return body;
}

function largeJson(value: string) {
  return JSON.stringify({ value, padding: "x".repeat(70_000), id: 9007199254740991 });
}
