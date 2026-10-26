// prepareNextRequest selects transport inputs; target, MIME, and field previews share pure resolution rules.
import type { Environment, HttpHeader, HttpRequest, RequestAuth, RequestData, RequestInputMode } from "./request";
import { createVariableResolver, EnvironmentVariableError } from "./requestVariables";
import { copyHttpRequest } from "./requestSnapshot";
import { stripJsonComments, toStrictJson } from "./json";
import { bodyText } from "./bodyDocument";

/**
 * Selects the exact next-send snapshot for transport, complete preview validation, and cURL export.
 * Unedited history drafts retain captured inputs; other definitions resolve the current environment.
 * The returned request owns its mutable arrays independently of either input.
 */
export function prepareNextRequest(request: RequestData, environment?: Environment, capturedRequest?: HttpRequest): HttpRequest {
  return capturedRequest ? copyHttpRequest(capturedRequest) : prepareRequest(request, environment);
}

/**
 * Resolves enabled environment variables and applies authentication without editing the draft.
 * Authentication replaces matching headers (case-insensitive) or query parameters (case-sensitive).
 * Throws a readable Error when variables or transport settings cannot produce a valid request.
 */
export function prepareRequest(request: RequestData, environment?: Environment): HttpRequest {
  const { resolve, method, url, headers, contentType } = prepareRequestMetadata(request, environment);
  const jsonBody = request.inputMode !== "literal" && isJsonContentType(contentType);
  const source = bodyText(request.body);
  const body = jsonBody ? resolveJsonBody(source, resolve) : resolve(source);
  if (body && !headers.some(header => header.name.toLowerCase() === "content-type")) {
    headers.push({ name: "Content-Type", value: contentType });
  }
  for (const header of headers) validateHeader(header);
  const sensitiveHeaderNames = [...new Set([
    ...request.sensitiveHeaderNames ?? [],
    ...(request.auth.type === "api-key" && request.auth.location === "header" ? [resolve(request.auth.name)] : []),
  ].map(name => name.toLowerCase()))];

  return {
    method, url: url.href, headers, body, timeoutMs: request.timeoutMs,
    ...(request.redirectPolicy === undefined ? {} : { redirectPolicy: request.redirectPolicy }),
    ...(sensitiveHeaderNames.length ? { sensitiveHeaderNames } : {}),
  };
}

/**
 * Projects the next destination and validates transport metadata without resolving or parsing the body.
 * Captures take precedence; literal inputs also validate their conditional default Content-Type immediately.
 * Template body errors and validation of its conditional default header require prepareNextRequest.
 */
export function previewRequestTarget(
  request: RequestData, environment?: Environment, capturedRequest?: HttpRequest,
): RequestFieldPreview {
  try {
    if (capturedRequest) return { value: capturedRequest.url, error: null, environmentError: false };
    const { url, headers, contentType } = prepareRequestMetadata(request, environment);
    for (const header of headers) validateHeader(header);
    if (request.inputMode === "literal" && request.body.length && !headers.some(header => header.name.toLowerCase() === "content-type")) {
      validateFieldValue(contentType, "header-value");
    }
    return { value: url.href, error: null, environmentError: false };
  } catch (error) {
    return fieldPreviewError(error);
  }
}

/** The input responsible for the body's effective MIME type; none means a captured request sent no header. */
export type RequestContentTypeSource = "default" | "header" | "authentication" | "captured" | "none";

/** Resolved body format for editor tooling, or a recoverable problem in the relevant header inputs. */
export type RequestContentTypePreview = RequestFieldPreview & { source: RequestContentTypeSource | null };

/**
 * Projects the same header/authentication precedence as transport without preparing URL, query, or body.
 * Editable empty bodies use the configured default to support composing their future body. Captures
 * use only their actual headers and ignore both editable fields and the active environment.
 */
export function previewRequestContentType(
  request: RequestData, environment?: Environment, capturedRequest?: HttpRequest,
): RequestContentTypePreview {
  try {
    if (capturedRequest) {
      const header = findContentType(capturedRequest.headers);
      return { value: header?.value ?? "", error: null, environmentError: false, source: header ? "captured" : "none" };
    }

    const resolve = requestResolver(request, environment);
    const { headers, authentication } = resolveRequestHeaders(request, resolve);
    const header = findContentType(headers);
    const value = header?.value ?? resolve(request.contentType);
    validateFieldValue(value, "header-value");
    const source = !header ? "default"
      : authentication?.name.toLowerCase() === "content-type" ? "authentication" : "header";
    return { value, error: null, environmentError: false, source };
  } catch (error) {
    return { ...fieldPreviewError(error), source: null };
  }
}

/** Field semantics shared by local editor feedback and transport preparation. */
export type RequestFieldKind = "text" | "url" | "method" | "header-name" | "header-value" | "basic-username" | "api-key-name";

/** A resolved editor value or a problem associated with that specific input. */
export type RequestFieldPreview =
  | { value: string; error: null; environmentError: false }
  | { value: null; error: string; environmentError: boolean };

/** Resolves and validates one input without preparing unrelated fields or modifying the draft. */
export function previewRequestField(value: string, kind: RequestFieldKind, environment?: Environment, inputMode: RequestInputMode = "template"): RequestFieldPreview {
  try {
    const resolved = kind === "method" ? value.trim().toUpperCase()
      : inputMode === "literal" ? value : createVariableResolver(environment)(value);
    validateFieldValue(resolved, kind);
    return { value: resolved, error: null, environmentError: false };
  } catch (error) {
    return fieldPreviewError(error);
  }
}

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isJsonContentType(contentType: string): boolean {
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  return mime === "application/json" || mime.endsWith("+json");
}

