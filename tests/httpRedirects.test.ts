// Verifies redirect choices and credential metadata through preparation, interchange, transport, and persistence interfaces.
import { beforeEach, expect, it, vi } from "vitest";
import { executeHttp } from "../src/http";
import { prepareRequest } from "../src/prepareRequest";
import { exportCurl, importCurl, parseCollectionDocument, serializeCollection } from "../src/interchange";
import { createRequest, type HttpRequest } from "../src/request";

const native = vi.hoisted(() => ({ isTauri: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

beforeEach(() => {
  vi.resetAllMocks();
  native.isTauri.mockReturnValue(false);
});

it("preserves opt-in redirect choices and configured API credential names in immutable snapshots", () => {
  const draft = { ...createRequest(), redirectPolicy: "follow" as const, sensitiveHeaderNames: ["X-Existing"],
    auth: { type: "api-key" as const, name: "X-Api-Key", value: "secret", location: "header" as const } };
  const original = structuredClone(draft);
  expect(prepareRequest(draft)).toMatchObject({ redirectPolicy: "follow", sensitiveHeaderNames: ["x-existing", "x-api-key"] });
  expect(draft).toEqual(original);
  expect(prepareRequest({ ...draft, auth: { type: "none" } }).sensitiveHeaderNames).toEqual(["x-existing"]);
  expect(prepareRequest(createRequest()).redirectPolicy).toBeUndefined();
});

it("roundtrips additive metadata in portable collections while accepting legacy definitions", () => {
  const collection = [{ kind: "request" as const, id: "one", name: "One", requestType: "GET" }];
  const requests = { one: { ...createRequest(), redirectPolicy: "same-origin" as const, sensitiveHeaderNames: ["X-Key"] } };
  expect(parseCollectionDocument(serializeCollection(requests, collection)).requests).toEqual(requests);
  expect(parseCollectionDocument(serializeCollection({ one: createRequest() }, collection)).requests.one.redirectPolicy).toBeUndefined();
  expect(() => serializeCollection({ one: { ...createRequest(), sensitiveHeaderNames: ["Bad Name"] } }, collection)).toThrow("sensitiveHeaderNames");
});

it("imports cURL's explicit redirect switch and reimports the bounded safe export", () => {
  expect(importCurl("curl https://example.com").redirectPolicy).toBeUndefined();
  expect(importCurl("curl -L https://example.com").redirectPolicy).toBe("follow");
  expect(importCurl("curl --location --no-location https://example.com").redirectPolicy).toBeUndefined();
  const snapshot = request({ redirectPolicy: "follow", headers: [{ name: "Authorization", value: "Bearer secret" }] });
  const curl = exportCurl(snapshot);
  expect(curl).toContain("--location --max-redirs 10 --proto-redir '=https'");
  expect(prepareRequest(importCurl(curl))).toEqual(snapshot);
  expect(() => importCurl("curl --location-trusted https://example.com")).toThrow("credentials");
  expect(() => importCurl("curl -L -X POST --data-raw payload https://example.com")).toThrow("preserves the method differently");
});

it("preserves normal POST-to-GET redirect semantics by avoiding cURL's explicit-method override", () => {
  const snapshot = request({ redirectPolicy: "follow", method: "POST", body: "payload", headers: [{ name: "Content-Type", value: "text/plain" }] });
  const curl = exportCurl(snapshot);
  expect(curl).not.toContain("--request");
  expect(prepareRequest(importCurl(curl))).toEqual(snapshot);
});

it("explains redirect policies and credential combinations cURL cannot represent safely", () => {
  expect(() => exportCurl(request({ redirectPolicy: "same-origin" }))).toThrow("same-origin");
  expect(() => exportCurl(request({ redirectPolicy: "follow", sensitiveHeaderNames: ["X-Api-Key"] }))).toThrow("custom credential headers");
  expect(() => exportCurl(request({ redirectPolicy: "follow", url: "http://example.com/" }))).toThrow("HTTPS");
});

it("never lets browser fetch follow an uninspectable redirect", async () => {
  const fetch = vi.fn().mockResolvedValue({ type: "opaqueredirect" });
  vi.stubGlobal("fetch", fetch);
  try {
    await expect(executeHttp(request())).rejects.toThrow("Browser preview stopped a redirect");
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "manual", credentials: "omit" });
    await expect(executeHttp(request({ redirectPolicy: "follow" }))).rejects.toThrow("desktop app");
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("validates redirect metadata before native IPC", async () => {
  native.isTauri.mockReturnValue(true);
  await expect(executeHttp(request({ sensitiveHeaderNames: ["Bad Name"] }))).rejects.toHaveProperty("kind", "validation");
  expect(native.invoke).not.toHaveBeenCalled();
});

function request(changes: Partial<HttpRequest> = {}): HttpRequest {
  return { method: "GET", url: "https://example.com/", headers: [], body: "", timeoutMs: 30000, ...changes };
}
