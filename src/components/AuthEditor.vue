<!-- AuthEditor edits parent-owned authentication and remembers each mode's accepted inputs for this editor's lifetime. -->
<script setup lang="ts">
import { useId, watch } from "vue";
import type { Environment, RequestAuth, RequestInputMode } from "../request";
import VariableInput from "./VariableInput.vue";

const props = defineProps<{
  /** Saved authentication configuration, including unresolved environment placeholders. */
  modelValue: Readonly<RequestAuth>;
  /** Active request scope for name completion and credential validation. */
  environment?: Environment;
  /** Captured snapshots must not reinterpret literal placeholders as variables. */
  captured?: boolean;
  /** Literal definitions retain credential text without resolving environment placeholders. */
  inputMode?: RequestInputMode;
}>();

const emit = defineEmits<{
  /** Complete active configuration; switching type restores that mode's remembered inputs. */
  "update:modelValue": [auth: RequestAuth];
  /** Opens the active environment when a credential reference is unresolved. */
  "edit-environment": [];
}>();

const fieldId = useId();
const labels = { none: "None", bearer: "Bearer token", basic: "Basic", "api-key": "API key" };
// Only parent-accepted values enter this cache. Keyed request editors keep it
// across tab switches; unmounting releases inactive credentials without saving them.
// Copies prevent later parent mutations from changing an inactive mode's draft.
const drafts = new Map<RequestAuth["type"], RequestAuth>();

watch(() => props.modelValue, auth => {
  drafts.set(auth.type, { ...auth });
}, { immediate: true, deep: true });

function changeType(event: Event) {
  const type = (event.target as HTMLSelectElement).value as RequestAuth["type"];
  // Capture the current prop again so a switch in the same update tick uses the
  // latest parent value, including an external edit that has not reached the watch.
  drafts.set(props.modelValue.type, { ...props.modelValue });
  emit("update:modelValue", { ...(drafts.get(type) ?? defaultAuth(type)) });
}

function updateBearer(token: string) {
  if (props.modelValue.type === "bearer") emit("update:modelValue", { ...props.modelValue, token });
}

function updateBasic(changes: Partial<{ username: string; password: string }>) {
  if (props.modelValue.type === "basic") emit("update:modelValue", { ...props.modelValue, ...changes });
}

function updateApiKey(changes: Partial<{ name: string; value: string; location: "header" | "query" }>) {
  if (props.modelValue.type === "api-key") emit("update:modelValue", { ...props.modelValue, ...changes });
}

function defaultAuth(type: RequestAuth["type"]): RequestAuth {
  const defaults: Record<RequestAuth["type"], RequestAuth> = {
    none: { type: "none" },
    bearer: { type: "bearer", token: "" },
    basic: { type: "basic", username: "", password: "" },
    "api-key": { type: "api-key", name: "", value: "", location: "header" },
  };
  return defaults[type];
}
</script>

<template>
  <details class="auth-editor">
    <summary>Authentication: {{ labels[modelValue.type] }}</summary>
    <div class="auth-fields">
      <label :for="`${fieldId}-type`">
        <span>Authentication type</span>
        <select class="ui-input" :id="`${fieldId}-type`" :value="modelValue.type" @change="changeType">
          <option v-for="(label, type) in labels" :key="type" :value="type">{{ label }}</option>
        </select>
      </label>
      <template v-if="modelValue.type === 'bearer'">
        <label :for="`${fieldId}-token`">
          <span>Bearer token</span>
          <VariableInput
            :id="`${fieldId}-token`" :model-value="modelValue.token" :environment="environment"
            :literal="captured" :input-mode="inputMode" kind="header-value" secret placeholder="Token or {{token}}"
            @update:model-value="updateBearer($event)" @edit-environment="emit('edit-environment')"
          />
        </label>
      </template>
      <template v-else-if="modelValue.type === 'basic'">
        <label :for="`${fieldId}-username`">
          <span>Username</span>
          <VariableInput
            :id="`${fieldId}-username`" :model-value="modelValue.username" :environment="environment"
            :literal="captured" :input-mode="inputMode" kind="basic-username" @update:model-value="updateBasic({ username: $event })"
            @edit-environment="emit('edit-environment')"
          />
        </label>
        <label :for="`${fieldId}-password`">
          <span>Password</span>
          <VariableInput
            :id="`${fieldId}-password`" :model-value="modelValue.password" :environment="environment"
            :literal="captured" :input-mode="inputMode" secret @update:model-value="updateBasic({ password: $event })"
            @edit-environment="emit('edit-environment')"
          />
        </label>
      </template>
      <template v-else-if="modelValue.type === 'api-key'">
        <label :for="`${fieldId}-key-name`">
          <span>API key name</span>
          <VariableInput
            :id="`${fieldId}-key-name`" :model-value="modelValue.name" :environment="environment"
            :literal="captured" :input-mode="inputMode" :kind="modelValue.location === 'header' ? 'header-name' : 'api-key-name'"
            placeholder="X-API-Key" @update:model-value="updateApiKey({ name: $event })"
            @edit-environment="emit('edit-environment')"
          />
        </label>
        <label :for="`${fieldId}-key-value`">
          <span>API key value</span>
          <VariableInput
            :id="`${fieldId}-key-value`" :model-value="modelValue.value" :environment="environment"
            :literal="captured" :input-mode="inputMode" :kind="modelValue.location === 'header' ? 'header-value' : 'text'"
            secret placeholder="Key or {{apiKey}}" @update:model-value="updateApiKey({ value: $event })"
            @edit-environment="emit('edit-environment')"
          />
        </label>
        <label :for="`${fieldId}-key-location`">
          <span>API key location</span>
          <select class="ui-input" :id="`${fieldId}-key-location`" :value="modelValue.location"
            @change="updateApiKey({ location: ($event.target as HTMLSelectElement).value as 'header' | 'query' })">
            <option value="header">Header</option>
            <option value="query">Query parameter</option>
          </select>
        </label>
      </template>
      <p v-if="modelValue.type !== 'none'" class="auth-hint">
        <template v-if="!captured && inputMode !== 'literal'">Supports <code v-pre>{{variables}}</code>. </template>
        Authentication replaces matching headers or query parameters.
        Inputs are remembered while switching types. Only the selected type is saved locally with this request.
      </p>
    </div>
  </details>
</template>

<style scoped>
.auth-editor {
  margin-top: 8px;
  padding: 8px 12px;
  border: 1px solid var(--color-control-border);
  border-radius: 8px;
}

summary {
  color: #b2bfd1;
  font-size: 12px;
  cursor: pointer;
}

.auth-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-top: 12px;
}

label {
  display: flex;
  flex: 1 1 150px;
  flex-direction: column;
  gap: 5px;
  color: #b2bfd1;
  font-size: 11px;
}

select { width: 100%; }

.auth-hint {
  flex-basis: 100%;
  margin: 0;
  color: var(--color-muted);
  font-size: 11px;
  line-height: 1.5;
}

summary:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }
</style>
