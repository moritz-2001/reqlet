// Verifies independent editing and execution scopes, lifecycle actions, and keyboard focus through the UI.
import { mount } from "@vue/test-utils";
import { afterEach, expect, it } from "vitest";
import EnvironmentManager from "../src/components/EnvironmentManager.vue";
import type { Environment } from "../src/request";

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
});

it("keeps management controls out of the header until opened and allows no environment", async () => {
  const manager = render([localEnvironment()], "local");
  expect(manager.find('[role="dialog"]').exists()).toBe(false);
  // The visible header label is hidden in narrow windows; its accessible name
  // must remain available independently of that responsive presentation.
  const scope = manager.get('select[aria-label="Environment"]');
  expect(scope.element.value).toBe("local");
  await scope.setValue("");
  expect(manager.emitted("update:activeEnvironmentId")!.at(-1)).toEqual([null]);
  await button(manager, "Manage environments").trigger("click");
  expect(manager.get('[role="dialog"]').text()).toContain("Variables and credentials are saved locally");
  expect(button(manager, "Manage environments").attributes("aria-expanded")).toBe("true");
  await manager.get('[aria-label="Close environments"]').trigger("click");
  expect(manager.find('[role="dialog"]').exists()).toBe(false);
});

it("creates and edits a named scope without activating it until explicitly requested", async () => {
  const manager = render([], null);
  await control(manager);
  await button(manager, "Manage environments").trigger("click");
  expect(document.activeElement).toBe(manager.get('input[placeholder="Local, Staging, Production…"]').element);
  expect(button(manager, "Create environment").attributes("disabled")).toBeDefined();
  await manager.get('input[placeholder="Local, Staging, Production…"]').setValue(" Staging ");
  await manager.findAll("form")[0].trigger("submit");
  const created = lastEnvironments(manager)[0];
  expect(created).toEqual({ id: expect.any(String), name: "Staging", variables: [] });
  expect(manager.emitted("update:activeEnvironmentId")).toBeUndefined();
  expect(manager.get("select").element.value).toBe("");
  expect(manager.get('[role="dialog"] select').element.value).toBe(created.id);
  expect(manager.get(".active-scope").text()).toBe("Active for sending: No environment.");

  const renameForm = manager.findAll("form")[1];
  expect(document.activeElement).toBe(renameForm.get("input").element);
  await renameForm.get("input").setValue("Production");
  await renameForm.trigger("submit");
  expect(lastEnvironments(manager)[0]).toEqual({ ...created, name: "Production" });
  expect(manager.emitted("update:activeEnvironmentId")).toBeUndefined();

  await button(manager, "Use this environment").trigger("click");
  expect(manager.emitted("update:activeEnvironmentId")!.at(-1)).toEqual([created.id]);
  expect(manager.get("select").element.value).toBe(created.id);
  expect(button(manager, "Use this environment").attributes("disabled")).toBeDefined();
  await button(manager, "Delete environment").trigger("click");
  expect(lastEnvironments(manager)).toEqual([]);
  expect(manager.emitted("update:activeEnvironmentId")!.at(-1)).toEqual([null]);
  expect(document.activeElement).toBe(manager.get('input[placeholder="Local, Staging, Production…"]').element);
});

it("inspects, edits, and deletes an inactive scope without changing the sending target", async () => {
  const staging = { ...localEnvironment(), id: "staging", name: "Staging" };
  const manager = render([localEnvironment(), staging], "local");
  await control(manager);
  await button(manager, "Manage environments").trigger("click");
  const editSelect = manager.get('[role="dialog"] select');
  expect(document.activeElement).toBe(editSelect.element);
  await editSelect.setValue("staging");
  await manager.get('[aria-label="variable 1 value"]').setValue("https://staging.example.com");
  const renameForm = manager.findAll("form")[1];
  await renameForm.get("input").setValue("Preview");
  await renameForm.trigger("submit");
  expect(lastEnvironments(manager)[1]).toEqual({
    ...staging, name: "Preview", variables: [{ name: "baseUrl", value: "https://staging.example.com", enabled: true }],
  });
  expect(manager.get("select").element.value).toBe("local");
  expect(manager.get(".active-scope").text()).toBe("Active for sending: Local.");
  expect(manager.emitted("update:activeEnvironmentId")).toBeUndefined();

  await button(manager, "Delete environment").trigger("click");
  expect(lastEnvironments(manager)).toEqual([localEnvironment()]);
  expect(manager.emitted("update:activeEnvironmentId")).toBeUndefined();
  expect(editSelect.element.value).toBe("local");
  expect(document.activeElement).toBe(editSelect.element);
});

