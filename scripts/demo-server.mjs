import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../demo/", import.meta.url));
export function createDemoServer() {
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!["index.html", "demo.css", "demo.js"].includes(file)) { res.writeHead(404); res.end("Not found"); return; }
    try {
      res.writeHead(200, { "Content-Type": { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)], "Cache-Control": "no-store" });
      res.end(await readFile(path.join(root, file)));
    } catch { res.writeHead(500); res.end("Unable to load demo"); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const server = createDemoServer();
  server.listen(port, "127.0.0.1", () => console.log(`Pause test store: http://127.0.0.1:${port}`));
}
