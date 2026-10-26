// Verifies AuthEditor's controlled updates, per-mode input recovery, and credential privacy through the UI.
import { mount } from "@vue/test-utils";
import { h, KeepAlive, nextTick, reactive, ref } from "vue";
import { afterEach, expect, it } from "vitest";
import AuthEditor from "../src/components/AuthEditor.vue";
import type { RequestAuth } from "../src/request";

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

it("offers every authentication mode and initializes modes without mutating parent credentials", async () => {
  const auth: RequestAuth = { type: "bearer", token: "secret" };
  const editor = render(auth);
  expect(editor.findAll("select option").map(option => option.text())).toEqual(["None", "Bearer token", "Basic", "API key"]);
  await editor.get("select").setValue("basic");
  expect(lastAuth(editor)).toEqual({ type: "basic", username: "", password: "" });
  expect(auth).toEqual({ type: "bearer", token: "secret" });
  await editor.get("select").setValue("none");
  expect(lastAuth(editor)).toEqual({ type: "none" });
});

it("restores each mode's inputs after switching through other types and None", async () => {
  const editor = render({ type: "bearer", token: "initial" });
  await editor.get('input[type="password"]').setValue("{{token}}");
  await editor.get("select").setValue("basic");
  await editor.get('input[type="text"]').setValue("Jörg");
  await editor.get('input[type="password"]').setValue("{{password}}");
  await editor.get("select").setValue("api-key");
  await editor.get('input[type="text"]').setValue("api_key");
  await editor.get('input[type="password"]').setValue("{{apiKey}}");
  await editor.findAll("select")[1].setValue("query");
  await editor.get("select").setValue("none");
  expect(editor.findAll("input")).toHaveLength(0);

  await editor.get("select").setValue("bearer");
  expect(editor.get('input[type="password"]').element.value).toBe("{{token}}");
  expect(lastAuth(editor)).toEqual({ type: "bearer", token: "{{token}}" });
  await editor.get("select").setValue("basic");
  expect(editor.get('input[type="text"]').element.value).toBe("Jörg");
  expect(editor.get('input[type="password"]').element.value).toBe("{{password}}");
  expect(lastAuth(editor)).toEqual({ type: "basic", username: "Jörg", password: "{{password}}" });
  await editor.get("select").setValue("api-key");
  expect(lastAuth(editor)).toEqual({ type: "api-key", name: "api_key", value: "{{apiKey}}", location: "query" });
  expect(editor.findAll("select")[1].element.value).toBe("query");
});

it("uses external replacements as the authoritative remembered value for each type", async () => {
  const editor = render({ type: "bearer", token: "old" });
  await editor.get("select").setValue("basic");
  await editor.get('input[type="text"]').setValue("local-user");
  await editor.setProps({ modelValue: { type: "bearer", token: "external-token" } });
  expect(editor.get('input[type="password"]').element.value).toBe("external-token");
  await editor.setProps({ modelValue: { type: "bearer", token: "" } });
  await editor.get("select").setValue("basic");
  expect(editor.get('input[type="text"]').element.value).toBe("local-user");
  await editor.get("select").setValue("bearer");
  expect(lastAuth(editor)).toEqual({ type: "bearer", token: "" });
  expect(editor.get('input[type="password"]').element.value).toBe("");
});

it("does not remember credential edits that the controlling parent rejects", async () => {
  const editor = render({ type: "bearer", token: "accepted" }, false);
  await editor.get("input").setValue("rejected");
  await editor.get("select").setValue("basic");
  await editor.get("select").setValue("bearer");
  expect(lastAuth(editor)).toEqual({ type: "bearer", token: "accepted" });
});

it("copies live parent updates without retaining detached credential objects", async () => {
  const auth = reactive({ type: "bearer" as const, token: "old" });
  const editor = render(auth);
  auth.token = "external-update";
  await nextTick();
  expect(editor.get("input").element.value).toBe("external-update");
  await editor.get("select").setValue("basic");
  auth.token = "detached-update";
  await nextTick();
  await editor.get("select").setValue("bearer");
  expect(lastAuth(editor)).toEqual({ type: "bearer", token: "external-update" });
});

