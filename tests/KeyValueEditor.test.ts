// Verifies accepted row editing keeps keyboard focus visible without overriding parent-owned data.
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import KeyValueEditor from "../src/components/KeyValueEditor.vue";
import type { KeyValueEntry } from "../src/request";

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it.each([
  ["Headers", "header"],
  ["Additional query parameters", "query parameter"],
  ["Variables", "variable"],
])("focuses and reveals an accepted new %s row while preserving existing duplicate and disabled entries", async (label, entryLabel) => {
  const original = [row("duplicate", false), row("duplicate")];
  const editor = render(original, label, entryLabel);
  await acceptChanges(editor);
  const add = editor.get("button");
  add.element.focus();
  await add.trigger("click");

  const input = editor.get<HTMLInputElement>(`[aria-label="${entryLabel} 3 name"]`);
  expect(document.activeElement).toBe(input.element);
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(input.element);
  expect(lastRows(editor)).toEqual([...original, { name: "", value: "", enabled: true }]);
  expect(original).toEqual([row("duplicate", false), row("duplicate")]);

  await input.setValue("new-name");
  expect(lastRows(editor)[2]?.name).toBe("new-name");
  expect(document.activeElement).toBe(input.element);
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
});

it("waits for parent acceptance before focusing a newly added row", async () => {
  const editor = render([row("first")]);
  const add = editor.get("button");
  add.element.focus();
  await add.trigger("click");
  expect(document.activeElement).toBe(add.element);
  expect(editor.find('[aria-label="header 2 name"]').exists()).toBe(false);
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();

  await editor.setProps({ modelValue: [...lastRows(editor)] });
  expect(document.activeElement).toBe(editor.get('[aria-label="header 2 name"]').element);
});

it("leaves focus alone when the parent rejects or replaces an addition", async () => {
  const editor = render([row("first")]);
  const add = editor.get("button");
  add.element.focus();
  await add.trigger("click");
  const emitted = lastRows(editor);
  await editor.setProps({ modelValue: emitted.map(entry => ({ ...entry })) });
  expect(document.activeElement).toBe(add.element);
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();

  // A later update must not revive focus for the replacement that was already rejected.
  await editor.setProps({ modelValue: emitted });
  expect(document.activeElement).toBe(add.element);
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
});

it("does not interrupt a different field selected before delayed acceptance", async () => {
  const editor = render([row("first")]);
  editor.get("button").element.focus();
  await editor.get("button").trigger("click");
  const value = editor.get('[aria-label="header 1 value"]');
  value.element.focus();
  await editor.setProps({ modelValue: lastRows(editor) });
  expect(document.activeElement).toBe(value.element);
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
});

it.each([
  [0, "second"],
  [1, "third"],
  [2, "second"],
])("moves focus to the nearest surviving name after removing row %s", async (index, expectedName) => {
  const editor = render([row("first"), row("second"), row("third")]);
  await acceptChanges(editor);
  const remove = editor.get(`[aria-label="Remove header ${index + 1}"]`);
  remove.element.focus();
  await remove.trigger("click");

  const active = document.activeElement as HTMLInputElement;
  expect(active.value).toBe(expectedName);
  expect(active.getAttribute("aria-label")).toMatch(/^header \d name$/);
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
});

it("returns focus to Add when the final row is removed", async () => {
  const editor = render([row("only")]);
  await acceptChanges(editor);
  const remove = editor.get('[aria-label="Remove header 1"]');
  remove.element.focus();
  await remove.trigger("click");
  expect(editor.find('[aria-label="header 1 name"]').exists()).toBe(false);
  expect(document.activeElement).toBe(editor.get("button").element);
});

it("preserves focus when a removal is rejected or another row is being edited", async () => {
  const editor = render([row("first"), row("second")]);
  const remove = editor.get('[aria-label="Remove header 2"]');
  remove.element.focus();
  await remove.trigger("click");
  await editor.setProps({ modelValue: [row("first"), row("second")] });
  expect(document.activeElement).toBe(remove.element);
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();

  await acceptChanges(editor);
  const firstValue = editor.get('[aria-label="header 1 value"]');
  firstValue.element.focus();
  await remove.trigger("click");
  expect(document.activeElement).toBe(firstValue.element);
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
});

