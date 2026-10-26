# Request parameters

The Parameters tab in [RequestEditor.vue](../src/components/RequestEditor.vue)
counts both parameters written in the URL and additional saved query rows.
Disabled additional rows remain included in this editing count, just as disabled
header rows remain visible in the Headers count.

**From URL** shows names and values exactly as written, preserving duplicate
names, order, percent encoding, plus signs, and environment placeholders. A bare
`flag` is distinguished from `flag=`. Empty `&` segments and URL fragments do not
create rows. **Edit URL parameters** focuses the original URL input and selects
its query text, so there is only one editable source for these parameters.

**Additional query parameters** retains the ordered editable rows already owned
by `RequestData.query`. Enabled rows are appended during request preparation;
disabled rows remain saved without being sent. For example,
`https://example.com/?tag=first` and an additional `tag=second` row retain both
values in order. Authentication may subsequently replace matching parameters,
following [authentication and environments](authentication-environments.md).

[urlQuery.ts](../src/urlQuery.ts) provides a pure display projection of the saved
URL. It never resolves variables or rewrites the address. Queries supplied only
by environment-variable values remain visible in the resolved destination
preview, rather than being presented as editable URL source. Transport behavior
continues to belong to [prepareRequest.ts](../src/prepareRequest.ts).

The projection follows `RequestData.inputMode`, defaulting to template syntax.
Complete `{{variable}}` references are opaque in template mode, even when their
names contain URL delimiters. Literal inputs and captured replay use ordinary URL
syntax inside braces: `?value={{first&second}}` has two parameters, while template
mode shows one parameter containing the unchanged variable reference. Clearing
captured replay returns the projection to the request's own input mode.
