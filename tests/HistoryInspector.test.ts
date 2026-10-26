// Verifies captured request/response inspection independently of sidebar navigation and editable drafts.
import { mount } from "@vue/test-utils";
import { afterEach, expect, it } from "vitest";
import HistoryInspector from "../src/components/HistoryInspector.vue";
import ResponseInspector from "../src/components/ResponseInspector.vue";
import type { HistoryEntry } from "../src/request";
import { editorView } from "./editor";

afterEach(() => {
  for (const inspector of mounted.splice(0)) inspector.unmount();
  document.body.replaceChildren();
});

it("shows captured inputs and response in read-only body editors with Pretty and exact Raw views", async () => {
  const captured = entry("captured");
  const inspection = renderInspector(captured);
  expect(inspection.text()).toContain("History · Read-only execution snapshot");
  expect(inspection.findAll(".history-request-metadata dd").map(value => value.text())).toEqual([
    new Date(captured.startedAt).toLocaleString(), "POST", "12,000 ms", "https://api.example.test/items?x=1&x=2",
  ]);
  expect(inspection.get("time").attributes("datetime")).toBe(captured.startedAt);
  expect(inspection.findAll(".history-request-details tbody tr").map(row => row.findAll("th, td").map(cell => cell.text())))
    .toEqual([
      ["Authorization", "Bearer captured-secret"],
      ["Content-Type", "application/json"],
      ["X-Tag", "one"],
      ["X-Tag", "two"],
    ]);
  const capturedRequest = inspection.get(".history-request-details");
  expect(capturedRequest.find(".cm-editor").exists()).toBe(false);
  (capturedRequest.element as HTMLDetailsElement).open = true;
  await capturedRequest.trigger("toggle");
  expect(editorView(capturedRequest.element).state.doc.toString()).toBe('{\n  "name": "captured"\n}');
  expect(capturedRequest.get('button[aria-pressed="true"]').text()).toBe("Pretty");
  expect(inspection.findAll('[role="textbox"]').map(editor => editor.attributes("aria-readonly"))).toEqual(["true", "true"]);
  const response = inspection.getComponent(ResponseInspector);
  expect(response.text()).toContain("201 Created");
  expect(response.text()).toContain("42 ms");
  expect(response.text()).toContain("11 bytes");
  expect(response.text()).toContain("X-Server");
  expect(editorView(response.element).state.doc.toString()).toBe('{\n  "ok": true\n}');
  expect(response.get('button[aria-pressed="true"]').text()).toBe("Pretty");
  await capturedRequest.findAll("button").find(button => button.text() === "Raw")!.trigger("click");
  await response.findAll("button").find(button => button.text() === "Raw")!.trigger("click");
  expect(editorView(capturedRequest.element).state.doc.toString()).toBe(captured.request.body);
  expect(editorView(response.element).state.doc.toString()).toBe('{"ok":true}');
  expect(captured.request.body).toBe('{"name":"captured"}');
  expect(captured.result.status === "success" && captured.result.response.body).toBe('{"ok":true}');
});

it("replaces a completed response with the captured failure or cancellation", async () => {
  const inspection = renderInspector(entry("successful"));
  await inspection.setProps({ entry: { ...entry("failed"), result: { status: "error", error: "Connection refused" } } });
  expect(inspection.getComponent(ResponseInspector).get('[role="alert"]').text()).toBe("Connection refused");
  expect(inspection.findAll(".cm-editor")).toHaveLength(0);
  expect(inspection.text()).not.toContain("Previous response");
  expect(inspection.text()).not.toContain("201 Created");
  await inspection.setProps({ entry: entry("another-success") });
  expect(inspection.findAll(".cm-editor")).toHaveLength(1);
  await inspection.setProps({ entry: { ...entry("cancelled"), result: { status: "cancelled" } } });
  expect(inspection.getComponent(ResponseInspector).get('[role="status"]').text()).toBe("Request cancelled.");
  expect(inspection.find('[role="alert"]').exists()).toBe(false);
  expect(inspection.findAll(".cm-editor")).toHaveLength(0);
  expect(inspection.text()).not.toContain("Previous response");
  expect(inspection.text()).not.toContain("201 Created");
});

it("retains the inspected request editor while its disclosure is closed and resets for a different capture", async () => {
  const inspection = renderInspector(entry("first"));
  const details = inspection.get(".history-request-details");
  (details.element as HTMLDetailsElement).open = true;
  await details.trigger("toggle");
  const editor = editorView(details.element);
  (details.element as HTMLDetailsElement).open = false;
  await details.trigger("toggle");
  expect(editorView(details.element)).toBe(editor);
  (details.element as HTMLDetailsElement).open = true;
  await details.trigger("toggle");
  expect(editorView(details.element)).toBe(editor);

  await inspection.setProps({ entry: entry("second") });
  expect(inspection.get<HTMLDetailsElement>(".history-request-details").element.open).toBe(false);
  expect(inspection.get(".history-request-details").find(".cm-editor").exists()).toBe(false);
});

type InspectorWrapper = ReturnType<typeof mount<typeof HistoryInspector>>;
const mounted: InspectorWrapper[] = [];

function renderInspector(captured: HistoryEntry) {
  const inspection = mount(HistoryInspector, { attachTo: document.body, props: { entry: captured } });
  mounted.push(inspection);
  return inspection;
}

function entry(id: string, name = "Create item"): HistoryEntry {
  return {
    id, requestId: "saved-request", name, startedAt: "2026-10-22T11:00:00Z",
    request: {
      method: "POST", url: "https://api.example.test/items?x=1&x=2", timeoutMs: 12000,
      headers: [
        { name: "Authorization", value: "Bearer captured-secret" },
        { name: "Content-Type", value: "application/json" },
        { name: "X-Tag", value: "one" },
        { name: "X-Tag", value: "two" },
      ],
      body: '{"name":"captured"}',
    },
    result: {
      status: "success",
      response: {
        status: 201, statusText: "Created", url: "https://api.example.test/items?x=1&x=2",
        headers: [{ name: "Content-Type", value: "application/json" }, { name: "X-Server", value: "test" }],
        durationMs: 42, sizeBytes: 11, body: '{"ok":true}',
      },
    },
  };
}
