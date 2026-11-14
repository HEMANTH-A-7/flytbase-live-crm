// Keeps the CRM live without a server that runs all day.
// Every request to /api/state may spend at most one MCP call, and only when the
// one-call-a-minute window is open. Priority:
//   1. learn what notes already exist (once per cold start, so we never resend)
//   2. write the next pending note (top moves, red risks)
//   3. otherwise poll get_signals, with a get_my_accounts every third call
// Any failure leaves the last good data in place.

import { callTool, gate, RateLimitedError } from "./mcp.js";
import { loadSeed, loadPlan, readOverlay, writeOverlay, emptyOverlay } from "./store.js";
import { buildModel, hash } from "./analyze.js";

let overlay = null;
let savedHash = null;

export function nextJob(ov, pendingNotes) {
  if (!ov.signalsAt) return { tool: "get_signals", args: {} };
  if (!ov.notesSynced) return { tool: "list_notes", args: {} };
  const todo = pendingNotes.filter((n) => !ov.notesTitles.includes(n.title));
  if (todo.length && ov.lastTool !== "write_note") {
    const n = todo[0];
    return { tool: "write_note", args: { text: n.text, account: n.account, kind: n.kind, title: n.title }, note: n };
  }
  return ov.calls % 3 === 2 ? { tool: "get_my_accounts", args: {} } : { tool: "get_signals", args: {} };
}

export function applyResult(ov, job, out, now) {
  const at = new Date(now).toISOString();
  if (job.tool === "get_signals") { ov.signals = out; ov.signalsAt = at; }
  if (job.tool === "get_my_accounts") { ov.accounts = out; ov.accountsAt = at; }
  if (job.tool === "list_notes") {
    const list = Array.isArray(out) ? out : out?.notes ?? [];
    ov.notesTitles = [...new Set([...ov.notesTitles, ...list.map((n) => n.title).filter(Boolean)])];
    ov.notesSynced = true;
  }
  if (job.tool === "write_note") {
    ov.notesTitles.push(job.note.title);
    ov.writes.push({ title: job.note.title, kind: job.note.kind, account: job.note.account, at });
  }
}

// get_my_accounts may return the accounts bare or wrapped; either way the
// newest accounts replace the seed's, and everything else stays.
export function currentExport(seedExport, ov) {
  const live = ov?.accounts;
  const accounts = Array.isArray(live) ? live : live?.accounts;
  if (!Array.isArray(accounts) || !accounts.length) return seedExport;
  return {
    ...seedExport,
    accounts,
    files: live.files ?? seedExport.files,
    minute: live.minute ?? seedExport.minute,
    exported_at: ov.accountsAt ?? seedExport.exported_at,
  };
}

export function modelFrom(ov, now = new Date()) {
  const seed = loadSeed();
  return buildModel({
    exp: currentExport(seed.export, ov),
    files: seed.files,
    signals: ov?.signals ?? seed.signals,
    plan: loadPlan(),
    debrief: seed.debrief,
    team: seed.team,
    paperwork: seed.paperwork,
    overlay: ov,
    now,
  });
}

const dataHash = (ov) => hash(JSON.stringify([ov.accounts, ov.signals, ov.notesTitles]));

export async function getState({ call = callTool, now = Date.now() } = {}) {
  if (!overlay) {
    overlay = await readOverlay();
    savedHash = dataHash(overlay);
  }
  let model = modelFrom(overlay, new Date(now));
  if (!process.env.AQ_TOKEN) return model;

  gate.seed(overlay.lastCallAt);
  if (gate.waitMs() > 0) return model;

  const job = nextJob(overlay, model.pending_notes);
  try {
    const out = await call(job.tool, job.args);
    applyResult(overlay, job, out, now);
    overlay.lastError = null;
  } catch (err) {
    overlay.lastError = { tool: job.tool, message: err instanceof RateLimitedError ? "rate limited, will retry" : String(err.message).slice(0, 200), at: new Date(now).toISOString() };
  }
  overlay.lastCallAt = gate.lastCallAt;
  overlay.lastTool = job.tool;
  overlay.calls += 1;

  const h = dataHash(overlay);
  if (h !== savedHash) {
    await writeOverlay(overlay);
    savedHash = h;
  }
  return modelFrom(overlay, new Date(now));
}

// Test hook.
export function _reset(ov = null) { overlay = ov ?? emptyOverlay(); savedHash = dataHash(overlay); }
