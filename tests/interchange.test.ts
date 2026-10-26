// Exercises the public cURL and portable collection contracts, including rejection and collision-safe merges.
import { describe, expect, it } from "vitest";
import { exportCurl, importCollection, importCurl, parseCollectionDocument, remapCollection, serializeCollection, type CollectionImport } from "../src/interchange";
import { prepareRequest } from "../src/prepareRequest";
import { createRequest, type Environment, type HttpRequest, type RequestData } from "../src/request";
import type { CollectionNode } from "../src/components/collectionTree";
import type { ProtobufSource } from "../src/protobuf";

describe("cURL conversion", () => {
  it("imports quoted multiline commands, repeated headers, Basic auth and inferred form POST", () => {
    const request = importCurl(`curl --url 'https://example.com/api' \\\n  -H 'X-Tag: first' -H "X-Tag: second" -u 'alice:p:a:ss' --max-time=1.25 \\\n  -d 'a=1' --data 'a=two'`);
    expect(prepareRequest(request)).toEqual({
      method: "POST", url: "https://example.com/api", body: "a=1&a=two", timeoutMs: 1250,
      headers: [
        { name: "X-Tag", value: "first" }, { name: "X-Tag", value: "second" },
        { name: "Content-Type", value: "application/x-www-form-urlencoded" },
        { name: "Authorization", value: "Basic YWxpY2U6cDphOnNz" },
      ],
    });
  });

  it("preserves explicit method, content type and literal raw body", () => {
    const request = importCurl(`curl -XPATCH -HContent-Type:application/json --data-raw '@{"a":"$literal"}' 'https://example.com'`);
    expect(request.method).toBe("PATCH");
    expect(request.body).toBe('@{"a":"$literal"}');
    expect(request.contentType).toBe("application/json");
    expect(request.headers).toEqual([{ name: "Content-Type", value: "application/json", enabled: true }]);
  });

  it.each([undefined, { id: "local", name: "Local", variables: [{ name: "token", value: "resolved-secret", enabled: true }] } satisfies Environment])(
    "keeps imported placeholder-looking body, headers, Basic credentials and query text literal with environment %j", environment => {
      const request = importCurl("curl -H 'X-Token: {{token}}' -u '{{token}}:{{token}}' --data-raw '{{token}}' https://example.com");
      expect(request.inputMode).toBe("literal");
      const prepared = prepareRequest(request, environment);
      expect(prepared.body).toBe("{{token}}");
      expect(prepared.headers).toContainEqual({ name: "X-Token", value: "{{token}}" });
      expect(prepared.headers).toContainEqual({ name: "Authorization", value: `Basic ${btoa("{{token}}:{{token}}")}` });
      expect(prepareRequest(importCurl(exportCurl(prepared)), environment)).toEqual(prepared);

      const query = prepareRequest(importCurl("curl -G --data-raw 'token={{token}}' https://example.com"), environment);
      expect(new URL(query.url).searchParams.get("token")).toBe("{{token}}");
      expect(prepareRequest(importCurl(exportCurl(query)), environment)).toEqual(query);
    },
  );

  it("preserves literal mode through portable collection export, remapping, and ordinary edits", () => {
    const request = importCurl("curl --data-raw '{{token}}' https://example.com");
    const nodes: CollectionNode[] = [{ id: "curl", kind: "request", name: request.name, requestType: request.method }];
    const imported = importCollection(serializeCollection({ curl: { ...request, name: "Edited name" } }, nodes));
    const restored = Object.values(imported.requests)[0];
    expect(restored.inputMode).toBe("literal");
    expect(prepareRequest({ ...restored, body: "edited {{token}}" }).body).toBe("edited {{token}}");
  });

  it("imports redirect policy flags and roundtrips the exporter's precise redirect options", () => {
    expect(importCurl("curl -L https://example.com").redirectPolicy).toBe("follow");
    expect(importCurl("curl --location --no-location https://example.com").redirectPolicy).toBeUndefined();
    for (const method of ["GET", "HEAD", "POST"]) {
      const snapshot: HttpRequest = { method, url: "https://example.com/", body: method === "POST" ? "{{literal}}" : "",
        headers: method === "POST" ? [{ name: "Content-Type", value: "text/plain" }] : [], timeoutMs: 30000, redirectPolicy: "follow" };
      const command = exportCurl(snapshot);
      expect(command).toContain("--location --max-redirs 10 --proto-redir '=https'");
      expect(prepareRequest(importCurl(command))).toEqual(snapshot);
    }
  });

  it("exports HEAD with cURL's response-body semantics and rejects an unrepresentable HEAD body", () => {
    const request: HttpRequest = { method: "HEAD", url: "https://example.com/", headers: [], body: "", timeoutMs: 30000 };
    expect(exportCurl(request)).toContain("--head");
    expect(exportCurl(request)).not.toContain("--request 'HEAD'");
    expect(prepareRequest(importCurl(exportCurl(request)))).toEqual(request);
    expect(importCurl("curl -I https://example.com").method).toBe("HEAD");
    expect(() => exportCurl({ ...request, body: "data" })).toThrow("HEAD request with a body");
  });

  it.each([
    [{ redirectPolicy: "same-origin" }, "same-origin"],
    [{ redirectPolicy: "follow", sensitiveHeaderNames: ["X-Api-Key"] }, "custom credential headers"],
    [{ redirectPolicy: "follow", url: "http://example.com/" }, "HTTPS"],
    [{ redirectPolicy: "follow", method: "PATCH" }, "method behavior"],
  ] as const)("rejects redirect exports that cannot preserve the snapshot: %j", (changes, message) => {
    expect(() => exportCurl({ method: "GET", url: "https://example.com/", body: "", headers: [], timeoutMs: 30000, ...changes })).toThrow(message);
  });

  it("uses an explicit content type for the editor while preserving MIME parameters", () => {
    const request = importCurl(`curl -H 'cOnTeNt-TyPe: application/json; charset=utf-8' --data-raw '{"source":"curl"}' https://example.com`);
    expect(request.contentType).toBe("application/json; charset=utf-8");
    expect(prepareRequest(request).headers).toEqual([
      { name: "cOnTeNt-TyPe", value: "application/json; charset=utf-8" },
    ]);
  });

  it("moves raw repeated data into the existing query before the fragment with --get", () => {
    const request = importCurl("curl -G -d 'a=two%20words' -d 'a=3' 'https://example.com/path?x=%2f#part'");
    expect(request.path).toBe("https://example.com/path?x=%2f&a=two%20words&a=3#part");
    expect(request.method).toBe("GET");
    expect(request.body).toBe("");
    expect(request.headers).toEqual([]);
  });

  it("supports escaped quotes, literal dollars, CRLF continuation and semicolon empty headers", () => {
    const request = importCurl('curl \\\r\n -H "X-Value: a\\\"b\\$c" -H \'X-Empty;\' --data-raw one\\ two https://example.com');
    expect(request.headers.slice(0, 2)).toEqual([
      { name: "X-Value", value: 'a"b$c', enabled: true }, { name: "X-Empty", value: "", enabled: true },
    ]);
    expect(request.body).toBe("one two");
  });

  it("imports precise fractional timeouts without floating point rounding", () => {
    expect(importCurl("curl --max-time 1.001 https://example.com").timeoutMs).toBe(1001);
    expect(importCurl("curl --max-time .5 https://example.com").timeoutMs).toBe(500);
    expect(importCurl("curl --max-time 01.0010 https://example.com").timeoutMs).toBe(1001);
    expect(importCurl("curl --max-time 2147483.647 https://example.com").timeoutMs).toBe(2147483647);
  });

  it("imports IPv6 URLs while rejecting path/query glob ranges", () => {
    expect(importCurl("curl 'http://[::1]:8080/api'").path).toBe("http://[::1]:8080/api");
    expect(() => importCurl("curl 'https://example.com/[1-3]'")).toThrow("globbing");
  });

  it.each(["https://example.com/?token={{token}}", "https://example.com/?field[0]=value"])("roundtrips literal URL characters that cURL would otherwise expand: %s", url => {
    const request = importCurl(`curl -g '${url}'`);
    const prepared = prepareRequest(request);
    const command = exportCurl(prepared);
    expect(command).toContain("--globoff");
    expect(prepareRequest(importCurl(command))).toEqual(prepared);
  });

  it("rejects header line breaks even where trimming would hide them", () => {
    expect(() => importCurl("curl -H 'X: \nvalue' https://example.com")).toThrow("line breaks");
  });

  it("lets an explicit authorization header override generated Basic auth", () => {
    const request = importCurl("curl -u 'user:password' -H 'Authorization: Bearer token' https://example.com");
    expect(request.auth).toEqual({ type: "none" });
    expect(prepareRequest(request).headers).toEqual([{ name: "Authorization", value: "Bearer token" }]);
  });

  it("roundtrips a resolved snapshot with apostrophes, substitutions as literals, empty and duplicate headers", () => {
    const request: HttpRequest = {
      method: "CUSTOM", url: "https://example.com/?a=1&a=2", timeoutMs: 1234,
      headers: [{ name: "X-Tag", value: "one" }, { name: "X-Tag", value: "two's" },
        { name: "X-Empty", value: "" }, { name: "Content-Type", value: "text/plain" }],
      body: "@O'Reilly says $(whoami); `rm`\nnext line \\ done",
    };
    expect(prepareRequest(importCurl(exportCurl(request)))).toEqual(request);
  });

  it.each([
    ["curl --location-trusted https://example.com", "forward credentials"],
    ["curl --max-redirs 4 https://example.com", "10 redirects"],
    ["curl --proto-redir '=http,https' https://example.com", "Only --proto-redir"],
    ["curl -L --proto-redir '=https' http://example.com", "HTTPS starting URL"],
    ["curl -L -X POST -d data https://example.com", "preserves the method differently"],
    ["curl --head --data-raw data https://example.com", "cannot be represented"],
    ["curl --head -X GET https://example.com", "cannot be represented"],
    ["curl https://example.com --insecure", "Unsupported"],
    ["curl https://example.com | sh", "Shell operators"],
    ["curl https://example.com; rm file", "Shell operators"],
    ['curl "https://example.com/$TOKEN"', "Shell substitutions"],
    ["curl https://example.com/$(whoami)", "Shell substitutions"],
    ["curl `whoami`", "Shell substitutions"],
    ["curl -d @body.json https://example.com", "Body files"],
    ["curl --data-binary @- https://example.com", "Body files"],
    ["curl -H @headers https://example.com", "Header files"],
    ["curl -H 'Content-Type:' https://example.com", "suppression"],
    ["curl -u username https://example.com", "password"],
    ["curl --max-time 0 https://example.com", "--max-time"],
    ["curl --max-time .0001 https://example.com", "--max-time"],
    ["curl --max-time 1.0001 https://example.com", "--max-time"],
    ["curl --url https://one.example https://two.example", "exactly one URL"],
    ["curl 'https://example.com", "unclosed quote"],
    ["curl --request", "Missing value"],
    ["curl ftp://example.com", "HTTP(S)"],
    ["curl 'https://example.com/{one,two}'", "globbing"],
    ["wget https://example.com", "Start"],
  ])("rejects unsupported or ambiguous input: %s", (command, error) => {
    expect(() => importCurl(command)).toThrow(error);
  });
});