it("preserves the inspected scope and unfinished rename when the active target changes", async () => {
  const staging = { ...localEnvironment(), id: "staging", name: "Staging" };
  const manager = render([localEnvironment(), staging], "local");
  await control(manager);
  await button(manager, "Manage environments").trigger("click");
  const editSelect = manager.get('[role="dialog"] select');
  await editSelect.setValue("staging");
  const rename = manager.findAll("form")[1].get("input");
  await rename.setValue("Pending name");
  await manager.get("select").setValue("");
  expect(editSelect.element.value).toBe("staging");
  expect(rename.element.value).toBe("Pending name");
  expect(manager.get(".active-scope").text()).toBe("Active for sending: No environment.");

  await manager.setProps({ activeEnvironmentId: "staging" });
  expect(editSelect.element.value).toBe("staging");
  expect(rename.element.value).toBe("Pending name");
  expect(manager.get(".active-scope").text()).toBe("Active for sending: Staging.");
});

it("edits ordered variables without mutating the parent scope and preserves disabled rows", async () => {
  const original = localEnvironment();
  const manager = render([original], "local");
  await control(manager);
  await button(manager, "Manage environments").trigger("click");
  await manager.get('[aria-label="variable 1 value"]').setValue("https://staging.example.com");
  await manager.get('[aria-label="Enable variable 1"]').setValue(false);
  await button(manager, "Add variable").trigger("click");
  await manager.get('[aria-label="variable 2 name"]').setValue("token");
  await manager.get('[aria-label="variable 2 value"]').setValue("{{secret}}");
  expect(lastEnvironments(manager)[0].variables).toEqual([
    { name: "baseUrl", value: "https://staging.example.com", enabled: false },
    { name: "token", value: "{{secret}}", enabled: true },
  ]);
  expect(original.variables).toEqual([{ name: "baseUrl", value: "https://example.com", enabled: true }]);
  await manager.get('[aria-label="Remove variable 1"]').trigger("click");
  expect(lastEnvironments(manager)[0].variables).toHaveLength(1);
});

it("closes on Escape with focus returned and closes on outside pointer input", async () => {
  const manager = render([localEnvironment()], "local");
  const manageButton = button(manager, "Manage environments");
  await manageButton.trigger("click");
  await manager.get('[role="dialog"]').trigger("keydown", { key: "Escape" });
  expect(manager.find('[role="dialog"]').exists()).toBe(false);
  expect(document.activeElement).toBe(manageButton.element);
  await manageButton.trigger("click");
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await manager.vm.$nextTick();
  expect(manager.find('[role="dialog"]').exists()).toBe(false);
});

it("preserves an unfinished rename while editing environment variables", async () => {
  const manager = render([localEnvironment()], "local");
  await control(manager);
  await button(manager, "Manage environments").trigger("click");
  const rename = manager.findAll("form")[1].get("input");
  await rename.setValue("Pending name");
  await manager.get('[aria-label="variable 1 value"]').setValue("https://changed.example.com");
  expect(rename.element.value).toBe("Pending name");
  await manager.findAll("form")[1].trigger("submit");
  expect(lastEnvironments(manager)[0].name).toBe("Pending name");
});

