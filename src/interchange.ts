// Converts cURL text and versioned collection files without executing shell code; CollectionImport is the merge boundary.
import type { CollectionNode } from "./components/collectionTree";
import { createRequest, type HttpRequest, type RequestData } from "./request";
import { parseCollection, validateRequestsAndCollection } from "./workspaceValidation";

/** Validated request definitions and hierarchy that can be merged into the workspace. */
export interface CollectionImport {
  /** Unlinked protobuf sources with remapped identities; absent in older imports. */
  protobufSources?: import("./protobuf").ProtobufSource[];
  /** Definitions keyed by the same identities used by request nodes. */
  requests: Record<string, RequestData>;
  /** Ordered folders and request references; imported identities are remapped before merging. */
  collection: readonly CollectionNode[];
}

/** Imports one text-only HTTP(S) cURL command, rejecting shell execution and unsupported transport options. */
export function importCurl(text: string): RequestData {
  const tokens = shellWords(text);
  if (tokens.shift() !== "curl") throw new Error("Start the command with curl.");

  const request = createRequest("Imported cURL request");
  // cURL has no environment-placeholder syntax; imports remain literal after edits and reloads.
  request.inputMode = "literal";
  let explicitMethod: string | undefined;
  let url: string | undefined;
  let get = false;
  let head = false;
  let globoff = false;
  let httpsRedirectsOnly = false;
  let positionalOnly = false;
  const data: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--" && !positionalOnly) { positionalOnly = true; continue; }
    if (positionalOnly || !token.startsWith("-")) {
      if (url !== undefined) throw new Error("Import supports exactly one URL per command.");
      url = token;
      continue;
    }
    if (token === "-G" || token === "--get") { get = true; continue; }
    if (token === "-I" || token === "--head") { head = true; continue; }
    if (token === "-g" || token === "--globoff") { globoff = true; continue; }
    if (token === "-L" || token === "--location") { request.redirectPolicy = "follow"; continue; }
    if (token === "--no-location") { delete request.redirectPolicy; continue; }
    if (token === "--location-trusted") throw new Error("--location-trusted can forward credentials to another origin and is unsupported.");

    const option = curlOption(token);
    if (!option) throw new Error(`Unsupported cURL option: ${token}.`);
    const value = option.value ?? tokens[++index];
    if (value === undefined) throw new Error(`Missing value for ${option.name}.`);
    switch (option.name) {
      case "--request": explicitMethod = value.toUpperCase(); break;
      case "--url":
        if (url !== undefined) throw new Error("Import supports exactly one URL per command.");
        url = value;
        break;
      case "--header": {
        if (value.startsWith("@")) throw new Error("Header files are unsupported; paste each header with -H.");
        const colon = value.indexOf(":");
        const empty = value.endsWith(";") && colon < 0;
        if (colon < 1 && !empty) throw new Error("Headers must use 'Name: value' or 'Name;' for an empty value.");
        const name = empty ? value.slice(0, -1) : value.slice(0, colon);
        if (/[\r\n\0]/.test(value)) throw new Error("Invalid HTTP header: line breaks are unsupported.");
        const headerValue = empty ? "" : value.slice(colon + 1).trim();
        if (!empty && !headerValue) throw new Error("cURL header suppression (Name:) is unsupported; use Name; for an empty header.");
        if (!HTTP_TOKEN.test(name) || /[\r\n\0]/.test(headerValue)) throw new Error("Invalid HTTP header.");
        request.headers.push({ name, value: headerValue, enabled: true });
        break;
      }
      case "--data":
      case "--data-binary":
      case "--data-raw":
        if (option.name !== "--data-raw" && value.startsWith("@")) {
          throw new Error("Body files and stdin are unsupported; paste the body with --data-raw.");
        }
        data.push(value);
        break;
      case "--user": {
        const colon = value.indexOf(":");
        if (colon < 0) throw new Error("Use --user 'username:password'; interactive password prompts are unsupported.");
        request.auth = { type: "basic", username: value.slice(0, colon), password: value.slice(colon + 1) };
        break;
      }
      case "--max-time": {
        const parts = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(value);
        const fraction = (parts?.[2] ?? parts?.[3] ?? "").replace(/0+$/, "");
        const milliseconds = Number(parts?.[1] ?? "0") * 1000 + Number(fraction.padEnd(3, "0"));
        if (!parts || fraction.length > 3 || !Number.isSafeInteger(milliseconds)
          || milliseconds < 1 || milliseconds > 2_147_483_647) {
          throw new Error("--max-time must be positive seconds with millisecond precision (at most 2147483.647).");
        }
        request.timeoutMs = milliseconds;
        break;
      }
      case "--max-redirs":
        if (value !== "10") throw new Error("The tool supports at most 10 redirects; use --max-redirs 10.");
        break;
      case "--proto-redir":
        if (value !== "=https") throw new Error("Only --proto-redir '=https' is supported for redirect protocol restrictions.");
        httpsRedirectsOnly = true;
        break;
    }
  }
  if (!url) throw new Error("The cURL command needs an absolute HTTP or HTTPS URL.");
  if (head && (data.length > 0 || (explicitMethod !== undefined && explicitMethod !== "HEAD"))) {
    throw new Error("--head with body data or a different explicit method cannot be represented by this tool.");
  }
  if (explicitMethod && !HTTP_TOKEN.test(explicitMethod)) throw new Error("Invalid HTTP method.");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Use an absolute HTTP or HTTPS URL."); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Use HTTP(S) without credentials in the URL; supply credentials with --user.");
  }
  if (!globoff && hasUrlGlobCharacters(url)) {
    throw new Error("cURL URL globbing is unsupported; import a single concrete URL.");
  }

  request.method = explicitMethod ?? (head ? "HEAD" : get || data.length === 0 ? "GET" : "POST");
  if (request.redirectPolicy === "follow" && httpsRedirectsOnly && parsed.protocol !== "https:") {
    throw new Error("HTTPS-only redirect restrictions require an HTTPS starting URL in this tool.");
  }
  if (request.redirectPolicy === "follow" && explicitMethod && !["GET", "HEAD"].includes(explicitMethod)) {
    throw new Error("cURL --request with redirects preserves the method differently. Remove --request to use normal POST redirect behavior, or import without --location.");
  }
  request.path = url;
  request.contentType = request.headers.find(header => header.name.toLowerCase() === "content-type")?.value
    ?? "application/x-www-form-urlencoded";
  if (get && data.length > 0) {
    // Append raw cURL data without decoding and re-encoding existing query bytes or duplicate parameters.
    const hash = url.indexOf("#");
    const base = hash < 0 ? url : url.slice(0, hash);
    const fragment = hash < 0 ? "" : url.slice(hash);
    request.path = `${base}${base.includes("?") ? "&" : "?"}${data.join("&")}${fragment}`;
  } else if (data.length > 0) {
    request.body = data.join("&");
    if (!request.headers.some(header => header.name.toLowerCase() === "content-type")) {
      request.headers.push({ name: "Content-Type", value: request.contentType, enabled: true });
    }
  }
  // An explicit Authorization header takes precedence over cURL's generated Basic authentication.
  if (request.headers.some(header => header.name.toLowerCase() === "authorization")) request.auth = { type: "none" };
  return request;
}

