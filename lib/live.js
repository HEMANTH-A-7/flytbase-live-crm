// Keeps the CRM live without a server that runs all day.
// Every request to /api/state may spend at most one MCP call, and only when the
// one-call-a-minute window is open. Priority:
//   1. learn what notes already exist (once per cold start, so we never resend)
//   2. write the next pending note (top moves, red risks)
//   3. fetch any account the game has newly released (whoami lists it in
//      new_accounts; get_new_account and get_new_account_file serve it)
//   4. otherwise rotate get_signals, whoami and get_my_accounts
// Any failure leaves the last good data in place.

import { callTool, gate, RateLimitedError } from "./mcp.js";
import { loadSeed, loadPlan, readOverlay, writeOverlay, emptyOverlay } from "./store.js";
import { buildModel, hash } from "./analyze.js";

let overlay = null;
let savedHash = null;
let sharedReadAt = 0;
const SHARED_REFRESH_MS = 60_000;

// Two server copies can each learn something different. Merging keeps both:
// events, accounts, files and paperwork are unions; for single values the
// newer read wins; notes already written are united so none is sent twice.
const later = (x, y) => (String(x ?? "") > String(y ?? "") ? x : y);
export function mergeOverlays(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newer = (a.lastCallAt ?? 0) >= (b.lastCallAt ?? 0) ? a : b;
  return {
    ...b, ...a,
    lastCallAt: Math.max(a.lastCallAt ?? 0, b.lastCallAt ?? 0),
    lastTool: newer.lastTool, lastError: newer.lastError,
    calls: Math.max(a.calls ?? 0, b.calls ?? 0),
    signals: mergeSignals(b.signals, a.signals),
    signalsAt: later(a.signalsAt, b.signalsAt),
    accounts: String(a.accountsAt ?? "") >= String(b.accountsAt ?? "") ? a.accounts ?? b.accounts : b.accounts ?? a.accounts,
    accountsAt: later(a.accountsAt, b.accountsAt),
    whoamiAt: later(a.whoamiAt, b.whoamiAt),
    newAccounts: [...new Set([...(a.newAccounts ?? []), ...(b.newAccounts ?? [])])],
    pack: String(a.whoamiAt ?? "") >= String(b.whoamiAt ?? "") ? a.pack ?? b.pack : b.pack ?? a.pack,
    drops: { ...(b.drops ?? {}), ...(a.drops ?? {}) },
    dropFiles: { ...(b.dropFiles ?? {}), ...(a.dropFiles ?? {}) },
    paperwork: { ...(b.paperwork ?? {}), ...(a.paperwork ?? {}) },
    notesSynced: Boolean(a.notesSynced || b.notesSynced),
    notesTitles: [...new Set([...(a.notesTitles ?? []), ...(b.notesTitles ?? [])])],
    writes: [...new Map([...(b.writes ?? []), ...(a.writes ?? [])].map((w) => [w.title, w])).values()],
  };
}

export function nextJob(ov, pendingNotes, knownFiles = new Set(), knownPaperwork = new Set()) {
  // Discovery first: a fresh server copy learns about released accounts on its
  // first call and fetches them on its second, then reads events.
  if (!ov.whoamiAt) return { tool: "whoami", args: {} };
  const drops = ov.drops ?? {};
  const missing = (ov.newAccounts ?? []).find((id) => !drops[id]);
  if (missing) return { tool: "get_new_account", args: { account: missing } };
  if (!ov.signalsAt) return { tool: "get_signals", args: {} };
  for (const [id, d] of Object.entries(drops)) {
    const file = (d.files ?? []).find((f) => !(ov.dropFiles ?? {})[f.id] && !knownFiles.has(f.id));
    if (file) return { tool: "get_new_account_file", args: { account: id, file_id: file.id } };
  }
  // Paperwork for any open account we do not hold yet, so calls, emails and
  // usage for a newly released account render without anyone asking.
  const needsPaperwork = (ov.pack ?? []).find((p) => p.open && !knownPaperwork.has(p.account) && !(ov.paperwork ?? {})[p.account]);
  if (needsPaperwork) return { tool: "get_all_paperwork", args: { account: needsPaperwork.account } };
  if (!ov.notesSynced) return { tool: "list_notes", args: {} };
  const todo = pendingNotes.filter((n) => !ov.notesTitles.includes(n.title));
  if (todo.length && ov.lastTool !== "write_note") {
    const n = todo[0];
    return { tool: "write_note", args: { text: n.text, account: n.account, kind: n.kind, title: n.title }, note: n };
  }
  const rotation = ["get_signals", "whoami", "get_signals", "get_my_accounts"];
  return { tool: rotation[ov.calls % rotation.length], args: {} };
}

