// Pure functions: raw game data in, five answers per account out.
// Every number and claim carries `cites`, a list of source ids that exist in
// the data. Analyst judgement lives in data/plan.json; this file applies it
// and fills in everything that can be derived mechanically, including new
// live events the plan has never seen.

const DAY = 86_400_000;
const POWER_ROLES = ["decides", "pays", "uses", "blocks", "champion"];
const COLD = new Set(["guarded", "neutral"]);

// ---------- source index ----------

export function indexSources({ exp, files = {}, signals = [], debrief, team, paperwork = {}, playerCard = null }) {
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
  for (const s of signals) {
    add(s.id, { kind: "signal", account: s.account, title: s.title, text: s.text, date: s.date });
    // Records that arrive with an event become citable. A new file keeps its
    // path as its id; a row added to an existing log is cited as path#event.
    for (const r of s.records ?? []) {
      const id = src[r.path] ? `${r.path}#${s.id}` : r.path;
      add(id, { kind: "record", account: s.account, record_kind: r.kind, title: r.path, text: r.note ? `${r.note}\n\n${r.text}` : r.text, via: s.id });
    }
  }
  const members = Array.isArray(team) ? team : team?.members ?? team?.team ?? team?.people ?? [];
  for (const m of members) add(m.id, { kind: "team", title: m.name, role: m.role ?? m.title ?? null });
  if (playerCard) {
    add("player_card", {
      kind: "game", title: "Morning scorecard",
      text: `${playerCard.source}\n\n${playerCard.player}: rank ${playerCard.rank} of ${playerCard.players}, score ${playerCard.score} (deal value ${playerCard.score_parts.deal_value}, insight ${playerCard.score_parts.insight}, people unlocked ${playerCard.score_parts.people_unlocked}). ${playerCard.closed_label}, insight ${playerCard.insight}, ${playerCard.people_unlocked} people unlocked, ${playerCard.moves} moves. Map header: insight ${playerCard.map_header.insight}, closed ${playerCard.map_header.closed.toLocaleString("en-GB")}, people ${playerCard.map_header.people}, deals ${playerCard.map_header.deals}.`,
    });
  }
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
    const date = s.dated ?? s.date ?? s.at ?? s.when ?? s.in_world_date ?? s.created_at ?? null;
    const account = s.account ?? s.account_id ?? null;
    const records = Array.isArray(s.records) ? s.records.filter((r) => r?.path && r?.text) : [];
    return { id, account, title: s.title ?? s.headline ?? null, text, date, minute: s.minute ?? s.game_minute ?? null, records, raw: s };
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
      add({ key: `stuck:${o.id}`, type: "stuck", title: `${o.title} is stuck: ${lowerFirst(o.blocker.text)}`, deal: o.id, cites: [o.id, ...(o.evidence ?? []).filter((e) => src[e])] });
    }
  }
  // Cold people who hold a paying, deciding or blocking role.
  const power = plan?.power ?? {};
  for (const p of account.stakeholders) {
    if (!COLD.has(p.relationship) && p.available !== false) continue;
    const holds = [];
    const deals = [];
    for (const [deal, roles] of Object.entries(power)) {
      const mine = ["decides", "pays", "blocks"].filter((role) => (roles[role] ?? []).some((e) => e.person === p.id));
      if (!mine.length) continue;
      const verbs = mine.map((r) => ({ decides: "decides", pays: "pays", blocks: "could block" }[r]));
      holds.push(`${listJoin(verbs)} on ${src[deal]?.title ?? deal}`);
      deals.push(deal);
    }
    if (!holds.length) continue;
    const stance = p.available === false ? "unavailable" : `only ${p.relationship} towards us`;
    const what = deals.length === 1 ? listJoin(holds) : `holds the deciding, paying or blocking role on ${deals.length} deals: ${listJoin(deals.map((d) => src[d]?.title ?? d))}`;
    add({ key: `cold:${p.id}`, type: "cold", title: `${p.name} is ${stance}, yet ${what}.`, person: p.id, cites: [p.id, ...deals] });
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
    else if (r.title) add(r); // an overlay for an event that has not arrived is skipped
  }
  const order = { red: 0, amber: 1, green: 2 };
  return risks.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------- moves ----------

