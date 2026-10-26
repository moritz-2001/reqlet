// Shares pure environment resolution and placeholder completion between execution and editable request fields.
import type { Environment } from "./request";

/** A variable-scope problem that the editor can route to the environment manager. */
export class EnvironmentVariableError extends Error {}

/**
 * Creates one isolated resolver for an environment snapshot. Values can reference other enabled variables.
 * The returned function preserves its input and throws EnvironmentVariableError for invalid scopes or references.
 * Its cache belongs only to this resolver; callers must recreate it after an environment edit.
 */
export function createVariableResolver(environment?: Environment): (text: string) => string {
  const variables = new Map<string, string>();
  for (const variable of environment?.variables.filter(entry => entry.enabled) ?? []) {
    const name = variable.name.trim();
    if (!name) throw new EnvironmentVariableError("Enabled environment variables need a name.");
    if (variables.has(name)) throw new EnvironmentVariableError(`Environment variable "${name}" is defined more than once.`);
    variables.set(name, variable.value);
  }

  // Nested values share work within one resolution without retaining secrets or stale environment edits globally.
  const resolved = new Map<string, string>();
  function resolve(text: string, ancestors: readonly string[] = []): string {
    return text.replace(/\{\{([^{}]*)\}\}/g, (_placeholder, reference: string) => {
      const name = reference.trim();
      if (!variables.has(name)) throw new EnvironmentVariableError(`Environment variable "${name || "(empty)"}" is not defined.`);
      if (ancestors.includes(name)) {
        throw new EnvironmentVariableError(`Environment variable cycle: ${[...ancestors, name].join(" → ")}.`);
      }
      if (!resolved.has(name)) resolved.set(name, resolve(variables.get(name)!, [...ancestors, name]));
      return resolved.get(name)!;
    });
  }
  return resolve;
}

/** A replacement range and matching names for the placeholder containing the input caret. */
export interface VariableCompletion {
  /** Offset of the opening braces, so choosing a name replaces the entire current placeholder. */
  start: number;
  /** Offset after existing closing braces, or the caret when the placeholder is incomplete. */
  end: number;
  /** Enabled names matching the typed prefix; values are deliberately excluded to protect credentials. */
  names: string[];
}

/** Finds enabled variable names at a caret without inspecting or exposing their resolved values. */
export function variableCompletion(text: string, caret: number, environment?: Environment): VariableCompletion | undefined {
  const start = text.lastIndexOf("{{", caret);
  if (start < 0 || caret < start + 2) return undefined;

  const prefix = text.slice(start + 2, caret);
  if (/[{}]/.test(prefix)) return undefined;

  const closing = text.indexOf("}}", caret);
  const nextOpening = text.indexOf("{{", caret);
  const end = closing >= 0 && (nextOpening < 0 || closing < nextOpening) ? closing + 2 : caret;
  const names = [...new Set(environment?.variables.filter(entry => entry.enabled)
    .map(entry => entry.name.trim()).filter(name => name && name.toLowerCase().startsWith(prefix.trim().toLowerCase())) ?? [])]
    .sort((a, b) => a.localeCompare(b));
  return names.length ? { start, end, names } : undefined;
}
