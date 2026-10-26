# Request preparation

The pure interfaces in [prepareRequest.ts](../src/prepareRequest.ts) separate
editable `RequestData` from concrete `HttpRequest` snapshots. They leave request
definitions and environments unchanged and report readable validation errors.

`prepareNextRequest(request, environment?, capturedRequest?)` selects the actual
inputs for the next execution. Send and `ImportExport` synchronously use this
boundary; `RequestTarget` uses it for deferred complete validation. A supplied
capture wins before any draft or environment is read;
this keeps an unedited history draft's placeholders and credentials exact.
Without a capture, `prepareRequest` applies the current input mode, environment,
query parameters, authentication, body defaults, and transport validation.

```ts
const snapshot = prepareNextRequest(draft.request, activeEnvironment, draft.capturedRequest);
const destination = snapshot.url;
const command = exportCurl(snapshot);
await executeHttp(snapshot, signal);
```

`previewRequestTarget(request, environment?, capturedRequest?)` returns
`{value, error, environmentError}` for the resolved destination without resolving
or parsing a template body. It shares URL, ordered query parameter,
authentication, and transport metadata preparation with `prepareRequest`, so its
destination matches the eventual send whenever complete preparation succeeds.
Method, timeout, redirect,
credential-header metadata, URL, enabled headers, authentication, and environment
errors appear immediately. Literal inputs validate without parsing or expanding
their bodies; captures return their exact URL before reading editable inputs.

```ts
const target = previewRequestTarget(draft.request, activeEnvironment, draft.capturedRequest);
if (!target.error) showDestination(target.value);
// A successful target projection does not imply that the template body is valid.
const snapshot = prepareNextRequest(draft.request, activeEnvironment, draft.capturedRequest);
```

`RequestTarget` checks complete template inputs after 200 ms without an edit.
Each change clears previous deferred feedback and cancels the pending check;
cached inactive editors and unmounted components cancel their timers too.
Missing body variables therefore appear after editing pauses, while the URL
continues updating immediately. The default Content-Type's header syntax also
waits for complete validation: it is sent only when the resolved body is
nonempty. Its variable resolution remains immediate. This avoids rejecting a
default header that an empty resolved body would never send. Send and export
always perform complete synchronous preparation, regardless of this feedback
delay. Malformed JSON remains sendable under the existing preparation rules.

The caller owns the returned snapshot. [copyHttpRequest](../src/requestSnapshot.ts)
copies header objects and `sensitiveHeaderNames`, including an explicitly empty
array. App uses it when starting execution and opening drafts or history views;
history insertion uses it for both incoming and retained captures. This keeps
later edits from changing in-flight inputs or historical credential handling.
`redirectPolicy` and sensitive header metadata also survive reconstruction of
editable history drafts, so leaving captured mode retains redirect protection.
History drafts also start with `inputMode: "literal"`. Editing or saving one to
Collections therefore preserves placeholder-looking captured text; selecting
Environment template in Advanced is the explicit transition back to substitution.

`previewRequestContentType(request, environment?, capturedRequest?)` projects the
body format without resolving unrelated URL, query, or body fields. It returns
`{value, error, environmentError, source}`; errors produce `value: null` and
`source: null`, so tooling can remain inactive and show a useful explanation.

The projection uses the same header resolution and authentication replacement as
transport. Enabled header names and values resolve according to the input mode;
authentication replaces matching names case-insensitively. The first remaining
Content-Type header is authoritative. Otherwise the configured default resolves.
For empty editable bodies, that default still guides composition even though
transport adds it only with a nonempty body. Captures use their actual headers;
without Content-Type their value is empty and source is `none`.

```ts
const mime = previewRequestContentType(request, activeEnvironment, capturedRequest);
const bodyFormat = mime.value ?? "";
const protobuf = resolveProtobufAssistance(request.protobuf, sources, states, bodyFormat);
```

`RequestEditor` uses the result for both body actions and protobuf assistance.
Header, authentication, and captured overrides explain why the default selector
is disabled. Changing environments updates tooling without changing saved text.
Literal input mode ignores the active environment, and `RequestTarget` labels
that behavior explicitly. A capture retains higher priority than literal mode.