export function movesFor(account, plan, src, signals, today, powerRows) {
  const planned = (plan?.moves ?? []).map((m, i) => ({ ...m, source: "plan", order: i }));
  const handled = new Set((plan?.handled_signals ?? []).map(String));
  const intake = [];
  for (const s of signals) {
    if (handled.has(s.id)) continue;
    // Default move for an event the plan has never seen: the named person gets
    // a reply within two working days, from the account owner.
    const who = s.people.map((id) => src[id]?.title).filter(Boolean);
    const deals = powerRows.filter((row) => POWER_ROLES.some((r) => row[r].some((e) => s.people.includes(e.person)))).map((r) => r.deal);
    const when = parseDate(s.date, today.getUTCFullYear());
    const start = when && when > today ? when : today;
    const recordIds = Object.values(src).filter((x) => x.via === s.id).map((x) => x.id);
    intake.push({
      key: `signal:${s.id}`, source: "signal", order: -1,
      action: who.length
        ? `Reply to ${who.join(" and ")} on this new event before anything else: ${trim(s.text, 140)}`
        : `Triage this new event and name an owner: ${trim(s.text, 140)}`,
      owner: plan?.account_owner ?? "Account owner",
      due: isoDay(nextWorkingDay(start, 0)),
      deadline_date: isoDay(nextWorkingDay(start, 2)),
      chance: 0.8,
      chance_why: "A reply is in our hands.",
      inside: "Two working days from the event, until someone reviews it",
      deals,
      why: `New live event${s.date ? ` dated ${s.date}` : ""}. Not yet reviewed in the plan.`,
      cites: [s.id, ...recordIds, ...s.people, ...deals],
    });
  }
  return [...intake, ...planned]
    .map((m) => ({ ...m, score: scoreMove(m, account, today), draft: draftFor(m, src, account) }))
    .sort((a, b) => b.score.score - a.score.score || a.order - b.order)
    .map((m, i) => ({ ...m, rank: i + 1 }));
}

// ---------- risk radar ----------

// One row per deal, three lights each: the deadline, the people who decide and
// pay, and the blocker. The row takes its worst light.
const RAG_ORDER = { red: 0, amber: 1, green: 2 };
export function riskRadar(account, power, signals, src) {
  const leaving = new Map();
  for (const s of signals) if (s.kinds?.includes("succession")) for (const id of s.people) leaving.set(id, s.id);
  return account.opportunities.map((o) => {
    const row = power.find((r) => r.deal === o.id);
    let deadline;
    if (!o.deadline) deadline = { rag: "green", text: "No deadline on file", cites: [o.id] };
    else if (o.deadline.passed) deadline = o.deadline.met ? { rag: "green", text: `Met: ${o.deadline.text}`, cites: [o.id] } : { rag: "red", text: `Missed: ${o.deadline.text}`, cites: [o.id] };
    else deadline = { rag: o.deadline.soon ? "red" : "amber", text: o.deadline.text, cites: [o.id] };

    const keyPeople = [...(row?.decides ?? []).map((e) => ({ ...e, as: "decides" })), ...(row?.pays ?? []).map((e) => ({ ...e, as: "pays" }))];
    const flags = [];
    for (const e of keyPeople) {
      if (e.person && leaving.has(e.person)) flags.push({ rag: "red", text: `${e.name} (${e.as}) is leaving`, cites: [e.person, leaving.get(e.person)] });
      else if (!e.person) flags.push({ rag: "amber", text: `${e.name} (${e.as}) has not been met`, cites: e.cites });
      else if (COLD.has(e.stance) || e.stance === "unavailable") flags.push({ rag: "amber", text: `${e.name} (${e.as}) is ${e.stance}`, cites: [e.person] });
    }
    flags.sort((a, b) => RAG_ORDER[a.rag] - RAG_ORDER[b.rag]);
    const people = flags.length
      ? { rag: flags[0].rag, text: flags.map((f) => f.text).join("; "), cites: [...new Set(flags.flatMap((f) => f.cites))] }
      : { rag: "green", text: "Deciders and payers are allies or warm", cites: keyPeople.map((e) => e.person).filter(Boolean) };

    const blocker = !o.blocker
      ? { rag: "amber", text: "Blocker not known yet", cites: [o.id] }
      : o.blocker.status === "open"
        ? { rag: "red", text: `Open: ${o.blocker.text}`, cites: [o.id] }
        : { rag: "green", text: `Cleared: ${o.blocker.text}`, cites: [o.id] };

    const overall = [deadline, people, blocker].sort((a, b) => RAG_ORDER[a.rag] - RAG_ORDER[b.rag])[0].rag;
    return { deal: o.id, title: o.title, stage: o.stage, overall, deadline, people, blocker };
  }).sort((a, b) => RAG_ORDER[a.overall] - RAG_ORDER[b.overall]);
}

// ---------- next best action ----------

