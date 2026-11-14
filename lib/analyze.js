// Pure functions: raw game data in, five answers per account out.
// Every number and claim carries `cites`, a list of source ids that exist in
// the data. Analyst judgement lives in data/plan.json; this file applies it
// and fills in everything that can be derived mechanically, including new
// live events the plan has never seen.

const DAY = 86_400_000;
const POWER_ROLES = ["decides", "pays", "uses", "blocks", "champion"];
const COLD = new Set(["guarded", "neutral"]);

// ---------- source index ----------

export function indexSources({ exp, files = {}, signals = [], debrief, team, paperwork = {} }) {
  const src = {};
  const add = (id, rec) => { if (id && !src[id]) src[id] = { id, ...rec }; };
  // Paperwork records have no id of their own; the game addresses them by
  // account and path, so that pair is the id we cite.
  for (const [acct, pw] of Object.entries(paperwork)) {
    for (const r of pw?.records ?? []) {
      const body = r.text ?? JSON.stringify(r.data, null, 1);
      add(`${acct}/${r.path}`, { kind: "record", account: acct, record_kind: r.kind, title: r.path, text: body.length > 6000 ? `${body.slice(0, 6000)}\n… (${body.length - 6000} more characters in the record)` : body });
    }
  }
  for (const a of exp.accounts) {
    for (const p of a.stakeholders) add(p.id, { kind: "person", account: a.id, title: p.name, role: p.role, relationship: p.relationship, available: p.available });
    for (const f of a.facts) add(f.id, { kind: "fact", account: a.id, text: f.text, said_by: f.said_by, status: f.status, verified_by: f.verified_by ?? null, learned_at_minute: f.learned_at_minute });
    for (const o of a.opportunities) add(o.id, { kind: "deal", account: a.id, title: o.title, stage: o.stage, worth_up_to: o.worth_up_to });
    for (const o of a.offers) add(o.id, { kind: "offer", account: a.id, title: o.title, value: o.value, status: o.status, pitch_to: o.pitch_to });
  }
  for (const f of exp.files) add(f.id, { kind: "file", account: f.account, title: f.title, path: f.path, content: files[f.id] ?? null });
  for (const s of signals) add(s.id, { kind: "signal", account: s.account, title: s.title, text: s.text, date: s.date });
  const members = Array.isArray(team) ? team : team?.members ?? team?.team ?? team?.people ?? [];
  for (const m of members) add(m.id, { kind: "team", title: m.name, role: m.role ?? m.title ?? null });
  if (debrief) {
    add("morning_debrief", {
      kind: "debrief",
      title: "Morning debrief",
      text: [debrief.source, ...debrief.deals.map((d) => `${d.title} (${d.account}, ${d.stage}): ${d.outcome}${d.would_have_moved ? ` What would have moved it: ${d.would_have_moved}` : ""}`)].join("\n\n"),
    });
  }
  return src;
}

// ---------- signals ----------

// Signals have no published shape yet, so read the common field names and
// give every one a stable id.
export function normaliseSignals(raw) {
  const list = Array.isArray(raw) ? raw : raw?.signals ?? raw?.events ?? [];
  return list.map((s, i) => {
    const text = String(s.text ?? s.body ?? s.message ?? s.summary ?? s.description ?? s.title ?? "");
    const id = String(s.id ?? s.signal_id ?? `signal_${i + 1}_${hash(text).slice(0, 6)}`);
    const date = s.date ?? s.at ?? s.when ?? s.in_world_date ?? s.created_at ?? null;
    const account = s.account ?? s.account_id ?? null;
    return { id, account, title: s.title ?? s.headline ?? null, text, date, minute: s.minute ?? s.game_minute ?? null, raw: s };
  });
}

