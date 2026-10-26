# HTTP response bodies

The transport returns a complete text body through `HttpResponse`. Receipt is
limited to 64 MiB, and every content-decoding stage has its own 64 MiB output
limit. A response that exceeds either limit fails with
`HttpExecutionError.kind === "response-limit"` and a readable explanation;
partial text is never presented as a completed response. HTTP error statuses
remain ordinary responses when their bodies fit the limits. Exactly 64 MiB is
accepted. These limits count body bytes; charset conversion, complete text
storage, and native IPC can require additional memory.

## Native desktop

[http_body.rs](../src-tauri/src/http_body.rs) receives bounded chunks without
reqwest's automatic decompression, then reverses the received `Content-Encoding`
sequence. Supported codings are `gzip` (including `x-gzip`), `deflate` with its
standard zlib wrapper, `br`, and `identity`. Unsupported codings and malformed
compressed bodies fail with a readable network error. At most eight non-identity
codings may be stacked. Empty bodies do not need a decoder, including HEAD and
204 responses that describe an encoded representation.

Only after content decoding does [http.rs](../src-tauri/src/http.rs) apply the
declared `Content-Type` charset. Missing or unknown charsets use UTF-8. The
response retains its received `Content-Encoding` and `Content-Length` headers;
`sizeBytes` measures the actual encoded body bytes received before decompression
and character conversion. Transfer framing and response headers are excluded.

The complete operation timeout and cancellation remain active during receipt and
decoding. Decoding reads bounded output chunks and yields between them, so a
small compressed body cannot allocate its full expanded representation before
the limit is checked or monopolize the async executor during expansion.

## Browser preview

[http.ts](../src/http.ts) reads the fetch body stream and cancels it when the
observed body exceeds 64 MiB. This does not trust a server's `Content-Length`.
Fetch performs content decoding itself: `sizeBytes` therefore measures bytes
exposed after browser decompression, and the preview cannot enforce or report a
separate compressed byte count. Browser restrictions also determine which
response headers are visible. Use the desktop transport when comparing an
encoded transfer size to its decoded text.

## Verification

Native loopback tests in `http_body.rs` exercise compressed charset decoding,
gzip/deflate/Brotli and stacked codings, raw byte counts and headers, invalid
encodings, compressed expansion, oversized chunked receipt, and empty bodies.
Both raw chunked receipt and gzip output are accepted at exactly 64 MiB.
Frontend [transport tests](../tests/http.test.ts) cover stream cancellation at
the limit, the exact limit boundary, timeout during receipt, and mapping native
limit failures into the public error type.
