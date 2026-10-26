// Verifies controlled request settings, ordered row edits, and execution intents through the rendered interface.
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it } from "vitest";
import { createRequest, type RequestAuth, type RequestData } from "../src/request";
import RequestEditor from "../src/components/RequestEditor.vue";
import RequestFields from "../src/components/RequestFields.vue";
import BodyText from "../src/components/BodyText.vue";
import { editorView, replaceText } from "./editor";
import { importCurl } from "../src/interchange";
import { prepareRequest } from "../src/prepareRequest";
import { bodyText, isBodyDocument } from "../src/bodyDocument";

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
});

it("edits URL and standard or custom methods without mutating the supplied request", async () => {
  const request = createRequest();
  const fields = renderFields(request);
  await fields.get('[aria-label="Request URL"]').setValue("{{baseUrl}}/items");
  expect(lastRequest(fields).path).toBe("{{baseUrl}}/items");
  expect(request.path).toBe("http://localhost:8080");
  await fields.get('.method-field input').setValue("PROPFIND");
  expect(lastRequest(fields).method).toBe("PROPFIND");
  await fields.get('.method-field input').trigger("keydown", { key: "Escape" });
  await fields.get('[aria-label="Show HTTP methods"]').trigger("click");
  await new DOMWrapper(document.body).findAll('[role="option"]').find(option => option.text().startsWith("POST"))!.trigger("click");
  expect(lastRequest(fields).method).toBe("POST");
  expect(request.method).toBe("GET");
  expect(document.querySelector('[role="listbox"][aria-label="HTTP methods"]')).toBeNull();
});

it("keeps duplicate header names, row order and disabled values through row operations", async () => {
  const request = createRequest();
  request.headers = [
    { name: "X-Tag", value: "first", enabled: true },
    { name: "X-Tag", value: "second", enabled: true },
  ];
  const fields = renderEditor(request);
  await fields.setProps({ 'onUpdate:modelValue': value => { void fields.setProps({ modelValue: value }); } });
  await settingsTab(fields, "Headers (2)").trigger("click");
  await fields.get('[aria-label="Enable header 1"]').setValue(false);
  await fields.get('[aria-label="header 2 value"]').setValue("updated");
  expect(lastRequest(fields).headers).toEqual([
    { name: "X-Tag", value: "first", enabled: false },
    { name: "X-Tag", value: "updated", enabled: true },
  ]);
  await fields.findAll("button").find(button => button.text() === "Add header")!.trigger("click");
  await fields.get('[aria-label="header 3 name"]').setValue("Another");
  await fields.get('[aria-label="Remove header 2"]').trigger("click");
  expect(lastRequest(fields).headers).toEqual([
    { name: "X-Tag", value: "first", enabled: false },
    { name: "Another", value: "", enabled: true },
  ]);
  expect(request.headers[0].enabled).toBe(true);
  expect(request.headers[1].value).toBe("second");
});

it("adds query parameters separately and accepts only positive integer timeouts", async () => {
  const fields = renderEditor(createRequest());
  await fields.setProps({ 'onUpdate:modelValue': value => { void fields.setProps({ modelValue: value }); } });
  await settingsTab(fields, "Parameters (0)").trigger("click");
  await fields.findAll("button").find(button => button.text() === "Add query parameter")!.trigger("click");
  await fields.get('[aria-label="query parameter 1 name"]').setValue("tag");
  await fields.get('[aria-label="query parameter 1 value"]').setValue("a & b");
  expect(lastRequest(fields).query).toEqual([{ name: "tag", value: "a & b", enabled: true }]);
  expect(lastRequest(fields).headers).toEqual([]);
  const count = fields.emitted("update:modelValue")!.length;
  await settingsTab(fields, "Advanced").trigger("click");
  for (const value of ["0", "-1", "1.5", "", "2147483648"]) await fields.get('input[type="number"]').setValue(value);
  expect(fields.emitted("update:modelValue")).toHaveLength(count);
  await fields.get('input[type="number"]').setValue("1200");
  expect(lastRequest(fields).timeoutMs).toBe(1200);
});