export function applyResult(ov, job, out, now) {
  const at = new Date(now).toISOString();
  if (job.tool === "get_signals") { ov.signals = out; ov.signalsAt = at; }
  if (job.tool === "get_my_accounts") { ov.accounts = out; ov.accountsAt = at; }
  if (job.tool === "whoami") {
    ov.whoamiAt = at;
    ov.newAccounts = (out?.new_accounts ?? []).map((a) => String(a.id ?? a));
    ov.pack = (out?.pack ?? []).map((p) => ({ account: String(p.account), open: p.open !== false }));
  }
  if (job.tool === "get_new_account") ov.drops = { ...(ov.drops ?? {}), [job.args.account]: { ...out, fetched_at: at } };
  if (job.tool === "get_all_paperwork") ov.paperwork = { ...(ov.paperwork ?? {}), [job.args.account]: out };
  if (job.tool === "get_new_account_file") ov.dropFiles = { ...(ov.dropFiles ?? {}), [job.args.file_id]: out };
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
export function currentExport(seedExport, ov, seedDrops = {}) {
  const live = ov?.accounts;
  const liveAccounts = Array.isArray(live) ? live : live?.accounts;
  const base = !Array.isArray(liveAccounts) || !liveAccounts.length ? seedExport : {
    ...seedExport,
    accounts: liveAccounts,
    files: live.files ?? seedExport.files,
    minute: live.minute ?? seedExport.minute,
    exported_at: live.exported_at ?? ov.accountsAt ?? seedExport.exported_at,
  };
  // Released accounts come in the export shape; each keeps its own clock
  // (minute and exported_at), since its deadlines are counted in its minutes.
  const drops = { ...seedDrops, ...(ov?.drops ?? {}) };
  const accounts = [...base.accounts];
  const files = [...(base.files ?? [])];
  for (const d of Object.values(drops)) {
    for (const a of d.accounts ?? []) {
      const withClock = { ...a, _clock: { minute: d.minute ?? 0, at: d.exported_at ?? null } };
      const i = accounts.findIndex((x) => x.id === a.id);
      if (i >= 0) accounts[i] = withClock; else accounts.push(withClock);
    }
    for (const f of d.files ?? []) if (!files.some((x) => x.id === f.id)) files.push(f);
  }
  return { ...base, accounts, files };
}

// Live events only accumulate. Union the snapshot with the latest read, keyed
// by id, so an older or partial read never hides an event we already hold.
export function mergeSignals(...sources) {
  const byId = new Map();
  for (const src of sources) {
    const list = Array.isArray(src) ? src : src?.signals ?? src?.events ?? [];
    for (const s of list) byId.set(String(s.id ?? s.title ?? JSON.stringify(s)), s);
  }
  return { signals: [...byId.values()] };
}

export function modelFrom(ov, now = new Date()) {
  const seed = loadSeed();
  return buildModel({
    exp: currentExport(seed.export, ov, seed.drops),
    seedExport: seed.export,
    files: { ...seed.files, ...(ov?.dropFiles ?? {}) },
    signals: mergeSignals(seed.signals, ov?.signals),
    plan: loadPlan(),
    debrief: seed.debrief,
    playerCard: seed.playerCard,
    team: seed.team,
    paperwork: { ...(ov?.paperwork ?? {}), ...Object.fromEntries(Object.entries(seed.paperwork).filter(([, v]) => v)) },
    overlay: ov,
    now,
  });
}

const dataHash = (ov) => hash(JSON.stringify([ov.accounts, ov.signals, ov.notesTitles, ov.newAccounts, ov.drops, ov.dropFiles && Object.keys(ov.dropFiles), ov.paperwork && Object.keys(ov.paperwork)]));

export async function getState({ call = callTool, now = Date.now() } = {}) {
  // Start from the shared state, and pick up what other server copies
  // learned at most once a minute.
  if (!overlay || now - sharedReadAt > SHARED_REFRESH_MS) {
    overlay = mergeOverlays(overlay, await readOverlay());
    sharedReadAt = now;
    savedHash = dataHash(overlay);
  }
  let model = modelFrom(overlay, new Date(now));
  if (!process.env.AQ_TOKEN) return model;

  gate.seed(overlay.lastCallAt);
  if (gate.waitMs() > 0) return model;

  const seed = loadSeed();
  const job = nextJob(overlay, model.pending_notes, new Set(Object.keys(seed.files)), new Set(Object.entries(seed.paperwork).filter(([, v]) => v).map(([k]) => k)));
  try {
    // Short timeout: the page waits on this call, and a slow MCP must not hold it.
    const out = await call(job.tool, job.args, { timeoutMs: 8_000 });
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
    // Merge with whatever another copy saved since we read, then save.
    overlay = mergeOverlays(overlay, await readOverlay());
    await writeOverlay(overlay);
    savedHash = dataHash(overlay);
    sharedReadAt = now;
  }
  return modelFrom(overlay, new Date(now));
}

// Test hook.
export function _reset(ov = null) { overlay = ov ?? emptyOverlay(); savedHash = dataHash(overlay); sharedReadAt = Date.now(); }
