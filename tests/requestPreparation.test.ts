// Verifies next-send selection, body MIME projection, and snapshot ownership through their public interfaces.
import { expect, it } from "vitest";
import { prepareNextRequest, prepareRequest, previewRequestContentType, previewRequestTarget } from "../src/prepareRequest";
import { createRequest, type Environment, type HttpRequest, type RequestData } from "../src/request";
import { copyHttpRequest } from "../src/requestSnapshot";

it("prepares the selected environment or preserves a captured request before reading invalid editable inputs", () => {
  const request = draft({ path: "{{baseUrl}}/items", body: "{{body}}" });
  const environment = scope({ baseUrl: "https://local.test", body: "local" });
  expect(prepareNextRequest(request, environment)).toEqual(prepareRequest(request, environment));
  expect(prepareNextRequest(request, scope({ baseUrl: "https://other.test", body: "other" })).body).toBe("other");

  const snapshot = captured();
  const prepared = prepareNextRequest({ ...request, timeoutMs: 0 }, scope({ duplicate: "bad" }), snapshot);
  expect(prepared).toEqual(snapshot);
  prepared.headers[0].value = "edited";
  prepared.sensitiveHeaderNames!.push("other-secret");
  expect(snapshot.headers[0].value).toBe("text/plain");
  expect(snapshot.sensitiveHeaderNames).toEqual(["x-key"]);
});

it("copies every mutable transport input without sharing credential header metadata", () => {
  const original = captured();
  const copy = copyHttpRequest(original);
  original.headers[0].value = "changed";
  original.sensitiveHeaderNames![0] = "changed";
  expect(copy.headers[0].value).toBe("text/plain");
  expect(copy.sensitiveHeaderNames).toEqual(["x-key"]);
  expect(copy.redirectPolicy).toBe("same-origin");
  expect(copyHttpRequest({ ...original, sensitiveHeaderNames: undefined }).sensitiveHeaderNames).toBeUndefined();
});

it("projects the same query-authenticated destination without resolving template bodies", () => {
  const request = draft({ path: "{{baseUrl}}/items?token=old&tag=one", body: '{"value":"{{missingBody}}"}',
    query: [entry("tag", "{{tag}}"), entry("ignored", "{{disabled}}", false)],
    auth: { type: "api-key", location: "query", name: "token", value: "{{token}}" } });
  const environment = scope({ baseUrl: "https://example.test", tag: "space here", token: "a & b" });
  const original = structuredClone({ request, environment });
  const preview = previewRequestTarget(request, environment);
  expect(preview).toEqual({ value: "https://example.test/items?tag=one&tag=space+here&token=a+%26+b",
    error: null, environmentError: false });
  expect(preview.value).toBe(prepareNextRequest({ ...request, body: "{}" }, environment).url);
  expect(() => prepareNextRequest(request, environment)).toThrow('"missingBody" is not defined');
  expect({ request, environment }).toEqual(original);
});

it("keeps target metadata validation immediate while leaving body-dependent headers to preparation", () => {
  const request = draft({ body: "{{missingBody}}" });
  expect(previewRequestTarget({ ...request, timeoutMs: 0 }).error).toContain("Timeout must be an integer");
  expect(previewRequestTarget({ ...request, headers: [entry("Bad header", "value")] }).error).toContain("HTTP tokens");
  expect(previewRequestTarget({ ...request, auth: { type: "bearer", token: "bad\nvalue" } }).error).toContain("line breaks");
  expect(previewRequestTarget({ ...request, contentType: "{{missingMime}}" }).error).toContain('"missingMime" is not defined');

  const emptyBody = draft({ body: "{{empty}}", contentType: "text/plain\ninvalid" });
  expect(previewRequestTarget(emptyBody, scope({ empty: "" })).error).toBeNull();
  expect(prepareNextRequest(emptyBody, scope({ empty: "" })).headers).toEqual([]);
  expect(previewRequestTarget({ ...emptyBody, inputMode: "literal" }).error).toContain("line breaks");
});