describe("portable collections", () => {
  it.each([null, "interpolate", 1])("rejects invalid input mode %j without converting legacy definitions", inputMode => {
    const data = collection();
    const envelope = JSON.parse(serializeCollection(data.requests, data.nodes));
    expect(parseCollectionDocument(JSON.stringify(envelope)).requests.request).not.toHaveProperty("inputMode");
    envelope.requests.request.inputMode = inputMode;
    expect(() => importCollection(JSON.stringify(envelope))).toThrow("requests.request.inputMode");
  });

  it("roundtrips nested collection definitions, disabled rows and saved auth without changing the source", () => {
    const data = collection();
    const original = structuredClone(data);
    const text = serializeCollection(data.requests, data.nodes);
    expect(JSON.parse(text)).toMatchObject({ kind: "api-tool-collection", version: 1 });
    expect(parseCollectionDocument(text)).toEqual({ requests: data.requests, collection: data.nodes });
    expect(data).toEqual(original);
  });

  it("exports only referenced protobuf names and bindings, excluding local model paths", () => {
    const data = protobufCollection();
    const original = structuredClone(data);
    const text = serializeCollection(data.requests, data.nodes, data.sources);
    const parsed = parseCollectionDocument(text);

    expect(parsed.requests).toEqual(data.requests);
    expect(parsed.protobufSources).toEqual([
      { id: "shared", name: "Shared models", rootPath: null, includePaths: [] },
      { id: "removed-models", name: "Unavailable protobuf source", rootPath: null, includePaths: [] },
    ]);
    expect(text).not.toContain("/private/");
    expect(data).toEqual(original);
  });

  it("imports shared and unavailable protobuf bindings into independent unlinked sources", () => {
    const data = protobufCollection();
    const original = structuredClone(data);
    const text = serializeCollection(data.requests, data.nodes, data.sources);
    const first = importCollection(text);
    const occupied = [...Object.keys(first.requests), ...first.protobufSources!.map(source => source.id)];
    const second = importCollection(text, occupied);

    for (const result of [first, second]) {
      const shared = result.protobufSources!.find(source => source.name === "Shared models")!;
      const unavailable = result.protobufSources!.find(source => source.name === "Unavailable protobuf source")!;
      const requests = Object.values(result.requests);
      expect(shared).toEqual({ id: expect.any(String), name: "Shared models", rootPath: null, includePaths: [] });
      expect(shared.id).not.toBe("shared");
      expect(unavailable.id).not.toBe("removed-models");
      expect(unavailable.id).not.toBe(shared.id);
      expect(requests.map(request => request.protobuf)).toEqual([
        { sourceId: shared.id, messageName: "users.FirstRequest" },
        { sourceId: shared.id, messageName: "users.SecondRequest" },
        { sourceId: unavailable.id, messageName: "users.RemovedRequest" },
      ]);
    }
    expect(second.protobufSources!.every(source => !occupied.includes(source.id))).toBe(true);
    Object.values(first.requests)[0].protobuf!.messageName = "users.EditedRequest";
    first.protobufSources![0].includePaths.push("/new/dependency");
    expect(Object.values(second.requests)[0].protobuf!.messageName).toBe("users.FirstRequest");
    expect(second.protobufSources![0].includePaths).toEqual([]);
    expect(data).toEqual(original);
  });

  it("retries protobuf identity collisions without merging shared and unavailable bindings", () => {
    const data = protobufCollection();
    const sequence = [
      "new-first", "new-second", "new-removed", "removed-models", "shared", "unused",
      "occupied-source", "new-shared-source", "new-removed-source",
    ];
    const result = remapCollection(
      { requests: data.requests, collection: data.nodes, protobufSources: data.sources },
      ["occupied-source"], () => sequence.shift()!,
    );

    const [shared, unavailable] = result.protobufSources!;
    const requests = Object.values(result.requests);
    expect(shared.id).toBe("new-shared-source");
    expect(unavailable.id).toBe("new-removed-source");
    expect(requests[0].protobuf?.sourceId).toBe(shared.id);
    expect(requests[1].protobuf?.sourceId).toBe(shared.id);
    expect(requests[2].protobuf?.sourceId).toBe(unavailable.id);
  });

  it("reports exhausted protobuf identity allocation without changing imported definitions", () => {
    const data = protobufCollection();
    const original = structuredClone(data);
    const sequence = ["new-first", "new-second", "new-removed"];
    expect(() => remapCollection(
      { requests: data.requests, collection: data.nodes, protobufSources: data.sources },
      [], () => sequence.shift() ?? "shared",
    )).toThrow("Could not allocate a unique imported identity");
    expect(data).toEqual(original);
  });

  it.each([
    ["duplicate sources", "protobufSources", (value: CollectionImport) => { value.protobufSources!.push({ ...value.protobufSources![0] }); }],
    ["invalid root", "protobufSources[0].rootPath", (value: CollectionImport) => { value.protobufSources![0].rootPath = false as never; }],
    ["invalid binding", "requests.first.protobuf", (value: CollectionImport) => { value.requests.first.protobuf = null as never; }],
    ["unsafe source identity", "requests.first.protobuf.sourceId", (value: CollectionImport) => { value.requests.first.protobuf!.sourceId = "__proto__"; }],
  ])("rejects portable protobuf metadata with %s before import", (_description, path, mutate) => {
    const data = protobufCollection();
    const envelope = JSON.parse(serializeCollection(data.requests, data.nodes, data.sources));
    mutate(envelope);
    expect(() => importCollection(JSON.stringify(envelope))).toThrow(path);
  });

  it("remaps every folder and request identity and preserves internal links, without source mutation", () => {
    const data = collection();
    const imported = { requests: data.requests, collection: data.nodes };
    const sequence = ["existing", "folder", "request", "new-folder", "new-request"];
    const result = remapCollection(imported, ["existing"], () => sequence.shift()!);
    expect(result.collection).toEqual([{ kind: "folder", id: "new-folder", name: "Folder", children: [
      { kind: "request", id: "new-request", name: "Request", requestType: "POST" },
    ] }]);
    expect(Object.keys(result.requests)).toEqual(["new-request"]);
    result.requests["new-request"].headers[0].value = "changed";
    expect(data.requests.request.headers[0].value).toBe("secret");
    expect(data.nodes[0].id).toBe("folder");
  });

  it("imports the same file twice with disjoint identities", () => {
    const data = collection();
    const text = serializeCollection(data.requests, data.nodes);
    const first = importCollection(text, ["request", "folder"]);
    const firstIds = [first.collection[0].id, ...Object.keys(first.requests)];
    const second = importCollection(text, firstIds);
    expect(second.collection[0].id).not.toBe(first.collection[0].id);
    expect(Object.keys(second.requests)[0]).not.toBe(firstIds[1]);
    expect(Object.keys(first.requests)[0]).not.toBe("request");
  });

  it.each([
    ["{", "valid JSON"],
    ["[]", "collection object"],
    [JSON.stringify({ kind: "api-tool-collection", version: 2 }), "Unsupported"],
    [JSON.stringify({ kind: "other", version: 1 }), "Unsupported"],
  ])("rejects invalid envelopes", (text, error) => {
    expect(() => parseCollectionDocument(text)).toThrow(error);
  });

  it("rejects malformed requests and dangling or duplicate references before importing", () => {
    const data = collection();
    const envelope = JSON.parse(serializeCollection(data.requests, data.nodes));
    envelope.requests.request.headers[0].enabled = "yes";
    expect(() => importCollection(JSON.stringify(envelope))).toThrow("enabled");
    envelope.requests.request.headers[0].enabled = true;
    envelope.collection[0].children[0].id = "missing";
    expect(() => importCollection(JSON.stringify(envelope))).toThrow("missing request");
    envelope.collection[0].children[0].id = "request";
    envelope.collection.push(envelope.collection[0]);
    expect(() => importCollection(JSON.stringify(envelope))).toThrow("duplicate identity");
  });
});