/** Exports a resolved snapshot using POSIX single quoting, preserving headers, credentials, payload, and timeout. */
export function exportCurl(request: HttpRequest): string {
  const policy = request.redirectPolicy ?? "never";
  if (policy === "same-origin") {
    throw new Error("cURL cannot follow only same-origin redirects. Choose Do not follow or export a request that follows across origins.");
  }
  const follows = policy === "follow";
  if (request.method === "HEAD" && request.body) {
    throw new Error("cURL --head cannot preserve a HEAD request with a body.");
  }
  if (follows && request.sensitiveHeaderNames?.some(name => !["authorization", "cookie", "proxy-authorization"].includes(name.toLowerCase()))) {
    throw new Error("cURL cannot remove custom credential headers on cross-origin redirects. Choose Do not follow before exporting this request.");
  }
  if (follows && (!request.url.startsWith("https:") || !["GET", "HEAD", "POST"].includes(request.method) || (request.method === "POST" && !request.body))) {
    throw new Error("cURL export with redirects supports HTTPS GET, HEAD, and POST requests with a body. Other combinations cannot preserve the tool's redirect safety and method behavior.");
  }
  const methodArgs = request.method === "HEAD" ? ["--head"]
    : follows && request.method === "POST" ? [] : ["--request", quote(request.method)];
  const args = ["curl", ...methodArgs, "--url", quote(request.url),
    "--max-time", quote(String(request.timeoutMs / 1000))];
  // Resolved snapshots can contain literal glob characters (for example from --get data),
  // which cURL would otherwise reinterpret as URL expansion after export.
  if (hasUrlGlobCharacters(request.url)) args.push("--globoff");
  if (follows) args.push("--location", "--max-redirs", "10", "--proto-redir", quote("=https"));
  for (const header of request.headers) {
    // cURL uses a colon with no value to suppress a header; semicolon explicitly sends an empty value.
    args.push("--header", quote(header.value ? `${header.name}: ${header.value}` : `${header.name};`));
  }
  if (request.body) args.push("--data-raw", quote(request.body));
  return args.join(" ");
}

