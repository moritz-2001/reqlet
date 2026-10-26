// Exercises execution feedback, real metadata, and safe read-only body inspection through the component UI.
import { mount } from "@vue/test-utils";
import { afterEach, expect, it } from "vitest";
import { defineComponent, h, KeepAlive } from "vue";
import ResponseInspector from "../src/components/ResponseInspector.vue";
import type { ExecutionState, HttpResponse } from "../src/request";
import { editorView, press } from "./editor";

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
});

it("announces first-send feedback without inventing a previous response", async () => {
  const inspector = renderInspector();
  expect(inspector.get('[role="status"]').text()).toBe("Send a request to inspect its response.");
  expect(inspector.find('[role="textbox"]').exists()).toBe(false);
  await inspector.setProps({ execution: { status: "running", startedAt: "2026-10-22T09:00:00Z" } });
  expect(inspector.get('[aria-label="Response"]').attributes("aria-busy")).toBe("true");
  expect(inspector.get('[role="status"]').text()).toBe("Sending request…");
  expect(inspector.find("dl").exists()).toBe(false);
  expect(inspector.find('[role="textbox"]').exists()).toBe(false);
  await inspector.setProps({ execution: { status: "cancelled" } });
  expect(inspector.get('[role="status"]').text()).toBe("Request cancelled.");
  expect(inspector.attributes("aria-busy")).toBe("false");
  await inspector.setProps({ execution: { status: "error", error: "Connection refused: <script>bad()</script>" } });
  expect(inspector.get('[role="alert"]').text()).toBe("Connection refused: <script>bad()</script>");
  expect(inspector.text()).toContain("Request failed");
  expect(inspector.find("script").exists()).toBe(false);
  await inspector.setProps({ execution: { status: "idle" } });
  expect(inspector.get('[role="status"]').text()).toBe("Send a request to inspect its response.");
});

it("retains the previous response through retries, failures, and cancellation until another HTTP response arrives", async () => {
  const inspector = renderInspector({ status: "success", response: response({ status: 503, statusText: "Service Unavailable" }) });
  const view = editorView(inspector.element);
  await inspector.setProps({ execution: { status: "running", startedAt: "2026-10-22T09:00:00Z" } });
  expect(inspector.attributes("aria-busy")).toBe("true");
  expect(inspector.get('[role="status"]').text()).toBe("Previous response · Sending…");
  expect(inspector.get(".response-status").text()).toBe("503 Service Unavailable");
  expect(inspector.get(".response-status").attributes("role")).toBeUndefined();
  expect(inspector.get(".response-summary").text()).toBe("12 ms · 15 bytes");
  expect(inspector.get(".response-url").text()).toContain("https://api.example.test/items");
  expect(editorView(inspector.element)).toBe(view);
  expect(view.state.doc.toString()).toBe("Server response");

  await inspector.setProps({ execution: { status: "error", error: "Connection refused: <script>bad()</script>" } });
  expect(inspector.get('[role="alert"]').text()).toBe("Previous response · Request failed: Connection refused: <script>bad()</script>");
  expect(inspector.find("script").exists()).toBe(false);
  expect(inspector.attributes("aria-busy")).toBe("false");
  expect(editorView(inspector.element)).toBe(view);
  await inspector.setProps({ execution: { status: "running", startedAt: "2026-10-22T09:01:00Z" } });
  await inspector.setProps({ execution: { status: "cancelled" } });
  expect(inspector.get('[role="status"]').text()).toBe("Previous response · Request cancelled.");
  expect(editorView(inspector.element)).toBe(view);
  expect(view.state.doc.toString()).toBe("Server response");

  await inspector.setProps({ execution: { status: "success", response: response({
    status: 404, statusText: "Not Found", body: "New response", durationMs: 25, sizeBytes: 12,
  }) } });
  expect(inspector.get('[role="status"]').text()).toBe("404 Not Found");
  expect(inspector.text()).not.toContain("Previous response");
  expect(inspector.find('[role="alert"]').exists()).toBe(false);
  expect(inspector.get(".response-summary").text()).toBe("25 ms · 12 bytes");
  expect(editorView(inspector.element)).toBe(view);
  expect(view.state.doc.toString()).toBe("New response");
});

