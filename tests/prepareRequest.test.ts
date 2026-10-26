// Verifies concrete execution snapshots through the public preparation interface without making network calls.
import { expect, it } from "vitest";
import { prepareRequest } from "../src/prepareRequest";
import { createRequest, type Environment, type KeyValueEntry, type RequestData } from "../src/request";

it("resolves nested variables across all request fields while preserving draft and environment data", () => {
  const request = draft({
    method: " patch ", path: "{{baseUrl}}/items?existing=one&existing=two",
    headers: [entry("X-{{header}}", "{{value}}"), entry("Ignored", "{{missing}}", false)],
    query: [entry("tag", "a & b"), entry("{{parameter}}", "{{value}}"), entry("tag", "last"), entry("ignored", "{{missing}}", false)],
    body: '{"message":"{{value}}"}', contentType: "{{type}}",
  });
  const environment = scope([
    entry("baseUrl", "{{scheme}}://example.com"), entry("scheme", "https"), entry("header", "Greeting"),
    entry("value", "hello"), entry("parameter", "tag"), entry("type", "application/json"), entry("ignored", "{{missing}}", false),
  ]);
  const savedRequest = structuredClone(request);
  const savedEnvironment = structuredClone(environment);
  const prepared = prepareRequest(request, environment);

  expect(prepared).toEqual({
    method: "PATCH", url: "https://example.com/items?existing=one&existing=two&tag=a+%26+b&tag=hello&tag=last",
    headers: [{ name: "X-Greeting", value: "hello" }, { name: "Content-Type", value: "application/json" }],
    body: '{"message":"hello"}', timeoutMs: 30000,
  });
  expect(request).toEqual(savedRequest);
  expect(environment).toEqual(savedEnvironment);
});

it("preserves ordered duplicate headers and honors an explicit content type", () => {
  const request = draft({ body: "text", headers: [entry("X-Tag", "a"), entry("X-Tag", "b"), entry("content-TYPE", "text/plain")] });
  expect(prepareRequest(request).headers).toEqual([
    { name: "X-Tag", value: "a" }, { name: "X-Tag", value: "b" }, { name: "content-TYPE", value: "text/plain" },
  ]);
  expect(prepareRequest(draft({ body: "", contentType: "{{unused}}" })).headers).toEqual([]);
  expect(prepareRequest(draft({ body: "hello", headers: [entry("Content-Type", "ignored", false)] })).headers)
    .toEqual([{ name: "Content-Type", value: "application/json" }]);
});

it("keeps every literal input unchanged and ignores even an invalid selected environment", () => {
  const request = draft({ inputMode: "literal", path: "https://example.com/{{token}}",
    headers: [entry("X-Token", "{{token}}")], query: [entry("{{token}}", "{{token}}")],
    body: "{{token}}", contentType: "{{token}}", auth: { type: "bearer", token: "{{token}}" } });
  const prepared = prepareRequest(request, scope([entry("token", "secret"), entry("token", "duplicate")]));
  expect(prepared.url).toBe("https://example.com/%7B%7Btoken%7D%7D?%7B%7Btoken%7D%7D=%7B%7Btoken%7D%7D");
  expect(prepared.body).toBe("{{token}}");
  expect(prepared.headers).toEqual([
    { name: "X-Token", value: "{{token}}" }, { name: "Authorization", value: "Bearer {{token}}" },
    { name: "Content-Type", value: "{{token}}" },
  ]);
  const apiKey = prepareRequest({ ...request, auth: { type: "api-key", name: "{{token}}", value: "{{token}}", location: "query" } });
  expect(new URL(apiKey.url).searchParams.get("{{token}}")).toBe("{{token}}");
});

it("validates literal inputs and enables substitution only when the mode changes explicitly", () => {
  const request = draft({ inputMode: "literal", body: "{{token}}" });
  const environment = scope([entry("token", "secret")]);
  expect(prepareRequest(request, environment).body).toBe("{{token}}");
  expect(prepareRequest({ ...request, inputMode: "template" }, environment).body).toBe("secret");
  expect(() => prepareRequest({ ...request, headers: [entry("Bad header", "{{token}}" )] })).toThrow("HTTP tokens");
  expect(() => prepareRequest({ ...request, inputMode: "invalid" as never })).toThrow("Input mode");
});