// An agreed deal is protected by a move, not won again, so it counts at a
// tenth of its value. Urgency rises as the deadline nears: 21 days out is 1.0,
// three or fewer days is the cap of 3, far-off deadlines floor at 0.4. A known
// deadline with no date counts as 1.0; no deadline at all as 0.5.
export const AGREED_WEIGHT = 0.1;
export function scoreMove(m, account, today) {
  const deals = (m.deals ?? []).map((id) => account.opportunities.find((o) => o.id === id)).filter(Boolean);
  const parts = deals.map((o) => ({ deal: o.id, worth: o.worth_up_to ?? 0, weight: o.stage === "agreed" ? AGREED_WEIGHT : 1 }));
  let value = parts.reduce((n, p) => n + p.worth * p.weight, 0);
  if (m.value_at_stake) value += m.value_at_stake.amount;
  const chance = m.chance ?? 0.5;
  const dl = m.deadline_date ? new Date(`${m.deadline_date}T00:00:00Z`) : null;
  const days = dl ? Math.round((dl - today) / DAY) : null;
  const urgency = days == null ? (m.deadline_known ? 1 : 0.5) : days <= 3 ? 3 : Math.min(3, Math.max(0.4, 21 / days));
  return {
    score: Math.round(value * chance * urgency),
    value: Math.round(value), chance, chance_why: m.chance_why ?? null,
    urgency: Math.round(urgency * 100) / 100, days, deadline_date: m.deadline_date ?? null,
    parts,
    cites: [...deals.map((o) => o.id), ...(m.value_at_stake?.cites ?? [])],
  };
}

// ---------- draft writer ----------

// The message to the customer carries the evidence that moves the deal, quoted
// from the record with its id; the internal request names an owner and a date.
// Claims are never used as evidence.
export function draftFor(m, src, account) {
  const d = m.draft ?? {};
  const toId = d.to ?? m.cites.find((id) => src[id]?.kind === "person");
  const evidenceIds = (d.evidence ?? m.cites).filter((id) => {
    const x = src[id];
    return x && (x.kind === "file" || x.kind === "record" || (x.kind === "fact" && x.status !== "claim"));
  });
  const evidence = evidenceIds.map((id) => {
    const x = src[id];
    if (x.kind === "fact") return { id, line: `${x.text} (${x.said_by}, ${x.status})` };
    if (x.kind === "file") return { id, line: `${x.title}: attached` };
    return { id, line: `${x.title}` };
  });
  const dealTitle = src[m.deals?.[0]]?.title ?? account.name;
  const internal = d.internal ? {
    to: src[d.internal.to]?.title ?? d.internal.to,
    to_id: src[d.internal.to] ? d.internal.to : null,
    ask: d.internal.ask,
    by: d.internal.by ?? m.due,
  } : null;
  return {
    to: toId ? src[toId]?.title ?? toId : null,
    to_id: toId && src[toId] ? toId : null,
    subject: d.subject ?? dealTitle,
    opening: d.opening ?? m.action,
    evidence,
    ask: d.ask ?? null,
    internal,
    cites: [...new Set([...(toId && src[toId] ? [toId] : []), ...evidenceIds, ...(internal?.to_id ? [internal.to_id] : [])])],
  };
}

// ---------- gaps ----------