it("preserves selection, Find, wrapping, presentation, and details while resending", async () => {
  const inspector = renderInspector({ status: "success", response: response({
    body: '{"message":"needle","again":"needle"}', headers: [{ name: "Content-Type", value: "application/json" }],
  }) });
  await button(inspector, "Raw").trigger("click");
  await button(inspector, "Find").trigger("click");
  const find = inspector.get<HTMLInputElement>(".cm-body-search input");
  await find.setValue("needle");
  await inspector.get('[aria-label="More body actions"]').trigger("click");
  const wrap = document.body.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
  wrap.click();
  await inspector.get("summary").trigger("click");
  const view = editorView(inspector.element);
  view.dispatch({ selection: { anchor: 12, head: 18 } });

  await inspector.setProps({ execution: { status: "running", startedAt: "2026-10-22T09:00:00Z" } });
  expect(editorView(inspector.element)).toBe(view);
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("needle");
  expect(inspector.get(".cm-body-search input").element).toBe(find.element);
  expect(find.element.value).toBe("needle");
  expect(inspector.get(".cm-content").classes()).toContain("cm-lineWrapping");
  expect(button(inspector, "Raw").attributes("aria-pressed")).toBe("true");
  expect(inspector.get("details").attributes("open")).toBeDefined();

  await inspector.setProps({ execution: { status: "success", response: response({
    body: '{"next":"needle"}', headers: [{ name: "Content-Type", value: "application/json" }],
  }) } });
  expect(editorView(inspector.element)).toBe(view);
  expect(view.state.doc.toString()).toBe('{"next":"needle"}');
  expect(inspector.get<HTMLInputElement>(".cm-body-search input").element.value).toBe("needle");
  expect(button(inspector, "Raw").attributes("aria-pressed")).toBe("true");
});

it("clears retained responses when execution becomes idle or is omitted", async () => {
  const inspector = renderInspector();
  for (const execution of [{ status: "idle" }, undefined] satisfies Array<ExecutionState | undefined>) {
    await inspector.setProps({ execution: { status: "success", response: response() } });
    await inspector.setProps({ execution });
    expect(inspector.find('[role="textbox"]').exists()).toBe(false);
    expect(inspector.get('[role="status"]').text()).toBe("Send a request to inspect its response.");
    await inspector.setProps({ execution: { status: "running", startedAt: "2026-10-22T09:00:00Z" } });
    expect(inspector.get('[role="status"]').text()).toBe("Sending request…");
    expect(inspector.find("dl").exists()).toBe(false);
  }
});

it("scopes retained responses to request keys and restores cached request views", async () => {
  const host = mount(KeyedInspectors, {
    attachTo: document.body,
    props: { requestId: "first", execution: { status: "success", response: response({ body: "First response" }) } },
  });
  mounted.push(host);
  const firstView = editorView(host.element);
  await host.setProps({ requestId: "second", execution: { status: "running", startedAt: "2026-10-22T09:00:00Z" } });
  expect(host.text()).not.toContain("First response");
  expect(host.get('[role="status"]').text()).toBe("Sending request…");
  expect(host.find('[role="textbox"]').exists()).toBe(false);
  await host.setProps({ execution: { status: "success", response: response({ body: "Second response" }) } });
  expect(editorView(host.element).state.doc.toString()).toBe("Second response");
  await host.setProps({ requestId: "first", execution: { status: "running", startedAt: "2026-10-22T09:01:00Z" } });
  expect(host.get('[role="status"]').text()).toBe("Previous response · Sending…");
  expect(editorView(host.element)).toBe(firstView);
  expect(firstView.state.doc.toString()).toBe("First response");
});