it("applies bearer authentication over all existing Authorization header variants", () => {
  const request = draft({
    headers: [entry("Authorization", "old"), entry("authorization", "other"), entry("X-Tag", "keep")],
    auth: { type: "bearer", token: "{{token}}" },
  });
  expect(prepareRequest(request, scope([entry("token", "secret")])).headers).toEqual([
    { name: "X-Tag", value: "keep" }, { name: "Authorization", value: "Bearer secret" },
  ]);
  expect(prepareRequest({ ...request, auth: { type: "none" } }).headers).toHaveLength(3);
});

it("encodes Basic credentials as UTF-8 and resolves both fields", () => {
  const request = draft({ auth: { type: "basic", username: "{{user}}", password: "{{password}}" } });
  expect(prepareRequest(request, scope([entry("user", "Jörg"), entry("password", "päss🔒")])).headers)
    .toEqual([{ name: "Authorization", value: "Basic SsO2cmc6cMOkc3Pwn5SS" }]);
  expect(() => prepareRequest(draft({ auth: { type: "basic", username: "a:b", password: "c" } })))
    .toThrow(/username.*colon/i);
});

it("replaces API key headers case-insensitively and query keys case-sensitively", () => {
  const environment = scope([entry("keyName", "apiKey"), entry("key", "a & b")]);
  const headerRequest = draft({
    headers: [entry("APIKEY", "old"), entry("apiKey", "older"), entry("X-Other", "keep")],
    auth: { type: "api-key", name: "{{keyName}}", value: "{{key}}", location: "header" },
  });
  expect(prepareRequest(headerRequest, environment).headers).toEqual([
    { name: "X-Other", value: "keep" }, { name: "apiKey", value: "a & b" },
  ]);
  const queryRequest = draft({
    path: "https://example.com/?apiKey=url&apiKey=url2&APIKEY=keep", query: [entry("apiKey", "row"), entry("tag", "one"), entry("tag", "two")],
    auth: { type: "api-key", name: "{{keyName}}", value: "{{key}}", location: "query" },
  });
  expect(prepareRequest(queryRequest, environment).url).toBe("https://example.com/?APIKEY=keep&tag=one&tag=two&apiKey=a+%26+b");
});

it("reports unresolved variables, enabled duplicate definitions, and nested cycles clearly", () => {
  expect(() => prepareRequest(draft({ path: "{{baseUrl}}/items" }))).toThrow(/baseUrl.*not defined/);
  expect(() => prepareRequest(draft({ body: "{{token}}" }), scope([entry("token", "disabled", false)]))).toThrow(/token.*not defined/);
  expect(() => prepareRequest(draft(), scope([entry("name", "a"), entry(" name ", "b")]))).toThrow(/name.*more than once/);
  expect(() => prepareRequest(draft(), scope([entry("", "a")]))).toThrow(/need a name/);
  expect(() => prepareRequest(draft({ body: "{{a}}" }), scope([entry("a", "{{b}}"), entry("b", "{{a}}")]))).toThrow(/cycle: a → b → a/);
  expect(() => prepareRequest(draft({ body: "{{}}" }))).toThrow(/empty.*not defined/);
  expect(prepareRequest(draft({ body: "{{ name }}" }), scope([entry("name", "ok"), entry("name", "disabled", false)])).body).toBe("ok");
});

it.each(["/relative", "file:///private/test", "ftp://example.com", "https://name:password@example.com"])("rejects invalid or credential-bearing URL %s", path => {
  expect(() => prepareRequest(draft({ path }))).toThrow(/HTTP.*HTTPS/);
});

it.each(["", "GE T", "GET\r\nX-Injected: yes"])("rejects invalid method %s", method => {
  expect(() => prepareRequest(draft({ method }))).toThrow(/HTTP method/);
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2147483648])("rejects invalid timeout %s", timeoutMs => {
  expect(() => prepareRequest(draft({ timeoutMs }))).toThrow(/Timeout.*2147483647/);
});