it("shows literal URL parameters alongside additional rows without rewriting either source", async () => {
  const path = "https://example.com/items?tag=first&tag=a%20b&flag&empty=&=unnamed&token={{token}}#ignored=fragment";
  const request = {
    ...createRequest(), path,
    query: [{ name: "tag", value: "additional", enabled: false }],
  };
  const editor = renderEditor(request);
  await editor.setProps({
    environment: { id: "local", name: "Local", variables: [{ name: "token", value: "secret", enabled: true }] },
    'onUpdate:modelValue': value => { void editor.setProps({ modelValue: value }); },
  });
  await settingsTab(editor, "Parameters (7)").trigger("click");
  expect(editor.get('[aria-label="Parameters from URL"]').isVisible()).toBe(true);
  expect(editor.findAll(".url-parameters tbody tr").map(row => row.findAll("td").map(cell => cell.text()))).toEqual([
    ["tag", "first"], ["tag", "a%20b"], ["flag", "No equals sign"],
    ["empty", "Empty value"], ["Empty name", "unnamed"], ["token", "{{token}}"],
  ]);
  expect(editor.get('[aria-label="Additional query parameters"]').isVisible()).toBe(true);
  expect(editor.get('[aria-label="Enable query parameter 1"]').element.checked).toBe(false);
  expect(editor.emitted("update:modelValue")).toBeUndefined();
  expect(editor.get('[aria-label="Request URL"]').element.value).toBe(path);

  await editor.get('[aria-label="query parameter 1 value"]').setValue("changed");
  expect(lastRequest(editor).path).toBe(path);
  expect(lastRequest(editor).query).toEqual([{ name: "tag", value: "changed", enabled: false }]);
  expect(request.query[0].value).toBe("additional");
});

it("focuses the original URL query for editing and updates the parameter count after a URL edit", async () => {
  const path = "https://example.com/items?tag=a+b&tag=%2f#section";
  const editor = renderEditor({ ...createRequest(), path });
  await editor.setProps({ 'onUpdate:modelValue': value => { void editor.setProps({ modelValue: value }); } });
  await settingsTab(editor, "Parameters (2)").trigger("click");
  await editor.findAll("button").find(button => button.text() === "Edit URL parameters")!.trigger("click");
  const url = editor.get<HTMLInputElement>('[aria-label="Request URL"]');
  expect(document.activeElement).toBe(url.element);
  expect(url.element.value.slice(url.element.selectionStart!, url.element.selectionEnd!)).toBe("tag=a+b&tag=%2f");
  expect(editor.emitted("update:modelValue")).toBeUndefined();

  await url.setValue("https://example.com/items?single=1#section");
  expect(settingsTab(editor, "Parameters (1)").attributes("aria-selected")).toBe("true");
  expect(editor.findAll(".url-parameters tbody tr")).toHaveLength(1);
  expect(editor.get(".url-parameters tbody").text()).toBe("single1");
  expect(lastRequest(editor).query).toEqual([]);

  await url.setValue("https://example.com/items#section?ignored=1");
  expect(settingsTab(editor, "Parameters (0)").attributes("aria-selected")).toBe("true");
  expect(editor.find('[aria-label="Parameters from URL"]').exists()).toBe(false);
});

it("bounds a large URL parameter table and reveals its final source parameter by scrolling", async () => {
  const path = `https://example.test/?${Array.from({ length: 1000 }, (_, index) => `name-${index}=value-${index}`).join("&")}`;
  const editor = renderEditor({ ...createRequest(), path });
  await settingsTab(editor, "Parameters (1000)").trigger("click");
  const table = editor.get('[role="table"][aria-label="Parameters written in URL"]');
  expect(table.attributes("aria-rowcount")).toBe("1001");
  expect(table.findAll('[role="row"]').length).toBeLessThan(40);
  const viewport = table.get('.virtual-rows');
  viewport.element.scrollTop = 32 * 1000;
  await viewport.trigger("scroll");
  expect(table.text()).toContain("name-999");
  expect(table.text()).toContain("value-999");
});

