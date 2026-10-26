// Serves the production UI with synthetic loopback responses and opt-in browser timing instrumentation.
import { createServer } from "node:http";
import { readFile, appendFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? 17428);
const output = process.argv[4] ?? "/tmp/reqlet-ui-performance.jsonl";
const types = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".html": "text/html" };

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/fixture") {
      const mib = Math.min(64, Math.max(0.001, Number(url.searchParams.get("mib") ?? 1)));
      const length = Math.floor(mib * 1024 * 1024);
      const row = '{"id":123456,"name":"performance item","enabled":true,"nested":{"value":"needle"}},';
      const start = '{"items":[';
      const end = '{"last":"TAIL-NEEDLE"}]}';
      const count = Math.max(0, Math.floor((length - start.length - end.length) / row.length));
      const padding = " ".repeat(length - start.length - end.length - row.length * count);
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": length, "Cache-Control": "no-store" });
      response.end(start + row.repeat(count) + padding + end);
      return;
    }
    if (url.pathname === "/metrics" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      await appendFile(output, body + "\n");
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/instrumentation.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(await readFile(new URL("./ui-performance-client.js", import.meta.url)));
      return;
    }

    const path = resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!path.startsWith(root + "/")) { response.writeHead(403).end(); return; }
    let content = await readFile(path);
    if (extname(path) === ".html") {
      content = content.toString().replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/,
        '<script type="module" src="/instrumentation.js" data-entry="$1"></script>');
    }
    response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    response.end(content);
  } catch (error) {
    console.error(error);
    response.writeHead(500).end(String(error));
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Production UI profiler: http://127.0.0.1:${port}/?mib=1&run=baseline-1`);
  console.log(`Build: ${root}; measurements: ${output}`);
});
