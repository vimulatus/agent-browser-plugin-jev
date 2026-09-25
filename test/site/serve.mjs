// Serves the blocker pages: node test/site/serve.mjs <port>
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] ?? 8792);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript" };
/** Pages that answer with an HTTP error, so the status code agrees with what the page shows. */
const errors = {
  "/error-500.html": { status: 500 },
  "/rate-limit.html": { status: 429, headers: { "retry-after": "30" } },
};

createServer(async (req, res) => {
  let { pathname } = new URL(req.url, `http://127.0.0.1:${port}`);
  if (pathname === "/") pathname = "/index.html";
  const file = join(root, normalize(pathname));
  if (!file.startsWith(root) || extname(file) === ".mjs") return res.writeHead(404).end("Not found");
  let body;
  try {
    body = await readFile(file);
  } catch {
    return res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
  const { status = 200, headers = {} } = errors[pathname] ?? {};
  res.writeHead(status, { "content-type": types[extname(file)] ?? "text/plain", ...headers }).end(body);
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