it("reveals an invalid header beyond the mounted rows before allowing Send", async () => {
  const headers = Array.from({ length: 1000 }, (_, index) => ({ name: index === 999 ? "Bad Name" : `X-Item-${index}`, value: "ok", enabled: true }));
  const editor = renderEditor({ ...createRequest(), headers });
  expect(editor.find('[aria-label="header 1000 name"]').exists()).toBe(false);
  await editor.get('.send-button').trigger("click");
  await flushPromises();
  expect(editor.emitted("send")).toBeUndefined();
  expect(settingsTab(editor, "Headers (1000)").attributes("aria-selected")).toBe("true");
  expect(editor.get('[aria-label="header 1000 name"]').element).toBe(document.activeElement);
});

it("uses ordinary URL parameter boundaries for literal input mode", async () => {
  const path = "https://example.com/?value={{first&second}}";
  const editor = renderEditor({ ...createRequest(), path, inputMode: "literal" });
  await settingsTab(editor, "Parameters (2)").trigger("click");
  expect(editor.findAll(".url-parameters tbody tr").map(row => row.findAll("td").map(cell => cell.text()))).toEqual([
    ["value", "{{first"], ["second}}", "No equals sign"],
  ]);
  expect(editor.get('[aria-label="Request URL"]').element.value).toBe(path);
  expect(editor.emitted("update:modelValue")).toBeUndefined();
});

it("switches captured query syntax back to template syntax only when captured replay clears", async () => {
  const path = "https://example.com/?value={{first&second}}";
  const editor = renderEditor({ ...createRequest(), path, inputMode: "template" });
  await editor.setProps({ capturedRequest: {
    method: "GET", url: path, body: "", headers: [], timeoutMs: 30000,
  } });
  await settingsTab(editor, "Parameters (2)").trigger("click");
  expect(editor.findAll(".url-parameters tbody tr")).toHaveLength(2);

  await editor.setProps({ capturedRequest: undefined });
  expect(settingsTab(editor, "Parameters (1)").attributes("aria-selected")).toBe("true");
  expect(editor.findAll(".url-parameters tbody tr").map(row => row.findAll("td").map(cell => cell.text()))).toEqual([
    ["value", "{{first&second}}"],
  ]);
  expect(editor.get('[aria-label="Request URL"]').element.value).toBe(path);
  expect(editor.emitted("update:modelValue")).toBeUndefined();
});

it("emits send from its button and keyboard shortcut, and offers explicit cancellation while running", async () => {
  const editor = mount(RequestEditor, { attachTo: document.body, props: { modelValue: createRequest() } });
  mounted.push(editor);
  await editor.get(".send-button").trigger("click");
  await editor.get('[aria-label="Request URL"]').trigger("keydown", { key: "Enter", ctrlKey: true });
  await editor.trigger("keydown", { key: "Enter", metaKey: true });
  await editor.trigger("keydown", { key: "Enter" });
  expect(editor.emitted("send")).toHaveLength(3);
  await editor.setProps({ execution: { status: "running", startedAt: new Date().toISOString() } });
  expect(editor.get(".send-button").attributes("disabled")).toBeDefined();
  await editor.trigger("keydown", { key: "Enter", ctrlKey: true });
  expect(editor.emitted("send")).toHaveLength(3);
  await editor.get(".cancel-button").trigger("click");
  expect(editor.emitted("cancel")).toHaveLength(1);
});

it("forwards pane preference changes to the workspace and keeps content type as its first select", async () => {
  const editor = mount(RequestEditor, {
    attachTo: document.body,
    props: {
      modelValue: { ...createRequest(), method: "POST" },
      execution: { status: "running", startedAt: new Date().toISOString() },
      layout: { horizontal: "60%", vertical: "55%" },
    },
  });
  mounted.push(editor);
  expect(editor.get("select").element.value).toBe("application/json");
  await editor.get("select").setValue("text/plain");
  expect((editor.emitted("update:modelValue")!.at(-1)![0] as RequestData).contentType).toBe("text/plain");
  await editor.get('[role="separator"]').trigger("keydown", { key: "ArrowDown" });
  expect(editor.emitted("update:layout")).toHaveLength(1);
});

