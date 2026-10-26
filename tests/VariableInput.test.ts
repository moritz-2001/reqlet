// Exercises placeholder editing, field feedback, and credential privacy through the rendered input contract.
import { mount } from "@vue/test-utils";
import { afterEach, expect, it } from "vitest";
import VariableInput from "../src/components/VariableInput.vue";
import type { Environment } from "../src/request";

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
});

it("completes enabled variable names at the caret while preserving the surrounding request text", async () => {
  const wrapper = render({ modelValue: "https://example.com/{{ba}}/items", environment });
  const input = wrapper.get("input");
  input.element.setSelectionRange(24, 24);
  await input.trigger("focus");
  expect(wrapper.findAll('[role="option"]').map(option => option.text())).toEqual(["{{baseUrl}}", "{{basicUser}}"]);
  expect(input.attributes("aria-expanded")).toBe("true");
  expect(input.attributes("aria-controls")).toBe(wrapper.get('[role="listbox"]').attributes("id"));

  await input.trigger("keydown", { key: "ArrowDown" });
  expect(wrapper.get('[aria-selected="true"]').text()).toBe("{{basicUser}}");
  expect(input.attributes("aria-activedescendant")).toBe(wrapper.get('[aria-selected="true"]').attributes("id"));
  await input.trigger("keydown", { key: "Enter" });
  expect(wrapper.emitted("update:modelValue")!.at(-1)![0]).toBe("https://example.com/{{basicUser}}/items");
  expect(input.element.selectionStart).toBe("https://example.com/{{basicUser}}".length);
  expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
});

it("supports Escape, Tab and mouse selection without treating a send shortcut as a completion", async () => {
  const wrapper = render({ modelValue: "{{ba", environment });
  const input = wrapper.get("input");
  input.element.setSelectionRange(4, 4);
  await input.trigger("focus");
  await input.trigger("keydown", { key: "Enter", ctrlKey: true });
  expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  await input.trigger("keydown", { key: "Escape" });
  expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
  await input.trigger("blur");
  await input.trigger("focus");
  await input.trigger("keydown", { key: "Tab" });
  expect(wrapper.emitted("update:modelValue")!.at(-1)![0]).toBe("{{baseUrl}}");

  await wrapper.setProps({ modelValue: "prefix {{bas" });
  input.element.setSelectionRange(12, 12);
  await input.trigger("blur");
  await input.trigger("focus");
  await wrapper.findAll('[role="option"]')[1].trigger("click");
  expect(wrapper.emitted("update:modelValue")!.at(-1)![0]).toBe("prefix {{basicUser}}");
});

it("previews nested URL values on hover and updates field-local missing-variable feedback with the environment", async () => {
  const wrapper = render({ modelValue: "{{baseUrl}}/items", environment, kind: "url", preview: true });
  const input = wrapper.get("input");
  expect(input.element.value).toBe("{{baseUrl}}/items");
  expect(input.attributes("title")).toBe("https://api.example.com/items");
  expect(input.element.checkValidity()).toBe(true);

  await wrapper.setProps({ environment: undefined });
  expect(input.attributes("aria-invalid")).toBe("true");
  expect(input.element.checkValidity()).toBe(false);
  expect(wrapper.get('[role="status"]').text()).toContain('Environment variable "baseUrl" is not defined.');
  expect(input.attributes("aria-describedby")).toBe(wrapper.get('[role="status"]').attributes("id"));
  await wrapper.get("button").trigger("click");
  expect(wrapper.emitted("edit-environment")).toHaveLength(1);

  await wrapper.setProps({ environment });
  expect(input.attributes("aria-invalid")).toBeUndefined();
  expect(input.element.checkValidity()).toBe(true);
  expect(wrapper.find('[role="status"]').exists()).toBe(false);
});

it("keeps completion names visible in masked authentication fields without exposing resolved credentials", async () => {
  const wrapper = render({ modelValue: "{{secret", environment, secret: true, preview: true });
  const input = wrapper.get("input");
  expect(input.attributes("type")).toBe("password");
  input.element.setSelectionRange(8, 8);
  await input.trigger("focus");
  expect(wrapper.get('[role="option"]').text()).toBe("{{secretToken}}");
  expect(wrapper.html()).not.toContain("private-credential-value");
  await input.trigger("keydown", { key: "Enter" });
  expect(input.element.value).toBe("{{secretToken}}");
  expect(input.attributes("title")).toBeUndefined();
  expect(wrapper.html()).not.toContain("private-credential-value");
});

