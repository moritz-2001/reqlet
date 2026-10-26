# Desktop setup

## Prerequisites

Use a supported Node.js LTS release, pnpm 11.25.0, and stable Rust with Cargo.
Install the Rust computation target with `rustup target add wasm32-unknown-unknown`.
The package manager version is recorded in `package.json`. Commit `pnpm-lock.yaml`,
`crates/Cargo.lock`, and `src-tauri/Cargo.lock` to keep dependency resolution reproducible.

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
for each development or build host:

- macOS: Xcode Command Line Tools for desktop development.
- Windows: Microsoft C++ Build Tools with Desktop development with C++, the
  MSVC Rust toolchain, and WebView2.
- Linux: the distribution's WebKitGTK 4.1 development libraries and the remaining
  system packages listed in Tauri's prerequisites.

For Ubuntu/Debian x86_64 package prerequisites, building a `.deb`, and installing
the application, see [Linux installation](linux-installation.md).

## Development

Run commands from the project root:

```sh
pnpm install
pnpm tauri dev
```

Tauri starts Vite and opens the native request workspace. HTTP requests execute
through Rust. `pnpm dev` runs the same frontend in a browser with fetch; server
CORS policy and browser restrictions apply to that transport. Initial examples
use the Local environment with `baseUrl` set to `http://localhost:8080`. No request
is sent automatically.

Development runs the Wasm build script directly before Vite, avoiding a nested
package-manager launch. Cargo still checks the computations on every start and
rebuilds changed Rust sources. See [startup measurements](ui-performance.md#startup-comparison-on-2026-10-26)
for the measured preparation and workspace restoration boundaries.

## Build and verification

```sh
pnpm build
pnpm test
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo fmt --manifest-path crates/Cargo.toml --all -- --check
cargo test --manifest-path crates/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

`pnpm dev`, `pnpm test`, and `pnpm build` first build the local JSON formatting
and response-search Wasm assets. `pnpm build:wasm` rebuilds them after Rust changes
during development; see [JSON formatting computation](wasm-json-formatting.md)
and [response search computation](wasm-response-search.md).
`pnpm build` checks Vue/TypeScript and builds the frontend. `cargo check` checks
the native code. `pnpm tauri build` builds and packages the desktop application
for the host platform. Verify each platform on its own host; a successful macOS
build does not establish Windows or Linux compatibility.

`pnpm test` runs formatter, pure data operations, transport boundaries, and Vue
component/application contracts. The Node formatter tests require Node 22.18 or
newer. Native transport tests use a local loopback HTTP server. See
[the body text guide](body-text.md) for editor interfaces and limitations, and
[HTTP execution](http-execution.md) for desktop/browser transport differences.
Signing, notarization, and release automation remain distribution work.
