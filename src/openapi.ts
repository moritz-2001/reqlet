// Imports OpenAPI descriptions without network access; OpenApiPreview separates review from collection creation.
import { parseDocument } from "yaml";
import type { CollectionNode } from "./components/collectionTree";
import type { CollectionImport } from "./interchange";
import { createRequest, type KeyValueEntry, type RequestAuth, type RequestData } from "./request";
import { hasOwn, isOpenApiObject, openApiExample, openApiJson, openApiScalar, type OpenApiObject, type OpenApiValueContext } from "./openapiValues";

/** An import candidate that can be reviewed and filtered without changing the workspace. */
export interface OpenApiPreview {
  /** API title used for the new root folder when this preview is imported. */
  title: string;
  /** HTTP operations in document path order; each owns an independent editable request definition. */
  operations: readonly OpenApiOperation[];
  /** Deduplicated explanations of unsupported features, omitted inputs, and sample approximations. */
  warnings: readonly string[];
}

/** One selectable operation and the request definition derived from its examples and schemas. */
export interface OpenApiOperation {
  /** Stable selection identity formed from uppercase method and original templated path, independent of operationId. */
  id: string;
  /** Uppercase HTTP method displayed beside the operation in the preview. */
  method: string;
  /** Original OpenAPI path, retaining parameter names for review and stable selection. */
  path: string;
  /** Summary, operationId, or method/path fallback used as the saved request name. */
  name: string;
  /** First operation tag used as a folder name; untagged operations use Other. */
  tag: string;
  /** Literal-mode request with example values and empty authentication credentials, never sent by the importer. */
  request: RequestData;
}

