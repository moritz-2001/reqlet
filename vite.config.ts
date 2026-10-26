// Configures Vue compilation and the fixed development server consumed by Tauri.
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [vue()],

  // Optimize the editor as one group so language facets and parsers share module instances.
  optimizeDeps: {
    include: [
      "@codemirror/state", "@codemirror/view", "@codemirror/commands",
      "@codemirror/language", "@codemirror/lint",
      "@lezer/common", "@lezer/highlight",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Keep native build outputs outside the frontend watcher. The copied Wasm
      // asset remains watched so rebuilding computations refreshes their consumers.
      ignored: ["**/src-tauri/**", "**/crates/target/**"],
    },
  },
}));
