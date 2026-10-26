<!-- EnvironmentManager separates the active execution scope from the environment being edited in its popover. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch } from "vue";
import type { Environment, KeyValueEntry } from "../request";
import KeyValueEditor from "./KeyValueEditor.vue";

const props = defineProps<{
  /** Named variable scopes owned by the workspace. */
  environments: readonly Environment[];
  /** Active execution scope; null means requests resolve without environment variables. */
  activeEnvironmentId: string | null;
  /** Lets a shared workspace menu call open() while keeping the active selector visible. */
  hideTrigger?: boolean;
}>();

const emit = defineEmits<{
  /** Complete replacement after creating, renaming, deleting, or editing variables. */
  "update:environments": [environments: Environment[]];
  /** Explicit execution scope choice; null means No environment or the active scope was deleted. */
  "update:activeEnvironmentId": [id: string | null];
}>();

const fieldId = useId();
const manager = useTemplateRef<HTMLElement>("manager");
const manageButton = useTemplateRef<HTMLButtonElement>("manageButton");
const editSelect = useTemplateRef<HTMLSelectElement>("editSelect");
const newNameInput = useTemplateRef<HTMLInputElement>("newNameInput");
const renameInput = useTemplateRef<HTMLInputElement>("renameInput");
const expanded = ref(false);
// External entry points may live outside this component; keep their focus target until dismissal.
let opener: HTMLElement | undefined;
const newName = ref("");
const renamedName = ref("");
// One reversible deletion is kept until the next deletion or Undo; closing the panel retains it.
// restoreActive is revoked by a later scope choice so Undo cannot redirect an intentional send target.
const deletedEnvironment = ref<{ environment: Environment; index: number; restoreActive: boolean }>();
const deletionMessage = ref("");
// Management owns this selection so inspecting or creating a scope cannot redirect the next send.
// It survives active-scope changes and resets only if the inspected scope is removed.
const inspectedEnvironmentId = ref(props.activeEnvironmentId ?? props.environments[0]?.id ?? null);
const selected = computed(() => props.environments.find(environment => environment.id === inspectedEnvironmentId.value));
const active = computed(() => props.environments.find(environment => environment.id === props.activeEnvironmentId));
watch(() => props.activeEnvironmentId, id => {
  if (id && deletedEnvironment.value) deletedEnvironment.value.restoreActive = false;
});
watch(() => props.environments.map(environment => environment.id), ids => {
  if (!ids.includes(inspectedEnvironmentId.value ?? "")) inspectedEnvironmentId.value = ids[0] ?? null;
});
watch([() => selected.value?.id, () => selected.value?.name], () => {
  renamedName.value = selected.value?.name ?? "";
}, { immediate: true });

onMounted(() => { document.addEventListener("pointerdown", closeOutside); });
onBeforeUnmount(() => { document.removeEventListener("pointerdown", closeOutside); });

function selectEnvironment(event: Event) {
  if (deletedEnvironment.value) deletedEnvironment.value.restoreActive = false;
  emit("update:activeEnvironmentId", (event.target as HTMLSelectElement).value || null);
}

/** Opens the active scope from request-field help without exposing management state to callers. */
async function open() {
  rememberOpener();
  if (active.value) inspectedEnvironmentId.value = active.value.id;
  expanded.value = true;
  await nextTick();
  const variableName = manager.value?.querySelector<HTMLInputElement>('[aria-label="variable 1 name"]');
  if (variableName) variableName.focus();
  else if (selected.value) manager.value?.querySelector<HTMLButtonElement>(".key-value-editor button")?.focus();
  else newNameInput.value?.focus();
}

defineExpose({ open });

async function toggleManagement() {
  if (expanded.value) {
    closeAndFocus();
    return;
  }

  rememberOpener();
  expanded.value = true;
  await nextTick();
  if (props.environments.length) editSelect.value?.focus();
  else newNameInput.value?.focus();
}

async function createEnvironment() {
  const name = newName.value.trim();
  if (!name) return;

  const environment: Environment = { id: crypto.randomUUID(), name, variables: [] };
  emit("update:environments", [...props.environments, environment]);
  inspectedEnvironmentId.value = environment.id;
  newName.value = "";
  await nextTick();
  renameInput.value?.focus();
}