it("inspects HTTP error statuses as received responses and retains duplicate header rows", () => {
  const inspector = renderInspector({ status: "success", response: response({
    status: 503, statusText: "Service Unavailable", url: "https://api.example.test/redirected?x=1",
    durationMs: 82.5, sizeBytes: 2048,
    headers: [
      { name: "Content-Type", value: "text/plain; charset=utf-8" },
      { name: "set-cookie", value: "session=one; HttpOnly" },
      { name: "set-cookie", value: "theme=dark" },
    ],
  }) });
  expect(inspector.get('[role="status"]').text()).toBe("503 Service Unavailable");
  expect(inspector.find('[role="alert"]').exists()).toBe(false);
  const values = inspector.findAll("dd").map(value => value.text());
  expect(values).toEqual([
    "https://api.example.test/redirected?x=1", "82.5 ms", "2,048 bytes", "text/plain; charset=utf-8",
  ]);
  expect(inspector.get("summary").text()).toBe("Response details · 3 headers");
  expect(inspector.findAll("tbody tr").map(row => row.findAll("th, td").map(cell => cell.text())))
    .toEqual([
      ["Content-Type", "text/plain; charset=utf-8"],
      ["set-cookie", "session=one; HttpOnly"],
      ["set-cookie", "theme=dark"],
    ]);
});

it("keeps status and body available while detailed metadata starts collapsed", async () => {
  const inspector = renderInspector({ status: "success", response: response() });
  const details = inspector.get("details");
  expect(details.attributes("open")).toBeUndefined();
  expect(inspector.get('[role="status"]').isVisible()).toBe(true);
  expect(inspector.get(".response-summary").text()).toBe("12 ms · 15 bytes");
  expect(inspector.get('[role="textbox"]').isVisible()).toBe(true);
  expect(inspector.get(".response-url").isVisible()).toBe(false);
  await inspector.get("summary").trigger("click");
  expect(inspector.get(".response-url").isVisible()).toBe(true);
  expect(inspector.get('[role="status"]').isVisible()).toBe(true);
  expect(inspector.get('[role="textbox"]').isVisible()).toBe(true);
});

it("detects JSON from a case-insensitive content-type header and preserves the readonly original", async () => {
  const original = '{"problem":"unavailable","id":9007199254740993}';
  const result = response({ body: original, headers: [{ name: "cOnTeNt-TyPe", value: "Application/Problem+JSON; charset=utf-8" }] });
  const inspector = renderInspector({ status: "success", response: result });
  const view = editorView(inspector.element);
  expect(inspector.get('[role="textbox"]').attributes("aria-readonly")).toBe("true");
  expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
  expect(inspector.findAll(".json-key")).toHaveLength(2);
  press(view, "Enter");
  expect(view.state.doc.toString()).toContain('\n  "problem": "unavailable"');
  expect(view.state.doc.toString()).toContain("9007199254740993");
  expect(result.body).toBe(original);
  await button(inspector, "Raw").trigger("click");
  expect(view.state.doc.toString()).toBe(original);
});

it("retains the chosen JSON presentation across sends, failures, and non-JSON responses", async () => {
  const inspector = renderInspector({ status: "success", response: response({
    body: '{"first":true}', headers: [{ name: "Content-Type", value: "application/json" }],
  }) });
  expect(button(inspector, "Pretty").attributes("aria-pressed")).toBe("true");
  await button(inspector, "Raw").trigger("click");

  for (const execution of [
    { status: "running", startedAt: "2026-10-22T09:00:00Z" },
    { status: "error", error: "Connection refused" },
    { status: "success", response: response({ body: "plain text" }) },
  ] satisfies ExecutionState[]) await inspector.setProps({ execution });

  const body = '{"second":true}';
  await inspector.setProps({ execution: { status: "success", response: response({
    body, headers: [{ name: "Content-Type", value: "application/json" }],
  }) } });
  expect(button(inspector, "Raw").attributes("aria-pressed")).toBe("true");
  expect(editorView(inspector.element).state.doc.toString()).toBe(body);
  await button(inspector, "Pretty").trigger("click");
  await inspector.setProps({ execution: { status: "running", startedAt: "2026-10-22T09:00:00Z" } });
  await inspector.setProps({ execution: { status: "success", response: response({
    body: '{"third":true}', headers: [{ name: "Content-Type", value: "application/json" }],
  }) } });
  expect(editorView(inspector.element).state.doc.toString()).toBe('{\n  "third": true\n}');
});