it("retains unresolved credential text without reinterpreting captured inputs", async () => {
  const editor = render({ type: "bearer", token: "{{captured-token}}" });
  await editor.setProps({ captured: true });
  await editor.get("select").setValue("basic");
  await editor.get("select").setValue("bearer");
  expect(editor.get("input").element.value).toBe("{{captured-token}}");
  expect(editor.get("input").element.validity.valid).toBe(true);
  await editor.setProps({ captured: false });
  expect(editor.get("input").element.validity.valid).toBe(false);
});

it("preserves isolated mode drafts when keyed editors leave and return through KeepAlive", async () => {
  const active = ref("first");
  const auth = reactive<Record<string, RequestAuth>>({
    first: { type: "bearer", token: "first-secret" },
    second: { type: "bearer", token: "second-secret" },
  });
  const host = mount({
    setup: () => () => h(KeepAlive, () => h(AuthEditor, {
      key: active.value,
      modelValue: auth[active.value],
      "onUpdate:modelValue": value => { auth[active.value] = value; },
    })),
  });

  try {
    await host.get("select").setValue("basic");
    active.value = "second";
    await nextTick();
    expect(host.get('input[type="password"]').element.value).toBe("second-secret");
    await host.get("select").setValue("basic");
    await host.get("select").setValue("bearer");
    expect(host.get('input[type="password"]').element.value).toBe("second-secret");
    active.value = "first";
    await nextTick();
    await host.get("select").setValue("bearer");
    expect(host.get('input[type="password"]').element.value).toBe("first-secret");
  } finally {
    host.unmount();
  }
});

it("releases inactive mode credentials when the editor unmounts", async () => {
  const editor = render({ type: "bearer", token: "transient-secret" });
  await editor.get("select").setValue("basic");
  const activeAuth = lastAuth(editor);
  editor.unmount();
  const reopened = render(activeAuth);
  await reopened.get("select").setValue("bearer");
  expect(lastAuth(reopened)).toEqual({ type: "bearer", token: "" });
});

it("keeps bearer tokens masked and accepts environment placeholders", async () => {
  const editor = render({ type: "bearer", token: "old" });
  expect(editor.get("input").attributes("type")).toBe("password");
  await editor.get("input").setValue("{{token}}");
  expect(lastAuth(editor)).toEqual({ type: "bearer", token: "{{token}}" });
});

it("edits Basic credentials while masking the password", async () => {
  const editor = render({ type: "basic", username: "old", password: "hidden" });
  await editor.get('input[type="text"]').setValue("Jörg");
  await editor.get('input[type="password"]').setValue("{{password}}");
  expect(lastAuth(editor)).toEqual({ type: "basic", username: "Jörg", password: "{{password}}" });
});

it("edits an API key and chooses header or query placement without revealing its value", async () => {
  const editor = render({ type: "api-key", name: "old", value: "hidden", location: "header" });
  await editor.get('input[type="text"]').setValue("api_key");
  await editor.get('input[type="password"]').setValue("{{apiKey}}");
  await editor.findAll("select")[1].setValue("query");
  expect(lastAuth(editor)).toEqual({ type: "api-key", name: "api_key", value: "{{apiKey}}", location: "query" });
  expect(editor.text()).toContain("Authentication replaces matching headers or query parameters");
});

type AuthWrapper = ReturnType<typeof mount<typeof AuthEditor>>;
const mounted: AuthWrapper[] = [];

function render(modelValue: RequestAuth, controlled = true) {
  const editor = mount(AuthEditor, {
    props: {
      modelValue,
      "onUpdate:modelValue": controlled ? value => { void editor.setProps({ modelValue: value }); } : undefined,
    },
  });
  mounted.push(editor);
  return editor;
}

function lastAuth(editor: AuthWrapper) {
  return editor.emitted("update:modelValue")!.at(-1)![0] as RequestAuth;
}