function collection() {
  const request = { ...createRequest("Request"), method: "POST", body: '{"key":"value"}',
    headers: [{ name: "X-Secret", value: "secret", enabled: false }],
    auth: { type: "bearer" as const, token: "{{token}}" } };
  const nodes: CollectionNode[] = [{ kind: "folder", id: "folder", name: "Folder", children: [
    { kind: "request", id: "request", name: "Request", requestType: "POST" },
  ] }];
  return { requests: { request }, nodes };
}

function protobufCollection() {
  const requests: Record<string, RequestData> = {
    first: { ...createRequest("First"), protobuf: { sourceId: "shared", messageName: "users.FirstRequest" } },
    second: { ...createRequest("Second"), protobuf: { sourceId: "shared", messageName: "users.SecondRequest" } },
    removed: { ...createRequest("Removed"), protobuf: { sourceId: "removed-models", messageName: "users.RemovedRequest" } },
  };
  const nodes: CollectionNode[] = Object.entries(requests).map(([id, request]) => ({
    kind: "request", id, name: request.name, requestType: request.method,
  }));
  const sources: ProtobufSource[] = [
    { id: "shared", name: "Shared models", rootPath: "/private/models", includePaths: ["/private/dependencies"] },
    { id: "unused", name: "Unused models", rootPath: "/private/unused", includePaths: [] },
  ];
  return { requests, nodes, sources };
}
