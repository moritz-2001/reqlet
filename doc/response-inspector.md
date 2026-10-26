# Response inspection

Large header lists use the shared measured viewport in
[VirtualRows.vue](../src/components/VirtualRows.vue). Above 80 headers, the table
mounts only visible rows and four neighbors on either side in a 180-pixel scroll
viewport. Header values keep their full text and natural wrapping, including
duplicate names. The accessible table reports its complete row count and each
mounted row's original index, including the column-heading row. Small header
tables retain the native HTML table layout. Header scrolling does not change the
received response or the independent body editor.

[ResponseInspector.vue](../src/components/ResponseInspector.vue) accepts an optional
`execution: ExecutionState` from [request.ts](../src/request.ts). Omitting it shows
the initial idle prompt. The workspace owns execution state; the inspector has no
transport, draft copy, or events that mutate the response.

```vue
<ResponseInspector :key="activeRequestId" :execution="executionByRequest[activeRequestId]" />
```

Idle, sending, cancelled, and transport failure states have accessible feedback.
An HTTP 4xx or 5xx status remains a completed response: its body, status, final
URL, duration in milliseconds, and received byte count are all available.

While resending, the inspector keeps the last received response and labels it
**Previous response · Sending…**. Its status, timings, headers, and body describe
that previous exchange; the current attempt is still running. A new HTTP response,
including a 4xx or 5xx response, replaces the displayed exchange. A transport
failure or cancellation keeps the previous response visible with explicit latest
attempt feedback. A failure is announced as an alert and escaped as plain text.
Without a previous response, those states use the ordinary sending, cancelled,
or failure placeholder.

Retention is presentation state owned by the inspector, separate from execution
and history. The containing request editor is keyed by request identity in
[App.vue](../src/App.vue), so cached editors restore their own response without
showing another request's body. A standalone caller must likewise use a request
key when changing identities. [HistoryInspector.vue](../src/components/HistoryInspector.vue)
keys the inspector by captured exchange ID, so switching history entries always
shows that exchange's result without retaining a different exchange's response.
Setting execution to idle or omitting it clears
the retained body. Unmounting, including eviction from the editor's bounded
`KeepAlive` cache, also drops this optional view cache. It is not persisted or
reconstructed after remounting while an attempt is running.

Status, duration, and received byte count remain visible above the body. A
collapsed **Response details** disclosure contains the final URL, full metadata,
and headers. Expanding it uses a bounded scrollable area, so inspecting metadata
does not move execution status out of view. The body fills the remaining space
instead of enforcing a minimum height that pushes it outside a small workspace.

The headers table preserves received order and repeated names, including
separate `set-cookie` fields. Content type is read from the first matching
`Content-Type` header, using a case-insensitive name comparison. Missing headers
fall back to `text/plain`; the inspector does not guess from the body.

The read-only [BodyText](../src/components/BodyText.vue) retains selection,
copying, wrapping, and JSON preview/folding tools. MIME values ending in `+json`
or equal to `application/json` enable those tools, with case and charset
parameters handled by BodyText. Other MIME types remain literal text, including
HTML, so response markup is never executed. Pretty formatting changes only the
preview and preserves the original body for copying and history.
Valid JSON responses up to 512 Ki UTF-16 units initially use Pretty. Larger bodies
use the [paged raw response viewer](large-responses.md), with cooperative Find
across the original response and complete Copy/Download actions. The inspector
does not impose separate truncation. The body editor stays mounted during
resends, preserving selection, Find, wrapping, folds, and the Pretty / Raw choice.
The same editor receives the next response; its existing document replacement
behavior updates the body while retaining Find and presentation preferences.
The inspector also remembers Pretty / Raw when no previous body exists and the
body component must unmount. Invalid JSON is shown as its original text without
discarding the saved preference.

[ResponseInspector tests](../tests/ResponseInspector.test.ts) cover state
transitions, HTTP error responses, duplicate headers, metadata, MIME detection,
safe non-JSON rendering, retry feedback and retained editor state, clearing and
request-keyed cache boundaries, the collapsed metadata disclosure, and read-only
JSON preview behavior.
