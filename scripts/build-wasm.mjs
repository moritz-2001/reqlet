// Builds dependency-free Rust computations and copies their assets into Vite's source tree.
import { mkdir, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const result = spawnSync("cargo", [
  "build", "--manifest-path", "crates/Cargo.toml", "--package", "json-formatter-wasm", "--package", "body-search-wasm",
  "--target", "wasm32-unknown-unknown", "--target-dir", "crates/target", "--release", "--locked",
], { cwd: fileURLToPath(root), stdio: "inherit" });

if (result.error || result.status !== 0) {
  if (result.error) console.error(result.error.message);
  console.error("Wasm build failed. Install stable Rust and run: rustup target add wasm32-unknown-unknown");
  process.exit(result.status || 1);
}

const destination = new URL("src/wasm/generated/", root);
await mkdir(destination, { recursive: true });
for (const [crate, asset] of [["json_formatter_wasm", "json_formatter"], ["body_search_wasm", "body_search"]]) {
  await copyFile(
    new URL(`crates/target/wasm32-unknown-unknown/release/${crate}.wasm`, root),
    new URL(`${asset}.wasm`, destination),
  );
}