it("blocks sending while the visible timeout control is invalid", async () => {
  const editor = mount(RequestEditor, { attachTo: document.body, props: { modelValue: createRequest() } });
  mounted.push(editor);
  await settingsTab(editor, "Advanced").trigger("click");
  await editor.get('input[type="number"]').setValue("0");
  await settingsTab(editor, "Headers (0)").trigger("click");
  await editor.get(".send-button").trigger("click");
  expect(settingsTab(editor, "Advanced").attributes("aria-selected")).toBe("true");
  expect(editor.get('input[type="number"]').element).toBe(document.activeElement);
  await editor.trigger("keydown", { key: "Enter", ctrlKey: true });
  expect(editor.emitted("send")).toBeUndefined();
  await editor.get('input[type="number"]').setValue("30000");
  await editor.get(".send-button").trigger("click");
  expect(editor.emitted("send")).toHaveLength(1);
});

it("opens collapsed authentication settings before revealing an invalid credential", async () => {
  const editor = renderEditor({ ...createRequest(), auth: { type: "bearer", token: "{{missingToken}}" } });
  await settingsTab(editor, "Auth").trigger("click");
  await editor.get(".auth-editor summary").trigger("click");
  expect(editor.get(".auth-editor").attributes("open")).toBeUndefined();
  await settingsTab(editor, "Body").trigger("click");
  await editor.get(".send-button").trigger("click");

  const token = editor.get('input[type="password"]');
  expect(editor.emitted("send")).toBeUndefined();
  expect(settingsTab(editor, "Auth").attributes("aria-selected")).toBe("true");
  expect(token.isVisible()).toBe(true);
  expect(editor.get(".auth-editor").attributes("open")).toBeDefined();
  expect(document.activeElement).toBe(token.element);
});

it("blocks invalid methods and preserves Send shortcuts while the method menu is open", async () => {
  const editor = renderEditor({ ...createRequest(), method: "GE T" });
  const method = editor.get<HTMLInputElement>('.method-field [role="combobox"]');
  expect(method.element.validity.valid).toBe(false);
  await editor.get(".send-button").trigger("click");
  expect(editor.emitted("send")).toBeUndefined();
  expect(document.activeElement).toBe(method.element);

  await editor.setProps({ modelValue: { ...createRequest(), method: "PROPFIND" } });
  expect(method.element.validity.valid).toBe(true);
  await method.trigger("click");
  await method.trigger("keydown", { key: "ArrowDown" });
  expect(document.querySelector('[role="listbox"][aria-label="HTTP methods"]')).not.toBeNull();
  await method.trigger("keydown", { key: "Enter", ctrlKey: true });
  await method.trigger("keydown", { key: "Enter", metaKey: true });
  expect(editor.emitted("send")).toHaveLength(2);
  expect(editor.emitted("update:modelValue")).toBeUndefined();
  expect(method.element.value).toBe("PROPFIND");
});

it("keeps empty GET bodies compact and preserves body editor identity when changing settings", async () => {
  const editor = renderEditor(createRequest());
  expect(editor.get(".empty-body").isVisible()).toBe(true);
  expect(editor.get(".body-content").isVisible()).toBe(false);
  const view = editorView(editor.element);
  await editor.findAll("button").find(button => button.text() === "Add body")!.trigger("click");
  expect(editor.get(".body-content").isVisible()).toBe(true);
  expect(editor.emitted("update:modelValue")).toBeUndefined();
  await replaceText(editor.element, "draft body");
  view.dispatch({ selection: { anchor: 5 } });
  await settingsTab(editor, "Headers (0)").trigger("click");
  expect(editor.get(".body-content").isVisible()).toBe(false);
  await settingsTab(editor, "Body").trigger("click");
  expect(editorView(editor.element)).toBe(view);
  expect(view.state.doc.toString()).toBe("draft body");
  expect(view.state.selection.main.anchor).toBe(5);
  expect(isBodyDocument(lastRequest(editor).body)).toBe(true);
  expect(bodyText(lastRequest(editor).body)).toBe("draft body");
});

