<!-- RequestFields keeps the request address and slotted execution actions together at every window size. -->
<script setup lang="ts">
import { useId } from "vue";
import type { Environment, RequestData } from "../request";
import MethodSelector from "./MethodSelector.vue";
import VariableInput from "./VariableInput.vue";

const props = defineProps<{
  /** Saved request definition; every address edit emits a complete replacement. */
  modelValue: Readonly<RequestData>;
  /** Scope for variable completion and local URL feedback; omitted means no environment. */
  environment?: Environment;
  /** Exact captured drafts bypass variable interpretation until the parent clears this after an edit. */
  captured?: boolean;
}>();

const emit = defineEmits<{
  /** Updated definition without changing the original parent-owned object. */
  "update:modelValue": [request: RequestData];
  /** Requests access to the parent-owned environment manager. */
  "edit-environment": [];
}>();

const fieldId = useId();

function updateRequest(changes: Partial<RequestData>) {
  emit("update:modelValue", { ...props.modelValue, ...changes });
}
</script>

<template>
  <section class="request-fields" aria-label="Request address">
    <MethodSelector
      class="method-field"
      :model-value="modelValue.method"
      :literal="captured"
      @update:model-value="updateRequest({ method: $event })"
    />
    <label class="url-field" :for="`${fieldId}-url`">
      <span>URL</span>
      <VariableInput
        :id="`${fieldId}-url`"
        :model-value="modelValue.path"
        :environment="environment"
        :literal="captured"
        :input-mode="modelValue.inputMode"
        kind="url"
        preview
        aria-label="Request URL"
        inputmode="url"
        placeholder="https://api.example.com/resource or {{baseUrl}}/resource"
        @update:model-value="updateRequest({ path: $event })"
        @edit-environment="emit('edit-environment')"
      />
    </label>
    <div class="execution-actions"><slot name="actions" /></div>
  </section>
</template>

<style scoped>
.request-fields {
  container: request-address / inline-size;
  display: grid;
  grid-template-columns: 116px minmax(0, 1fr) auto;
  flex-shrink: 0;
  align-items: start;
  gap: 8px;
  min-width: 0;
  padding: 8px;
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  color: #b2bfd1;
  font-size: 12px;
}

:deep(input) { font-size: 13px; }

.execution-actions { display: flex; padding-top: 18px; flex-shrink: 0; gap: 6px; }
.execution-actions:empty { display: none; }

/* Keep the complete address editable when execution adds Cancel beside Send. */
@container request-address (max-width: 420px) {
  .method-field { grid-column: 1; grid-row: 1; }
  .execution-actions { grid-column: 2 / -1; grid-row: 1; justify-content: end; }
  .url-field { grid-column: 1 / -1; grid-row: 2; }
}

</style>