it("shows HTML and other non-JSON bodies as literal selectable text", () => {
  const text = '<html><img src="x" onerror="bad()"><p>Hello</p></html>';
  const inspector = renderInspector({ status: "success", response: response({
    body: text, headers: [{ name: "content-type", value: "text/html" }],
  }) });
  expect(editorView(inspector.element).state.doc.toString()).toBe(text);
  expect(inspector.find("img").exists()).toBe(false);
  expect(inspector.find(".json-key").exists()).toBe(false);
  expect(inspector.findAll("button").map(button => button.text())).not.toContain("Pretty");
});

it("falls back to plain text without guessing JSON and handles empty bodies and reason phrases", async () => {
  const inspector = renderInspector({ status: "success", response: response({
    status: 204, statusText: "", headers: [], body: "", durationMs: 0, sizeBytes: 0,
  }) });
  expect(inspector.get('[role="status"]').text()).toBe("204");
  expect(inspector.findAll("dd").map(value => value.text())).toEqual([
    "https://api.example.test/items", "0 ms", "0 bytes", "text/plain",
  ]);
  expect(inspector.text()).toContain("No response headers.");
  expect(inspector.get('[role="textbox"]').attributes("aria-readonly")).toBe("true");
  await inspector.setProps({ execution: { status: "success", response: response({ body: '{"looks":"json"}' }) } });
  expect(editorView(inspector.element).state.doc.toString()).toBe('{"looks":"json"}');
  expect(inspector.find(".json-key").exists()).toBe(false);
  expect(inspector.findAll("button").map(button => button.text())).not.toContain("Pretty");
});

it("bounds large header tables and scrolls to the final duplicate while preserving table context", async () => {
  const headers = Array.from({ length: 2_000 }, (_, index) => ({ name: "set-cookie", value: `entry=${index}` }));
  const inspector = renderInspector({ status: "success", response: response({ headers }) });
  await inspector.get("summary").trigger("click");
  expect(inspector.get('[role="table"]').attributes("aria-rowcount")).toBe("2001");
  expect(inspector.findAll('[role="row"]').length).toBeLessThan(30);
  expect(inspector.findAll('[role="rowheader"]').map(header => header.text())).toEqual(
    Array(inspector.findAll('[role="rowheader"]').length).fill("set-cookie"),
  );

  const viewport = inspector.get<HTMLElement>(".virtual-rows");
  viewport.element.scrollTop = 2_000 * 32 - 180;
  await viewport.trigger("scroll");
  expect(inspector.get('[aria-rowindex="2001"]').text()).toBe("set-cookieentry=1999");
  expect(inspector.findAll('[role="row"]').length).toBeLessThan(30);
});

type InspectorWrapper = ReturnType<typeof mount<typeof ResponseInspector>>;
const mounted: Array<{ unmount(): void }> = [];
// Match App's request-keyed KeepAlive ownership without exposing component internals.
const KeyedInspectors = defineComponent((props: { requestId: string; execution?: ExecutionState }) =>
  () => h(KeepAlive, () => h(ResponseInspector, { key: props.requestId, execution: props.execution })),
{ props: ["requestId", "execution"] });

function renderInspector(execution?: ExecutionState) {
  const inspector = mount(ResponseInspector, { attachTo: document.body, props: { execution } });
  mounted.push(inspector);
  return inspector;
}

function response(changes: Partial<HttpResponse> = {}): HttpResponse {
  return {
    url: "https://api.example.test/items", status: 200, statusText: "OK", headers: [],
    body: "Server response", durationMs: 12, sizeBytes: 15, ...changes,
  };
}

function button(inspector: InspectorWrapper, label: string) {
  return inspector.findAll("button").find(button => button.text() === label)!;
}
