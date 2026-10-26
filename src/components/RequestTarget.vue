<!-- RequestTarget previews destinations immediately and checks template bodies after editing pauses. -->
<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from "vue";
import { prepareNextRequest, previewRequestTarget } from "../prepareRequest";
import { EnvironmentVariableError } from "../requestVariables";
import type { Environment, HttpRequest, RequestData } from "../request";

const props = defineProps<{
  /** Current draft; preparation reads it without replacing placeholders or starting transport. */
  request: Readonly<RequestData>;
  /** Active execution scope; omitted means the request has no environment variables. */
  environment?: Environment;
  /** Exact next-send inputs for an unedited history draft; omitted uses normal environment preparation. */
  capturedRequest?: HttpRequest;
}>();

const emit = defineEmits<{
  /** Opens the parent environment editor when unresolved request fields prevent preparation. */
  "edit-environment": [];
}>();

const destination = computed(() => previewRequestTarget(props.request, props.environment, props.capturedRequest));
// A body error belongs only to the last settled inputs. Any edit clears it before
// another validation is scheduled, so old feedback cannot describe a new request.
const bodyError = ref<{ message: string; environmentError: boolean }>();
const target = computed(() => ({
  url: destination.value.value,
  error: destination.value.error ?? bodyError.value?.message ?? null,
  environmentError: destination.value.error ? destination.value.environmentError : bodyError.value?.environmentError ?? false,
}));
let validationTimer: ReturnType<typeof setTimeout> | undefined;
// Cached editors retain their inputs, but inactive tabs must not parse hidden bodies.
let active = true;

watch([destination, () => props.request.body], scheduleBodyValidation, { immediate: true });
onActivated(() => { active = true; scheduleBodyValidation(); });
onDeactivated(() => { active = false; cancelBodyValidation(); });
onBeforeUnmount(cancelBodyValidation);

function scheduleBodyValidation() {
  cancelBodyValidation();
  bodyError.value = undefined;
  if (!active || destination.value.error || props.capturedRequest
    || props.request.inputMode === "literal" || props.request.body.length === 0) return;

  validationTimer = setTimeout(() => {
    validationTimer = undefined;
    try {
      prepareNextRequest(props.request, props.environment, props.capturedRequest);
    } catch (error) {
      bodyError.value = {
        message: error instanceof Error ? error.message : "Unable to prepare this request.",
        environmentError: error instanceof EnvironmentVariableError,
      };
    }
  }, 200);
}

function cancelBodyValidation() {
  if (validationTimer !== undefined) clearTimeout(validationTimer);
  validationTimer = undefined;
}
</script>

<template>
  <div class="request-target" aria-label="Execution target">
    <span v-if="capturedRequest" class="environment" title="Captured inputs are sent unchanged; the active environment is not applied.">
      <strong>Captured inputs</strong>
    </span>
    <span v-else-if="request.inputMode === 'literal'" class="environment" title="Literal inputs are sent without applying the active environment.">
      <strong>Literal inputs</strong> · Environment not applied
    </span>
    <span v-else class="environment" :title="`Environment: ${environment?.name ?? 'No environment'}`">
      Environment: <strong>{{ environment?.name ?? 'No environment' }}</strong>
    </span>
    <span v-if="target.error" class="destination target-error" role="status" :title="target.error">
      Cannot send: {{ target.error }}
    </span>
    <button v-if="target.environmentError" type="button" class="ui-button ui-button--link edit-environment" @click="emit('edit-environment')">Edit environment</button>
    <span v-if="!target.error" class="destination" :title="target.url ?? undefined">
      <span>Target:</span> <code tabindex="0">{{ target.url }}</code>
    </span>
  </div>
</template>

<style scoped>
.request-target {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
  min-width: 0;
  margin-top: 6px;
  padding: 0 2px;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.5;
}

.environment {
  overflow-wrap: anywhere;
}

.environment strong {
  color: var(--color-text);
  font-weight: 600;
}

.destination {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.destination > span { flex-shrink: 0; }

.target-error {
  color: var(--color-danger);
  overflow-wrap: anywhere;
}

.edit-environment { align-self: flex-start; }

code {
  /* Keep every URL character reachable without allowing a long address to
     widen the editor or consume its vertical space. Focus enables keyboard scrolling. */
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  padding: 1px 0;
  color: var(--color-text);
  font-size: 13px;
  white-space: nowrap;
  scrollbar-width: thin;
}

code:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
</style>
