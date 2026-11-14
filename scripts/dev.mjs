// Local server: serves public/ and the two API routes, same code as on Vercel.
// Run with `npm run dev` (reads AQ_TOKEN from .env if present).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as state from "../api/state.js";
import * as health from "../api/health.js";

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const routes = { "/api/state": state, "/api/health": health };
const port = Number(process.env.PORT) || 3000;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes[url.pathname];
  if (route) {
    const r = await route.GET(new Request(url));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const file = path.join(PUB, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}).listen(port, () => console.log(`CRM on http://localhost:${port}${process.env.AQ_TOKEN ? "" : " (no AQ_TOKEN: seed data only)"}`));
