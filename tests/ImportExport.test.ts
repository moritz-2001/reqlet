// Verifies import/export intents, explicit credential inclusion, and browser errors through the panel interface.
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import ImportExport from "../src/components/ImportExport.vue";
import { createRequest } from "../src/request";
import { importCurl, serializeCollection } from "../src/interchange";
import type { CollectionNode } from "../src/components/collectionTree";
import type { CollectionImport } from "../src/interchange";

afterEach(() => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount());
  document.body.replaceChildren();
  vi.doUnmock("../src/openapi");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps controls compact until opened and returns focus after Escape", async () => {
  const panel = render();
  expect(panel.find('[role="dialog"]').exists()).toBe(false);
  const toggle = button(panel, "Import / Export");
  await toggle.trigger("click");
  expect(document.activeElement).toBe(panel.get("textarea").element);
  expect(button(panel, "Copy collection JSON").attributes("disabled")).toBeDefined();
  await panel.get('[role="dialog"]').trigger("keydown", { key: "Escape" });
  expect(panel.find('[role="dialog"]').exists()).toBe(false);
  expect(document.activeElement).toBe(toggle.element);
});

it("imports a cURL request with a fresh ID without modifying existing requests", async () => {
  const panel = await open();
  await panel.get("textarea").setValue("curl -d 'a=1' https://example.com/api");
  await button(panel, "Import").trigger("click");
  const imported = panel.emitted("import")![0][0] as { requests: Record<string, unknown>; collection: CollectionNode[] };
  const ids = Object.keys(imported.requests);
  expect(ids).toHaveLength(1);
  expect(ids[0]).not.toBe("request");
  expect(imported.collection[0].id).toBe(ids[0]);
  expect(imported.requests[ids[0]]).toMatchObject({ method: "POST", body: "a=1" });
  expect(panel.get('[role="status"]').text()).toContain("Imported 1");
  expect(panel.get("textarea").element.value).toBe("");
});

it("remaps request and nested folder IDs on collection import and rejects malformed data without emitting", async () => {
  const panel = await open();
  await panel.get("textarea").setValue(serializeCollection(fixture().requests, fixture().nodes));
  await button(panel, "Import").trigger("click");
  const imported = panel.emitted("import")![0][0] as { requests: Record<string, unknown>; collection: CollectionNode[] };
  expect(imported.collection[0].id).not.toBe("folder");
  expect(Object.keys(imported.requests)[0]).not.toBe("request");
  await panel.get("textarea").setValue('{"kind":"api-tool-collection","version":1,"requests":{},"collection":[{}]}');
  await button(panel, "Import").trigger("click");
  expect(panel.emitted("import")).toHaveLength(1);
  expect(panel.get('[role="alert"]').text()).toContain("Invalid");
});

it("reserves configured and missing existing protobuf sources when importing model bindings", async () => {
  const existingSourceId = "00000000-0000-4000-8000-000000000001";
  const missingSourceId = "00000000-0000-4000-8000-000000000002";
  const importedRequestId = "00000000-0000-4000-8000-000000000003";
  const importedSourceId = "00000000-0000-4000-8000-000000000004";
  const data = fixture();
  const panel = await open({
    requests: { request: { ...data.requests.request, protobuf: { sourceId: missingSourceId, messageName: "users.ExistingRequest" } } },
    protobufSources: [{ id: existingSourceId, name: "Existing models", rootPath: "/existing/models", includePaths: [] }],
  });
  const request = { ...createRequest("Imported"), protobuf: { sourceId: "incoming-models", messageName: "users.ImportedRequest" } };
  const nodes: CollectionNode[] = [{ kind: "request", id: "incoming-request", name: request.name, requestType: request.method }];
  const text = serializeCollection({ "incoming-request": request }, nodes, [
    { id: "incoming-models", name: "Imported models", rootPath: "/incoming/models", includePaths: [] },
  ]);
  vi.spyOn(crypto, "randomUUID")
    .mockReturnValueOnce(importedRequestId)
    .mockReturnValueOnce(existingSourceId)
    .mockReturnValueOnce(missingSourceId)
    .mockReturnValueOnce(importedSourceId);

  await panel.get("textarea").setValue(text);
  await button(panel, "Import").trigger("click");
  const imported = panel.emitted("import")![0][0] as CollectionImport;
  expect(imported.protobufSources).toEqual([
    { id: importedSourceId, name: "Imported models", rootPath: null, includePaths: [] },
  ]);
  expect(imported.requests[importedRequestId].protobuf).toEqual({ sourceId: importedSourceId, messageName: "users.ImportedRequest" });
  expect(panel.props("requests").request.protobuf?.sourceId).toBe(missingSourceId);
  expect(panel.props("protobufSources")?.[0].id).toBe(existingSourceId);
  expect(panel.find('[role="alert"]').exists()).toBe(false);
});

