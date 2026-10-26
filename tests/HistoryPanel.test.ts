// Exercises history navigation and filters without mounting inspection or execution actions in the sidebar.
import { mount } from "@vue/test-utils";
import { afterEach, expect, it } from "vitest";
import HistoryPanel from "../src/components/HistoryPanel.vue";
import type { HistoryEntry } from "../src/request";

afterEach(() => {
  for (const panel of mounted.splice(0)) panel.unmount();
  document.body.replaceChildren();
});

it("explains an empty history and disables clearing until completed records exist", async () => {
  const panel = renderPanel([]);
  expect(panel.get('[role="status"]').text()).toBe("No executions yet. Send a request to start your history.");
  expect(panel.text()).toContain("including credentials");
  expect(panel.text()).toContain("inspect it in the workspace");
  const clear = panel.get("button");
  expect(clear.text()).toBe("Clear history");
  expect(clear.attributes("disabled")).toBeDefined();
  await clear.trigger("click");
  expect(panel.emitted("clear")).toBeUndefined();
});

it("emits inspection without mounting captured bodies or choosing an entry on its own", async () => {
  const captured = entry("captured");
  const panel = renderPanel([captured]);
  expect(panel.findAll('[aria-pressed="true"]')).toHaveLength(0);
  expect(panel.findAll(".cm-editor")).toHaveLength(0);
  await inspect(panel, "Create item").trigger("click");

  expect(panel.emitted("inspect")).toEqual([[captured]]);
  expect(panel.emitted("replay")).toBeUndefined();
  expect(panel.findAll('[aria-pressed="true"]')).toHaveLength(0);
  await panel.setProps({ selectedEntryId: captured.id });
  expect(panel.findAll('[aria-pressed="true"]')).toHaveLength(1);
  expect(panel.find('[aria-label="Captured execution"]').exists()).toBe(false);
});

it("shows each completion result and follows the workspace's selected execution", async () => {
  const successful = entry("successful");
  const failed = { ...entry("failed", "Failed request"), result: { status: "error", error: "Connection refused" } } as HistoryEntry;
  const cancelled = { ...entry("cancelled", "Cancelled request"), result: { status: "cancelled" } } as HistoryEntry;
  const panel = renderPanel([successful, failed, cancelled]);
  expect(panel.text()).toContain("201 Created");
  expect(panel.text()).toContain("Failed");
  expect(panel.text()).toContain("Cancelled");
  await panel.setProps({ selectedEntryId: failed.id });
  expect(inspect(panel, "Failed request").attributes("aria-pressed")).toBe("true");
  await panel.setProps({ entries: [successful] });
  expect(panel.findAll('[aria-pressed="true"]')).toHaveLength(0);
  await panel.setProps({ selectedEntryId: undefined });
  expect(panel.emitted("inspect")).toBeUndefined();
});

it("offers inspection and an explicit clear intent while execution actions stay in the workspace", async () => {
  const first = entry("first");
  const second = entry("second", "Another request");
  const entries = [first, second];
  const original = structuredClone(entries);
  const panel = renderPanel(entries);

  expect(panel.find('[aria-label^="Replay"]').exists()).toBe(false);
  expect(panel.text()).not.toContain("Send again");
  expect(panel.text()).not.toContain("Open as draft");
  await inspect(panel, "Another request").trigger("click");
  expect(panel.emitted("inspect")).toEqual([[second]]);
  expect(panel.emitted("replay")).toBeUndefined();
  await panel.findAll("button").find(button => button.text() === "Clear history")!.trigger("click");
  expect(panel.emitted("clear")).toEqual([[]]);
  expect(entries).toEqual(original);
});

it("searches captured names, URLs, and methods together while retaining the selected workspace entry", async () => {
  const create = entry("create");
  const list = { ...entry("list", "List people"), request: { ...create.request, method: "GET", url: "https://service.test/people" } };
  const panel = renderPanel([create, list]);
  await panel.setProps({ selectedEntryId: create.id });
  const search = panel.get('[aria-label="Search executions"]');

  await search.setValue("get PEOPLE");
  expect(panel.findAll(".history-select").map(row => row.text())).toHaveLength(1);
  expect(panel.get(".history-name").text()).toBe("List people");
  expect(panel.get('[role="status"]').text()).toBe("Showing 1 of 2 executions");
  expect(panel.findAll('[aria-pressed="true"]')).toHaveLength(0);
  await search.trigger("keydown", { key: "Enter" });
  expect(panel.emitted("inspect")).toEqual([[list]]);
  await search.setValue("EXAMPLE.TEST/ITEMS");
  expect(panel.get(".history-name").text()).toBe("Create item");
  expect(panel.get(".history-select").attributes("aria-pressed")).toBe("true");
  await search.setValue("no such request");
  expect(panel.get('[role="status"]').text()).toBe("No executions match your filters.");
  expect(panel.find(".history-list").exists()).toBe(false);
  await search.trigger("keydown", { key: "Enter" });
  expect(panel.emitted("inspect")).toHaveLength(1);
});