function renameEnvironment() {
  const name = renamedName.value.trim();
  if (!selected.value || !name) return;
  updateSelected({ name });
}

async function deleteEnvironment() {
  if (!selected.value) return;
  const deletedId = selected.value.id;
  const wasActive = deletedId === props.activeEnvironmentId;
  deletedEnvironment.value = {
    environment: { ...selected.value, variables: selected.value.variables.map(variable => ({ ...variable })) },
    index: props.environments.findIndex(environment => environment.id === deletedId),
    restoreActive: wasActive,
  };
  deletionMessage.value = `Deleted “${selected.value.name}”.${wasActive ? " Active environment switched to No environment." : ""}`;
  emit("update:environments", props.environments.filter(environment => environment.id !== deletedId));
  if (wasActive) emit("update:activeEnvironmentId", null);

  await nextTick();
  if (props.environments.length) editSelect.value?.focus();
  else newNameInput.value?.focus();
}

async function undoDeletion() {
  const deletion = deletedEnvironment.value;
  if (!deletion) return;

  const environments = [...props.environments];
  if (!environments.some(environment => environment.id === deletion.environment.id)) {
    environments.splice(Math.min(deletion.index, environments.length), 0, deletion.environment);
    emit("update:environments", environments);
  }
  if (deletion.restoreActive && props.activeEnvironmentId === null) {
    emit("update:activeEnvironmentId", deletion.environment.id);
  }
  inspectedEnvironmentId.value = deletion.environment.id;
  deletedEnvironment.value = undefined;
  deletionMessage.value = `Restored “${deletion.environment.name}”.`;
  await nextTick();
  renameInput.value?.focus();
}

function updateSelected(changes: Partial<Pick<Environment, "name" | "variables">>) {
  if (!selected.value) return;
  emit("update:environments", props.environments.map(environment =>
    environment.id === selected.value!.id ? { ...environment, ...changes } : environment));
}

function updateVariables(variables: KeyValueEntry[]) {
  updateSelected({ variables });
}

function closeOutside(event: PointerEvent) {
  if (event.target instanceof Node && !manager.value?.contains(event.target)) expanded.value = false;
}

function closeOnFocusOutside(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !manager.value?.contains(event.relatedTarget)) expanded.value = false;
}

function closeAndFocus() {
  expanded.value = false;
  if (opener?.isConnected) opener.focus();
  else manageButton.value?.focus();
}

function rememberOpener() {
  if (!expanded.value) opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement : manageButton.value ?? undefined;
}
</script>