it.each(["source", "server", "format", "close", "unmount"] as const)("discards an OpenAPI preview invalidated by %s while its parser loads", async change => {
  const parser = await vi.importActual<typeof import("../src/openapi")>("../src/openapi");
  const parse = vi.spyOn(parser, "parseOpenApi");
  let completeLoad!: () => void;
  const pendingLoad = new Promise<typeof parser>(resolve => { completeLoad = () => resolve(parser); });
  vi.doMock("../src/openapi", () => pendingLoad);
  const panel = await open();
  const source = JSON.stringify(openApiFixture());
  await panel.get("textarea").setValue(source);
  await button(panel, "Import").trigger("click");
  expect(panel.get('[role="status"]').text()).toContain("Loading OpenAPI");
  expect(button(panel, "Preview OpenAPI").attributes("disabled")).toBeDefined();

  if (change === "source") {
    await panel.get("textarea").setValue("changed");
    await panel.get("textarea").setValue(source);
  } else if (change === "server") {
    await panel.get('input[type="url"]').setValue("https://staging.example.com/api");
    await panel.get('input[type="url"]').setValue("");
  } else if (change === "format") {
    await panel.get("select").setValue("auto");
    await panel.get("select").setValue("openapi");
  } else if (change === "close") {
    await button(panel, "Close").trigger("click");
    await button(panel, "Import / Export").trigger("click");
  } else {
    panel.unmount();
    mounted.splice(mounted.indexOf(panel), 1);
  }

  completeLoad();
  await vi.dynamicImportSettled();
  expect(parse).not.toHaveBeenCalled();
  expect(panel.emitted("import")).toBeUndefined();
  if (change !== "unmount") {
    expect(panel.find('[aria-label="OpenAPI operations"]').exists()).toBe(false);
    expect(panel.find('[role="status"]').exists()).toBe(false);
    expect(button(panel, "Preview OpenAPI").attributes("disabled")).toBeUndefined();
  }
});

it("imports cURL immediately while an obsolete OpenAPI parser load is pending", async () => {
  const parser = await vi.importActual<typeof import("../src/openapi")>("../src/openapi");
  let completeLoad!: () => void;
  const pendingLoad = new Promise<typeof parser>(resolve => { completeLoad = () => resolve(parser); });
  vi.doMock("../src/openapi", () => pendingLoad);
  const panel = await open();
  await panel.get("textarea").setValue(JSON.stringify(openApiFixture()));
  await button(panel, "Import").trigger("click");
  await panel.get("select").setValue("auto");
  await panel.get("textarea").setValue("curl https://example.com/current");
  await button(panel, "Import").trigger("click");
  const imported = panel.emitted("import")![0][0] as CollectionImport;
  expect(Object.values(imported.requests)[0].path).toBe("https://example.com/current");

  completeLoad();
  await vi.dynamicImportSettled();
  expect(panel.find('[aria-label="OpenAPI operations"]').exists()).toBe(false);
  expect(panel.get('[role="status"]').text()).toContain("Imported 1");
});

it("reports a failed OpenAPI parser load and allows another preview attempt", async () => {
  vi.doMock("../src/openapi", () => { throw new Error("OpenAPI support could not be loaded"); });
  const panel = await open();
  await panel.get("textarea").setValue(JSON.stringify(openApiFixture()));
  await button(panel, "Import").trigger("click");
  await vi.dynamicImportSettled();
  expect(panel.get('[role="alert"]').text()).not.toBe("");
  expect(panel.find('[role="status"]').exists()).toBe(false);
  expect(button(panel, "Preview OpenAPI").attributes("disabled")).toBeUndefined();

  vi.doUnmock("../src/openapi");
  await button(panel, "Preview OpenAPI").trigger("click");
  await vi.dynamicImportSettled();
  expect(panel.find('[role="alert"]').exists()).toBe(false);
  expect(panel.get('[aria-label="OpenAPI operations"]').text()).toContain("GET /users/{id}");
});