it("distinguishes HTTP error responses from transport errors and cancellations", async () => {
  const successful = entry("success");
  const badRequest = httpEntry("bad-request", 422, "Unprocessable Entity");
  const unavailable = httpEntry("unavailable", 503, "Service Unavailable");
  const transportError = { ...entry("transport-error", "Offline"), result: { status: "error", error: "Connection refused" } } as HistoryEntry;
  const cancelled = { ...entry("cancelled", "Stopped"), result: { status: "cancelled" } } as HistoryEntry;
  const entries = [successful, badRequest, unavailable, transportError, cancelled];
  const original = structuredClone(entries);
  const panel = renderPanel(entries);
  const filter = panel.get('[aria-label="Filter execution results"]');

  await filter.setValue("http-error");
  expect(panel.findAll(".history-result").map(row => row.text())).toEqual(["422 Unprocessable Entity", "503 Service Unavailable"]);
  expect(panel.findAll('[data-result="http-error"]')).toHaveLength(2);
  await filter.setValue("transport-error");
  expect(panel.get(".history-name").text()).toBe("Offline");
  await filter.setValue("cancelled");
  expect(panel.get(".history-name").text()).toBe("Stopped");
  await filter.setValue("http-success");
  expect(panel.get(".history-result").text()).toBe("201 Created");
  await panel.get('[aria-label="Search executions"]').setValue("missing");
  expect(panel.get('[role="status"]').text()).toBe("No executions match your filters.");
  await panel.get('button.clear-filters').trigger("click");
  expect(panel.findAll(".history-select")).toHaveLength(5);
  expect(document.activeElement).toBe(panel.get('[aria-label="Search executions"]').element);
  expect(panel.emitted("inspect")).toBeUndefined();
  expect(entries).toEqual(original);
});

it("clears history search and result filters with Escape without clearing retained history", async () => {
  const panel = renderPanel([entry("success")]);
  const search = panel.get<HTMLInputElement>('[aria-label="Search executions"]');
  await search.setValue("missing");
  await panel.get('[aria-label="Filter execution results"]').setValue("cancelled");
  await search.trigger("keydown", { key: "Escape" });

  expect(search.element.value).toBe("");
  expect(panel.get<HTMLSelectElement>('select').element.value).toBe("all");
  expect(panel.findAll(".history-select")).toHaveLength(1);
  expect(panel.emitted("clear")).toBeUndefined();
  expect(document.activeElement).toBe(search.element);
});

it("leaves composition Enter and Escape to history search without opening a snapshot or clearing filters", async () => {
  const captured = entry("success");
  const panel = renderPanel([captured]);
  const search = panel.get<HTMLInputElement>('[aria-label="Search executions"]');
  await search.setValue("Create");
  await panel.get('[aria-label="Filter execution results"]').setValue("http-success");

  await search.trigger("keydown", { key: "Enter", isComposing: true });
  expect(panel.emitted("inspect")).toBeUndefined();
  await search.trigger("keydown", { key: "Escape", isComposing: true });
  expect(search.element.value).toBe("Create");
  expect(panel.get<HTMLSelectElement>("select").element.value).toBe("http-success");

  await search.trigger("keydown", { key: "Enter" });
  expect(panel.emitted("inspect")).toEqual([[captured]]);
});

type HistoryWrapper = ReturnType<typeof mount<typeof HistoryPanel>>;
const mounted: HistoryWrapper[] = [];

function renderPanel(entries: HistoryEntry[]) {
  const panel = mount(HistoryPanel, { attachTo: document.body, props: { entries } });
  mounted.push(panel);
  return panel;
}

function inspect(panel: HistoryWrapper, name: string) {
  return panel.findAll("button").find(button => button.attributes("aria-label")?.startsWith(`Inspect ${name},`))!;
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

function httpEntry(id: string, status: number, statusText: string): HistoryEntry {
  const captured = entry(id);
  if (captured.result.status === "success") {
    captured.result.response.status = status;
    captured.result.response.statusText = statusText;
  }
  return captured;
}