function resolveJsonBody(body: string, resolve: (value: string) => string): string {
  // Commented-out variables are inactive even when bare template values make the source
  // incomplete JSON. Validate only after substitution; literal requests bypass this path.
  const resolved = resolve(stripJsonComments(body));
  try { return toStrictJson(resolved); }
  catch (error) {
    // Keep malformed payloads sendable for testing API validation, as with other text bodies.
    if (error instanceof SyntaxError) return resolve(body);
    throw error;
  }
}

function requestUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter an absolute HTTP or HTTPS URL."); }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("Use an HTTP or HTTPS URL without embedded credentials; configure authentication separately.");
  }
  return url;
}

function requestResolver(request: RequestData, environment?: Environment): (value: string) => string {
  if (request.inputMode !== undefined && !["template", "literal"].includes(request.inputMode)) {
    throw new Error("Input mode must be template or literal.");
  }
  return request.inputMode === "literal" ? value => value : createVariableResolver(environment);
}

function prepareRequestMetadata(request: RequestData, environment?: Environment) {
  const resolve = requestResolver(request, environment);
  const method = request.method.trim().toUpperCase();
  validateFieldValue(method, "method");
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2_147_483_647) {
    throw new Error("Timeout must be an integer from 1 to 2147483647 milliseconds.");
  }
  if (request.redirectPolicy !== undefined && !["never", "same-origin", "follow"].includes(request.redirectPolicy)) {
    throw new Error("Redirect policy must be never, same-origin, or follow.");
  }
  for (const name of request.sensitiveHeaderNames ?? []) validateFieldValue(name, "header-name");

  const url = requestUrl(resolve(request.path));
  for (const entry of request.query.filter(entry => entry.enabled)) {
    url.searchParams.append(resolve(entry.name), resolve(entry.value));
  }
  const { headers } = resolveRequestHeaders(request, resolve);
  applyQueryAuthentication(request.auth, resolve, url);
  const contentType = findContentType(headers)?.value ?? (request.body.length ? resolve(request.contentType) : "");
  return { resolve, method, url, headers, contentType };
}

function resolveRequestHeaders(request: RequestData, resolve: (value: string) => string) {
  const headers = request.headers.filter(entry => entry.enabled).map(entry => ({
    name: resolve(entry.name), value: resolve(entry.value),
  }));
  const authentication = authenticationHeader(request.auth, resolve);
  return { headers: authentication ? replaceHeader(headers, authentication.name, authentication.value) : headers, authentication };
}

function authenticationHeader(auth: RequestAuth, resolve: (text: string) => string): HttpHeader | undefined {
  switch (auth.type) {
    case "none": return undefined;
    case "bearer": return { name: "Authorization", value: `Bearer ${resolve(auth.token)}` };
    case "basic": {
      const username = resolve(auth.username);
      validateFieldValue(username, "basic-username");
      const credentials = new TextEncoder().encode(`${username}:${resolve(auth.password)}`);
      let binary = "";
      for (const byte of credentials) binary += String.fromCharCode(byte);
      return { name: "Authorization", value: `Basic ${btoa(binary)}` };
    }
    case "api-key": {
      if (auth.location !== "header") return undefined;
      const name = resolve(auth.name);
      validateFieldValue(name, "api-key-name");
      return { name, value: resolve(auth.value) };
    }
  }
}

function applyQueryAuthentication(auth: RequestAuth, resolve: (text: string) => string, url: URL): void {
  if (auth.type !== "api-key" || auth.location !== "query") return;

  const name = resolve(auth.name);
  const value = resolve(auth.value);
  validateFieldValue(name, "api-key-name");
  url.searchParams.delete(name);
  url.searchParams.append(name, value);
}

function findContentType(headers: readonly HttpHeader[]): HttpHeader | undefined {
  return headers.find(header => header.name.toLowerCase() === "content-type");
}

function fieldPreviewError(error: unknown): Extract<RequestFieldPreview, { value: null }> {
  return {
    value: null,
    error: error instanceof Error ? error.message : "Unable to prepare this field.",
    environmentError: error instanceof EnvironmentVariableError,
  };
}

function replaceHeader(headers: HttpHeader[], name: string, value: string): HttpHeader[] {
  return [...headers.filter(header => header.name.toLowerCase() !== name.toLowerCase()), { name, value }];
}

function validateHeader(header: HttpHeader): void {
  validateFieldValue(header.name, "header-name");
  validateFieldValue(header.value, "header-value");
}

function validateFieldValue(value: string, kind: RequestFieldKind): void {
  switch (kind) {
    case "url": requestUrl(value); break;
    case "method":
      if (!HTTP_TOKEN.test(value)) throw new Error("Enter a valid HTTP method.");
      break;
    case "header-name":
      if (!HTTP_TOKEN.test(value)) throw new Error("Header names must be HTTP tokens; spaces, line breaks, and unsupported characters are not allowed.");
      break;
    case "header-value":
      if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) {
        throw new Error("Header names must be HTTP tokens and values cannot contain line breaks or unsupported characters.");
      }
      break;
    case "basic-username":
      if (value.includes(":")) throw new Error("Basic authentication usernames cannot contain a colon.");
      break;
    case "api-key-name":
      if (!value) throw new Error("API key authentication needs a name.");
      break;
  }
}