/** Parses OpenAPI 3.0/3.1 JSON or YAML locally, throwing useful errors before producing a reviewable preview. */
export function parseOpenApi(text: string, options: { baseUrl?: string } = {}): OpenApiPreview {
  const document = readDocument(text);
  if (typeof document.openapi !== "string" || !/^3\.(?:0|1)\.\d+(?:[-+].*)?$/.test(document.openapi)) {
    throw new Error("Unsupported OpenAPI version. Use an OpenAPI 3.0 or 3.1 JSON or YAML document.");
  }
  const title = isOpenApiObject(document.info) ? nonemptyString(document.info.title) : undefined;
  if (!title) {
    throw new Error("The OpenAPI document needs an info.title to name its imported collection.");
  }
  if (!isOpenApiObject(document.paths)) throw new Error("The OpenAPI document needs a paths object containing HTTP operations.");
  if (options.baseUrl !== undefined && typeof options.baseUrl !== "string") throw new Error("The base URL override must be text.");

  const warnings = new Set<string>();
  const context = valueContext(document, warnings);
  const operations: OpenApiOperation[] = [];
  let generatedSize = 0;
  for (const [path, rawPath] of Object.entries(document.paths)) {
    if (path.startsWith("x-")) continue;
    if (!path.startsWith("/") || /[?#\r\n\0]/.test(path)) throw new Error(`Invalid OpenAPI path ${path}: paths must start with / and contain no query or fragment.`);
    const pathItem = context.resolve(rawPath, `Path ${path}`);
    if (!pathItem) continue;
    for (const method of METHODS) {
      if (!hasOwn(pathItem, method)) continue;
      const operation = context.resolve(pathItem[method], `${method.toUpperCase()} ${path}`);
      if (!operation) continue;
      const imported = importOperation(document, pathItem, operation, method.toUpperCase(), path, options.baseUrl?.trim(), context);
      generatedSize += requestInputSize(imported.request);
      if (generatedSize > 10 * 1024 * 1024) throw new Error("Generated OpenAPI requests exceed the 10 MiB import limit. Split the description or use smaller examples.");
      operations.push(imported);
    }
  }
  if (!operations.length) {
    const detail = warnings.size ? ` ${[...warnings].join(" ")}` : "";
    throw new Error(`No HTTP operations were found in the OpenAPI paths.${detail}`);
  }
  if (document.webhooks !== undefined) context.warn("OpenAPI webhooks are not imported; only callable HTTP path operations are included.");
  return { title, operations, warnings: [...warnings] };
}

/** Builds a detached, deterministic collection; remapCollection must allocate workspace identities before merging it. */
export function createOpenApiCollection(preview: OpenApiPreview, selectedOperationIds?: readonly string[]): CollectionImport {
  const selected = selectedOperationIds === undefined ? undefined : new Set(selectedOperationIds);
  const known = new Set(preview.operations.map(operation => operation.id));
  if (selected && [...selected].some(id => !known.has(id))) throw new Error("The selected OpenAPI operation is no longer in this preview. Preview the document again.");
  const operations = preview.operations.filter(operation => selected === undefined || selected.has(operation.id));
  if (!operations.length) return { requests: {}, collection: [] };

  const requests: Record<string, RequestData> = {};
  const groups = new Map<string, CollectionNode[]>();
  for (const [index, operation] of operations.entries()) {
    const id = `openapi-request-${index + 1}`;
    requests[id] = JSON.parse(JSON.stringify(operation.request)) as RequestData;
    const nodes = groups.get(operation.tag) ?? [];
    nodes.push({ kind: "request", id, name: operation.name, requestType: operation.method });
    groups.set(operation.tag, nodes);
  }
  const children: CollectionNode[] = [...groups].map(([name, nodes], index) => ({
    kind: "folder", id: `openapi-tag-${index + 1}`, name, children: nodes,
  }));
  return { requests, collection: [{ kind: "folder", id: "openapi-root", name: preview.title, children }] };
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_DOCUMENT_LENGTH = 5 * 1024 * 1024;

function importOperation(
  document: OpenApiObject,
  pathItem: OpenApiObject,
  operation: OpenApiObject,
  method: string,
  path: string,
  baseUrl: string | undefined,
  context: OpenApiValueContext,
): OpenApiOperation {
  const id = `${method} ${path}`;
  const name = nonemptyString(operation.summary) ?? nonemptyString(operation.operationId) ?? id;
  const tag = Array.isArray(operation.tags) ? operation.tags.map(nonemptyString).find(Boolean) ?? "Other" : "Other";
  const request = createRequest(name);
  request.method = method;
  request.inputMode = "literal";
  const parameters = operationParameters(pathItem.parameters, operation.parameters, context, id);
  const resolvedPath = applyParameters(request, path, parameters, context, id);
  request.path = `${operationServer(document, pathItem, operation, baseUrl, context, id).replace(/\/+$/, "")}${resolvedPath}`;
  importBody(request, operation.requestBody, context, id);
  request.auth = importAuthentication(document, operation, context, id);
  if (operation.callbacks !== undefined) context.warn(`${id}: callbacks are not imported as callable requests.`);
  return { id, method, path, name, tag, request };
}

function operationServer(
  document: OpenApiObject,
  pathItem: OpenApiObject,
  operation: OpenApiObject,
  override: string | undefined,
  context: OpenApiValueContext,
  label: string,
): string {
  let url = override;
  if (!url) {
    const servers = [operation.servers, pathItem.servers, document.servers].find(value => Array.isArray(value) && value.length);
    if (servers === undefined) throw new Error(`${label}: no absolute server URL is declared. Enter a base URL override and preview again.`);
    const list = servers as unknown[];
    const server = context.resolve(list[0], `${label} server`);
    if (!server || typeof server.url !== "string") throw new Error(`${label}: the server needs a URL. Enter a base URL override and preview again.`);
    if (list.length > 1) context.warn(`${label}: only the first declared server is used; a base URL override can select another destination.`);
    url = server.url.replace(/\{([^{}]+)\}/g, (_, name: string) => {
      const variable = isOpenApiObject(server.variables) && isOpenApiObject(server.variables[name]) ? server.variables[name] : undefined;
      if (!variable || typeof variable.default !== "string") throw new Error(`${label}: server variable ${name} needs a default. Enter a base URL override and preview again.`);
      return variable.default;
    });
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`${label}: use an absolute HTTP(S) server URL or enter a base URL override. Relative servers need an explicit destination.`); }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
    || parsed.search || parsed.hash || /[{}\s\0]/.test(url)) {
    throw new Error(`${label}: the server must be an absolute HTTP(S) URL without credentials, query, fragment, or unresolved variables. Enter a base URL override.`);
  }
  return url;
}

function operationParameters(
  pathParameters: unknown,
  operationParameters: unknown,
  context: OpenApiValueContext,
  label: string,
): OpenApiObject[] {
  const merged = new Map<string, OpenApiObject>();
  for (const values of [pathParameters, operationParameters]) {
    if (values === undefined) continue;
    if (!Array.isArray(values)) throw new Error(`${label}: parameters must be an array.`);
    for (const rawParameter of values) {
      const parameter = context.resolve(rawParameter, `${label} parameter`);
      if (!parameter) continue;
      if (!nonemptyString(parameter.name) || !["path", "query", "header", "cookie"].includes(String(parameter.in))) {
        throw new Error(`${label}: each parameter needs a name and a path, query, header, or cookie location.`);
      }
      merged.set(`${parameter.in}\0${parameter.name}`, parameter);
    }
  }
  return [...merged.values()];
}

function applyParameters(
  request: RequestData,
  path: string,
  parameters: readonly OpenApiObject[],
  context: OpenApiValueContext,
  label: string,
): string {
  const pathValues = new Map<string, string>();
  let generatedSize = 0;
  const reserve = (size: number) => {
    generatedSize += size;
    if (generatedSize > 2 * 1024 * 1024) throw new Error(`${label}: generated parameter samples exceed the 2 MiB size limit. Use smaller examples.`);
  };
  for (const parameter of parameters) {
    const name = parameter.name as string;
    const location = parameter.in as string;
    const field = `${label} parameter ${name}`;
    if (location === "cookie") { context.warn(`${field}: cookie parameters are unsupported and were omitted.`); continue; }
    if (location === "header" && ["accept", "content-type", "authorization"].includes(name.toLowerCase())) {
      context.warn(`${field}: OpenAPI ignores this header parameter; configure content type or authentication separately.`);
      continue;
    }
    if (location === "header" && !HTTP_TOKEN.test(name)) throw new Error(`${field}: header names must be valid HTTP tokens.`);
    const content = isOpenApiObject(parameter.content) ? preferredContent(parameter.content) : undefined;
    if (parameter.content !== undefined && !content) {
      context.warn(`${field}: unsupported parameter content media types were omitted; configure this parameter manually.`);
      continue;
    }
    const value = content
      ? openApiExample(content.value, context, field)
      : openApiExample(parameter, context, field);
    const enabled = parameter.required === true || location === "path";
    if (content) {
      if (location === "path" && value === undefined) {
        context.warn(`${field}: no usable sample was found; replace its generated value before sending.`);
        pathValues.set(name, "value");
        continue;
      }
      const serialized = isJsonMediaType(content.type) ? openApiJson(value, field) : openApiScalar(value);
      reserve(name.length + serialized.length);
      if (location === "path") pathValues.set(name, encodeURIComponent(serialized));
      else (location === "header" ? request.headers : request.query).push({ name, value: serialized, enabled });
      continue;
    }
    if (parameter.allowReserved === true) context.warn(`${field}: allowReserved is unsupported; query values use normal URL encoding.`);
    if (location !== "query" && ((Array.isArray(value) && !value.every(isScalar))
      || (isOpenApiObject(value) && !Object.values(value).every(isScalar)))) {
      context.warn(`${field}: nested ${location} serialization is unsupported; nested values are retained as JSON samples for editing.`);
    }
    if (location === "path") {
      if (parameter.style !== undefined && parameter.style !== "simple") context.warn(`${field}: path style ${String(parameter.style)} is unsupported; a simple sample is used.`);
      if (value === undefined) context.warn(`${field}: no usable sample was found; replace its generated value before sending.`);
      const serialized = value === undefined ? "value" : simpleParameter(value, parameter.explode === true, true);
      reserve(serialized.length);
      pathValues.set(name, serialized);
    } else if (location === "header") {
      if (parameter.style !== undefined && parameter.style !== "simple") context.warn(`${field}: header style ${String(parameter.style)} is unsupported; a simple sample is used.`);
      const serialized = simpleParameter(value, parameter.explode === true, false);
      reserve(name.length + serialized.length);
      if (/[\r\n\0]/.test(serialized)) context.warn(`${field}: the example contains invalid header characters and needs editing before sending.`);
      request.headers.push({ name, value: serialized, enabled });
    } else {
      const rows = queryParameter(name, value, parameter, enabled, context, field);
      reserve(rows.reduce((size, row) => size + row.name.length + row.value.length, 0));
      request.query.push(...rows);
    }
  }

  return path.replace(/(?:\{[^{}]+\}|[^/\\])+/g, (segment, offset: number) => {
    const names = new Set<string>();
    const sample = segment.replace(/\{([^{}]+)\}/g, (_, name: string) => {
      names.add(name);
      if (pathValues.has(name)) return pathValues.get(name)!;
      context.warn(`${label}: path parameter ${name} has no usable definition; replace its generated value before sending.`);
      return "value";
    });
    // HTTP URL parsing removes dot segments, including percent-encoded dots. Check
    // complete segments because several parameters or literal dots can form one.
    const normalized = sample.replace(/\t/g, "");
    const comparable = offset + segment.length === path.length
      ? normalized.replace(/[\u0000-\u0020]+$/, "") : normalized;
    if (!names.size || !/^(?:\.|%2e){1,2}$/i.test(comparable)) return sample;

    for (const name of names) {
      context.warn(`${label} parameter ${name}: the path sample forms a dot segment that URL processing would remove; it was replaced with value for editing before sending.`);
    }
    return segment.replace(/\{([^{}]+)\}/g, "value");
  });
}

function simpleParameter(value: unknown, explode: boolean, encode: boolean): string {
  const scalar = (part: unknown) => encode ? encodeURIComponent(openApiScalar(part)) : openApiScalar(part);
  if (Array.isArray(value)) return value.map(scalar).join(",");
  if (isOpenApiObject(value)) return Object.entries(value).map(([key, item]) => `${scalar(key)}${explode ? "=" : ","}${scalar(item)}`).join(",");
  return scalar(value);
}

function queryParameter(
  name: string,
  value: unknown,
  parameter: OpenApiObject,
  enabled: boolean,
  context: OpenApiValueContext,
  label: string,
): KeyValueEntry[] {
  const style = parameter.style ?? "form";
  const explode = parameter.explode === undefined ? style === "form" : parameter.explode === true;
  const row = (key: string, item: unknown): KeyValueEntry => ({ name: key, value: openApiScalar(item), enabled });
  if ((Array.isArray(value) && !value.every(isScalar)) || (isOpenApiObject(value) && !Object.values(value).every(isScalar))) {
    context.warn(`${label}: nested parameter serialization is unsupported; a JSON sample is retained for editing.`);
    return [row(name, openApiJson(value, label))];
  }
  if (style === "form") {
    if (Array.isArray(value)) return explode ? value.map(item => row(name, item)) : [row(name, value.map(openApiScalar).join(","))];
    if (isOpenApiObject(value)) return explode ? Object.entries(value).map(([key, item]) => row(key, item)) : [row(name, simpleParameter(value, false, false))];
    return [row(name, value)];
  }
  if (style === "deepObject" && isOpenApiObject(value) && Object.values(value).every(isScalar)) {
    if (!Object.keys(value).length) context.warn(`${label}: an empty deepObject sample has no serialized fields; add its properties before sending.`);
    return Object.entries(value).map(([key, item]) => row(`${name}[${key}]`, item));
  }
  if (["spaceDelimited", "pipeDelimited"].includes(String(style)) && Array.isArray(value) && value.every(isScalar) && !explode) {
    return [row(name, value.map(openApiScalar).join(style === "spaceDelimited" ? " " : "|"))];
  }
  context.warn(`${label}: serialization style ${String(style)} is unsupported for this value; a simple editable sample is used.`);
  return [row(name, simpleParameter(value, false, false))];
}

function importBody(request: RequestData, rawBody: unknown, context: OpenApiValueContext, label: string): void {
  if (rawBody === undefined) return;
  const body = context.resolve(rawBody, `${label} request body`);
  if (!body) return;
  if (!isOpenApiObject(body.content) || !Object.keys(body.content).length) throw new Error(`${label}: request body needs a nonempty content map.`);
  const content = preferredContent(body.content);
  if (!content) {
    context.warn(`${label}: unsupported request body media types (${Object.keys(body.content).join(", ")}); multipart and binary bodies are omitted.`);
    return;
  }
  if (Object.keys(body.content).length > 1) context.warn(`${label}: request body uses ${content.type}; other declared media types are not imported.`);
  const sample = openApiExample(content.value, context, `${label} body`);
  request.contentType = content.type;
  if (sample === undefined) {
    context.warn(`${label}: no usable request body example or schema sample was found; the body is empty.`);
    return;
  }
  if (isJsonMediaType(content.type)) request.body = openApiJson(sample, `${label} body`, true);
  else if (mediaType(content.type) === "application/x-www-form-urlencoded") {
    if (!isOpenApiObject(sample)) {
      context.warn(`${label}: form-urlencoded bodies need an object example; the body was omitted.`);
      return;
    }
    const fields = new URLSearchParams();
    const encoding = isOpenApiObject(content.value.encoding) ? content.value.encoding : {};
    for (const [name, value] of Object.entries(sample)) {
      const configuration = isOpenApiObject(encoding[name]) ? encoding[name] : {};
      const field = `${label} body field ${name}`;
      if (configuration.contentType !== undefined || configuration.headers !== undefined || configuration.allowReserved === true) {
        context.warn(`${field}: custom content encoding is unsupported; form URL encoding is used.`);
      }
      // Form bodies default to JSON for object fields. Query-style expansion
      // applies only when a serialization field is explicitly configured.
      const usesParameterStyle = ["style", "explode", "allowReserved"].some(key => configuration[key] !== undefined);
      const rows = isOpenApiObject(value) && !usesParameterStyle
        ? [{ name, value: openApiJson(value, field), enabled: true }]
        : queryParameter(name, value, configuration, true, context, field);
      for (const row of rows) fields.append(row.name, row.value);
    }
    request.body = fields.toString();
  } else {
    if (!isScalar(sample)) context.warn(`${label}: an object example for a text body is serialized as JSON; review the body before sending.`);
    request.body = isScalar(sample) ? openApiScalar(sample) : openApiJson(sample, `${label} body`, true);
  }
  if (request.body.length > 2 * 1024 * 1024) throw new Error(`${label}: generated body exceeds 2 MiB. Use a smaller example before importing.`);
}

function importAuthentication(document: OpenApiObject, operation: OpenApiObject, context: OpenApiValueContext, label: string): RequestAuth {
  const security = hasOwn(operation, "security") ? operation.security : document.security;
  if (security === undefined) return { type: "none" };
  if (!Array.isArray(security)) throw new Error(`${label}: security must be an array.`);
  if (!security.length) return { type: "none" };
  if (!isOpenApiObject(security[0])) throw new Error(`${label}: security requirements must be objects.`);
  if (security.length > 1) context.warn(`${label}: security has alternatives; only the first alternative is imported.`);
  const names = Object.keys(security[0]);
  if (names.length > 1) context.warn(`${label}: combined security schemes cannot all be represented; only one supported authentication hint is imported.`);
  const schemes = isOpenApiObject(document.components) && isOpenApiObject(document.components.securitySchemes)
    ? document.components.securitySchemes : {};
  let chosen: RequestAuth = { type: "none" };
  for (const name of names) {
    const scheme = context.resolve(schemes[name], `${label} security scheme ${name}`);
    if (!scheme) { context.warn(`${label}: security scheme ${name} is unavailable; configure authentication before sending.`); continue; }
    let auth: RequestAuth | undefined;
    if (scheme.type === "http" && typeof scheme.scheme === "string") {
      if (scheme.scheme.toLowerCase() === "basic") auth = { type: "basic", username: "", password: "" };
      if (scheme.scheme.toLowerCase() === "bearer") auth = { type: "bearer", token: "" };
    }
    if (scheme.type === "apiKey" && typeof scheme.name === "string" && scheme.name.trim() && (scheme.in === "header" || scheme.in === "query")) {
      auth = { type: "api-key", name: scheme.name, value: "", location: scheme.in };
    }
    if (!auth) context.warn(`${label}: authentication scheme ${name} (${String(scheme.type)}) is unsupported; configure it manually.`);
    else if (chosen.type === "none") chosen = auth;
  }
  if (chosen.type !== "none") context.warn(`${label}: authentication credentials are empty; enter your own credentials before sending.`);
  return chosen;
}

function preferredContent(content: OpenApiObject): { type: string; value: OpenApiObject } | undefined {
  const entries = Object.entries(content).filter((entry): entry is [string, OpenApiObject] => isOpenApiObject(entry[1]));
  const supported = entries.find(([type]) => isJsonMediaType(type))
    ?? entries.find(([type]) => mediaType(type) === "application/x-www-form-urlencoded")
    ?? entries.find(([type]) => mediaType(type).startsWith("text/"));
  return supported ? { type: supported[0], value: supported[1] } : undefined;
}

function mediaType(type: string): string {
  return type.split(";", 1)[0].trim().toLowerCase();
}

function isJsonMediaType(type: string): boolean {
  const mime = mediaType(type);
  return mime === "application/json" || /^application\/[\w.+-]+\+json$/.test(mime);
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isScalar(value: unknown): boolean {
  return value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value);
}

function requestInputSize(request: RequestData): number {
  return request.name.length + request.method.length + request.path.length + request.body.length + request.contentType.length
    + [...request.headers, ...request.query].reduce((size, entry) => size + entry.name.length + entry.value.length, 0);
}

function valueContext(document: OpenApiObject, warnings: Set<string>): OpenApiValueContext {
  const warn = (message: string) => { warnings.add(message); };
  return {
    warn,
    resolve: (value, label) => resolve(value, label, "reference"),
    resolveSchema: (value, label) => resolve(value, label, "schema"),
  };

  function resolve(value: unknown, label: string, kind: "reference"): OpenApiObject | undefined;
  function resolve(value: unknown, label: string, kind: "schema"): OpenApiObject | boolean | undefined;
  function resolve(value: unknown, label: string, kind: "reference" | "schema"): OpenApiObject | boolean | undefined {
    if (value === undefined) return undefined;
    const seen = new Set<OpenApiObject>();
    const schemaSiblings: OpenApiObject[] = [];
    let current: unknown = value;
    for (let depth = 0; depth < 32; depth++) {
      if (kind === "schema" && typeof current === "boolean") return mergeReferencedSchema(current, schemaSiblings);
      if (!isOpenApiObject(current)) throw new Error(`${label} must be an object.`);
      if (seen.has(current)) { warn(`${label}: a recursive reference was omitted.`); return undefined; }
      seen.add(current);
      if (!hasOwn(current, "$ref")) return schemaSiblings.length ? mergeReferencedSchema(current, schemaSiblings) : current;
      if (typeof current.$ref !== "string") throw new Error(`${label}: $ref must be a string.`);
      const siblings = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "$ref"));
      if (Object.keys(siblings).length) {
        if (kind === "schema" && String(document.openapi).startsWith("3.1.")) schemaSiblings.push(siblings);
        else if (Object.keys(siblings).some(key => !["summary", "description"].includes(key))) {
          warn(`${label}: sibling fields beside $ref are unsupported here and were ignored; inline the definition to preserve them.`);
        }
      }
      if (!current.$ref.startsWith("#")) { warn(`${label}: external reference ${current.$ref} is unsupported and was not loaded.`); return undefined; }
      let pointer: string;
      try { pointer = decodeURIComponent(current.$ref.slice(1)); } catch { throw new Error(`${label}: invalid local reference ${current.$ref}.`); }
      if (pointer !== "" && !pointer.startsWith("/")) throw new Error(`${label}: local references must use a JSON pointer such as #/components/schemas/Name.`);
      let target: unknown = document;
      for (const encoded of pointer === "" ? [] : pointer.slice(1).split("/")) {
        if (/~(?:[^01]|$)/.test(encoded)) throw new Error(`${label}: invalid JSON pointer escape in ${current.$ref}.`);
        const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
        if ((!isOpenApiObject(target) && !Array.isArray(target)) || !hasOwn(target, key)) {
          throw new Error(`${label}: local reference ${current.$ref} could not be resolved.`);
        }
        target = (target as OpenApiObject)[key];
      }
      current = target;
    }
    warn(`${label}: a deeply chained reference was omitted.`);
    return undefined;
  }
}

