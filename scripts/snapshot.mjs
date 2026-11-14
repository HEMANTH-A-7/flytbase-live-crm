// scripts/snapshot.mjs: pulls every game record into data/seed/, one call per 62 s.
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
const TOKEN = process.env.AQ_TOKEN;
if (!TOKEN) { console.error("Set AQ_TOKEN"); process.exit(1); }
const BASE = "https://questathon.aihackerscollective.com/api/public";
const OUT = new URL("../data/seed/", import.meta.url);
await mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (f) => access(new URL(f, OUT)).then(() => true, () => false);
let first = true;
async function pace() { if (!first) await sleep(62_000); first = false; }

function parse(body) {
  const t = body.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const lines = t.split("\n").filter((l) => l.startsWith("data:"));
  return JSON.parse(lines.at(-1).slice(5));
}
async function tool(name, args, file) {
  if (await exists(file)) return console.log("skip", file);
  await pace();
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
  });
  const j = parse(await res.text());
  if (j.error || j.result?.isError) { console.error("ERR", file, res.status, JSON.stringify(j).slice(0, 300)); return; }
  const text = j.result.content[0].text;
  let data; try { data = JSON.parse(text); } catch { data = { text }; }
  await writeFile(new URL(file, OUT), JSON.stringify(data, null, 1));
  console.log(new Date().toISOString(), "ok", file);
}

if (!(await exists("export.json"))) {
  await pace();
  const r = await fetch(`${BASE}/v1/export`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`export ${r.status}`);
  await writeFile(new URL("export.json", OUT), JSON.stringify(await r.json(), null, 1));
  console.log("ok export.json");
}
const exp = JSON.parse(await readFile(new URL("export.json", OUT), "utf8"));
await tool("get_signals", {}, "signals.json");
await tool("get_all_paperwork", { account: "A" }, "paperwork_A.json");
await tool("get_all_paperwork", { account: "B" }, "paperwork_B.json");
await tool("list_notes", {}, "notes.json");
await tool("get_flytbase_team", {}, "team.json");
await tool("get_release_notes", {}, "release_notes.json");
await tool("get_feature_requests", {}, "feature_requests.json");
await tool("get_data_format", {}, "schema.json");
for (const f of exp.files) await tool("get_file", { id: f.id ?? f }, `file_${f.id ?? f}.json`);
console.log("DONE");
