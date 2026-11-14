// Seed snapshot (committed under data/seed) plus a small live overlay.
// The overlay holds whatever the MCP told us after the seed was taken:
// fresh accounts, signals, notes already written, and when we last called.
// It is kept in memory by lib/live.js and mirrored to a JSON file (.cache/
// locally, the OS temp dir on Vercel) so a warm instance survives a module
// reload. A cold instance rebuilds it within a call or two: get_signals first,
// then list_notes so nothing is written twice.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_DIR = path.join(ROOT, "data", "seed");
const overlayPath = () => process.env.CRM_OVERLAY_FILE
  ?? (process.env.VERCEL ? path.join(os.tmpdir(), "crm-overlay.json") : path.join(ROOT, ".cache", "overlay.json"));

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const maybe = (name) => (existsSync(path.join(SEED_DIR, name)) ? readJson(path.join(SEED_DIR, name)) : null);

let seedCache;
export function loadSeed() {
  if (seedCache) return seedCache;
  const files = {};
  for (const f of readdirSync(SEED_DIR)) {
    const m = f.match(/^file_(.+)\.json$/);
    if (m) files[m[1]] = readJson(path.join(SEED_DIR, f));
  }
  seedCache = {
    export: readJson(path.join(SEED_DIR, "export.json")),
    signals: maybe("signals.json"),
    paperwork: { A: maybe("paperwork_A.json"), B: maybe("paperwork_B.json") },
    notes: maybe("notes.json"),
    team: maybe("team.json"),
    debrief: maybe("morning_debrief.json"),
    playerCard: maybe("player_card.json"),
    files,
  };
  return seedCache;
}

export function loadPlan() {
  return readJson(path.join(ROOT, "data", "plan.json"));
}

export const emptyOverlay = () => ({
  v: 1,
  lastCallAt: 0,
  lastTool: null,
  lastError: null,
  calls: 0,
  accounts: null, // latest get_my_accounts result
  accountsAt: null,
  signals: null, // latest get_signals result
  signalsAt: null,
  notesSynced: false, // have we read list_notes once?
  notesTitles: [], // titles already on the server (ours or earlier)
  writes: [], // { title, at }
});

export async function readOverlay() {
  try {
    if (existsSync(overlayPath())) return { ...emptyOverlay(), ...readJson(overlayPath()) };
  } catch (err) {
    console.error("overlay read failed:", err.message);
  }
  return emptyOverlay();
}

export async function writeOverlay(overlay) {
  try {
    mkdirSync(path.dirname(overlayPath()), { recursive: true });
    writeFileSync(overlayPath(), JSON.stringify(overlay));
  } catch (err) {
    console.error("overlay write failed:", err.message);
  }
}
