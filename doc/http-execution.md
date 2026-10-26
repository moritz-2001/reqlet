# HTTP execution

[executeHttp](../src/http.ts) is the asynchronous transport boundary. It receives
an already-resolved [HttpRequest](../src/request.ts), leaving drafts, environments,
history, and execution state ownership with the caller. Its resolved value is a
complete `HttpResponse`; status codes such as 404 and 500 remain valid responses.

```ts
const cancellation = new AbortController();
try {
  const response = await executeHttp(preparedRequest, cancellation.signal);
  // Store response separately from the editable request definition.
} catch (error) {
  if (error instanceof Error && error.name === "AbortError") {
    // Record cancellation without displaying it as a network error.
  }
}
// The caller can call cancellation.abort() while execution is running.
```

`HttpExecutionError` has a readable `message` and a `kind` of `validation`,
`network`, `timeout`, `cancelled`, `response-limit`, or `internal`. Cancellation uses the standard
`AbortError` name. The timeout covers receiving the complete body. Both transports
validate HTTP(S) destinations without embedded credentials, HTTP method and
header tokens, header values, and integer timeouts from 1 to 2,147,483,647 ms.
Authentication is prepared as headers or query parameters before execution.
`redirectPolicy` defaults to `never`, including existing snapshots without the
field. `same-origin` follows only within the original scheme, hostname, and port;
`follow` permits other origins with credential removal and HTTPS downgrade
protection. The complete redirect chain shares one cancellation signal and
timeout. See [redirect policy](http-redirects.md) for browser and cURL limits.

## Native transport

[http.rs](../src-tauri/src/http.rs) uses reqwest with the operating system's trusted
certificate roots. [lib.rs](../src-tauri/src/lib.rs) registers three Tauri commands:

- `http_create_operation` reserves an operation ID and cancellation token.
- `http_execute` consumes that reservation once and retains the token while
  connecting, following redirects, and receiving the body.
- `http_cancel` cancels a reserved or running operation. After completion it is
  a harmless no-op.

The managed `HttpOperations` instance initializes one HTTP client on its first
execution, so loading operating-system TLS roots does not delay native startup.
Initialization runs on a blocking worker, and concurrent sends share its result.
Cancellation releases an operation immediately while initialization finishes for
later sends. This one-time preparation precedes the transport timeout and elapsed
response measurement; those continue to cover connection through complete body
receipt.
Consecutive sends can reuse connections; request headers, credentials, body,
timeout, and cancellation are never stored as client defaults. The client has
no shared cookie jar. Client construction errors use the ordinary execution
error path, including reservation cleanup. Its automatic redirect policy remains
disabled because the explicit redirect loop inspects every next destination.

The frontend reserves before installing its cancellation handler and then checks
the signal again. This covers cancellation during the reservation itself without
allowing a cancel command to overtake registration. Execution always consumes the
reservation, including when already cancelled. A cleanup guard removes the token
on success, errors, validation failure, or dropping the native execution future.
Dropping the request future interrupts transport work; cancellation does not merely
hide its eventual response. A late result cannot override an aborted frontend call.

Response size is measured from received body bytes before content decoding or conversion to text.
The [bounded body reader](../src-tauri/src/http_body.rs) accepts gzip, deflate,
and Brotli content encodings, reversing stacked encodings before charset
conversion. Encoded receipt and each decoded stage are limited to 64 MiB;
exceeding either limit produces `response-limit` without retaining a partial
response. Received headers continue to describe the encoded representation.
The declared Content-Type charset selects decoding, falling back to UTF-8 for
missing or unknown character sets. Repeated response fields are retained; the
header map does not preserve the original global wire order. Request bodies are
UTF-8 text. Native execution has no browser CORS restrictions or shared cookie jar.

## Browser preview

Without a Tauri webview, execution uses fetch and an AbortController. The same
signal handles cancellation and timeout through body receipt. The browser enforces
CORS, hides response headers not exposed by the server, combines some repeated
fields, and controls forbidden request headers and methods. GET and HEAD bodies
produce a clear validation error because fetch cannot send them. Cookies are
omitted. Use the desktop app when these browser constraints affect a request.
Fetch uses manual redirects so the browser cannot forward credentials to an
uninspected destination. Opaque redirect responses require desktop execution,
and explicit `follow` is unavailable in the preview. Browsers perform content
decoding before exposing response chunks, so the preview's 64 MiB body limit
and size measurement apply to the browser-exposed bytes.

The current boundary collects a bounded complete response as bytes and returns text;
streaming and binary file downloads require a separate interface.
See [response decoding and limits](http-response-bodies.md).

## Verification

[Frontend transport tests](../tests/http.test.ts) cover snapshot forwarding,
HTTP error statuses, byte measurement and charset decoding, timeout during body
receipt, validation, and cancellation while native registration or execution is
pending. Native tests in [http.rs](../src-tauri/src/http.rs) use a temporary
127.0.0.1 server to verify transmitted method, URL, headers and body, duplicate
response fields, error statuses, byte count, timeout, and actual cancellation.

Run `pnpm exec vitest run tests/http.test.ts` and, from `src-tauri`,
`cargo test --offline --lib`. Native tests need permission to bind loopback sockets.
