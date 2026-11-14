import { test } from "node:test";
import assert from "node:assert/strict";
import { nextJob, applyResult, currentExport, getState, _reset } from "../lib/live.js";
import { emptyOverlay, loadSeed } from "../lib/store.js";
import { gate } from "../lib/mcp.js";
import os from "node:os";
import path from "node:path";

process.env.CRM_OVERLAY_FILE = path.join(os.tmpdir(), `crm-test-${process.pid}.json`);

const note = (t) => ({ title: t, text: "x", account: "A", kind: "next_step" });

test("call priority: signals first, then learn existing notes, then write, then poll", () => {
  const ov = emptyOverlay();
  assert.equal(nextJob(ov, []).tool, "get_signals");
  ov.signalsAt = "t";
  assert.equal(nextJob(ov, [note("n1")]).tool, "list_notes");
  ov.notesSynced = true;
  assert.equal(nextJob(ov, [note("n1")]).tool, "write_note");
  ov.lastTool = "write_note";
  assert.notEqual(nextJob(ov, [note("n1")]).tool, "write_note", "a write is followed by a read, so new events still arrive");
});

test("notes already on the server are never written again", () => {
  const ov = { ...emptyOverlay(), signalsAt: "t", notesSynced: false };
  applyResult(ov, { tool: "list_notes" }, { notes: [{ title: "n1" }] }, 0);
  assert.equal(nextJob(ov, [note("n1")]).tool, "get_signals");
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
  assert.equal(currentExport(seed, { accounts: { nothing: 1 } }), seed);
});

test("a new signal from the MCP shows up in the next state, and failures keep the last good data", async () => {
  process.env.AQ_TOKEN = "test-token";
  _reset();
  gate.seed(0);
  const sig = { signals: [{ id: "s1", account: "B", date: "30 Nov", text: "Three docks that flew most nights stopped for two weeks." }] };
  // get_signals is the first job on a fresh overlay
  let m = await getState({ call: async () => sig, now: Date.now() });
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