const SIGNAL_KINDS = [
  { kind: "succession", re: /\b(leav|leaves|leaving|left|successor|handover|resign|retir|moves on)/i, label: "Key person leaving" },
  { kind: "usage_drop", re: /\b(stopp|stopped|idle|not flown|no flights|dropped|stalled|quiet)/i, label: "Usage dropped" },
  { kind: "deadline", re: /\b(deadline|by \d|this week|before|event on|due|in writing)/i, label: "Deadline set by the customer" },
  { kind: "complaint", re: /\b(ticket|complain|unhappy|escalat|nobody (has )?repl)/i, label: "Unanswered request" },
];

export function classifySignal(sig, people) {
  const kinds = SIGNAL_KINDS.filter((k) => k.re.test(sig.text)).map((k) => k.kind);
  const named = people.filter((p) => mentions(sig.text, p.title));
  return { kinds: kinds.length ? kinds : ["other"], people: named.map((p) => p.id) };
}

function mentions(text, name) {
  const parts = String(name).replace(/^(Insp\.|Dr\.|Mr\.|Ms\.)\s*/, "").split(/\s+/);
  const last = parts.at(-1);
  return new RegExp(`\\b${escapeRe(last)}\\b`, "i").test(text);
}

// ---------- dates ----------

export function parseDate(d, year) {
  if (!d) return null;
  // Date.parse("30 Nov") guesses a year (2001 in V8), so only trust it when
  // the string carries a four-digit year.
  if (/\b\d{4}\b/.test(String(d))) {
    const t = Date.parse(d);
    if (!Number.isNaN(t)) return new Date(t);
  }
  const m = String(d).match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i);
  if (m) return new Date(Date.UTC(year, "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(m[2].toLowerCase()) / 3, Number(m[1])));
  return null;
}

export function nextWorkingDay(date, plusDays = 1) {
  const d = new Date(date.getTime() + plusDays * DAY);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setTime(d.getTime() + DAY);
  return d;
}

export const isoDay = (d) => d.toISOString().slice(0, 10);

// ---------- usage, from the weekly log ----------

// What the docks actually did over the last four logged weeks. This is the
// check on "13 of 15 flying" style claims.
export function usageFrom(csv, cite) {
  if (!csv) return null;
  const rows = csv.trim().split("\n").slice(1).map((l) => {
    const [week, dock, flights, online] = l.split(",");
    return { week, dock, flights: Number(flights), online: Number(online) };
  });
  const weeks = [...new Set(rows.map((r) => r.week))].sort();
  const last = new Set(weeks.slice(-4));
  const per = new Map();
  for (const r of rows) {
    if (!last.has(r.week)) continue;
    const d = per.get(r.dock) ?? { flights: 0, online: 0 };
    d.flights += r.flights;
    d.online += r.online;
    per.set(r.dock, d);
  }
  const docks = [...per.entries()];
  const idle = docks.filter(([, d]) => d.flights === 0 && d.online > 0).map(([id]) => id);
  const regular = docks.filter(([, d]) => d.flights >= 12).map(([id]) => id);
  const flights = docks.reduce((n, [, d]) => n + d.flights, 0);
  return {
    from: weeks.at(-4) ?? weeks[0], to: weeks.at(-1),
    docks: docks.length, idle: idle.length, idle_ids: idle,
    regular: regular.length, flights,
    top_share: share(docks.map(([, d]) => d.flights), 5),
    cites: [cite],
  };
}

// Share of flights flown by the busiest n docks.
function share(xs, n) {
  const total = xs.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  return [...xs].sort((a, b) => b - a).slice(0, n).reduce((a, b) => a + b, 0) / total;
}

// ---------- book ----------

export function backingOf(evidence, src) {
  const tally = { verified: [], told: [], claim: [], file: [], missing: [] };
  for (const id of evidence ?? []) {
    const s = src[id];
    if (!s) tally.missing.push(id);
    else if (s.kind === "file") tally.file.push(id);
    else if (s.kind === "fact") (tally[s.status] ?? tally.told).push(id);
  }
  const level = tally.verified.length || tally.file.length ? "verified" : tally.told.length ? "told" : tally.claim.length ? "claim" : "none";
  return { level, ...tally };
}

export function bookFor(account, src, valueBasis = {}) {
  const deals = account.opportunities.map((o) => {
    const backing = backingOf(o.evidence, src);
    const value = o.worth_up_to;
    const basis = valueBasis[o.id] ?? null;
    let bucket;
    if (o.stage === "agreed") bucket = "closed";
    else if (value == null) bucket = "unvalued";
    else bucket = backing.level === "verified" ? "backed" : backing.level === "told" ? "told" : "claim";
    return {
      id: o.id, title: o.title, stage: o.stage, value, bucket,
      blocker: o.blocker, deadline: o.deadline, backing,
      basis,
      cites: [o.id, ...(o.evidence ?? []).filter((e) => src[e])],
    };
  });
  const offers = account.offers.map((o) => ({
    id: o.id, title: o.title, value: o.value, status: o.status, pitch_to: o.pitch_to,
    bucket: o.status === "won" ? "closed" : o.status === "declined" ? "lost" : "open",
    cites: [o.id],
  }));
  const sum = (xs) => xs.reduce((n, x) => n + (x.value ?? 0), 0);
  const ids = (xs) => xs.map((x) => x.id);
  const pick = (b) => [...deals, ...offers].filter((x) => x.bucket === b);
  const segments = ["closed", "backed", "told", "claim"].map((b) => ({ bucket: b, value: sum(pick(b)), cites: ids(pick(b)) }));
  // Money a person asserted that no file supports: shown apart, never added.
  const claimed = account.facts
    .filter((f) => f.status === "claim" && /\d/.test(f.text))
    .map((f) => ({ id: f.id, text: f.text, said_by: f.said_by, cites: [f.id] }));
  return {
    deals, offers, segments,
    total: { value: sum(segments), cites: segments.flatMap((s) => s.cites) },
    unvalued: pick("unvalued").map((d) => ({ id: d.id, title: d.title, basis: d.basis, cites: [d.id] })),
    lost: pick("lost").map((o) => ({ id: o.id, title: o.title, value: o.value, cites: [o.id] })),
    claimed,
  };
}

// ---------- power ----------

export function powerFor(account, plan, src) {
  const roles = plan?.power ?? {};
  return account.opportunities.map((o) => {
    const r = roles[o.id] ?? {};
    const out = { deal: o.id, title: o.title, stage: o.stage };
    for (const role of POWER_ROLES) {
      out[role] = (r[role] ?? []).map((e) => {
        const p = e.person ? src[e.person] : null;
        return {
          person: e.person ?? null,
          name: p?.title ?? e.name,
          role: p?.role ?? e.role ?? null,
          stance: p?.relationship ?? "not met",
          note: e.note ?? null,
          cites: e.cites ?? [],
        };
      });
    }
    out.waiting_on = r.waiting_on ?? null;
    return out;
  });
}

// ---------- risks ----------

export function risksFor(account, plan, src, signals, today) {
  const risks = [];
  const add = (r) => risks.push({ severity: "amber", ...r });
  for (const o of account.opportunities) {
    if (o.deadline && !o.deadline.passed) {
      add({ key: `deadline:${o.id}`, type: "deadline", severity: o.deadline.soon ? "red" : "amber", title: o.deadline.text, deal: o.id, cites: [o.id] });
    }
    if (o.blocker?.status === "open") {
      add({ key: `stuck:${o.id}`, type: "stuck", title: `${o.title} is stuck: ${o.blocker.text}`, deal: o.id, cites: [o.id, ...(o.evidence ?? []).filter((e) => src[e])] });
    }
  }
  // Cold people who hold a paying, deciding or blocking role.
  const power = plan?.power ?? {};
  for (const p of account.stakeholders) {
    if (!COLD.has(p.relationship) && p.available !== false) continue;
    const holds = [];
    for (const [deal, roles] of Object.entries(power)) {
      for (const role of ["decides", "pays", "blocks"]) {
        if ((roles[role] ?? []).some((e) => e.person === p.id)) holds.push(`${role} on ${deal}`);
      }
    }
    if (!holds.length) continue;
    add({ key: `cold:${p.id}`, type: "cold", title: `${p.name} is ${p.available === false ? "unavailable" : p.relationship} and ${holds.join(", ")}`, person: p.id, cites: [p.id] });
  }
  for (const s of signals) {
    add({
      key: `signal:${s.id}`, type: "signal", severity: "red",
      title: s.text, date: s.date, cites: [s.id, ...s.people],
      turns_bad: s.date ? `Dated ${s.date} in the event itself` : null,
      live: true,
    });
  }
  // Plan overlays analyst judgement onto computed risks, and may add its own.
  const overlay = plan?.risks ?? [];
  for (const r of overlay) {
    const hit = risks.find((x) => x.key === r.key);
    if (hit) Object.assign(hit, { ...r, cites: unique([...hit.cites, ...(r.cites ?? [])]) });
    else add(r);
  }
  const order = { red: 0, amber: 1, green: 2 };
  return risks.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------- moves ----------

export function movesFor(account, plan, src, signals, today, powerRows) {
  const planned = (plan?.moves ?? []).map((m) => ({ ...m, source: "plan" }));
  const handled = new Set((plan?.handled_signals ?? []).map(String));
  const intake = [];
  for (const s of signals) {
    if (handled.has(s.id)) continue;
    // Default move for an event the plan has never seen: the named person gets
    // a reply on the next working day, from the account owner.
    const who = s.people.map((id) => src[id]?.title).filter(Boolean);
    const deals = powerRows.filter((row) => POWER_ROLES.some((r) => row[r].some((e) => s.people.includes(e.person)))).map((r) => r.deal);
    const when = parseDate(s.date, today.getUTCFullYear());
    const due = when && when > today ? new Date(Math.min(nextWorkingDay(today).getTime(), when.getTime())) : nextWorkingDay(today);
    intake.push({
      key: `signal:${s.id}`, source: "signal",
      action: who.length
        ? `Reply to ${who.join(" and ")} on this new event before anything else: ${trim(s.text, 140)}`
        : `Triage this new event and name an owner: ${trim(s.text, 140)}`,
      owner: plan?.account_owner ?? "Account owner",
      due: isoDay(due),
      deals,
      why: `New live event${s.date ? ` dated ${s.date}` : ""}. Not yet in the plan, so it goes first until someone reviews it.`,
      cites: [s.id, ...s.people, ...deals],
    });
  }
  const all = [...intake, ...planned].map((m, i) => ({ ...m, rank: i + 1 }));
  return all;
}

// ---------- gaps ----------

export function gapsFor(account, plan, src) {
  const gaps = [];
  const fill = plan?.gap_owners ?? {};
  for (const f of account.facts.filter((x) => x.status === "claim")) {
    gaps.push({ key: `claim:${f.id}`, type: "claim", title: `Unconfirmed: "${f.text}"`, why: `Only ${f.said_by}'s word; no file backs it.`, who: fill[f.id]?.who ?? null, how: fill[f.id]?.how ?? null, cites: [f.id, ...(fill[f.id]?.cites ?? [])] });
  }
  for (const o of account.opportunities.filter((x) => x.worth_up_to == null)) {
    gaps.push({ key: `value:${o.id}`, type: "unvalued", title: `No value yet for "${o.title}"`, why: "Still at identified: who decides, who pays and the blocker are not known well enough to size it.", who: fill[o.id]?.who ?? null, how: fill[o.id]?.how ?? null, cites: [o.id, ...(fill[o.id]?.cites ?? [])] });
  }
  for (const g of plan?.gaps ?? []) gaps.push({ type: "plan", ...g });
  return gaps;
}

// ---------- write-back ----------

export function notesToWrite(model) {
  const out = [];
  for (const a of model.accounts) {
    for (const m of a.moves.slice(0, 3)) {
      out.push({
        account: a.id, kind: "next_step",
        title: `CRM ${a.id} move: ${m.key}`,
        text: `#${m.rank} ${m.action} Owner: ${m.owner}. Due ${m.due}. Moves: ${(m.deals ?? []).join(", ") || "account"}. Sources: ${m.cites.join(", ")}.`,
      });
    }
    for (const r of a.risks.filter((x) => x.severity === "red")) {
      out.push({
        account: a.id, kind: "risk",
        title: `CRM ${a.id} risk: ${r.key}`,
        text: `${r.title}${r.turns_bad ? ` Turns bad: ${r.turns_bad}.` : ""} Sources: ${r.cites.join(", ")}.`,
      });
    }
  }
  return out;
}

// ---------- the whole model ----------

export function buildModel({ exp, files, signals: rawSignals, plan, debrief, team, paperwork = {}, overlay = null, now = new Date() }) {
  const signals = normaliseSignals(rawSignals);
  const src = indexSources({ exp, files, signals, debrief, team, paperwork });
  const people = Object.values(src).filter((s) => s.kind === "person");
  for (const s of signals) {
    const c = classifySignal(s, people.filter((p) => !s.account || p.account === s.account));
    s.kinds = c.kinds;
    s.people = c.people;
    if (!s.account && c.people.length) s.account = src[c.people[0]].account;
  }
  const today = plan?.today ? new Date(`${plan.today}T00:00:00Z`) : now;
  const accounts = exp.accounts.map((a) => {
    const p = plan?.accounts?.[a.id] ?? {};
    const sigs = signals.filter((s) => s.account === a.id);
    const power = powerFor(a, p, src);
    return {
      id: a.id,
      name: a.name,
      official_story: a.official_story,
      headline: p.headline ?? null,
      headline_cites: p.headline_cites ?? [],
      currency: paperwork[a.id]?.records?.find((r) => r.path === "profile.json")?.data?.currency ?? null,
      usage: usageFrom(paperwork[a.id]?.records?.find((r) => r.path === "usage_weekly.csv")?.text, `${a.id}/usage_weekly.csv`),
      book: bookFor(a, src, p.value_basis),
      power,
      moves: movesFor(a, { ...p, account_owner: plan?.account_owner }, src, sigs, today, power),
      risks: risksFor(a, p, src, sigs, today),
      gaps: gapsFor(a, p, src),
      signals: sigs,
    };
  });
  const model = {
    as_of: exp.exported_at,
    minute: exp.minute,
    today: isoDay(today),
    world_closed: exp.world_closed,
    accounts,
    unassigned_signals: signals.filter((s) => !s.account),
    sources: src,
    live: overlay ? {
      last_call_at: overlay.lastCallAt ? new Date(overlay.lastCallAt).toISOString() : null,
      last_tool: overlay.lastTool,
      last_error: overlay.lastError,
      accounts_at: overlay.accountsAt,
      signals_at: overlay.signalsAt,
      notes_written: overlay.writes,
    } : null,
  };
  model.pending_notes = notesToWrite(model);
  return model;
}

// ---------- id validation ----------

// Every id the model cites must exist in the source index. Used by tests and
// served with the state so a broken cite is visible, never silent.
export function invalidCites(model) {
  const bad = [];
  const walk = (node, where) => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${where}[${i}]`));
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "cites" && Array.isArray(v)) v.forEach((id) => { if (!model.sources[id]) bad.push({ id, where }); });
        else if (k !== "sources" && k !== "raw") walk(v, `${where}.${k}`);
      }
    }
  };
  walk(model.accounts, "accounts");
  return bad;
}

// ---------- helpers ----------

export function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}
const unique = (xs) => [...new Set(xs)];
const trim = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