it("bounds thousands of rows while adding, editing, and removing the final row keeps it reachable", async () => {
  const editor = render(Array.from({ length: 2_000 }, (_, index) => row(`header-${index}`)));
  await acceptChanges(editor);
  expect(editor.findAll(".entry-row").length).toBeLessThan(30);
  editor.get("button").element.focus();
  await editor.get("button").trigger("click");
  await flushPromises();

  const name = editor.get<HTMLInputElement>('[aria-label="header 2001 name"]');
  expect(document.activeElement).toBe(name.element);
  await name.setValue("last-header");
  expect(lastRows(editor)[2_000]?.name).toBe("last-header");
  expect(editor.findAll(".entry-row").length).toBeLessThan(30);

  const remove = editor.get('[aria-label="Remove header 2001"]');
  remove.element.focus();
  await remove.trigger("click");
  await flushPromises();
  expect(document.activeElement).toBe(editor.get('[aria-label="header 2000 name"]').element);
});

it("keeps every row reachable through Tab across virtual window boundaries", async () => {
  const editor = render(Array.from({ length: 2_000 }, (_, index) => row(`header-${index}`)));
  const boundary = editor.findAll(".entry-row").length;
  const remove = editor.get(`[aria-label="Remove header ${boundary}"]`);
  remove.element.focus();
  await remove.trigger("keydown", { key: "Tab" });
  await flushPromises();
  expect(document.activeElement).toBe(editor.get(`[aria-label="Enable header ${boundary + 1}"]`).element);

  await editor.get(`[aria-label="Enable header ${boundary + 1}"]`).trigger("keydown", { key: "Tab", shiftKey: true });
  await flushPromises();
  expect(document.activeElement).toBe(editor.get(`[aria-label="Remove header ${boundary}"]`).element);
});

it("reveals the first invalid logical row even when it starts outside the mounted window", async () => {
  const entries = Array.from({ length: 2_000 }, (_, index) => row(`header-${index}`));
  entries[1_999] = { name: "invalid name", value: "value", enabled: true };
  const editor = render(entries);
  await editor.setProps({ resolveVariables: true, headers: true });
  expect(editor.find('[aria-label="header 2000 name"]').exists()).toBe(false);

  const invalid = await (editor.vm as unknown as { revealInvalid(): Promise<HTMLInputElement | undefined> }).revealInvalid();
  expect(invalid).toBe(editor.get('[aria-label="header 2000 name"]').element);
  expect(invalid?.validity.valid).toBe(false);
  expect(editor.findAll(".entry-row").length).toBeLessThan(30);
});

it("retains an input and its completion while scrolling its row outside the viewport", async () => {
  const editor = render(Array.from({ length: 2_000 }, (_, index) => row(`header-${index}`)));
  await acceptChanges(editor);
  await editor.setProps({ resolveVariables: true, environment: { id: "env", name: "Test", variables: [{ name: "HOST", value: "api.test", enabled: true }] } });
  const input = editor.get<HTMLInputElement>('[aria-label="header 1 name"]');
  input.element.focus();
  await input.setValue("{{");
  const viewport = editor.get<HTMLElement>(".virtual-rows");
  viewport.element.scrollTop = 40_000;
  await viewport.trigger("scroll");
  expect(document.activeElement).toBe(input.element);
  expect(editor.get('[role="option"]').text()).toBe("{{HOST}}");
  expect(editor.findAll(".entry-row").length).toBeLessThan(30);
});

it("preserves the focused value and selection when an earlier logical row is removed", async () => {
  const editor = render(Array.from({ length: 2_000 }, (_, index) => row(`header-${index}`)));
  await acceptChanges(editor);
  const value = editor.get<HTMLInputElement>('[aria-label="header 2 value"]');
  value.element.focus();
  value.element.setSelectionRange(2, 6);
  await editor.get('[aria-label="Remove header 1"]').trigger("click");
  await flushPromises();

  expect(editor.get('[aria-label="header 1 value"]').element).toBe(value.element);
  expect(document.activeElement).toBe(value.element);
  expect(value.element.value).toBe("value for header-1");
  expect([value.element.selectionStart, value.element.selectionEnd]).toEqual([2, 6]);
});

type EditorWrapper = ReturnType<typeof mount<typeof KeyValueEditor>>;
const mounted: EditorWrapper[] = [];
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function render(modelValue: KeyValueEntry[], label = "Headers", entryLabel = "header") {
  const editor = mount(KeyValueEditor, { attachTo: document.body, props: { modelValue, label, entryLabel } });
  mounted.push(editor);
  return editor;
}

function acceptChanges(editor: EditorWrapper) {
  return editor.setProps({ "onUpdate:modelValue": modelValue => { void editor.setProps({ modelValue }); } });
}

function lastRows(editor: EditorWrapper) {
  return editor.emitted("update:modelValue")!.at(-1)![0] as KeyValueEntry[];
}

function row(name: string, enabled = true): KeyValueEntry {
  return { name, value: `value for ${name}`, enabled };
}