it("preserves literal captured and disabled-row text without resolving it or blocking execution", async () => {
  const wrapper = render({ modelValue: "{{missing}}", kind: "header-value", literal: true, environment });
  const input = wrapper.get("input");
  input.element.setSelectionRange(5, 5);
  await input.trigger("focus");
  expect(input.element.value).toBe("{{missing}}");
  expect(input.element.checkValidity()).toBe(true);
  expect(input.attributes("title")).toBeUndefined();
  expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
  expect(wrapper.find('[role="status"]').exists()).toBe(false);

  await wrapper.setProps({ literal: false });
  expect(input.element.checkValidity()).toBe(false);
  expect(wrapper.get('[role="status"]').text()).toContain('"missing" is not defined');
});

it("validates literal request text while suppressing variable previews, suggestions, and environment errors", async () => {
  const wrapper = render({ modelValue: "{{secretToken}}", kind: "header-value", inputMode: "literal", environment, preview: true });
  const input = wrapper.get("input");
  await input.trigger("focus");
  expect(input.element.checkValidity()).toBe(true);
  expect(input.attributes("role")).toBeUndefined();
  expect(input.attributes("title")).toBeUndefined();
  expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
  expect(wrapper.html()).not.toContain("private-credential-value");
  await wrapper.setProps({ kind: "header-name", modelValue: "Bad header" });
  expect(input.element.checkValidity()).toBe(false);
  expect(wrapper.get('[role="status"]').text()).toContain("HTTP tokens");
  expect(wrapper.find("button").exists()).toBe(false);
});

it.each([
  ["url", "/relative", "absolute HTTP or HTTPS URL"],
  ["header-name", "Bad header", "HTTP tokens"],
  ["header-value", "{{invalidHeader}}", "line breaks"],
  ["basic-username", "person:password", "cannot contain a colon"],
] as const)("reports %s validation beside its input without offering environment editing for transport problems", (kind, modelValue, message) => {
  const wrapper = render({ modelValue, kind, environment });
  expect(wrapper.get('[role="status"]').text()).toContain(message);
  expect(wrapper.get("input").element.checkValidity()).toBe(false);
  expect(wrapper.find("button").exists()).toBe(false);
});

it("keeps pristine empty fields quiet while retaining validity and reveals their message on blur or Send validation", async () => {
  const wrapper = render({ modelValue: "", kind: "header-name" });
  const input = wrapper.get("input");
  expect(input.attributes("aria-invalid")).toBe("true");
  expect(input.element.validity.valid).toBe(false);
  expect(wrapper.find('[role="status"]').exists()).toBe(false);
  await input.trigger("focus");
  expect(wrapper.find('[role="status"]').exists()).toBe(false);
  await input.trigger("blur");
  expect(wrapper.get('[role="status"]').text()).toContain("HTTP tokens");

  const other = render({ modelValue: "", kind: "api-key-name" });
  expect(other.find('[role="status"]').exists()).toBe(false);
  await other.get("input").trigger("invalid");
  expect(other.get('[role="status"]').text()).toContain("needs a name");
});

it("suppresses visible errors during active completion without making the incomplete URL valid", async () => {
  const wrapper = render({ modelValue: "{{ba", kind: "url", environment });
  const input = wrapper.get("input");
  expect(wrapper.get('[role="status"]').text()).toContain("absolute HTTP or HTTPS URL");
  input.element.setSelectionRange(4, 4);
  await input.trigger("focus");
  expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
  expect(wrapper.find('[role="status"]').exists()).toBe(false);
  expect(input.attributes("aria-invalid")).toBe("true");
  expect(input.element.validity.valid).toBe(false);
  await input.trigger("keydown", { key: "Escape" });
  expect(wrapper.get('[role="status"]').text()).toContain("absolute HTTP or HTTPS URL");
});

type InputWrapper = ReturnType<typeof mount<typeof VariableInput>>;
const mounted: InputWrapper[] = [];
const environment: Environment = {
  id: "local", name: "Local", variables: [
    { name: "baseUrl", value: "{{scheme}}://api.example.com", enabled: true },
    { name: "scheme", value: "https", enabled: true },
    { name: "basicUser", value: "developer", enabled: true },
    { name: "baseDisabled", value: "ignored", enabled: false },
    { name: "secretToken", value: "private-credential-value", enabled: true },
    { name: "invalidHeader", value: "line\nbreak", enabled: true },
  ],
};

function render(props: InstanceType<typeof VariableInput>["$props"]) {
  const wrapper = mount(VariableInput, { attachTo: document.body, props: {
    ...props,
    "onUpdate:modelValue": value => { void wrapper.setProps({ modelValue: value }); },
  } });
  mounted.push(wrapper);
  return wrapper;
}
