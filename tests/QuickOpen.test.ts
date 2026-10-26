// Exercises quick-open matching, keyboard/pointer selection, and focus through its public dialog interface.
import { mount } from "@vue/test-utils";
import { afterEach, expect, it } from "vitest";
import QuickOpen from "../src/components/QuickOpen.vue";
import { createRequest, type RequestData } from "../src/request";
import type { CollectionNode } from "../src/components/collectionTree";

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
});

it("focuses search and matches canonical names, methods, URLs, and ancestor folders", async () => {
  const picker = renderPicker();
  const search = picker.get<HTMLInputElement>('[role="combobox"]');
  expect(document.activeElement).toBe(search.element);
  expect(picker.get("dialog").element.open).toBe(true);
  expect(options(picker)).toHaveLength(3);

  await search.setValue("TEAM patch PEOPLE");
  expect(options(picker)).toHaveLength(1);
  expect(options(picker)[0].text()).toContain("Update person");
  expect(options(picker)[0].text()).toContain("Team API / People");
  await search.setValue("HEALTH");
  expect(options(picker)[0].text()).toContain("Service status");
  await search.setValue("Create account");
  expect(options(picker)[0].text()).toContain("Create account");
  await search.setValue("stale label");
  expect(options(picker)).toHaveLength(0);
  expect(picker.get('[role="status"]').text()).toBe("No requests match your search.");
});

it("wraps arrow navigation, resets selection after filtering, and opens only on Enter", async () => {
  const picker = renderPicker();
  const search = picker.get('[role="combobox"]');
  await search.trigger("keydown", { key: "ArrowUp" });
  expect(options(picker)[2].attributes("aria-selected")).toBe("true");
  await search.trigger("keydown", { key: "ArrowDown" });
  expect(options(picker)[0].attributes("aria-selected")).toBe("true");
  await search.trigger("keydown", { key: "ArrowDown" });
  expect(search.attributes("aria-activedescendant")).toBe(options(picker)[1].attributes("id"));
  expect(picker.emitted("select-request")).toBeUndefined();
  await search.trigger("keydown", { key: "Enter", isComposing: true });
  expect(picker.emitted("select-request")).toBeUndefined();
  await search.trigger("keydown", { key: "Enter" });
  expect(picker.emitted("select-request")).toEqual([["update"]]);

  await search.setValue("health");
  expect(options(picker)[0].attributes("aria-selected")).toBe("true");
  await search.trigger("keydown", { key: "Enter" });
  expect(picker.emitted("select-request")?.at(-1)).toEqual(["health"]);
  await search.setValue("no match");
  expect(search.attributes("aria-activedescendant")).toBeUndefined();
  await search.trigger("keydown", { key: "ArrowDown" });
  await search.trigger("keydown", { key: "Enter" });
  expect(picker.emitted("select-request")).toHaveLength(2);
});

it("supports pointer selection and reflects request edits and deletions while open", async () => {
  const picker = renderPicker();
  await options(picker)[2].trigger("click");
  expect(picker.emitted("select-request")).toEqual([["health"]]);
  await picker.get('[role="combobox"]').setValue("renamed");
  await picker.setProps({ requests: { ...requests, update: { ...requests.update, name: "Renamed request" } } });
  expect(options(picker)).toHaveLength(1);
  await picker.setProps({ requests: { create: requests.create, health: requests.health } });
  expect(options(picker)).toHaveLength(0);
});

it("dismisses through Escape, native cancel, backdrop, and close, restoring opener focus on unmount", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const picker = renderPicker();
  await picker.get('[role="combobox"]').trigger("keydown", { key: "Escape", isComposing: true });
  expect(picker.emitted("close")).toBeUndefined();
  await picker.get('[role="combobox"]').trigger("keydown", { key: "Escape" });
  await picker.get("dialog").trigger("cancel");
  await picker.get("dialog").trigger("click");
  await picker.get('[aria-label="Close quick open"]').trigger("click");
  expect(picker.emitted("close")).toHaveLength(4);
  picker.unmount();
  mounted.splice(mounted.indexOf(picker), 1);
  expect(document.activeElement).toBe(opener);
});

it("announces an empty workspace", () => {
  const picker = renderPicker({});
  expect(picker.get('[role="status"]').text()).toBe("No saved requests yet.");
});

it("bounds rendered results while keyboard and page controls can reach every match", async () => {
  const definitions = Object.fromEntries(Array.from({ length: 125 }, (_, index) => [
    `request-${index}`, createRequest(`Request ${index}`),
  ]));
  const picker = mount(QuickOpen, {
    attachTo: document.body,
    props: {
      requests: definitions,
      nodes: Object.keys(definitions).map(id => ({ kind: "request", id, name: id, requestType: "GET" })),
    },
  });
  mounted.push(picker);
  const search = picker.get('[role="combobox"]');
  expect(options(picker)).toHaveLength(50);
  expect(picker.get('[role="status"]').text()).toBe("125 requests · Showing 1–50");
  await search.trigger("keydown", { key: "ArrowUp" });
  expect(options(picker)).toHaveLength(25);
  const last = options(picker).at(-1)!;
  expect(last.attributes("aria-posinset")).toBe("125");
  expect(last.attributes("aria-setsize")).toBe("125");
  expect(search.attributes("aria-activedescendant")).toBe(last.attributes("id"));
  await search.trigger("keydown", { key: "Enter" });
  expect(picker.emitted("select-request")).toEqual([["request-124"]]);
  await search.trigger("keydown", { key: "ArrowDown" });
  expect(picker.get('[role="status"]').text()).toBe("125 requests · Showing 1–50");
  await picker.get('.result-pages button:last-child').trigger("click");
  expect(picker.get('[role="status"]').text()).toBe("125 requests · Showing 51–100");
  expect(options(picker)[0].attributes("aria-posinset")).toBe("51");
  await picker.get('.result-pages button:first-child').trigger("click");
  expect(options(picker)[0].attributes("aria-posinset")).toBe("1");
  await search.setValue("Request 124");
  expect(options(picker)).toHaveLength(1);
  expect(picker.find(".result-pages").exists()).toBe(false);
  expect(search.attributes("aria-activedescendant")).toBe(options(picker)[0].attributes("id"));
});

type PickerWrapper = ReturnType<typeof mount<typeof QuickOpen>>;
const mounted: PickerWrapper[] = [];
const requests = {
  create: { ...createRequest("Create account"), method: "POST", path: "https://api.test/accounts" },
  update: { ...createRequest("Update person"), method: "PATCH", path: "https://api.test/people/1" },
  health: { ...createRequest("Service status"), path: "https://api.test/health" },
};
const nodes: CollectionNode[] = [{
  kind: "folder", id: "team", name: "Team API", children: [
    { kind: "request", id: "create", name: "Stale label", requestType: "GET" },
    { kind: "folder", id: "people", name: "People", children: [
      { kind: "request", id: "update", name: "Stale label", requestType: "GET" },
    ] },
  ],
}, { kind: "request", id: "health", name: "Status", requestType: "GET" }];

function renderPicker(definitions: Readonly<Record<string, RequestData>> = requests) {
  const picker = mount(QuickOpen, { attachTo: document.body, props: { requests: definitions, nodes } });
  mounted.push(picker);
  return picker;
}

function options(picker: PickerWrapper) { return picker.findAll('[role="option"]'); }
