// Seed snapshot (committed under data/seed) plus a small live overlay.
// The overlay holds whatever the MCP told us after the seed was taken:
// fresh accounts, signals, notes already written, and when we last called.
// It is shared between server copies through a private Vercel Blob (see
// readOverlay), and kept in a local JSON file when running on a laptop.

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
  // Accounts the game released after the morning (drop_<id>.json).
  const drops = {};
  for (const f of readdirSync(SEED_DIR)) {
    const m = f.match(/^drop_(.+)\.json$/);
    if (m) drops[m[1]] = readJson(path.join(SEED_DIR, f));
  }
  seedCache = {
    drops,
    export: readJson(path.join(SEED_DIR, "export.json")),
    signals: maybe("signals.json"),
    paperwork: Object.fromEntries(readdirSync(SEED_DIR).map((f) => f.match(/^paperwork_(.+)\.json$/)).filter(Boolean).map((m) => [m[1], readJson(path.join(SEED_DIR, m[0]))])),
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

// Shared state: a private Vercel Blob when the project has one, so every
// server copy starts from the latest live state. Locally, a JSON file.
const BLOB_KEY = "crm/overlay.json";
const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

export async function readOverlay() {
  try {
    if (useBlob()) {
      const { get } = await import("@vercel/blob");
      const r = await get(BLOB_KEY, { access: "private", useCache: false });
      if (!r?.stream) return emptyOverlay();
      return { ...emptyOverlay(), ...JSON.parse(await new Response(r.stream).text()) };
    }
    if (existsSync(overlayPath())) return { ...emptyOverlay(), ...readJson(overlayPath()) };
  } catch (err) {
    if (!/not.?found/i.test(String(err?.name) + String(err?.message))) console.error("overlay read failed:", err.message);
  }
  return emptyOverlay();
}

export async function writeOverlay(overlay) {
  const body = JSON.stringify(overlay);
  try {
    if (useBlob()) {
      const { put } = await import("@vercel/blob");
      await put(BLOB_KEY, body, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
      return;
    }
    mkdirSync(path.dirname(overlayPath()), { recursive: true });
    writeFileSync(overlayPath(), body);
  } catch (err) {
    console.error("overlay write failed:", err.message);
  }
}