/** Saves all request definitions, including credentials, in a portable versioned collection document. */
export function serializeCollection(requests: Record<string, RequestData>, nodes: readonly CollectionNode[], sources: readonly import("./protobuf").ProtobufSource[] = []): string {
  validateRequestsAndCollection(requests, nodes);
  const sourceIds = new Set(Object.values(requests).flatMap(r => r.protobuf ? [r.protobuf.sourceId] : []));
  const protobufSources = [...sourceIds].map(id => ({ id, name: sources.find(s => s.id === id)?.name ?? "Unavailable protobuf source", rootPath: null, includePaths: [] }));
  return JSON.stringify({ kind: "api-tool-collection", version: 1, requests, collection: nodes, ...(protobufSources.length ? { protobufSources } : {}) }, null, 2);
}

/** Validates a portable file before returning its definitions and references; does not mutate or allocate identities. */
export function parseCollectionDocument(text: string): CollectionImport {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("The collection file is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Reqlet collection object.");
  const document = value as Record<string, unknown>;
  if (document.kind !== "api-tool-collection" || document.version !== 1) {
    throw new Error("Unsupported collection format; expected api-tool-collection version 1.");
  }
  return parseCollection(document);
}

/** Imports a portable file with fresh identities so merging never replaces an existing folder or request. */
export function importCollection(text: string, occupiedIds: Iterable<string> = []): CollectionImport {
  return remapCollection(parseCollectionDocument(text), occupiedIds);
}

/**
 * Copies a validated collection with new IDs for every node and model source. The allocator is injectable for deterministic tests.
 * Existing IDs and all original imported IDs are reserved, even if an allocator accidentally returns one.
 */
