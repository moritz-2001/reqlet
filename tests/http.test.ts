// Verifies executeHttp's public transport contract, including native IPC cancellation ordering.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeHttp } from "../src/http";
import type { HttpRequest, HttpResponse } from "../src/request";

const native = vi.hoisted(() => ({ isTauri: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

beforeEach(() => {
  vi.resetAllMocks();
  native.isTauri.mockReturnValue(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser transport", () => {
  it("sends the concrete snapshot and returns HTTP errors as responses with byte size", async () => {
    const fetch = vi.fn().mockResolvedValue(response(new Uint8Array([99, 97, 102, 233]), { status: 422, headers: { "Content-Type": "text/plain; charset=iso-8859-1" } }));
    vi.stubGlobal("fetch", fetch);

    const result = await executeHttp(request({ method: "POST", body: "payload", headers: [{ name: "X-Test", value: "one" }, { name: "X-Test", value: "two" }] }));
    expect(result).toMatchObject({ status: 422, body: "café", sizeBytes: 4, url: "https://example.test/final" });
    const options = fetch.mock.calls[0][1];
    expect(options).toMatchObject({ method: "POST", body: "payload", credentials: "omit" });
    expect(options.headers.get("x-test")).toBe("one, two");
  });

  it("times out while receiving the body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, options) => Promise.resolve({
      ...response(new Uint8Array()),
      body: new ReadableStream({ start(controller) { options.signal.addEventListener("abort", () => controller.error(new Error("Aborted"))); } }),
    })));
    const result = executeHttp(request({ timeoutMs: 25 }));
    const assertion = expect(result).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it("distinguishes user cancellation and cancels fetch", async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
      fetchSignal = options.signal;
      options.signal.addEventListener("abort", () => reject(new Error("Aborted")));
    })));
    const result = executeHttp(request(), controller.signal);
    controller.abort();

    await expect(result).rejects.toMatchObject({ kind: "cancelled", name: "AbortError" });
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("stops receiving browser response bodies above 64 MiB without trusting Content-Length", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ...response(new Uint8Array(), { headers: { "Content-Length": "1" } }),
      // Disable fixture prefetch so the count measures reads requested by the transport.
      body: new ReadableStream({
        pull(controller) { sent += 1; controller.enqueue(chunk); },
        cancel,
      }, { highWaterMark: 0 }),
    }));

    await expect(executeHttp(request())).rejects.toMatchObject({ kind: "response-limit", message: expect.stringContaining("64 MiB") });
    expect(cancel).toHaveBeenCalledOnce();
    expect(sent).toBe(65);
  });

  it("accepts exactly 64 MiB from a chunked browser body", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    let sent = 0;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ...response(new Uint8Array()),
      body: new ReadableStream({
        pull(controller) {
          if (sent++ < 64) controller.enqueue(chunk);
          else controller.close();
        },
      }),
    }));

    const result = await executeHttp(request());
    expect(result.sizeBytes).toBe(64 * 1024 * 1024);
    expect(result.body.length).toBe(64 * 1024 * 1024);
    expect(result.body.startsWith("aaaa")).toBe(true);
    expect(result.body.endsWith("aaaa")).toBe(true);
  });

  it("rejects already cancelled and invalid requests before dispatch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(executeHttp(request(), controller.signal)).rejects.toHaveProperty("name", "AbortError");
    for (const invalid of [
      { url: "file:///tmp/example" }, { url: "https://name:secret@example.test" },
      { method: "GET\r\nInjected" }, { timeoutMs: 0 }, { timeoutMs: 1.5 },
      { headers: [{ name: "X-Test", value: "yes\r\nInjected: yes" }] },
    ]) {
      await expect(executeHttp(request(invalid))).rejects.toHaveProperty("kind", "validation");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("native transport", () => {
  beforeEach(() => { native.isTauri.mockReturnValue(true); });

  it("reserves an ID before executing and passes valid error-status responses through", async () => {
    native.invoke.mockResolvedValueOnce("operation-1").mockResolvedValueOnce(completed());
    const snapshot = request();
    await expect(executeHttp(snapshot)).resolves.toEqual(completed());
    expect(native.invoke.mock.calls).toEqual([
      ["http_create_operation"], ["http_execute", { operationId: "operation-1", request: snapshot }],
    ]);
  });

  it("preserves cancellation while reservation is pending and still consumes the reservation", async () => {
    let reserve: (id: string) => void = () => {};
    native.invoke.mockImplementation((command: string) => {
      if (command === "http_create_operation") return new Promise<string>((resolve) => { reserve = resolve; });
      if (command === "http_execute") return Promise.reject({ kind: "cancelled", message: "Request cancelled." });
      return Promise.resolve();
    });
    const controller = new AbortController();
    const result = executeHttp(request(), controller.signal);
    controller.abort();
    reserve("operation-2");

    await expect(result).rejects.toMatchObject({ name: "AbortError", kind: "cancelled" });
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["http_create_operation", "http_cancel", "http_execute"]);
  });

  it("keeps a late completed result from overriding user cancellation and removes abort listeners", async () => {
    let finish: (response: HttpResponse) => void = () => {};
    native.invoke.mockImplementation((command: string) => {
      if (command === "http_create_operation") return Promise.resolve("operation-3");
      if (command === "http_execute") return new Promise<HttpResponse>((resolve) => { finish = resolve; });
      return Promise.resolve();
    });
    const controller = new AbortController();
    const result = executeHttp(request(), controller.signal);
    await Promise.resolve();
    controller.abort();
    finish(completed());

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(native.invoke).toHaveBeenCalledWith("http_cancel", { operationId: "operation-3" });
  });

  it("maps serialized native failures to ordinary typed errors", async () => {
    native.invoke.mockResolvedValueOnce("operation-4").mockRejectedValueOnce({ kind: "network", message: "Connection refused." });
    await expect(executeHttp(request())).rejects.toMatchObject({ name: "HttpExecutionError", kind: "network", message: "Connection refused." });
  });

  it("preserves native response-limit failures as typed errors", async () => {
    native.invoke.mockResolvedValueOnce("operation-5").mockRejectedValueOnce({ kind: "response-limit", message: "Decoded response body exceeds the 64 MiB limit." });
    await expect(executeHttp(request())).rejects.toMatchObject({ name: "HttpExecutionError", kind: "response-limit" });
  });
});

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { method: "GET", url: "https://example.test/path", headers: [], body: "", timeoutMs: 30000, ...overrides };
}

function completed(): HttpResponse {
  return { url: "https://example.test/path", status: 500, statusText: "Internal Server Error", headers: [], body: "problem", sizeBytes: 7, durationMs: 10 };
}

function response(bytes: Uint8Array, options: { status?: number; headers?: Record<string, string> } = {}) {
  return {
    url: "https://example.test/final", status: options.status ?? 200, statusText: "",
    headers: new Headers(options.headers), body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
  };
}
