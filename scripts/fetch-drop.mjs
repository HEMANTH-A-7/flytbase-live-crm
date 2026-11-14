// scripts/fetch-drop.mjs: pull a dropped account (and the latest events) into
// data/seed/, one call per 62 s. Usage: node --env-file=.env scripts/fetch-drop.mjs K
import { writeFile, access, mkdir } from "node:fs/promises";
const TOKEN = process.env.AQ_TOKEN;
if (!TOKEN) { console.error("Set AQ_TOKEN"); process.exit(1); }
const id = process.argv[2] ?? "K";
const BASE = "https://questathon.aihackerscollective.com/api/public";
const OUT = new URL("../data/seed/", import.meta.url);
await mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (f) => access(new URL(f, OUT)).then(() => true, () => false);
let first = true;
async function pace() { if (!first) await sleep(62_000); first = false; }
const save = async (file, data) => { await writeFile(new URL(file, OUT), JSON.stringify(data, null, 1)); console.log(new Date().toISOString(), "ok", file); };
async function rest(path, file, force = false) {
  if (!force && await exists(file)) { console.log("skip", file); return JSON.parse(await (await import("node:fs/promises")).readFile(new URL(file, OUT), "utf8")); }
  await pace();
  const r = await fetch(`${BASE}/v1${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const t = await r.text();
  if (!r.ok) { console.error("ERR", path, r.status, t.slice(0, 300)); return null; }
  const data = JSON.parse(t);
  await save(file, data);
  return data;
}
async function rpc(method, params, file) {
  await pace();
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  const t = (await r.text()).trim();
  const j = JSON.parse(t.startsWith("{") ? t : t.split("\n").filter((l) => l.startsWith("data:")).at(-1).slice(5));
  await save(file, j.result ?? j);
  return j.result ?? j;
}
const tools = await rpc("tools/list", {}, "mcp_tools.json");
console.log("tools:", (tools.tools ?? []).map((t) => t.name).join(", "));
const drop = await rest(`/drops/${id}`, `drop_${id}.json`);
await rest("/signals", "signals.json", true);
const files = drop?.files ?? drop?.account?.files ?? [];
for (const f of files) {
  const fid = f.id ?? f;
  await rest(`/drops/${id}/files/${fid}`, `file_${fid}.json`);
}
console.log("DONE", files.length, "files");
