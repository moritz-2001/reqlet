# Reqlet

A desktop HTTP client built with Tauri 2, Rust, Vue 3, and TypeScript.

For Ubuntu/Debian x86_64, see [Linux installation](doc/linux-installation.md)
to build a `.deb` with `pnpm build:linux` and install it with `apt`.

- Editable method, URL, headers, query parameters, text body, and timeout.
- Send/cancel requests and inspect status, headers, timing, and received byte size, with progress/status badges on background tabs.
- Manage request/folder collections and named environments with authentication.
- Save the workspace locally, restore tabs/layout, and replay execution history.
- Autosave editable drafts before adding them to Collections; reopen closed drafts after closing or reload.
- Undo cleared history while retaining new executions, and open responses from closed-tab completion notices.
- Undo collection deletion while preserving newer edits, tabs, and layout.
- Import cURL, portable collections, and OpenAPI 3.0/3.1 JSON or YAML with an operation preview; export requests as cURL and collections as JSON.
- Keep imported cURL and OpenAPI values literal; choose template expansion explicitly when needed.
- Inspect redirects by default, with explicit follow policies and credential protection.
- Decode gzip, deflate, and Brotli responses with bounded response sizes.
- Inspect responses up to 64 MiB with bounded raw pages and whole-response Find for large bodies.
- JSON highlighting, folding, formatting, indentation, line/block comments, trailing commas, and independent editor tabs.
- Search saved requests by name, method, URL, and folder; quick-open with ⌘/Ctrl+K. Keep search, filters, expanded folders, and scroll position when switching Collections/History.
- Find text in request and response bodies with ⌘/Ctrl+F, match highlights, and next/previous navigation.

```sh
rustup target add wasm32-unknown-unknown
pnpm install
pnpm tauri dev
```

The native client executes HTTP through Rust. `pnpm dev` runs the frontend with
browser fetch instead; browser CORS and restricted-header rules apply there.
The initial examples target `http://localhost:8080` through the Local environment.
Choose your own URL or environment before sending.

Workspace definitions, drafts, credentials, and resolved execution history are
stored locally in the webview's storage. **Save to Collections** promotes a draft
to a saved request; closing its tab keeps it available through **Reopen closed
draft**. Live requests and recovery notices do not resume after reload.
Collection and cURL exports can include secrets.
Production persistence uses IndexedDB with separate definition and capture
records. Persisted history is limited to 100 captures and 8 MiB; omitted captures
produce a storage notice and remain available in the current session. Existing
localStorage workspaces migrate without changing their original bytes.

See [setup](doc/setup.md), [architecture](ARCHITECTURE.md),
[request editor](doc/request-editor.md), [HTTP execution](doc/http-execution.md),
[JSON comments and sending behavior](doc/json-comments.md),
[OpenAPI import](doc/openapi-import.md), and [workspace storage](doc/workspace-storage.md).
Large-response behavior and reproducible UI measurements are documented in
[large responses](doc/large-responses.md) and [UI performance](doc/ui-performance.md).
Medium JSON previews compute in Rust/Wasm; see
[JSON formatting computation](doc/wasm-json-formatting.md) for interfaces and benchmarks.
Large-response Find retains its source in a cancellable Wasm worker; see
[response search computation](doc/wasm-response-search.md) for ownership and measurements.
