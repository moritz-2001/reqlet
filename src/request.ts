// Shared contracts separate saved request definitions from transport results and execution state.

/** An ordered editable header, query parameter, or environment variable. */
export interface KeyValueEntry {
  /** Name sent to the server or used when resolving a variable. */
  name: string;
  /** Literal value; request fields may contain {{variable}} references. */
  value: string;
  /** Disabled entries remain editable but do not participate in execution. */
  enabled: boolean;
}

/** Authentication is applied during preparation without mutating saved headers. */
export type RequestAuth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "api-key"; name: string; value: string; location: "header" | "query" };

/** Redirects are opt-in; following other origins never forwards known credential headers. */
export type RedirectPolicy = "never" | "same-origin" | "follow";

/** Whether editable input values contain environment references or only literal text. */
export type RequestInputMode = "template" | "literal";

/** An editable request definition, saved in a collection or owned by an unsaved tab. Results live separately. */
export interface RequestData {
  /** Literal inputs preserve placeholder-looking text; absence keeps existing environment-template behavior. */
  inputMode?: RequestInputMode;
  /** Optional protobuf editing model; absence leaves ordinary JSON editing. */
  protobuf?: import("./protobuf").ProtobufMessageBinding;
  /** Display name used by its editor/tab and, after saving, its collection entry. */
  name: string;
  /** HTTP method, normalized to uppercase when preparing the request. */
  method: string;
  /** Absolute HTTP(S) URL, optionally containing environment references. */
  path: string;
  /** Current editable source; live revisions share text storage. Use bodyText at string boundaries. */
  body: import("./bodyDocument").BodySource;
  /** Default Content-Type when a nonempty body has no explicit header override. */
  contentType: string;
  /** Ordered headers; repeated names are preserved and disabled rows are omitted. */
  headers: KeyValueEntry[];
  /** Additional URL parameters, preserving duplicates and URL-encoding names and values. */
  query: KeyValueEntry[];
  /** Credentials resolved only when sending; none leaves user headers untouched. */
  auth: RequestAuth;
  /** Maximum execution duration, including receiving the body, in milliseconds. */
  timeoutMs: number;
  /** Redirect handling; absence uses never, including requests saved before this option existed. */
  redirectPolicy?: RedirectPolicy;
  /** Credential headers retained from an imported/replayed snapshot; absent means only configured authentication is added. */
  sensitiveHeaderNames?: string[];
}

/** Named variable scope selected for preparing requests. */
export interface Environment {
  /** Stable identity retained across renames. */
  id: string;
  /** User-visible scope name, such as Local or Production. */
  name: string;
  /** Ordered variable definitions; disabled entries do not resolve placeholders. */
  variables: KeyValueEntry[];
}

/** A concrete header after variables and authentication have been resolved. */
export interface HttpHeader {
  /** HTTP field name, compared case-insensitively. */
  name: string;
  /** Field value; repeated fields use separate entries. */
  value: string;
}

/** Immutable execution snapshot shared by transport, history, and cURL export. */
export interface HttpRequest {
  /** Validated uppercase HTTP method. */
  method: string;
  /** Absolute HTTP(S) URL with resolved and encoded parameters. */
  url: string;
  /** Enabled headers including authentication and inferred Content-Type. */
  headers: HttpHeader[];
  /** Text payload; an empty string sends no body. */
  body: string;
  /** Positive timeout in milliseconds. */
  timeoutMs: number;
  /** Redirect handling captured at preparation time; absence means never. */
  redirectPolicy?: RedirectPolicy;
  /** Additional credential header names stripped permanently after an origin change; absent means standard names only. */
  sensitiveHeaderNames?: string[];
}

/** Completed HTTP exchange; HTTP error status codes are valid responses. */
export interface HttpResponse {
  /** Final URL after redirects. */
  url: string;
  /** Numeric HTTP response status. */
  status: number;
  /** HTTP reason phrase; may be empty when unavailable. */
  statusText: string;
  /** Response fields including repeated names when available; transports may normalize their order. */
  headers: HttpHeader[];
  /** Text after content decoding and charset conversion, bounded by transport body limits. */
  body: string;
  /** Elapsed transport time through receiving the complete body, in milliseconds. */
  durationMs: number;
  /** Encoded body bytes in native transport; browser preview exposes bytes after browser decompression. */
  sizeBytes: number;
}

/** Transient state owned by the workspace, independent of an editor's mounted lifetime. */
export type ExecutionState =
  | { status: "idle" }
  | { status: "running"; startedAt: string }
  | { status: "success"; response: HttpResponse }
  | { status: "error"; error: string }
  | { status: "cancelled" };

/** Completed execution retained for inspection and exact replay. */
export interface HistoryEntry {
  /** Unique execution identity, independent of the saved request ID. */
  id: string;
  /** Originating saved request or transient draft identity; its definition may change or no longer exist. */
  requestId: string;
  /** Request name captured at execution time. */
  name: string;
  /** ISO timestamp of execution start. */
  startedAt: string;
  /** Resolved snapshot replayed without resolving the current environment again. */
  request: HttpRequest;
  /** Final result; running and idle operations are never history entries. */
  result: Exclude<ExecutionState, { status: "idle" | "running" }>;
}

/** Creates an independently editable request with useful transport defaults. */
export function createRequest(name = "New request"): RequestData {
  return {
    name, method: "GET", path: "http://localhost:8080", body: "",
    contentType: "application/json", headers: [], query: [], auth: { type: "none" }, timeoutMs: 30000,
  };
}
