import { test } from "node:test";
import assert from "node:assert/strict";
import { nextJob, applyResult, currentExport, getState, _reset } from "../lib/live.js";
import { emptyOverlay, loadSeed } from "../lib/store.js";
import { gate } from "../lib/mcp.js";
import os from "node:os";
import path from "node:path";

process.env.CRM_OVERLAY_FILE = path.join(os.tmpdir(), `crm-test-${process.pid}.json`);

const note = (t) => ({ title: t, text: "x", account: "A", kind: "next_step" });

test("call priority: whoami, new accounts, events, files, then notes, then poll", () => {
  const ov = emptyOverlay();
  assert.equal(nextJob(ov, []).tool, "whoami", "discovery comes first on a fresh server copy");
  applyResult(ov, { tool: "whoami" }, { new_accounts: [{ id: "K", name: "Kestrel Estates" }] }, 0);
  const fetch = nextJob(ov, []);
  assert.deepEqual([fetch.tool, fetch.args.account], ["get_new_account", "K"], "a released account is fetched on the second call");
  applyResult(ov, fetch, { accounts: [{ id: "K" }], files: [{ id: "K_f1" }] }, 0);
  assert.equal(nextJob(ov, []).tool, "get_signals");
  ov.signalsAt = "t";
  const file = nextJob(ov, []);
  assert.deepEqual([file.tool, file.args.file_id], ["get_new_account_file", "K_f1"]);
  applyResult(ov, file, { id: "K_f1", text: "note" }, 0);
  assert.equal(nextJob(ov, [note("n1")]).tool, "list_notes");
  ov.notesSynced = true;
  assert.equal(nextJob(ov, [note("n1")]).tool, "write_note");
  ov.lastTool = "write_note";
  assert.notEqual(nextJob(ov, [note("n1")]).tool, "write_note", "a write is followed by a read, so new events still arrive");
});

test("notes already on the server are never written again", () => {
  const ov = { ...emptyOverlay(), signalsAt: "t", whoamiAt: "t", notesSynced: false };
  applyResult(ov, { tool: "list_notes" }, { notes: [{ title: "n1" }] }, 0);
  assert.notEqual(nextJob(ov, [note("n1")]).tool, "write_note");
  const job = nextJob(ov, [note("n1"), note("n2")]);
  assert.equal(job.args.title, "n2");
  applyResult(ov, job, { ok: true }, 0);
  assert.deepEqual(ov.notesTitles, ["n1", "n2"]);
});

test("fresh accounts from get_my_accounts replace the seed's, wrapped or bare", () => {
  const seed = loadSeed().export;
  const changed = structuredClone(seed.accounts);
  changed[0].name = "Renamed";
  assert.equal(currentExport(seed, { accounts: { accounts: changed } }).accounts[0].name, "Renamed");
  assert.equal(currentExport(seed, { accounts: changed }).accounts[0].name, "Renamed");
  assert.deepEqual(currentExport(seed, { accounts: { nothing: 1 } }).accounts, seed.accounts);
  const withDrop = currentExport(seed, { drops: { K: { minute: 0, exported_at: "x", accounts: [{ id: "K", name: "Kestrel Estates" }], files: [{ id: "K_f1" }] } } });
  assert.deepEqual(withDrop.accounts.map((a) => a.id), ["A", "B", "K"], "a released account joins the others");
  assert.ok(withDrop.files.some((f) => f.id === "K_f1"));
});

test("a new signal from the MCP shows up in the next state, and failures keep the last good data", async () => {
  process.env.AQ_TOKEN = "test-token";
  _reset();
  gate.seed(0);
  const sig = { signals: [{ id: "s1", account: "B", date: "30 Nov", text: "Three docks that flew most nights stopped for two weeks." }] };
  // get_signals is the first job on a fresh overlay
  // The fake MCP answers by tool: whoami first (nothing new), then the events.
  const fake = async (tool) => (tool === "whoami" ? { new_accounts: [], pack: [] } : sig);
  await getState({ call: fake, now: Date.now() });
  gate.seed(0);
  let m = await getState({ call: fake, now: Date.now() + 61_000 });
  assert.ok(m.accounts.find((a) => a.id === "B").signals.some((s) => s.id === "s1"));
  // force the window open again and make the next call fail
  m.live && gate.seed(0);
  const failing = async () => { throw new Error("boom"); };
  m = await getState({ call: failing, now: Date.now() + 120_000 });
  assert.ok(m.accounts.find((a) => a.id === "B").signals.some((s) => s.id === "s1"), "still shown after a failed call");
  delete process.env.AQ_TOKEN;
});

test("live events accumulate: a stale empty read never hides events already held", async () => {
  const { mergeSignals } = await import("../lib/live.js");
  const seedSig = { signals: [{ id: "a", text: "one" }] };
  assert.deepEqual(mergeSignals(seedSig, { signals: [] }).signals.map((s) => s.id), ["a"]);
  assert.deepEqual(mergeSignals(seedSig, { signals: [{ id: "a", text: "one, updated" }, { id: "b", text: "two" }] }).signals.map((s) => `${s.id}:${s.text}`), ["a:one, updated", "b:two"]);
});

test("paperwork for any open account we do not hold is fetched without being asked", () => {
  const ov = { ...emptyOverlay(), signalsAt: "t" };
  applyResult(ov, { tool: "whoami" }, { new_accounts: [], pack: [{ account: "A", open: true }, { account: "K", open: true }] }, 0);
  const job = nextJob(ov, [], new Set(), new Set(["A"]));
  assert.deepEqual([job.tool, job.args.account], ["get_all_paperwork", "K"]);
  applyResult(ov, job, { account: "K", records: [{ path: "usage_weekly.csv", kind: "usage", text: "week_start,dock_id,flights,days_online\n2026-11-02,K-1,0,7" }] }, 0);
  assert.notEqual(nextJob(ov, [], new Set(), new Set(["A"])).tool, "get_all_paperwork");
});

test("two server copies merge what they learned instead of overwriting each other", async () => {
  const { mergeOverlays } = await import("../lib/live.js");
  const a = { ...emptyOverlay(), lastCallAt: 2, signals: { signals: [{ id: "s1" }] }, drops: { K: { accounts: [] } }, notesTitles: ["n1"], writes: [{ title: "n1" }] };
  const b = { ...emptyOverlay(), lastCallAt: 1, signals: { signals: [{ id: "s2" }] }, dropFiles: { f1: { text: "x" } }, notesTitles: ["n2"], writes: [{ title: "n2" }], notesSynced: true };
  const m = mergeOverlays(a, b);
  assert.deepEqual(m.signals.signals.map((s) => s.id).sort(), ["s1", "s2"]);
  assert.ok(m.drops.K && m.dropFiles.f1);
  assert.deepEqual(m.notesTitles.sort(), ["n1", "n2"]);
  assert.equal(m.writes.length, 2);
  assert.ok(m.notesSynced);
  assert.equal(m.lastCallAt, 2);
});
