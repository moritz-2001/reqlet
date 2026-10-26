# Redirect policy and credential boundaries

`RequestData.redirectPolicy` is captured into `HttpRequest.redirectPolicy` by
[prepareRequest](../src/prepareRequest.ts). The Advanced editor setting exposes
three choices:

- `never` returns the first response, including a 3xx status and its body.
- `same-origin` follows only when scheme, hostname, and effective port stay the
  same. A redirect to another origin is returned as the final 3xx response.
- `follow` follows across origins after removing credential headers. HTTPS to
  HTTP downgrades produce an error before any request reaches that destination.

An absent field means `never`, including old saved requests, imported collections,
and historical snapshots. This intentionally changes the previous implicit native
redirect following into an explicit choice. Select a following policy in Advanced
when the server requires redirects. At most ten redirects are followed. A single
timeout and cancellation token cover every hop and the complete final body.

The native transport inspects each `Location` before sending the next request in
[http_redirects.rs](../src-tauri/src/http_redirects.rs). It supports 301, 302, 303,
307, and 308. POST becomes GET after 301/302; 303 becomes GET except for HEAD.
These changes discard the body and its content headers. 307/308 retain both.
Only HTTP(S) destinations without embedded credentials are accepted. An explicit
Host header is removed after an origin change so it cannot misroute the next hop.

## Credential metadata

`Authorization`, `Cookie`, `Cookie2`, `Proxy-Authorization`, and `WWW-Authenticate` are always removed when the
origin changes. A configured header API key also adds its resolved name to
`HttpRequest.sensitiveHeaderNames`. Names are compared case-insensitively and
removal persists even if a subsequent redirect returns to the original origin.
Same-origin redirects preserve credentials. Scheme and effective port changes
both count as origin changes.

`RequestData.sensitiveHeaderNames` retains this information when a captured
snapshot becomes an editable draft. Preparation merges those names with the
currently configured API key without changing the saved headers. Missing metadata
in old data means only the standard credential names are recognized; choose the
default `never` policy or configure API-key authentication before opting into
cross-origin redirects with a custom credential header. Authentication query
parameters are part of the initial URL and are not reapplied to redirected URLs.
As with request bodies, a server can explicitly include received data in its
`Location`; opt into cross-origin following only for a trusted destination.

```ts
const draft = {
  ...createRequest(),
  path: "https://service.example/items",
  redirectPolicy: "follow" as const,
  auth: { type: "api-key", name: "X-Api-Key", value: "secret", location: "header" } as const,
};
const snapshot = prepareRequest(draft);
// snapshot.sensitiveHeaderNames is ["x-api-key"]. Native execution keeps it
// for same-origin redirects and removes that header before another origin.
```

## Browser preview and cURL

Browser fetch hides intermediate URLs and redirect responses. Preview always uses
manual redirect handling and explains that an opaque redirect requires the
desktop app. It cannot implement `follow` safely because it cannot inspect
intermediate destinations or enforce the downgrade guard, so that choice produces
a validation error before network access. `never` and `same-origin` never
silently follow a redirect in preview.

cURL import without `--location` uses `never`; `-L`/`--location` opts into `follow`
under the application's ten-hop and downgrade restrictions. `--no-location`
restores `never`. `--location-trusted` is rejected because it forwards credentials.
Explicit methods other than GET/HEAD combined with following are rejected because
cURL preserves them through redirects differently from the application's normal
method transitions.

Follow exports use `--location --max-redirs 10 --proto-redir '=https'`. Export
supports HTTPS GET/HEAD and POST with a body; POST uses cURL's inferred method to
preserve normal POST-to-GET transitions. cURL cannot express same-origin-only
following or removal of arbitrary credential headers, so those combinations
produce an explanatory export error. Other starting schemes and method
combinations that cannot retain the safety and method semantics also produce an
error. Choose `never` to export any otherwise-supported snapshot without following.

Public-interface tests live in [httpRedirects.test.ts](../tests/httpRedirects.test.ts)
and the native redirect module. The native tests use two loopback origins to check
that secrets never reach the redirected destination.