function mergeReferencedSchema(target: OpenApiObject | boolean, siblings: readonly OpenApiObject[]): OpenApiObject | boolean {
  // False accepts no value even when sibling keywords suggest an example; true
  // adds no constraints and lets adjacent keywords describe the generated value.
  if (target === false || !siblings.length) return target;
  let schema: OpenApiObject = target === true ? {} : target;
  // Schema references in 3.1 retain adjacent keywords. Sampling combines the
  // property maps so a referenced base and its inline additions both stay visible.
  for (const sibling of [...siblings].reverse()) {
    const properties = isOpenApiObject(schema.properties) && isOpenApiObject(sibling.properties)
      ? Object.fromEntries([...Object.entries(schema.properties), ...Object.entries(sibling.properties)]) : undefined;
    schema = { ...schema, ...sibling, ...(properties ? { properties } : {}) };
  }
  return schema;
}

function readDocument(text: string): OpenApiObject {
  if (!text.trim()) throw new Error("Paste an OpenAPI JSON or YAML document first.");
  if (text.length > MAX_DOCUMENT_LENGTH) throw new Error("The OpenAPI document exceeds the 5 MiB import limit.");
  let value: unknown;
  try {
    const parsed = parseDocument(text, { strict: true, uniqueKeys: true, stringKeys: true, version: "1.2" });
    if (parsed.errors.length || parsed.warnings.length) throw new Error((parsed.errors[0] ?? parsed.warnings[0]).message);
    value = parsed.toJS({ maxAliasCount: 50 });
  } catch (error) {
    throw new Error(`Invalid OpenAPI JSON or YAML: ${error instanceof Error ? error.message : "unable to parse document"}`);
  }
  validateDocumentValues(value);
  if (!isOpenApiObject(value)) throw new Error("Expected an OpenAPI document object.");
  return value;
}

function validateDocumentValues(value: unknown): void {
  let remaining = 100_000;
  const ancestors = new Set<object>();
  function visit(current: unknown, depth: number): void {
    if (--remaining < 0 || depth > 64) throw new Error("The OpenAPI document is too deeply nested or complex to import.");
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number" && Number.isFinite(current)) return;
    if (typeof current !== "object" || !current) throw new Error("OpenAPI documents may contain only finite, JSON-compatible values.");
    if (ancestors.has(current)) throw new Error("Recursive YAML aliases are unsupported. Use local $ref references for recursive schemas.");
    ancestors.add(current);
    for (const child of Object.values(current)) visit(child, depth + 1);
    ancestors.delete(current);
  }
  visit(value, 0);
}