it("previews OpenAPI operations before importing only the selected requests with fresh identities", async () => {
  const panel = await open();
  const source = JSON.stringify(openApiFixture());
  await panel.get("textarea").setValue(source);
  await button(panel, "Import").trigger("click");
  await vi.dynamicImportSettled();
  expect(panel.emitted("import")).toBeUndefined();
  expect(panel.get('[aria-label="OpenAPI operations"]').text()).toContain("GET /users/{id}");
  expect(panel.get('[aria-label="OpenAPI operations"]').text()).toContain("https://example.com/v1/users/");
  const choices = panel.findAll('.operation input[type="checkbox"]');
  await choices[1].setValue(false);
  await button(panel, "Import selected operations").trigger("click");
  const first = panel.emitted("import")![0][0] as CollectionImport;
  const [id, request] = Object.entries(first.requests)[0];
  expect(Object.keys(first.requests)).toHaveLength(1);
  expect(request).toMatchObject({ name: "Get user", method: "GET", path: "https://example.com/v1/users/42" });
  expect(first.collection[0]).toMatchObject({ kind: "folder", name: "Users API" });
  expect(id).not.toBe("request");
  expect(panel.find('[aria-label="OpenAPI operations"]').exists()).toBe(false);
  expect(panel.get('[role="status"]').text()).toContain("Imported 1");

  await panel.get("textarea").setValue(source);
  await button(panel, "Preview OpenAPI").trigger("click");
  await vi.dynamicImportSettled();
  await button(panel, "Import selected operations").trigger("click");
  const second = panel.emitted("import")![1][0] as CollectionImport;
  expect(Object.keys(second.requests)).toHaveLength(2);
  expect(second.collection[0].id).not.toBe(first.collection[0].id);
  expect(Object.keys(second.requests)).not.toContain(id);
});

it("invalidates an OpenAPI preview when its source or server changes and disables an empty selection", async () => {
  const panel = await open();
  await panel.get("select").setValue("openapi");
  await panel.get("textarea").setValue(JSON.stringify(openApiFixture()));
  await button(panel, "Preview OpenAPI").trigger("click");
  await vi.dynamicImportSettled();
  await button(panel, "Select none").trigger("click");
  expect(button(panel, "Import selected operations").attributes("disabled")).toBeDefined();
  await button(panel, "Select all").trigger("click");
  expect(button(panel, "Import selected operations").attributes("disabled")).toBeUndefined();

  await panel.get('input[type="url"]').setValue("https://staging.example.com/api");
  expect(panel.find('[aria-label="OpenAPI operations"]').exists()).toBe(false);
  await button(panel, "Preview OpenAPI").trigger("click");
  await vi.dynamicImportSettled();
  expect(panel.get('[aria-label="OpenAPI operations"]').text()).toContain("https://staging.example.com/api/users/42");
  await panel.get("textarea").setValue("openapi: [invalid");
  expect(panel.find('[aria-label="OpenAPI operations"]').exists()).toBe(false);
  await button(panel, "Preview OpenAPI").trigger("click");
  await vi.dynamicImportSettled();
  expect(panel.find('[role="alert"]').exists()).toBe(true);
  expect(panel.emitted("import")).toBeUndefined();
});

it("loads YAML and requires an explicit target for relative OpenAPI servers", async () => {
  const panel = await open();
  const yaml = "openapi: 3.1.0\ninfo: {title: Local API, version: '1'}\nservers: [{url: /api}]\npaths:\n  /health:\n    get:\n      responses: {'200': {description: OK}}\n";
  const input = panel.get('input[type="file"]');
  expect(input.attributes("accept")).toContain(".yaml");
  Object.defineProperty(input.element, "files", { configurable: true, value: [
    { name: "openapi.yaml", size: yaml.length, text: async () => yaml },
  ] });
  await input.trigger("change");
  await flushPromises();
  await button(panel, "Import").trigger("click");
  await vi.dynamicImportSettled();
  expect(panel.find('[role="alert"]').exists()).toBe(true);
  expect(panel.emitted("import")).toBeUndefined();
  await panel.get('input[type="url"]').setValue("http://localhost:8080/api");
  await button(panel, "Preview OpenAPI").trigger("click");
  await vi.dynamicImportSettled();
  await button(panel, "Import selected operations").trigger("click");
  const imported = panel.emitted("import")![0][0] as CollectionImport;
  expect(Object.values(imported.requests)[0].path).toBe("http://localhost:8080/api/health");
});

