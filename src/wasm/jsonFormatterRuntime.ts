// Adapts the formatter's owned Wasm jobs to strings while preserving every UTF-16 code unit.
import type { JsonPreviewResult } from "../components/jsonPreview.ts";

/** A synchronous computation used inside a worker; worker termination cancels active work. */
export type JsonFormatter = (text: string, maxLength: number) => JsonPreviewResult;

/** Creates one isolated formatter instance. Every call releases its input and output in a finally block. */
export function createJsonFormatter(module: WebAssembly.Module): JsonFormatter {
  const wasm = new WebAssembly.Instance(module).exports as unknown as FormatterExports;
  // Validation rejects raw unpaired surrogates before returning output. Native
  // decoding is therefore lossless; escaped surrogate tokens remain ASCII.
  const decoder = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true });

  return (text, maxLength) => {
    if (!(maxLength >= 0)) {
      throw new RangeError("The formatted output limit must be nonnegative.");
    }
    // Wasm32 cannot address an output above this limit; Infinity means no smaller
    // caller budget, as in the existing formatter. Fractional limits round down.
    const limit = Math.min(Math.floor(maxLength), 0xffff_ffff);

    const job = wasm.job_new(text.length);
    try {
      // Copy original units before validation. Encoding input as UTF-8 would
      // replace malformed surrogates rather than allowing the core to reject them.
      const input = new Uint16Array(wasm.memory.buffer, wasm.job_text(job), text.length);
      for (let index = 0; index < text.length; index += 1) input[index] = text.charCodeAt(index);

      const status = wasm.job_format(job, limit);
      if (status === 1) return { status: "invalid" };
      if (status === 2) return { status: "too-large" };
      if (status !== 0) throw new Error(`Unknown JSON formatter status: ${status}.`);

      // Formatting may grow linear memory, invalidating the old input view.
      const output = new Uint8Array(wasm.memory.buffer, wasm.job_text(job), wasm.job_length(job) * 2);
      return { status: "formatted", text: decoder.decode(output) };
    } finally {
      wasm.job_free(job);
    }
  };
}

/** Private ABI: pointers identify live jobs, and text pointers expire when a job formats or is freed. */
interface FormatterExports {
  /** Linear memory shared only for the duration of an input or output copy. */
  memory: WebAssembly.Memory;
  /** Allocates a job containing the specified number of zeroed UTF-16 input units. */
  job_new(length: number): number;
  /** Returns the current input/output pointer without transferring ownership. */
  job_text(job: number): number;
  /** Returns the current input/output length in UTF-16 code units. */
  job_length(job: number): number;
  /** Replaces input on success; returns 0=formatted, 1=invalid, 2=too-large. */
  job_format(job: number, maxLength: number): number;
  /** Frees the job and its buffer; the host must copy the output before this call. */
  job_free(job: number): void;
}