it("undoes deletion at its original position with all variables and the previous active scope", async () => {
  const staging = { id: "staging", name: "Staging", variables: [
    { name: "token", value: "{{secret}}", enabled: false },
    { name: "token", value: "second", enabled: true },
  ] };
  const production = { ...localEnvironment(), id: "production", name: "Production" };
  const manager = render([localEnvironment(), staging, production], "staging");
  await control(manager);
  await button(manager, "Manage environments").trigger("click");
  await button(manager, "Delete environment").trigger("click");
  expect(manager.get('[role="status"]').text())
    .toBe('Deleted “Staging”. Active environment switched to No environment.');
  expect(manager.get("select").element.value).toBe("");
  await manager.get('[aria-label="Close environments"]').trigger("click");
  await button(manager, "Manage environments").trigger("click");
  await button(manager, "Undo deletion").trigger("click");
  expect(lastEnvironments(manager)).toEqual([localEnvironment(), staging, production]);
  expect(manager.get("select").element.value).toBe("staging");
  expect(manager.get('[role="dialog"] select').element.value).toBe("staging");
  expect(manager.get('[role="status"]').text()).toBe('Restored “Staging”.');
  expect(document.activeElement).toBe(manager.findAll("form")[1]!.get("input").element);
  expect(manager.findAll("button").some(candidate => candidate.text() === "Undo deletion")).toBe(false);
});

it.each(["production", ""])("undo preserves a sending-scope choice made after deletion: %s", async chosen => {
  const production = { ...localEnvironment(), id: "production", name: "Production" };
  const manager = render([localEnvironment(), production], "local");
  await control(manager);
  await button(manager, "Manage environments").trigger("click");
  await button(manager, "Delete environment").trigger("click");
  await manager.get("select").setValue(chosen);
  await button(manager, "Undo deletion").trigger("click");
  expect(lastEnvironments(manager)).toEqual([localEnvironment(), production]);
  expect(manager.get("select").element.value).toBe(chosen);
});

it("undoes an inactive deletion without activating it or discarding later edits", async () => {
  const staging = { ...localEnvironment(), id: "staging", name: "Staging" };
  const manager = render([localEnvironment(), staging], "local");
  await control(manager);
  await button(manager, "Manage environments").trigger("click");
  await manager.get('[role="dialog"] select').setValue("staging");
  await button(manager, "Delete environment").trigger("click");
  await manager.get('[aria-label="variable 1 value"]').setValue("https://changed.example.com");
  await button(manager, "Undo deletion").trigger("click");
  expect(lastEnvironments(manager)).toEqual([
    { ...localEnvironment(), variables: [{ name: "baseUrl", value: "https://changed.example.com", enabled: true }] },
    staging,
  ]);
  expect(manager.emitted("update:activeEnvironmentId")).toBeUndefined();
});

it("opens active environment variables through the public help action without changing the sending scope", async () => {
  const staging = { ...localEnvironment(), id: "staging", name: "Staging" };
  const manager = render([localEnvironment(), staging], "local");
  await button(manager, "Manage environments").trigger("click");
  await manager.get('[role="dialog"] select').setValue("staging");
  await manager.get('[aria-label="Close environments"]').trigger("click");
  await manager.vm.open();
  expect(manager.get('[role="dialog"] select').element.value).toBe("local");
  expect(document.activeElement).toBe(manager.get('[aria-label="variable 1 name"]').element);
  expect(manager.emitted("update:activeEnvironmentId")).toBeUndefined();

  const empty = render([], null);
  await empty.vm.open();
  expect(document.activeElement).toBe(empty.get('input[placeholder="Local, Staging, Production…"]').element);
});

type ManagerWrapper = ReturnType<typeof mount<typeof EnvironmentManager>>;
const mounted: ManagerWrapper[] = [];

function render(environments: Environment[], activeEnvironmentId: string | null) {
  const manager = mount(EnvironmentManager, { attachTo: document.body, props: { environments, activeEnvironmentId } });
  mounted.push(manager);
  return manager;
}

function control(manager: ManagerWrapper) {
  return manager.setProps({
    'onUpdate:environments': environments => { void manager.setProps({ environments }); },
    'onUpdate:activeEnvironmentId': activeEnvironmentId => { void manager.setProps({ activeEnvironmentId }); },
  });
}

function button(manager: ManagerWrapper, text: string) {
  return manager.findAll("button").find(candidate => candidate.text() === text)!;
}

function lastEnvironments(manager: ManagerWrapper) {
  return manager.emitted("update:environments")!.at(-1)![0] as Environment[];
}

function localEnvironment(): Environment {
  return { id: "local", name: "Local", variables: [{ name: "baseUrl", value: "https://example.com", enabled: true }] };
}
