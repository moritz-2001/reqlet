# Authentication and environments

Saved requests, selected environments, and execution snapshots have separate
ownership. [AuthEditor](../src/components/AuthEditor.vue) emits replacement
`RequestAuth` values. [EnvironmentManager](../src/components/EnvironmentManager.vue)
emits replacement environment lists and active execution IDs, while the workspace
owns and persists those values. Its compact Environment selector explicitly
chooses the scope used for sending. Manage environments has its own Edit
environment selection: inspecting, creating, renaming, and editing another scope
does not switch the execution target. Use this environment explicitly activates
the inspected scope. Changing the active target elsewhere preserves the manager's
selection and unfinished rename. Deleting the active environment selects No
environment; deleting an inactive environment leaves the target unchanged.

[RequestTarget](../src/components/RequestTarget.vue) displays the active environment
and resolved destination beside the sending controls. It accepts the current
`request` and optional `environment`, and calls the same pure `prepareRequest`
boundary used by Send. It displays preparation errors before execution and updates
when the draft or active scope changes, without executing or changing saved data.
The destination includes enabled query rows and query authentication; the full
value remains in its title when the available width truncates the preview.

[`prepareRequest(request, environment?)`](../src/prepareRequest.ts) is the pure
boundary between a saved definition and an executable `HttpRequest`. Calling it
does not change the request or environment. It either returns a fully resolved
snapshot or throws a readable validation error, before transport starts.

```ts
const request = {
  ...createRequest("Get account"),
  path: "{{baseUrl}}/account",
  auth: { type: "bearer", token: "{{token}}" } as const,
};
const environment = {
  id: "local",
  name: "Local",
  variables: [
    { name: "baseUrl", value: "http://localhost:8080", enabled: true },
    { name: "token", value: "example-token", enabled: true },
  ],
};
const snapshot = prepareRequest(request, environment);
// snapshot.url is http://localhost:8080/account; the saved placeholders remain intact.
```

Enabled variables resolve `{{name}}` references in URL text, header names and
values, additional query names and values, body text, authentication fields, and
the default Content-Type when used. Whitespace around a reference or definition
name is ignored. Values may reference other variables. Missing references,
dependency cycles, empty enabled variable names, and duplicate enabled names
produce readable errors. Disabled rows do not participate, including duplicates
and unresolved references they contain. Variable values are inserted literally;
use separate query rows when a query value needs URL encoding.

Query rows append to the existing URL query, retaining order and repeated names.
Enabled headers retain their order and duplicates. Content-Type is added only
when the resolved body is nonempty and no explicit enabled Content-Type header
exists. Method names are normalized to uppercase. URLs must be absolute HTTP or
HTTPS without embedded credentials. Header names must be HTTP tokens, and values
must satisfy the same byte-range and line-break checks as the transport. Timeouts
must be integers from 1 through 2147483647 milliseconds.

Authentication supports None, Bearer, Basic, and API key in a header or query
parameter. Basic credentials use UTF-8 before Base64 encoding; usernames cannot
contain a colon. Authentication takes precedence: it removes all existing
matching headers using case-insensitive names, or all matching URL and added
query parameters using case-sensitive names, then appends its resolved value.
None preserves manually configured authentication headers. This policy keeps the
execution result unambiguous without altering the saved rows.

Authentication password, token, and key inputs are masked. Switching the
authentication type restores that mode's last accepted inputs, including Basic
credentials and API key placement; selecting None temporarily disables configured
authentication without clearing those inputs. `AuthEditor` still emits one complete
active `RequestAuth` value through `update:modelValue`. Parent-supplied values are
authoritative: external replacements refresh the remembered inputs for their
type, and rejected edits are never remembered. Only the selected type enters the
saved request, execution, and exports.

Inactive credentials stay in the individual editor's memory. App keys cached
request editors by request/draft identity, so switching workspace or settings tabs
preserves those inputs without sharing them between requests. Unmounting the editor
(including KeepAlive eviction) or reloading releases the inactive values. Consumers
reusing `AuthEditor` for different requests must key it by the request identity.
Remembered values remain unresolved text; captured-input mode continues to treat
placeholders literally and never converts credentials while changing modes.

Name completion and local credential validation share the execution resolver.
Suggestions list enabled variable names only. Password, token, and API key fields
never display resolved values in a hover preview or completion list.
Credentials and environment variables are saved in the local workspace; executed
history contains resolved values. Masking inputs does not encrypt local storage.

## Shared input assistance

[`createVariableResolver(environment?)`](../src/requestVariables.ts) owns the same
nested-variable semantics for execution and previews. A resolver captures one
scope and caches only within that call; recreate it after editing the environment.
`EnvironmentVariableError` identifies scope/reference problems so an input can
offer the environment manager without confusing them with transport validation.
[`previewRequestField(value, kind, environment?)`](../src/prepareRequest.ts) returns
a resolved value or a field-local error using the same HTTP rules as preparation.
It never prepares unrelated request fields or mutates a definition.

```ts
const result = previewRequestField("{{baseUrl}}/account", "url", environment);
if (result.error) {
  showFieldError(result.error);
  // result.environmentError determines whether to offer Edit environment.
} else {
  showUrlTooltip(result.value);
}
```

[`VariableInput`](../src/components/VariableInput.vue) is a controlled text input:

```vue
<VariableInput
  v-model="request.path"
  :environment="activeEnvironment"
  kind="url"
  preview
  aria-label="Request URL"
  @edit-environment="openEnvironmentManager"
/>
```

Use `secret` for credentials; it masks the input and suppresses resolved previews.
Use `literal` for captured snapshots, disabled rows, or plain variable definitions;
it bypasses resolution, suggestions, and validity so exact history replay is not
reinterpreted against today's scope. Standard attributes such as IDs, labels, and
placeholders apply to the native input. Errors set native custom validity and `aria-invalid` immediately. Pristine
empty fields and open completion menus keep visible error text quiet; leaving a
field or native Send validation reveals an empty-field message. Rendered messages
remain associated with the input, allowing the enclosing editor to focus the
problem when sending. Choosing a name emits the full updated string through `update:modelValue`.
The component never rewrites placeholders into resolved values.
