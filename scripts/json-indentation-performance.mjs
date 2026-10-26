// Measures the pure JSON Enter policy with pre-parsed trees, independently of editor and browser rendering.
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const sizes = process.argv.slice(2).map(Number);
const kibibytes = sizes.length ? sizes : [8, 32, 128, 512];
if (kibibytes.some(size => !Number.isFinite(size) || size <= 0)) {
  throw new Error("Pass positive fixture sizes in KiB, for example: pnpm perf:indentation 32 128 512");
}

// Loading only TypeScript keeps this benchmark independent of the dev server,
// Vue plugins, dependency optimization, sockets, and the user's stored workspace.
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { jsonNewlineEdit } = await server.ssrLoadModule("/src/components/jsonIndentation.ts");
  const { jsonLanguage } = await server.ssrLoadModule("/src/components/jsonLanguage.ts");
  console.log("JSON Enter policy only: pre-parsed trees, 2 warmups, median of 7 samples; milliseconds.");
  for (const kib of kibibytes) {
    for (const multiline of [false, true]) {
      const row = multiline
        ? '  {"id":123,"name":"hello","enabled":true},\n'
        : '{"id":123,"name":"hello","enabled":true},';
      const source = "[" + (multiline ? "\n" : "") + row.repeat(Math.floor(kib * 1024 / row.length)) + "{}]";
      const tree = jsonLanguage.parser.parse(source);
      const samples = [];
      for (let sample = 0; sample < 9; sample++) {
        const start = performance.now();
        jsonNewlineEdit(source, source.length - 1, source.length - 1, tree);
        if (sample >= 2) samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      console.log(JSON.stringify({
        characters: source.length,
        layout: multiline ? "multiline" : "minified",
        medianMs: Number(samples[3].toFixed(2)),
        minMs: Number(samples[0].toFixed(2)),
        maxMs: Number(samples[6].toFixed(2)),
      }));
    }
  }
} finally {
  await server.close();
}