it("automatically detects flow-style YAML without treating its opening brace as collection JSON", async () => {
  const panel = await open();
  await panel.get("textarea").setValue("{openapi: 3.1.0, info: {title: Flow API, version: '1'}, servers: [{url: 'https://example.com'}], paths: {/health: {get: {}}}}");
  await button(panel, "Import").trigger("click");
  await vi.dynamicImportSettled();
  expect(panel.find('[role="alert"]').exists()).toBe(false);
  expect(panel.get('[aria-label="OpenAPI operations"]').text()).toContain("GET /health");
  expect(panel.emitted("import")).toBeUndefined();
});

it("requires explicit credential inclusion and exports the prepared active request", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const panel = await open({
    activeRequest: { ...createRequest(), path: "{{baseUrl}}/api", auth: { type: "bearer", token: "{{token}}" } },
    environment: { id: "local", name: "Local", variables: [
      { name: "baseUrl", value: "https://example.com", enabled: true },
      { name: "token", value: "secret-token", enabled: true },
    ] },
  });
  expect(button(panel, "Copy active cURL").attributes("disabled")).toBeDefined();
  await panel.get('input[type="checkbox"]').setValue(true);
  await button(panel, "Copy active cURL").trigger("click");
  await flushPromises();
  const exported = importCurl(writeText.mock.calls[0][0]);
  expect(exported.path).toBe("https://example.com/api");
  expect(exported.headers).toContainEqual({ name: "Authorization", value: "Bearer secret-token", enabled: true });
  expect(panel.get('[role="status"]').text()).toContain("cURL command copied");
});

it("exports imported literal inputs without resolving the selected environment", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const panel = await open({ activeRequest: importCurl("curl -H 'X-Token: {{token}}' --data-raw '{{token}}' https://example.com"),
    environment: { id: "local", name: "Local", variables: [{ name: "token", value: "secret", enabled: true }] } });
  await panel.get('input[type="checkbox"]').setValue(true);
  await button(panel, "Copy active cURL").trigger("click");
  await flushPromises();
  const exported = importCurl(writeText.mock.calls[0][0]);
  expect(exported.inputMode).toBe("literal");
  expect(exported.body).toBe("{{token}}");
  expect(exported.headers).toContainEqual({ name: "X-Token", value: "{{token}}", enabled: true });
});

it("exports exact captured draft inputs before resolving the current editable fields or environment", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const panel = await open({ activeRequest: { ...createRequest(), path: "{{missing}}", timeoutMs: 0 },
    capturedRequest: { method: "POST", url: "https://captured.test/action", body: "{{token}}", timeoutMs: 5000,
      headers: [{ name: "X-Literal", value: "{{token}}" }] },
    environment: { id: "local", name: "Local", variables: [{ name: "token", value: "changed", enabled: true }] } });
  await panel.get('input[type="checkbox"]').setValue(true);
  await button(panel, "Copy active cURL").trigger("click");
  await flushPromises();
  const exported = importCurl(writeText.mock.calls[0][0]);
  expect(exported.path).toBe("https://captured.test/action");
  expect(exported.body).toBe("{{token}}");
  expect(exported.timeoutMs).toBe(5000);
  expect(exported.headers).toContainEqual({ name: "X-Literal", value: "{{token}}", enabled: true });
  expect(panel.find('[role="alert"]').exists()).toBe(false);
});

it("shows clipboard errors and leaves generated JSON available for manual copying", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("Clipboard denied")) } });
  const panel = await open();
  await panel.get('input[type="checkbox"]').setValue(true);
  await button(panel, "Copy collection JSON").trigger("click");
  await flushPromises();
  expect(panel.get('[role="alert"]').text()).toContain("Clipboard denied");
  const output = panel.get("textarea[readonly]").element.value;
  expect(JSON.parse(output)).toMatchObject({ kind: "api-tool-collection", version: 1 });
  expect(JSON.parse(output).requests.request.auth).toEqual({ type: "bearer", token: "saved-secret" });
});

