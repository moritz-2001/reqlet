# UI and recovery verification — 26 October 2026

This focused pass preserves the existing component interfaces and workspace,
execution, history, environment, and editor ownership boundaries described in
[architecture.md](architecture.md).

## Improvements and confirmed defects

| Trigger and previous behavior | Result and code | Regression evidence |
| --- | --- | --- |
| Load an older version-1 IndexedDB document without `drafts` or `closedDraftIds`. Validation discarded its normalized return value, so App received missing recovery containers and could not mount the workspace. | [workspaceRepository.ts](../src/workspaceRepository.ts) returns normalized state without rewriting storage during load. | [Repository](../tests/workspaceRepository.test.ts) and [application](../tests/App.storage.test.ts) tests failed before the fix; now restore open requests, edit/save/reload definitions, and persist recoverable drafts. |
| Choose an import file, then paste different import text before its asynchronous read finishes. The older file overwrote the newer text. | [ImportExport.vue](../src/components/ImportExport.vue) preserves later edits, announces the discarded load, and exposes loading feedback. | Deferred-file UI regression in [ImportExport.test.ts](../tests/ImportExport.test.ts), red before the fix. |
| Press Enter or Escape while composing text in history search. Enter opened a snapshot; Escape cleared filters. | [HistoryPanel.vue](../src/components/HistoryPanel.vue) leaves composing keys to the input method. | Composition-event UI regression in [HistoryPanel.test.ts](../tests/HistoryPanel.test.ts), red before the fix. |
| Activate Pretty/Raw using the keyboard. Expanding folds moved focus from the toolbar into CodeMirror. | [BodyText.vue](../src/components/BodyText.vue) restores the initiating control or More trigger. | Direct-toggle and overflow-menu cases in [BodyText.test.ts](../tests/BodyText.test.ts), red before the fix; direct Raw activation also checked in the browser. |
| Collapse Authentication with an invalid bearer token, select Body, then Send. Auth was selected but its invalid field remained hidden. | [RequestEditor.vue](../src/components/RequestEditor.vue) opens enclosing disclosures before native validation and focus. | [RequestEditor.test.ts](../tests/RequestEditor.test.ts) failed before the fix. Browser verified Auth selected, disclosure open, and token focused with `aria-invalid=true`. |
| Reduce window width below 760px. Hiding the visible Environment label removed the selector's accessible name. | [EnvironmentManager.vue](../src/components/EnvironmentManager.vue) supplies an explicit Environment name. | Existing scope-selection test now exercises its named control and failed before the fix; named browser lookup verified at 601px. |
| Send at 602×600 with the desktop sidebar visible. Method, Cancel, and Sending squeezed the URL field to approximately 25px. | [RequestFields.vue](../src/components/RequestFields.vue) gives the URL a full row when the address container is at most 420px wide. During execution its measured width is now 308px. | Real browser measurement and matched 602×600 screenshots below; no geometry claims rely on jsdom. |

Removed an unused `@codemirror/lang-json` prebundle entry from
[vite.config.ts](../vite.config.ts), eliminating its startup dependency warning.
The project uses its own JSON language implementation.

## Runtime checks

`pnpm tauri dev` launched with a separate `dev.apitool.ui-review` identifier and
an incognito webview. A temporary macOS app wrapper made the debug executable
accessible to the UI automation tool. The default native window was 800×600.
The browser frontend used a separate development server and clean origin,
`http://127.0.0.1:17426`, avoiding existing data at `localhost:1420`.
All sent requests targeted a local HTTP fixture at `127.0.0.1:17427`; the
transport-error check targeted an unused loopback port. Fixture data and tokens
were synthetic.

| Runtime | Observed journeys |
| --- | --- |
| Native Tauri / Rust HTTP | Open saved requests; receive HTTP 200 and 500; switch away during a slow request; close its tab and inspect the background completion notice; open captured history as a draft; edit, close, recover, save to Collections, and send the recovered definition. |
| Browser / fetch | Receive 200, 404, 204 with an empty body, and a 171,590-byte response containing 4,000 items; cancel; time out after 100ms; inspect a transport failure; retry successfully while previous-response feedback remains available. |
| Browser / workspace | Edit variables; create and inspect an environment without activating it; explicitly change the active scope; replay history with captured inputs after that change; inspect missing-variable feedback and literal/captured input labels. |
| Browser / navigation | Create a long-named request; rename; move to Drafts; delete and Undo; search/select through keyboard quick-open; Escape dismissal and focus restoration; navigate seven open tabs through the picker. |
| Browser / bodies | Pretty/Raw keyboard focus; Find, one-match feedback, and retained query through tab switches; Copy; format an editable JSON body; undo after switching request tabs; reload and restore formatted body and saved tab selection. |
| Browser / interchange | Paste/import cURL; preview an OpenAPI 3.0 document and import its selected operation; export active cURL and collection JSON to the clipboard. Imports did not send requests. |

Browser viewports checked: 800×600, 1280×800, and 599/600/601/602×600 CSS pixels.
At 600px the drawer made the workspace inert; Escape restored Navigation focus
with a visible outline. At 602px the HTTP-method popup remained within the
viewport. Dialogs and long labels were inspected during the workflows above.

## Screenshots

- [Before, constrained running address](ui-review/before-narrow-running.jpg)
- [After, constrained running address](ui-review/after-narrow-running.jpg)
- [Native default window with received response](ui-review/native-response.png)
- [600px navigation layout](ui-review/after-600.jpg)
- [Validation reveals the credential](ui-review/after-auth-validation.jpg)
- [1280×800 request editor](ui-review/after-large.jpg)
- [800×600 baseline](ui-review/before-800.jpg)

## Verification results and limits

- Baseline: `pnpm test` passed 729 Vitest tests and 7 formatter tests;
  `pnpm build` passed.
- Final: `pnpm test` passed 735 Vitest tests across 47 files and 7 formatter
  tests; `pnpm build` passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and
  `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- `cargo test --manifest-path src-tauri/Cargo.toml` passed all 35 native tests.
  The first sandboxed run could not bind fixture sockets; rerunning with
  loopback permission passed. Native source was unchanged.
- The production build still reports its existing JavaScript chunk-size warning
  (approximately 795kB before gzip). Bundle splitting was outside this pass.
- IME composition and delayed file-read races were verified through component
  events, rather than a physical IME or a deliberately delayed OS file read.
  Older IndexedDB document restoration used the production adapter backed by
  fake-indexeddb and the mounted application, rather than altering a live user's
  database.
- Native resizing beyond its default window, screen-reader speech, extreme tab
  counts, and Windows/Linux were not manually verified. Responsive geometry
  checks were browser checks; fetch CORS/header behavior is not evidence for
  native transport behavior.
- No Git metadata was available in this checkout. Edits were confined to the
  identified components, storage normalization, Vite configuration, regression
  tests, subsystem documentation, and these review artifacts.
