# Linux installation

Reqlet can be packaged for Ubuntu/Debian x86_64 using Tauri's Debian bundler.
Build on an x86_64 Linux host, virtual machine, or container. The macOS build
cannot be installed on Linux. Linux packaging and desktop behavior still need
verification on a Linux host; the instructions below describe that procedure.

## Build the Debian package

Use Ubuntu 22.04+ or Debian 12+ with WebKitGTK 4.1 packages available. For packages
distributed to several machines, build on the oldest distribution release you
intend to support: newer build hosts can require a newer glibc on the destination.
See Tauri's [Debian compatibility guidance](https://v2.tauri.app/distribute/debian/).

Install the [Linux build prerequisites](https://v2.tauri.app/start/prerequisites/#linux):

```sh
sudo apt update
sudo apt install build-essential pkg-config curl wget file \
  libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

Install a supported Node.js LTS release, pnpm 11.25.0 (recorded in
`package.json`), and stable Rust through [rustup](https://rustup.rs/). Make sure
`node`, `pnpm`, `rustup`, and `cargo` are available in your shell.

Copy the source tree and its lockfiles to the Linux host. Omit `node_modules`,
`dist`, `target`, `crates/target`, `src-tauri/target`, and `src/wasm/generated`;
dependencies and generated assets are rebuilt for the destination host.
From the project root on Linux:

```sh
rustup target add wasm32-unknown-unknown
pnpm install --frozen-lockfile
pnpm build:linux
```

`pnpm build:linux` runs `tauri build --bundles deb`. Tauri first runs `pnpm build`
to compile both Rust/Wasm computations, check Vue/TypeScript, and bundle the
frontend. It then compiles the native HTTP client and creates the Debian package.
The default output directory is `src-tauri/target/release/bundle/deb/`.
Use the `.deb` ending in `_amd64.deb` for x86_64 machines.

To try the application before packaging, run `pnpm tauri dev` in a graphical
Linux session. The release build itself does not require an open desktop session.

## Install and launch

Copy the generated `.deb` to the target Linux machine. From the directory
containing it, substitute its exact filename below:

```sh
sudo apt install ./reqlet_0.1.0_amd64.deb
```

`apt` installs the package and resolves its declared runtime dependencies.
Node.js, pnpm, Rust, and the development libraries are needed only on the build
host. Launch **Reqlet** from the application menu, or run `reqlet` from a
terminal in your graphical desktop session. Installing a newer package uses
the same `apt install ./filename.deb` command.

To remove the application package:

```sh
sudo apt remove reqlet
```

Workspace storage belongs to the local Linux user. Installation does not import
the macOS workspace; export collections there and import them on Linux if needed.

## Optional AppImage

On the Linux build host, create an AppImage instead of a Debian package:

```sh
pnpm tauri build --bundles appimage
```

The output is in `src-tauri/target/release/bundle/appimage/`. Copy the file to the
Linux desktop and run it using its actual filename:

```sh
chmod +x Reqlet_0.1.0_amd64.AppImage
./Reqlet_0.1.0_amd64.AppImage
```

The same build-host glibc compatibility constraint applies. If FUSE is unavailable,
try running it with `--appimage-extract-and-run`. See Tauri's
[AppImage guide](https://v2.tauri.app/distribute/appimage/).

## Verify on Linux

Run `pnpm test`, `cargo test --manifest-path crates/Cargo.toml`, and
`cargo test --manifest-path src-tauri/Cargo.toml` on the build host. Then install
the `.deb` and check the packaged application in a graphical session:

- Launch from the application menu and send an HTTPS request through the native client.
- Open a local protobuf source through the native file dialog.
- Save a request, quit, and reopen to confirm workspace restoration.

A successful frontend or macOS build does not verify Linux linking, WebKitGTK
behavior, or the generated package's runtime dependencies.