export function gapsFor(account, plan, src) {
  const gaps = [];
  const fill = plan?.gap_owners ?? {};
  for (const f of account.facts.filter((x) => x.status === "claim")) {
    const base = `Only ${f.said_by}'s word; no file backs it.`;
    gaps.push({ key: `claim:${f.id}`, type: "claim", title: `Unconfirmed: "${f.text}"`, why: fill[f.id]?.why ? `${base} ${fill[f.id].why}` : base, who: fill[f.id]?.who ?? null, how: fill[f.id]?.how ?? null, cites: [f.id, ...(fill[f.id]?.cites ?? [])] });
  }
  for (const o of account.opportunities.filter((x) => x.worth_up_to == null)) {
    gaps.push({ key: `value:${o.id}`, type: "unvalued", title: `No value yet for "${o.title}"`, why: fill[o.id]?.why ?? "Still at identified: who decides, who pays and the blocker are not known well enough to size it.", who: fill[o.id]?.who ?? null, how: fill[o.id]?.how ?? null, cites: [o.id, ...(fill[o.id]?.cites ?? [])] });
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

export function buildModel({ exp, files, signals: rawSignals, plan, debrief, team, paperwork = {}, playerCard = null, overlay = null, seedExport = null, now = new Date() }) {
  const signals = normaliseSignals(rawSignals);
  const src = indexSources({ exp, files, signals, debrief, team, paperwork, playerCard });
  const people = Object.values(src).filter((s) => s.kind === "person");
  for (const s of signals) {
    const c = classifySignal(s, people.filter((p) => !s.account || p.account === s.account));
    s.kinds = c.kinds;
    s.people = c.people;
    if (!s.account && c.people.length) s.account = src[c.people[0]].account;
  }
  const today = inWorldToday(plan?.today, signals, now);
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
      moves: movesFor(a, { ...p, account_owner: plan?.account_owner }, src, sigs, today, power)
        .map((m) => ({ ...m, overdue: m.due < isoDay(today) })),
      risks: risksFor(a, p, src, sigs, today),
      radar: riskRadar(a, power, sigs, src),
      gaps: gapsFor(a, p, src),
      signals: sigs,
      changes: seedExport ? diffAccount(seedExport.accounts.find((x) => x.id === a.id), a) : [],
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
  // The game's own closed total, checked against the one this CRM computes.
  const computedClosed = accounts.reduce((n, a) => n + (a.book.segments.find((x) => x.bucket === "closed")?.value ?? 0), 0);
  model.player = playerCard ? {
    ...playerCard,
    computed_closed: computedClosed,
    closed_matches: computedClosed === playerCard.closed,
    closed_cites: accounts.flatMap((a) => a.book.segments.find((x) => x.bucket === "closed")?.cites ?? []),
    cites: ["player_card"],
  } : null;
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
const lowerFirst = (t) => (/^[A-Z][a-z]/.test(t) && !/^(I|FlytBase)\b/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
const listJoin = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const trim = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- in-world date ----------

// The game's calendar runs ahead of the wall clock: live events carry their
// own dates. "Today" is the plan's date, moved forward by the latest dated
// event, so overdue moves show as overdue instead of silently passing.
export function inWorldToday(planToday, signals, now) {
  const base = planToday ? new Date(`${planToday}T00:00:00Z`) : now;
  const year = base.getUTCFullYear();
  const dated = signals.map((s) => parseDate(s.date, year)).filter(Boolean);
  const latest = dated.length ? new Date(Math.max(...dated.map((d) => d.getTime()))) : null;
  return latest && latest > base ? latest : base;
}

// ---------- what changed since the seed ----------

// New facts, deal stage moves, blockers cleared and relationships shifting all
// arrive through get_my_accounts without any event. List them so a reader can
// see what moved, each with the id that proves it.
export function diffAccount(before, after) {
  if (!before || !after) return [];
  const out = [];
  const factIds = new Set(before.facts.map((f) => f.id));
  for (const f of after.facts) {
    if (!factIds.has(f.id)) out.push({ key: `fact:${f.id}`, kind: "new_fact", text: `New ${f.status} fact from ${f.said_by}: ${f.text}`, cites: [f.id] });
  }
  for (const o of after.opportunities) {
    const b = before.opportunities.find((x) => x.id === o.id);
    if (!b) { out.push({ key: `deal:${o.id}`, kind: "new_deal", text: `New deal: ${o.title} (${o.stage})`, cites: [o.id] }); continue; }
    if (b.stage !== o.stage) out.push({ key: `stage:${o.id}:${o.stage}`, kind: "stage", text: `${o.title} moved from ${b.stage} to ${o.stage}`, cites: [o.id] });
    if (b.worth_up_to !== o.worth_up_to) out.push({ key: `worth:${o.id}:${o.worth_up_to}`, kind: "value", text: `${o.title} is now sized at ${o.worth_up_to ?? "no value"} (was ${b.worth_up_to ?? "no value"})`, cites: [o.id] });
    if (b.blocker?.status !== o.blocker?.status && o.blocker) out.push({ key: `blocker:${o.id}:${o.blocker.status}`, kind: "blocker", text: `${o.title}: blocker now ${o.blocker.status}`, cites: [o.id] });
  }
  for (const p of after.stakeholders) {
    const b = before.stakeholders.find((x) => x.id === p.id);
    if (!b) out.push({ key: `person:${p.id}`, kind: "new_person", text: `New contact: ${p.name}, ${p.role} (${p.relationship})`, cites: [p.id] });
    else if (b.relationship !== p.relationship || b.available !== p.available) {
      out.push({ key: `stance:${p.id}:${p.relationship}:${p.available}`, kind: "stance", text: `${p.name} is now ${p.available === false ? "unavailable" : p.relationship} (was ${b.relationship})`, cites: [p.id] });
    }
  }
  return out;
}