it("projects captured and literal destinations without consulting an invalid environment", () => {
  const environment: Environment = { id: "bad", name: "Bad", variables: [entry("duplicate", "a"), entry("duplicate", "b")] };
  const request = draft({ inputMode: "literal", path: "https://literal.test/{{token}}", body: "{{literal}}" });
  expect(previewRequestTarget(request, environment).value).toBe(prepareNextRequest(request, environment).url);
  expect(previewRequestTarget({ ...request, inputMode: "template", timeoutMs: 0 }, environment, captured()))
    .toEqual({ value: captured().url, error: null, environmentError: false });
});

it("resolves variable header names and values for MIME tooling with the active environment", () => {
  const request = draft({ headers: [entry("{{headerName}}", "{{mime}}")], contentType: "{{unused}}" });
  for (const mime of ["text/plain", "application/json; charset=utf-8"]) {
    const environment = scope({ headerName: "cOnTeNt-TyPe", mime });
    const preview = previewRequestContentType(request, environment);
    expect(preview).toEqual({ value: mime, source: "header", error: null, environmentError: false });
    expect(prepareRequest(request, environment).headers[0].value).toBe(preview.value);
  }
  expect(previewRequestContentType(request, scope({ headerName: "X-Other", mime: "text/plain", unused: "application/xml" })))
    .toMatchObject({ value: "application/xml", source: "default" });
});

it("uses the first enabled Content-Type and resolves the default without requiring URL, query, or body validity", () => {
  const request = draft({ path: "{{missingUrl}}", body: "{{missingBody}}", query: [entry("q", "{{missingQuery}}")],
    timeoutMs: 0, contentType: "{{mime}}", headers: [entry("Content-Type", "{{disabled}}", false)] });
  expect(previewRequestContentType(request, scope({ mime: "application/json" })))
    .toEqual({ value: "application/json", source: "default", error: null, environmentError: false });
  const duplicate = draft({ headers: [entry("Content-Type", "text/plain"), entry("content-type", "application/json")] });
  expect(previewRequestContentType(duplicate).value).toBe(prepareRequest(duplicate).headers[0].value);
  expect(previewRequestContentType({ ...request, contentType: "{{missing}}" }).error).toContain('"missing" is not defined');
});

it("lets resolved authentication replace Content-Type before selecting MIME tooling", () => {
  const request = draft({ headers: [entry("content-type", "text/plain"), entry("Content-Type", "application/xml")],
    auth: { type: "api-key", location: "header", name: "{{name}}", value: "{{mime}}" } });
  const environment = scope({ name: "CONTENT-TYPE", mime: "application/json" });
  expect(previewRequestContentType(request, environment))
    .toEqual({ value: "application/json", source: "authentication", error: null, environmentError: false });
  expect(prepareRequest(request, environment).headers).toEqual([{ name: "CONTENT-TYPE", value: "application/json" }]);
  expect(previewRequestContentType({ ...request, auth: { type: "api-key", location: "query", name: "{{missing}}", value: "{{missing}}" } }).value)
    .toBe("text/plain");
});

it("preserves literal MIME values and uses captured headers without consulting an invalid environment", () => {
  const environment: Environment = { id: "bad", name: "Bad", variables: [entry("duplicate", "a"), entry("duplicate", "b")] };
  const request = draft({ inputMode: "literal", headers: [entry("Content-Type", "{{mime}}")], contentType: "application/json" });
  expect(previewRequestContentType(request, environment))
    .toEqual({ value: "{{mime}}", source: "header", error: null, environmentError: false });
  const snapshot = captured();
  expect(previewRequestContentType({ ...request, inputMode: "template" }, environment, snapshot))
    .toEqual({ value: "text/plain", source: "captured", error: null, environmentError: false });
  expect(previewRequestContentType(request, environment, { ...snapshot, headers: [] }))
    .toEqual({ value: "", source: "none", error: null, environmentError: false });
});

function draft(changes: Partial<RequestData> = {}): RequestData {
  return { ...createRequest(), path: "https://example.test/", body: "body", ...changes };
}

function scope(values: Record<string, string>): Environment {
  return { id: "local", name: "Local", variables: Object.entries(values).map(([name, value]) => entry(name, value)) };
}

function entry(name: string, value: string, enabled = true) {
  return { name, value, enabled };
}

function captured(): HttpRequest {
  return { method: "POST", url: "https://captured.test/", body: "{{literal}}", timeoutMs: 5000,
    headers: [{ name: "Content-Type", value: "text/plain" }], redirectPolicy: "same-origin", sensitiveHeaderNames: ["x-key"] };
}
