// Executes concrete HttpRequest snapshots through native HTTP or the browser preview transport.
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { HttpRequest, HttpResponse } from "./request";

/** Transport failures stay separate from valid HTTP responses, including 4xx and 5xx. */
export class HttpExecutionError extends Error {
  constructor(readonly kind: "validation" | "network" | "timeout" | "cancelled" | "response-limit" | "internal", message: string) {
    super(message);
    this.name = kind === "cancelled" ? "AbortError" : "HttpExecutionError";
  }
}

// Fetch exposes decompressed bytes; the native transport separately bounds received and decoded bytes.
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Executes a resolved snapshot; aborting rejects with an Error named AbortError. */
export async function executeHttp(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
  if (signal?.aborted) throw cancelled();
  validateRequest(request);

  try {
    return await (isTauri() ? executeNative(request, signal) : executeBrowser(request, signal));
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw transportError(error);
  }
}

async function executeNative(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
  // Reserving first prevents a cancel command from arriving before the operation exists.
  // Even an already-cancelled reservation is executed once so Rust can release its registry entry.
  const operationId = await invoke<string>("http_create_operation");
  const abort = () => { void invoke("http_cancel", { operationId }).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  try {
    const response = await invoke<HttpResponse>("http_execute", { operationId, request });
    if (signal?.aborted) throw cancelled();
    return response;
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw transportError(error);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function executeBrowser(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
  if (request.body && /^(GET|HEAD)$/i.test(request.method)) {
    throw new HttpExecutionError("validation", "Browser preview cannot send GET or HEAD bodies. Use the desktop app for this request.");
  }
  if (request.redirectPolicy === "follow") {
    throw new HttpExecutionError("validation", "Browser preview cannot safely inspect cross-origin redirects or prevent HTTPS downgrades. Use the desktop app to follow redirects.");
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs);
  const startedAt = performance.now();

  try {
    const headers = new Headers();
    for (const header of request.headers) headers.append(header.name, header.value);
    const response = await fetch(request.url, {
      method: request.method,
      headers,
      body: request.body || undefined,
      signal: controller.signal,
      credentials: "omit",
      redirect: "manual",
    });
    if (response.type === "opaqueredirect" || (request.redirectPolicy === "same-origin" && response.status >= 300 && response.status < 400 && response.headers.has("location"))) {
      throw new HttpExecutionError("validation", "Browser preview stopped a redirect, but fetch hides its destination and response. Use the desktop app to inspect or follow it safely.");
    }
    const bytes = await readBrowserBody(response, controller.signal);
    if (signal?.aborted) throw cancelled();
    if (timedOut) throw timeout(request.timeoutMs);

    return {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers: Array.from(response.headers, ([name, value]) => ({ name, value })),
      body: decodeBody(bytes, response.headers.get("content-type")),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      sizeBytes: bytes.byteLength,
    };
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (timedOut) throw timeout(request.timeoutMs);
    if (error instanceof HttpExecutionError) throw error;
    throw new HttpExecutionError("network", "Request failed in browser preview. Check the address, connection, and server CORS policy.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function validateRequest(request: HttpRequest): void {
  let url: URL;
  try { url = new URL(request.url); } catch { throw new HttpExecutionError("validation", "Enter an absolute HTTP or HTTPS URL."); }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) {
    throw new HttpExecutionError("validation", "Use an HTTP or HTTPS URL without embedded credentials; configure authentication separately.");
  }
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(request.method)) {
    throw new HttpExecutionError("validation", "Enter a valid HTTP method.");
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2_147_483_647) {
    throw new HttpExecutionError("validation", "Timeout must be an integer from 1 to 2147483647 milliseconds.");
  }
  if (request.redirectPolicy !== undefined && !["never", "same-origin", "follow"].includes(request.redirectPolicy)) {
    throw new HttpExecutionError("validation", "Redirect policy must be never, same-origin, or follow.");
  }
  if (request.sensitiveHeaderNames !== undefined && (!Array.isArray(request.sensitiveHeaderNames)
    || request.sensitiveHeaderNames.some(name => typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)))) {
    throw new HttpExecutionError("validation", "Sensitive header names must be HTTP tokens.");
  }
  for (const header of request.headers) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name) || /[^\t\x20-\x7e\x80-\xff]/.test(header.value)) {
      throw new HttpExecutionError("validation", "Header names must be HTTP tokens and values cannot contain line breaks or unsupported characters.");
    }
  }
}

async function readBrowserBody(response: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_RESPONSE_BYTES - length) {
        throw new HttpExecutionError("response-limit", "Decoded response body exceeds the 64 MiB limit.");
      }
      chunks.push(value);
      length += value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    complete = true;
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) abort();
    reader.releaseLock();
  }
}

function decodeBody(bytes: Uint8Array<ArrayBuffer>, contentType: string | null): string {
  const charset = contentType?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ?? "utf-8";
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

function transportError(error: unknown): HttpExecutionError {
  if (error instanceof HttpExecutionError) return error;
  if (typeof error === "object" && error !== null && "kind" in error && "message" in error) {
    const kind = error.kind;
    if (["validation", "network", "timeout", "cancelled", "response-limit", "internal"].includes(String(kind))) {
      return new HttpExecutionError(kind as HttpExecutionError["kind"], String(error.message));
    }
  }
  return new HttpExecutionError("internal", error instanceof Error ? error.message : String(error));
}

function cancelled(): HttpExecutionError {
  return new HttpExecutionError("cancelled", "Request cancelled.");
}

function timeout(timeoutMs: number): HttpExecutionError {
  return new HttpExecutionError("timeout", `Request timed out after ${timeoutMs} ms.`);
}
