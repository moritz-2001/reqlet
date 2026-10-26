// Exercises method selection, editable custom values, native validity, and keyboard focus through the public input.
import { DOMWrapper, mount } from "@vue/test-utils";
import { afterEach, expect, it } from "vitest";
import MethodSelector from "../src/components/MethodSelector.vue";

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
});

it("opens the complete method list with an accessible active option and chooses without losing input focus", async () => {
  const selector = renderSelector("PATCH");
  const input = selector.get<HTMLInputElement>('[role="combobox"]');
  expect(selector.get("label").text()).toContain("Method");
  expect(selector.get("label").attributes("for")).toBe(input.attributes("id"));
  expect(input.attributes("aria-autocomplete")).toBe("list");
  expect(input.attributes("aria-expanded")).toBe("false");
  expect(menu().exists()).toBe(false);

  await selector.get('[aria-label="Show HTTP methods"]').trigger("click");
  expect(document.activeElement).toBe(input.element);
  expect(input.attributes("aria-expanded")).toBe("true");
  const list = menu();
  expect(input.attributes("aria-controls")).toBe(list.attributes("id"));
  expect(options(selector).map(option => methodName(option.text()))).toEqual([
    "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
  ]);
  expect(options(selector).every(option => option.text().length > methodName(option.text())!.length)).toBe(true);
  expect(methodName(activeOption(selector).text())).toBe("PATCH");
  expect(activeOption(selector).attributes("aria-selected")).toBe("true");
  expect(input.attributes("aria-activedescendant")).toBe(activeOption(selector).attributes("id"));
  expect(selector.emitted("update:modelValue")).toBeUndefined();

  await options(selector).find(option => option.text().startsWith("DELETE"))!.trigger("mousedown");
  await options(selector).find(option => option.text().startsWith("DELETE"))!.trigger("click");
  expect(selector.emitted("update:modelValue")).toEqual([["DELETE"]]);
  expect(input.element.value).toBe("DELETE");
  expect(document.activeElement).toBe(input.element);
  expect(input.attributes("aria-expanded")).toBe("false");
  expect(input.attributes("aria-activedescendant")).toBeUndefined();
});

it("opens on the current method and cycles highlights without editing until Enter commits", async () => {
  const selector = renderSelector("POST");
  const input = selector.get<HTMLInputElement>('[role="combobox"]');
  await input.trigger("keydown", { key: "ArrowDown" });
  expect(methodName(activeOption(selector).text())).toBe("POST");
  await input.trigger("keydown", { key: "ArrowDown" });
  expect(methodName(activeOption(selector).text())).toBe("PUT");
  expect(input.element.value).toBe("POST");
  expect(options(selector).find(option => option.attributes("aria-selected") === "true")?.text()).toMatch(/^POST/);
  await input.trigger("keydown", { key: "ArrowUp" });
  await input.trigger("keydown", { key: "ArrowUp" });
  await input.trigger("keydown", { key: "ArrowUp" });
  expect(methodName(activeOption(selector).text())).toBe("OPTIONS");
  expect(selector.emitted("update:modelValue")).toBeUndefined();
  await input.trigger("keydown", { key: "Enter" });
  expect(selector.emitted("update:modelValue")).toEqual([["OPTIONS"]]);
  expect(menu().exists()).toBe(false);
  await input.trigger("keydown", { key: "Enter" });
  expect(selector.emitted("update:modelValue")).toHaveLength(1);
});

it("opens custom methods on the first or last suggestion without replacing the draft", async () => {
  const selector = renderSelector("PROPFIND");
  const input = selector.get('[role="combobox"]');
  await input.trigger("keydown", { key: "ArrowDown" });
  expect(methodName(activeOption(selector).text())).toBe("GET");
  await input.trigger("keydown", { key: "Escape" });
  await input.trigger("keydown", { key: "ArrowUp" });
  expect(methodName(activeOption(selector).text())).toBe("OPTIONS");
  expect(selector.emitted("update:modelValue")).toBeUndefined();
});

it("filters suggestions by case-insensitive prefix while emitting exact custom text", async () => {
  const selector = renderSelector();
  const input = selector.get<HTMLInputElement>('[role="combobox"]');
  await input.setValue("p");
  expect(options(selector).map(option => methodName(option.text()))).toEqual(["POST", "PUT", "PATCH"]);
  expect(selector.emitted("update:modelValue")?.at(-1)).toEqual(["p"]);
  await input.setValue("pa");
  expect(options(selector)).toHaveLength(1);
  expect(methodName(activeOption(selector).text())).toBe("PATCH");
  await input.trigger("keydown", { key: "Enter" });
  expect(input.element.value).toBe("PATCH");

  await input.setValue(" propfind ");
  expect(options(selector)).toHaveLength(0);
  expect(input.attributes("aria-activedescendant")).toBeUndefined();
  await input.trigger("keydown", { key: "Enter" });
  expect(selector.emitted("update:modelValue")?.at(-1)).toEqual([" propfind "]);
  expect(input.element.value).toBe(" propfind ");
  expect(input.element.validity.valid).toBe(true);
  await input.setValue("ET");
  expect(options(selector)).toHaveLength(0);
});