it("reports unresolved environment variables when exporting cURL", async () => {
  const panel = await open({ activeRequest: { ...createRequest(), path: "{{missing}}/api" } });
  await panel.get('input[type="checkbox"]').setValue(true);
  await button(panel, "Copy active cURL").trigger("click");
  await flushPromises();
  expect(panel.get('[role="alert"]').text()).toContain('"missing" is not defined');
});

it("loads a file for review before importing and reports file read errors", async () => {
  const panel = await open();
  const file = { name: "request.curl", size: 30, text: vi.fn().mockResolvedValue("curl https://example.com") };
  const input = panel.get('input[type="file"]');
  Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
  await input.trigger("change");
  await flushPromises();
  expect(panel.get("textarea").element.value).toBe("curl https://example.com");
  expect(panel.emitted("import")).toBeUndefined();
  expect(panel.get('[role="status"]').text()).toContain("Review the text");
  file.text.mockRejectedValue(new Error("Permission denied"));
  await input.trigger("change");
  await flushPromises();
  expect(panel.get('[role="alert"]').text()).toContain("Permission denied");
});

it("preserves later pasted import text when an earlier file finishes loading", async () => {
  const panel = await open();
  const pasted = "curl https://example.com/later-paste";
  let completeRead!: (text: string) => void;
  const text = new Promise<string>(resolve => { completeRead = resolve; });
  const input = panel.get('input[type="file"]');
  Object.defineProperty(input.element, "files", { configurable: true, value: [
    { name: "earlier.curl", size: 64, text: () => text },
  ] });
  await input.trigger("change");
  expect(panel.get('[role="status"]').text()).toContain("Reading earlier.curl");
  expect(button(panel, "Import").attributes("disabled")).toBeDefined();
  await panel.get("textarea").setValue(pasted);

  completeRead("curl https://example.com/earlier-file");
  await flushPromises();
  expect(panel.get("textarea").element.value).toBe(pasted);
  expect(panel.get('[role="status"]').text()).toContain("import text changed");
  expect(input.attributes("disabled")).toBeUndefined();
  await button(panel, "Import").trigger("click");
  const imported = panel.emitted("import")![0][0] as CollectionImport;
  expect(Object.values(imported.requests)[0].path).toBe("https://example.com/later-paste");
});

it("downloads portable JSON and reports download failures", async () => {
  const createObjectURL = vi.fn().mockReturnValue("blob:collection");
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  const panel = await open();
  await panel.get('input[type="checkbox"]').setValue(true);
  await button(panel, "Download collection JSON").trigger("click");
  expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect(click).toHaveBeenCalledOnce();
  expect(document.querySelector('a[download]')).toBeNull();
  expect(panel.get('[role="status"]').text()).toContain("download started");
  createObjectURL.mockImplementation(() => { throw new Error("Downloads unavailable"); });
  await button(panel, "Download collection JSON").trigger("click");
  expect(panel.get('[role="alert"]').text()).toContain("Downloads unavailable");
});

type PanelWrapper = ReturnType<typeof mount<typeof ImportExport>>;
type PanelProps = InstanceType<typeof ImportExport>["$props"];
const mounted: PanelWrapper[] = [];

function fixture() {
  const requests = { request: { ...createRequest("Saved"), auth: { type: "bearer" as const, token: "saved-secret" } } };
  const nodes: CollectionNode[] = [{ kind: "folder", id: "folder", name: "Folder", children: [
    { kind: "request", id: "request", name: "Saved", requestType: "GET" },
  ] }];
  return { requests, nodes };
}

function openApiFixture() {
  return {
    openapi: "3.0.3", info: { title: "Users API", version: "1" }, servers: [{ url: "https://example.com/v1" }],
    paths: {
      "/users/{id}": { get: { summary: "Get user", tags: ["Users"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", example: 42 } }],
        responses: { "200": { description: "User" } },
      } },
      "/users": { post: { summary: "Create user", tags: ["Users"], responses: { "201": { description: "Created" } } } },
    },
  };
}

function render(overrides: Partial<PanelProps> = {}) {
  const wrapper = mount(ImportExport, { attachTo: document.body, props: { ...fixture(), ...overrides } });
  mounted.push(wrapper);
  return wrapper;
}

async function open(overrides: Partial<PanelProps> = {}) {
  const wrapper = render(overrides);
  await button(wrapper, "Import / Export").trigger("click");
  return wrapper;
}

function button(wrapper: PanelWrapper, text: string) {
  return wrapper.findAll("button").find(button => button.text() === text)!;
}