<template>
  <div ref="manager" class="environment-manager" @keydown.esc.stop="closeAndFocus" @focusout="closeOnFocusOutside">
    <label class="environment-selector" :for="`${fieldId}-environment`">
      <span>Environment</span>
      <select class="ui-input" :id="`${fieldId}-environment`" aria-label="Environment" :value="activeEnvironmentId ?? ''" @change="selectEnvironment">
        <option value="">No environment</option>
        <option v-for="environment in environments" :key="environment.id" :value="environment.id">{{ environment.name }}</option>
      </select>
    </label>
    <button v-if="!hideTrigger" ref="manageButton" class="ui-button manage-button" type="button" :aria-expanded="expanded"
      :aria-controls="`${fieldId}-manager`" @click="toggleManagement">Manage environments</button>
    <section v-if="expanded" :id="`${fieldId}-manager`" class="management-panel" role="dialog"
      :aria-labelledby="`${fieldId}-heading`">
      <div class="panel-heading">
        <h2 :id="`${fieldId}-heading`">Environments</h2>
        <button class="ui-button" type="button" aria-label="Close environments" @click="closeAndFocus">Close</button>
      </div>
      <p class="hint">Use <code v-pre>{{variable}}</code> in request URLs, headers, query parameters, bodies, and authentication.</p>
      <div v-if="environments.length" class="inspection-selection">
        <label class="grow" :for="`${fieldId}-edit-environment`">
          <span>Edit environment</span>
          <select class="ui-input" :id="`${fieldId}-edit-environment`" ref="editSelect" v-model="inspectedEnvironmentId">
            <option v-for="environment in environments" :key="environment.id" :value="environment.id">{{ environment.name }}</option>
          </select>
        </label>
        <button class="ui-button" type="button" :disabled="!selected || selected.id === activeEnvironmentId"
          @click="emit('update:activeEnvironmentId', selected!.id)">Use this environment</button>
      </div>
      <p class="active-scope">Active for sending: <strong>{{ active?.name ?? 'No environment' }}</strong>.</p>
      <div v-if="deletionMessage" class="deletion-feedback">
        <p role="status">{{ deletionMessage }}</p>
        <button class="ui-button" v-if="deletedEnvironment" type="button" @click="undoDeletion">Undo deletion</button>
      </div>
      <form class="name-form" @submit.prevent="createEnvironment">
        <label class="grow" :for="`${fieldId}-new-name`">
          <span>New environment name</span>
          <input class="ui-input" :id="`${fieldId}-new-name`" ref="newNameInput" v-model="newName" type="text" placeholder="Local, Staging, Production…" />
        </label>
        <button class="ui-button" type="submit" :disabled="!newName.trim()">Create environment</button>
      </form>
      <template v-if="selected">
        <form class="name-form existing-environment" @submit.prevent="renameEnvironment">
          <label class="grow" :for="`${fieldId}-rename`">
            <span>Environment name</span>
            <input class="ui-input" :id="`${fieldId}-rename`" ref="renameInput" v-model="renamedName" type="text" />
          </label>
          <button class="ui-button" type="submit" :disabled="!renamedName.trim() || renamedName.trim() === selected.name">Rename environment</button>
          <button type="button" class="ui-button ui-button--danger delete-button" @click="deleteEnvironment">Delete environment</button>
        </form>
        <KeyValueEditor :model-value="selected.variables" label="Variables" entry-label="variable" @update:model-value="updateVariables" />
      </template>
      <p v-else class="hint">Create an environment to edit its variables. Creating or editing an environment does not activate it.</p>
      <p class="storage-note">Variables and credentials are saved locally. Executed history contains their resolved values.</p>
    </section>
  </div>
</template>

<style scoped>
.environment-manager {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.environment-selector {
  display: flex;
  align-items: center;
  flex-direction: row;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.environment-selector > span { white-space: nowrap; }
.environment-selector > select { flex: 1; min-width: 0; width: 160px; max-width: 220px; }

label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: #b2bfd1;
  font-size: 11px;
}

select {
  max-width: 160px;
}

.manage-button {
  white-space: nowrap;
}

.management-panel {
  position: fixed;
  top: calc(var(--app-header-height, 52px) + 4px);
  right: 16px;
  z-index: 30;
  width: min(640px, calc(100vw - 32px));
  max-height: calc(100dvh - var(--app-header-height, 52px) - 20px);
  overflow: auto;
  padding: 16px;
  border: 1px solid #34435a;
  border-radius: 10px;
  color: var(--color-text);
  background: #101823;
  box-shadow: 0 18px 48px #0008;
}

.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

h2 {
  margin: 0;
  font-size: 14px;
}

.hint, .storage-note, .active-scope {
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.5;
}

.storage-note {
  margin-bottom: 0;
  padding-top: 12px;
  border-top: 1px solid var(--color-control-border);
  font-size: 11px;
}

.name-form, .inspection-selection {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.inspection-selection select {
  max-width: none;
}

.active-scope {
  margin-top: -6px;
}

.deletion-feedback {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px;
  margin-bottom: 16px;
  border: 1px solid #536b92;
  border-radius: 6px;
  background: #1b2a41;
}

.deletion-feedback p { margin: 0; font-size: 12px; line-height: 1.5; }
.deletion-feedback button { flex-shrink: 0; }

.grow {
  flex: 1 1 160px;
}

.existing-environment {
  padding-top: 16px;
  border-top: 1px solid var(--color-control-border);
}

@media (max-width: 760px) {
  .environment-selector > span {
    display: none;
  }

  .manage-button {
    max-width: 76px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  select {
    max-width: 120px;
  }

}

@media (max-width: 520px) { .environment-selector > select { max-width: none; } }
</style>