it("dismisses through Escape, Tab, and blur without committing highlighted suggestions", async () => {
  const selector = renderSelector();
  const input = selector.get<HTMLInputElement>('[role="combobox"]');
  await input.setValue("p");
  await input.trigger("keydown", { key: "ArrowDown" });
  await input.trigger("keydown", { key: "Escape" });
  expect(input.attributes("aria-expanded")).toBe("false");
  expect(input.element.value).toBe("p");
  await input.trigger("click");
  expect(options(selector)).toHaveLength(7);
  await input.trigger("keydown", { key: "ArrowDown" });
  await input.trigger("keydown", { key: "Tab" });
  expect(input.attributes("aria-expanded")).toBe("false");
  expect(input.element.value).toBe("p");

  await input.trigger("click");
  const outside = document.createElement("button");
  document.body.append(outside);
  input.element.focus();
  outside.focus();
  await selector.vm.$nextTick();
  expect(menu().exists()).toBe(false);

  await input.trigger("click");
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await selector.vm.$nextTick();
  expect(menu().exists()).toBe(false);
  expect(selector.emitted("update:modelValue")).toEqual([["p"]]);
});

it("dismisses the portaled menu when its request is cached and reactivates with a closed picker", async () => {
  const host = mount({
    components: { MethodSelector },
    data: () => ({ visible: true }),
    template: '<KeepAlive><MethodSelector v-if="visible" model-value="GET" /></KeepAlive>',
  }, { attachTo: document.body });
  mounted.push(host);
  await host.get('[aria-label="Show HTTP methods"]').trigger("click");
  expect(menu().exists()).toBe(true);
  await host.setData({ visible: false });
  expect(menu().exists()).toBe(false);
  await host.setData({ visible: true });
  expect(host.get('[role="combobox"]').attributes("aria-expanded")).toBe("false");
  await host.get('[role="combobox"]').trigger("keydown", { key: "ArrowDown" });
  expect(menu().exists()).toBe(true);
});

it("ignores composition and modified shortcuts while suggestions are open", async () => {
  const selector = renderSelector();
  const input = selector.get('[role="combobox"]');
  await input.trigger("click");
  for (const keys of [
    { key: "ArrowDown", isComposing: true }, { key: "Enter", isComposing: true },
    { key: "Escape", isComposing: true }, { key: "ArrowDown", ctrlKey: true },
    { key: "Enter", ctrlKey: true }, { key: "Enter", metaKey: true },
    { key: "ArrowUp", altKey: true },
  ]) {
    await input.trigger("keydown", keys);
  }
  expect(methodName(activeOption(selector).text())).toBe("GET");
  expect(input.attributes("aria-expanded")).toBe("true");
  expect(selector.emitted("update:modelValue")).toBeUndefined();
});

it("shares native method validation and suppresses it only while literal replay is active", async () => {
  const selector = renderSelector("GE T");
  const input = selector.get<HTMLInputElement>('[role="combobox"]');
  expect(input.element.validity.valid).toBe(false);
  expect(input.attributes("aria-invalid")).toBe("true");
  expect(descriptionText(input.attributes("aria-describedby"))).toContain("Enter a valid HTTP method.");

  await selector.setProps({ literal: true });
  expect(input.element.validity.valid).toBe(true);
  expect(input.attributes("aria-invalid")).toBeUndefined();
  await selector.setProps({ literal: false, modelValue: "X-CUSTOM+METHOD" });
  expect(input.element.validity.valid).toBe(true);
  expect(input.element.value).toBe("X-CUSTOM+METHOD");
  expect(selector.emitted("update:modelValue")).toBeUndefined();
});

it("keeps empty fields invalid and reveals their explanation after leaving the field", async () => {
  const selector = renderSelector("");
  const input = selector.get<HTMLInputElement>('[role="combobox"]');
  expect(input.element.validity.valid).toBe(false);
  expect(descriptionText(input.attributes("aria-describedby"))).not.toContain("Enter a valid HTTP method.");
  input.element.focus();
  input.element.blur();
  await selector.vm.$nextTick();
  expect(descriptionText(input.attributes("aria-describedby"))).toContain("Enter a valid HTTP method.");
});

type SelectorWrapper = ReturnType<typeof mount<typeof MethodSelector>>;
const mounted: Array<{ unmount(): void }> = [];

function renderSelector(modelValue = "GET") {
  const selector: SelectorWrapper = mount(MethodSelector, {
    attachTo: document.body,
    props: {
      modelValue,
      'onUpdate:modelValue': value => { void selector.setProps({ modelValue: value }); },
    },
  });
  mounted.push(selector);
  return selector;
}

function menu() { return new DOMWrapper(document.body).find('[role="listbox"][aria-label="HTTP methods"]'); }

function options(_selector: SelectorWrapper) { return menu().findAll('[role="option"]'); }

function activeOption(selector: SelectorWrapper) {
  const activeId = selector.get('[role="combobox"]').attributes("aria-activedescendant");
  return new DOMWrapper(document.getElementById(activeId!)!);
}

function methodName(text: string) {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].find(method => text.startsWith(method));
}

function descriptionText(ids: string | undefined) {
  return ids?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ") ?? "";
}