it("shows bodies immediately for POST and for GET requests with an existing body", async () => {
  const request = { ...createRequest(), method: "POST" };
  const editor = renderEditor(request);
  expect(editor.get(".body-content").isVisible()).toBe(true);
  await editor.setProps({ modelValue: { ...request, method: "GET", body: "existing body" } });
  expect(editor.get(".body-content").isVisible()).toBe(true);
});

it("keeps protobuf setup in Advanced and links bound bodies to their configuration", async () => {
  const request = { ...createRequest(), method: "POST" };
  const editor = renderEditor(request);
  const view = editorView(editor.get('.body-text').element);
  expect(editor.get('.protobuf-settings').isVisible()).toBe(false);
  await settingsTab(editor, "Advanced").trigger("click");
  expect(editor.get('.protobuf-settings').isVisible()).toBe(true);
  expect(editor.get('.protobuf-settings').text()).toContain('Protobuf completion');

  await editor.setProps({ modelValue: { ...request, protobuf: { sourceId: "models", messageName: "demo.Request" } } });
  await settingsTab(editor, "Body").trigger("click");
  await editor.get('.protobuf-context').trigger("click");
  expect(settingsTab(editor, "Advanced").attributes('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(editor.get('.protobuf-settings h3').element);
  await settingsTab(editor, "Body").trigger("click");
  expect(editorView(editor.get('.body-text').element)).toBe(view);
  expect(editor.emitted('update:modelValue')).toBeUndefined();
});

it("keeps empty GET and HEAD settings compact until another section or a body is opened", async () => {
  for (const method of ["GET", "HEAD"]) {
    const editor = renderEditor({ ...createRequest(), method });
    await editor.setProps({ execution: { status: "running", startedAt: new Date().toISOString() } });
    const divider = editor.get('[role="separator"]');
    expect(divider.isVisible()).toBe(false);
    expect(editor.get(".empty-body").isVisible()).toBe(true);

    await settingsTab(editor, "Headers (0)").trigger("click");
    expect(divider.isVisible()).toBe(true);
    await settingsTab(editor, "Body").trigger("click");
    expect(divider.isVisible()).toBe(false);
    await editor.findAll("button").find(button => button.text() === "Add body")!.trigger("click");
    expect(divider.isVisible()).toBe(true);
    expect(editor.get(".body-content").isVisible()).toBe(true);
    expect(editor.emitted("update:modelValue")).toBeUndefined();
    expect(editor.emitted("update:layout")).toBeUndefined();
  }
});

it("compacts an idle response and restores user divider preferences when both panes are useful", async () => {
  const request = { ...createRequest(), method: "POST" };
  const editor = renderEditor(request);
  const divider = editor.get('[role="separator"]');
  expect(divider.isVisible()).toBe(false);
  expect(editor.get(".body-content").isVisible()).toBe(true);
  expect(editor.get(".response-inspector").text()).toContain("Send a request");

  const running = { status: "running" as const, startedAt: new Date().toISOString() };
  await editor.setProps({ execution: running });
  expect(divider.isVisible()).toBe(true);
  await divider.trigger("keydown", { key: "ArrowDown" });
  const preferredSize = divider.attributes("aria-valuetext");
  const changes = editor.emitted("update:layout")!.length;

  await editor.setProps({ execution: { status: "idle" } });
  expect(divider.isVisible()).toBe(false);
  await editor.setProps({ execution: running });
  expect(divider.isVisible()).toBe(true);
  expect(divider.attributes("aria-valuetext")).toBe(preferredSize);
  await editor.setProps({ modelValue: { ...request, method: "GET" } });
  expect(divider.isVisible()).toBe(false);
  await settingsTab(editor, "Headers (0)").trigger("click");
  expect(divider.isVisible()).toBe(true);
  expect(divider.attributes("aria-valuetext")).toBe(preferredSize);
  expect(editor.emitted("update:layout")).toHaveLength(changes);
});

it("offers keyboard navigation and linked settings panels without adding tab stops for inactive tabs", async () => {
  const editor = renderEditor(createRequest());
  const bodyTab = settingsTab(editor, "Body");
  const headerTab = settingsTab(editor, "Headers (0)");
  expect(bodyTab.attributes("tabindex")).toBe("0");
  expect(headerTab.attributes("tabindex")).toBe("-1");
  await bodyTab.trigger("keydown", { key: "ArrowRight" });
  expect(headerTab.attributes("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(headerTab.element);
  const panel = document.getElementById(headerTab.attributes("aria-controls"))!;
  expect(panel.getAttribute("aria-labelledby")).toBe(headerTab.attributes("id"));
  expect(panel.style.display).not.toBe("none");
  await headerTab.trigger("keydown", { key: "End" });
  expect(settingsTab(editor, "Advanced").attributes("aria-selected")).toBe("true");
  await settingsTab(editor, "Advanced").trigger("keydown", { key: "ArrowRight" });
  expect(bodyTab.attributes("aria-selected")).toBe("true");
});

it("shows an explicit Content-Type header as the authoritative body format", async () => {
  const request = createRequest();
  request.body = '{"message":"text"}';
  request.headers = [{ name: "content-TYPE", value: "text/plain", enabled: true }];
  const editor = mount(RequestEditor, { attachTo: document.body, props: { modelValue: request } });
  mounted.push(editor);
  expect(editor.get("select").element.value).toBe("text/plain");
  expect(editor.get("select").attributes("disabled")).toBeDefined();
  const explanation = editor.get(`[id="${editor.get("select").attributes("aria-describedby")}"]`);
  expect(explanation.isVisible()).toBe(true);
  expect(explanation.text()).toBe("Set by the enabled Content-Type header.");
  expect(editor.findAll("button").map(button => button.text())).not.toContain("Format JSON");

  await editor.setProps({ modelValue: { ...request, headers: [{ ...request.headers[0], enabled: false }] } });
  expect(editor.get("select").element.value).toBe("application/json");
  expect(editor.get("select").attributes("disabled")).toBeUndefined();
  expect(editor.get("select").attributes("aria-describedby")).toBeUndefined();
  expect(editor.text()).not.toContain("Set by the enabled Content-Type header");
  expect(editor.findAll("button").map(button => button.text())).toContain("Format JSON");
});

it("switches body and protobuf tooling with resolved header MIME values even while URL and body variables are incomplete", async () => {
  const request = { ...createRequest(), method: "POST", path: "{{missingUrl}}", body: "{{missingBody}}",
    headers: [{ name: "{{headerName}}", value: "{{mime}}", enabled: true }],
    protobuf: { sourceId: "models", messageName: "demo.Request" } };
  const editor = renderEditor(request);
  const sources = [{ id: "models", name: "Models", rootPath: "/models", includePaths: [] }];
  const states = { models: { loading: false, catalog: { messages: { "demo.Request": [] }, enums: {} } } };
  const environment = { id: "local", name: "Local", variables: [
    { name: "headerName", value: "Content-Type", enabled: true },
    { name: "mime", value: "application/json", enabled: true },
  ] };
  await editor.setProps({ environment, protobufSources: sources, protobufStates: states });
  expect(editor.getComponent(BodyText).props("contentType")).toBe("application/json");
  expect(editor.getComponent(BodyText).props("protobufContext")?.messageName).toBe("demo.Request");
  expect(editor.get("select").attributes("disabled")).toBeDefined();
  expect(editor.findAll("button").map(button => button.text())).toContain("Format JSON");

  await editor.setProps({ environment: { ...environment, name: "Other", variables: [environment.variables[0],
    { name: "mime", value: "text/plain", enabled: true },
  ] } });
  expect(editor.getComponent(BodyText).props("contentType")).toBe("text/plain");
  expect(editor.getComponent(BodyText).props("protobufContext")).toBeUndefined();
  expect(editor.findAll("button").map(button => button.text())).not.toContain("Format JSON");
  expect(editor.emitted("update:modelValue")).toBeUndefined();
});

it("uses resolved defaults, authentication overrides, and captured MIME with the same precedence as Send", async () => {
  const request = { ...createRequest(), method: "POST", body: "{}", contentType: "{{mime}}" };
  const editor = renderEditor(request);
  await editor.setProps({ environment: { id: "local", name: "Local", variables: [
    { name: "mime", value: "application/json", enabled: true },
  ] } });
  expect(editor.getComponent(BodyText).props("contentType")).toBe("application/json");
  expect(editor.get("select").attributes("disabled")).toBeUndefined();

  await editor.setProps({ modelValue: { ...request, headers: [{ name: "Content-Type", value: "text/plain", enabled: true }],
    auth: { type: "api-key", location: "header", name: "Content-Type", value: "{{mime}}" } } });
  expect(editor.getComponent(BodyText).props("contentType")).toBe("application/json");
  expect(editor.text()).toContain("Set by the authentication Content-Type header.");

  await editor.setProps({ capturedRequest: { method: "POST", url: "https://captured.test/", body: "{}",
    headers: [{ name: "content-TYPE", value: "text/plain" }], timeoutMs: 5000 } });
  expect(editor.getComponent(BodyText).props("contentType")).toBe("text/plain");
  expect(editor.text()).toContain("Set by the captured Content-Type header.");
  expect(editor.findAll("button").map(button => button.text())).not.toContain("Format JSON");
});

it("reveals the specific invalid settings field on Send and forwards its environment action", async () => {
  const request = {
    ...createRequest(),
    headers: [{ name: "X-Token", value: "{{missing}}", enabled: true }],
  };
  const editor = renderEditor(request);
  await editor.get(".send-button").trigger("click");
  expect(editor.emitted("send")).toBeUndefined();
  expect(settingsTab(editor, "Headers (1)").attributes("aria-selected")).toBe("true");
  const value = editor.get('[aria-label="header 1 value"]');
  expect(value.element).toBe(document.activeElement);
  expect(value.attributes("aria-invalid")).toBe("true");
  const field = value.element.closest(".variable-input")!;
  expect(field.textContent).toContain('Environment variable "missing" is not defined.');
  await editor.get(".key-value-editor .field-error button").trigger("click");
  expect(editor.emitted("edit-environment")).toHaveLength(1);

  await editor.setProps({ modelValue: { ...request, headers: [{ ...request.headers[0], enabled: false }] } });
  await editor.get(".send-button").trigger("click");
  expect(editor.emitted("send")).toHaveLength(1);
});

it("keeps captured placeholders literal across all editable fields until captured replay is cleared", async () => {
  const request = {
    ...createRequest(), path: "https://captured.example.com/",
    headers: [{ name: "X-Token", value: "{{literal}}", enabled: true }],
    query: [{ name: "query", value: "{{literal}}", enabled: true }],
    auth: { type: "bearer" as const, token: "{{literal}}" },
  };
  const editor = renderEditor(request);
  await editor.setProps({ capturedRequest: {
    method: "GET", url: request.path, body: "", headers: [{ name: "X-Token", value: "{{literal}}" }], timeoutMs: 30000,
  } });
  expect(editor.findAll('[aria-invalid="true"]')).toHaveLength(0);
  await editor.get(".send-button").trigger("click");
  expect(editor.emitted("send")).toHaveLength(1);

  await editor.setProps({ capturedRequest: undefined });
  await editor.get(".send-button").trigger("click");
  expect(editor.emitted("send")).toHaveLength(1);
  expect(settingsTab(editor, "Headers (1)").attributes("aria-selected")).toBe("true");
  expect(editor.get('[aria-label="header 1 value"]').attributes("aria-invalid")).toBe("true");
});

it("keeps imported inputs literal through normal edits and makes environment templates an explicit choice", async () => {
  const request = importCurl("curl -H 'X-Token: {{token}}' -u '{{token}}:{{token}}' --data-raw '{{token}}' https://example.com");
  request.query = [{ name: "token", value: "{{token}}", enabled: true }];
  const environment = { id: "local", name: "Local", variables: [{ name: "token", value: "secret", enabled: true }] };
  const editor = renderEditor(request);
  await editor.setProps({ environment, 'onUpdate:modelValue': value => { void editor.setProps({ modelValue: value }); } });
  expect(editor.get(".input-mode-summary").text()).toBe("Inputs: Literal text");
  expect(editor.findAll('[aria-invalid="true"]')).toHaveLength(0);
  await editor.get('[aria-label="header 1 value"]').setValue("edited {{token}}");
  expect(lastRequest(editor).inputMode).toBe("literal");
  expect(prepareRequest(lastRequest(editor), environment).headers).toContainEqual({ name: "X-Token", value: "edited {{token}}" });
  await editor.get(".send-button").trigger("click");
  expect(editor.emitted("send")).toHaveLength(1);

  await editor.get(".input-mode-summary").trigger("click");
  expect(settingsTab(editor, "Advanced").attributes("aria-selected")).toBe("true");
  await editor.get(".input-mode-field select").setValue("template");
  expect(lastRequest(editor).inputMode).toBe("template");
  expect(prepareRequest(lastRequest(editor), environment).headers).toContainEqual({ name: "X-Token", value: "edited secret" });
  expect(editor.get(".input-mode-summary").text()).toBe("Inputs: Environment template");
});

it("reveals an untouched empty header's local error when Send focuses the invalid field", async () => {
  const editor = renderEditor({ ...createRequest(), headers: [{ name: "", value: "", enabled: true }] });
  const name = editor.get('[aria-label="header 1 name"]');
  expect(editor.find(".key-value-editor .field-error").exists()).toBe(false);
  expect(name.attributes("aria-invalid")).toBe("true");
  await editor.get(".send-button").trigger("click");
  expect(editor.emitted("send")).toBeUndefined();
  expect(settingsTab(editor, "Headers (1)").attributes("aria-selected")).toBe("true");
  expect(name.element).toBe(document.activeElement);
  expect(editor.get(".key-value-editor .field-error").text()).toContain("HTTP tokens");
});

it.each([
  { type: "bearer", token: "token" },
  { type: "basic", username: "person", password: "password" },
  { type: "api-key", location: "header", name: "{{authHeader}}", value: "key" },
] satisfies RequestAuth[])("validates the sent authentication header while still resolving replaced $type header definitions", async auth => {
  const request = {
    ...createRequest(), auth,
    headers: [
      { name: auth.type === "api-key" ? "{{authHeader}}" : "authorization", value: "ignored emoji🔒", enabled: true },
      { name: "Invalid disabled name", value: "{{missingDisabled}}", enabled: false },
    ],
  };
  const editor = renderEditor(request);
  await editor.setProps({ environment: {
    id: "local", name: "Local", variables: [{ name: "authHeader", value: "X-Key", enabled: true }],
  } });
  expect(editor.get('[aria-label="header 1 value"]').attributes("aria-invalid")).toBeUndefined();
  expect(editor.get('[aria-label="header 2 name"]').attributes("aria-invalid")).toBeUndefined();
  expect(editor.get('[aria-label="header 2 value"]').attributes("aria-invalid")).toBeUndefined();
  await editor.get(".send-button").trigger("click");
  expect(editor.emitted("send")).toHaveLength(1);

  await editor.setProps({ modelValue: { ...request, headers: [{ ...request.headers[0], value: "{{missing}}" }] } });
  await editor.get(".send-button").trigger("click");
  expect(editor.emitted("send")).toHaveLength(1);
  expect(editor.get('[aria-label="header 1 value"]').attributes("aria-invalid")).toBe("true");
});

type FieldsWrapper = ReturnType<typeof mount<typeof RequestFields>>;
type EditorWrapper = ReturnType<typeof mount<typeof RequestEditor>>;
const mounted: Array<{ unmount(): void }> = [];

function renderFields(modelValue: RequestData) {
  const fields = mount(RequestFields, { attachTo: document.body, props: { modelValue } });
  mounted.push(fields);
  return fields;
}

function renderEditor(modelValue: RequestData) {
  const editor = mount(RequestEditor, { attachTo: document.body, props: { modelValue } });
  mounted.push(editor);
  return editor;
}

function settingsTab(editor: EditorWrapper, label: string) {
  return editor.findAll('[role="tab"]').find(tab => tab.text() === label)!;
}

function lastRequest(fields: FieldsWrapper | EditorWrapper) {
  return fields.emitted("update:modelValue")!.at(-1)![0] as RequestData;
}