export function remapCollection(
  imported: CollectionImport,
  occupiedIds: Iterable<string> = [],
  allocateId: () => string = () => crypto.randomUUID(),
): CollectionImport {
  validateRequestsAndCollection(imported.requests, imported.collection);
  const reserved = new Set(occupiedIds);
  const replacements = new Map<string, string>();
  function reserve(nodes: readonly CollectionNode[]) {
    for (const node of nodes) {
      reserved.add(node.id);
      if (node.kind === "folder") reserve(node.children);
    }
  }
  reserve(imported.collection);
  const sourceIds = new Set(Object.values(imported.requests).flatMap(request => request.protobuf ? [request.protobuf.sourceId] : []));
  for (const id of sourceIds) reserved.add(id);
  for (const source of imported.protobufSources ?? []) reserved.add(source.id);

  function allocateIdentity(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = allocateId();
      if (candidate && !reserved.has(candidate) && !["__proto__", "constructor", "prototype"].includes(candidate)) {
        reserved.add(candidate);
        return candidate;
      }
    }
    throw new Error("Could not allocate a unique imported identity. Try importing again.");
  }

  function remap(nodes: readonly CollectionNode[]): CollectionNode[] {
    return nodes.map(node => {
      const id = allocateIdentity();
      replacements.set(node.id, id);
      return node.kind === "folder" ? { ...node, id, children: remap(node.children) } : { ...node, id };
    });
  }
  const collection = remap(imported.collection);
  // Map original identities once so generated IDs cannot be mistaken for another source's old ID.
  const sourceReplacements = new Map([...sourceIds].map(id => [id, allocateIdentity()]));
  const requests = Object.fromEntries(Object.entries(imported.requests).map(([id, request]) => {
    const copy = JSON.parse(JSON.stringify(request)) as RequestData;
    if (copy.protobuf) copy.protobuf.sourceId = sourceReplacements.get(copy.protobuf.sourceId)!;
    return [replacements.get(id)!, copy];
  }));
  const protobufSources = [...sourceReplacements].map(([originalId, id]) => {
    return { id, name: imported.protobufSources?.find(s => s.id === originalId)?.name ?? "Unavailable protobuf source", rootPath: null, includePaths: [] };
  });
  return { requests, collection, ...(protobufSources.length ? { protobufSources } : {}) };
}

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const OPTIONS: Record<string, string> = {
  "-X": "--request", "--request": "--request", "-H": "--header", "--header": "--header",
  "-d": "--data", "--data": "--data", "--data-raw": "--data-raw", "--data-binary": "--data-binary",
  "-u": "--user", "--user": "--user", "--url": "--url", "--max-time": "--max-time",
  "--max-redirs": "--max-redirs", "--proto-redir": "--proto-redir",
};

function hasUrlGlobCharacters(url: string): boolean {
  const outsideAuthority = url.slice(url.indexOf("://") + 3).replace(/^[^/?#]*/, "");
  return /[{}]/.test(url) || /[\[\]]/.test(outsideAuthority);
}

function curlOption(token: string): { name: string; value?: string } | undefined {
  if (Object.prototype.hasOwnProperty.call(OPTIONS, token)) return { name: OPTIONS[token] };
  const equal = token.indexOf("=");
  if (token.startsWith("--") && equal > 0 && Object.prototype.hasOwnProperty.call(OPTIONS, token.slice(0, equal))) {
    return { name: OPTIONS[token.slice(0, equal)], value: token.slice(equal + 1) };
  }
  if (/^-[XHdu].+/.test(token)) return { name: OPTIONS[token.slice(0, 2)], value: token.slice(2) };
  return undefined;
}

function quote(value: string): string {
  if (value.includes("\0")) throw new Error("cURL export cannot represent NUL bytes in shell arguments.");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quoted: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "\0") throw new Error("NUL bytes are unsupported in cURL commands.");
    if (quoted === "'") {
      if (character === "'") quoted = undefined;
      else word += character;
      continue;
    }
    if (character === "\\") {
      const next = text[++index];
      if (next === undefined) throw new Error("The cURL command ends with an incomplete escape.");
      if (next === "\n") continue;
      if (next === "\r" && text[index + 1] === "\n") { index++; continue; }
      if (quoted === '"' && !['$', '`', '"', '\\'].includes(next)) word += "\\";
      word += next;
      started = true;
      continue;
    }
    if (character === "$" || character === "`") throw new Error("Shell substitutions and variables are unsupported; paste literal values in single quotes.");
    if (quoted === '"') {
      if (character === '"') quoted = undefined;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') { quoted = character; started = true; continue; }
    if (/[|;&<>()]/.test(character) || (character === "#" && !started)) {
      throw new Error("Shell operators and comments are unsupported; import one literal cURL command.");
    }
    if (/\s/.test(character)) {
      if (started) { words.push(word); word = ""; started = false; }
      continue;
    }
    word += character;
    started = true;
  }
  if (quoted) throw new Error("The cURL command has an unclosed quote.");
  if (started) words.push(word);
  return words;
}