it("accepts the full timeout range and custom HTTP token methods", () => {
  expect(prepareRequest(draft({ method: "propfind", timeoutMs: 1 })).method).toBe("PROPFIND");
  expect(prepareRequest(draft({ timeoutMs: 2147483647 })).timeoutMs).toBe(2147483647);
});

it.each([
  entry("", "a"), entry("Bad name", "a"), entry("X-Test", "a\r\nX-Injected: yes"), entry("X-Test", "nul\0"),
  entry("X-Test", "emoji🔒"), entry("X-Test\nInjected", "value"),
])("rejects invalid headers before execution", header => {
  expect(() => prepareRequest(draft({ headers: [header] }))).toThrow(/Header names.*line breaks/);
});

it("validates resolved authentication and inferred content type headers", () => {
  expect(() => prepareRequest(draft({ auth: { type: "bearer", token: "{{token}}" } }), scope([entry("token", "secret\nInjected: yes")]))).toThrow(/line breaks/);
  expect(() => prepareRequest(draft({ body: "body", contentType: "text/plain\r\nInjected: yes" }))).toThrow(/line breaks/);
  expect(() => prepareRequest(draft({ auth: { type: "api-key", name: "", value: "secret", location: "query" } }))).toThrow(/needs a name/);
});

it("sends strict JSON for annotated template bodies while preserving draft tokens and comments", () => {
  const source = '// example {{unused}}\n{"id":9007199254740993,"id":-0,"name":"{{name}}","items":[1,2,],}';
  const request = draft({ body: source });
  const prepared = prepareRequest(request, scope([entry("name", "value")]));
  expect(JSON.parse(prepared.body)).toEqual({ id: -0, name: "value", items: [1, 2] });
  expect(prepared.body).toContain('"id":9007199254740993,"id":-0');
  expect(prepared.body).not.toContain("unused");
  expect(request.body).toBe(source);
});

it("normalizes JSONC after resolving bare environment values", () => {
  const request = draft({ body: '{"count":{{count}}, /* {{unused}} */}', contentType: "{{type}}" });
  const prepared = prepareRequest(request, scope([entry("count", "2"), entry("type", "application/json")]));
  expect(JSON.parse(prepared.body)).toEqual({ count: 2 });
});

it("uses the effective content type, including explicit headers and authentication, for JSONC", () => {
  const body = '{"a":1, /* note */}';
  const request = draft({ body, contentType: "text/plain" });
  const json = entry("cOnTeNt-TyPe", "Application/Problem+JSON; charset=utf-8");
  expect(prepareRequest(request).body).toBe(body);
  expect(JSON.parse(prepareRequest({ ...request, headers: [json] }).body)).toEqual({ a: 1 });
  expect(prepareRequest({ ...request, contentType: "application/json", headers: [entry("Content-Type", "text/plain")] }).body).toBe(body);
  const authenticated = { ...request, auth: { type: "api-key", name: "Content-Type", value: "application/json", location: "header" } as const };
  expect(JSON.parse(prepareRequest(authenticated).body)).toEqual({ a: 1 });
});

it("preserves literal JSONC, ordinary JSON bytes, and malformed test payloads", () => {
  const jsonc = '// exact literal\n{"a":1,}';
  expect(prepareRequest(draft({ body: jsonc, inputMode: "literal" })).body).toBe(jsonc);
  for (const body of [' \r\n{"a":1,"a":2}\t', '{"a":1,,}', '{"a":', '/* unfinished']) {
    expect(prepareRequest(draft({ body })).body).toBe(body);
  }
});

function draft(changes: Partial<RequestData> = {}): RequestData {
  return { ...createRequest(), path: "https://example.com/", ...changes };
}

function scope(variables: KeyValueEntry[]): Environment {
  return { id: "local", name: "Local", variables };
}

function entry(name: string, value: string, enabled = true): KeyValueEntry {
  return { name, value, enabled };
}
