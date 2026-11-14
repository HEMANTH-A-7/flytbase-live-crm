// Account book: renders /api/state. No token, no secrets here: the server
// holds the token and does the MCP calls. Polls once a minute.

const POLL_MS = 60_000;
const SEEN_KEY = "crm-seen-signals";
const $ = (s, el = document) => el.querySelector(s);

let model = null;
let current = (location.hash.match(/^#(A|B)\b/) ?? [])[1] ?? safeGet("crm-account") ?? "A";
let lastOk = null;
let lastFocus = null;

// ---------- helpers ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

function money(v, cur) {
  if (v == null) return "no value";
  const sym = cur === "GBP" ? "£" : cur === "EUR" ? "€" : "";
  return sym + Math.round(v).toLocaleString("en-GB");
}
function short(v, cur) {
  if (v == null) return "no value";
  const sym = cur === "GBP" ? "£" : cur === "EUR" ? "€" : "";
  if (v >= 1e6) return `${sym}${(v / 1e6).toFixed(2).replace(/\.?0+$/, "")}m`;
  if (v >= 1e3) return `${sym}${Math.round(v / 1e3)}k`;
  return sym + v;
}
function day(iso) {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function chipClass(id) {
  const s = model.sources[id];
  if (!s) return "missing";
  if (s.kind === "fact") return s.status;
  return s.kind;
}
function chips(ids = []) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return "";
  return `<div class="chips">${uniq.map((id) => `<button type="button" class="chip ${chipClass(id)}" data-src="${esc(id)}" title="Open source ${esc(id)}">${esc(id)}</button>`).join("")}</div>`;
}

const BUCKET = {
  closed: { label: "Agreed or won", hint: "agreed deals and won offers" },
  backed: { label: "Backed", hint: "open, with a verified fact or a file we hold" },
  told: { label: "Told only", hint: "open, on someone's word" },
  claim: { label: "Claimed only", hint: "open, on a claim nobody has checked" },
  unvalued: { label: "No value yet", hint: "" },
};

// ---------- render ----------

function render() {
  const a = model.accounts.find((x) => x.id === current) ?? model.accounts[0];
  current = a.id;
  renderStrip();
  renderRail(a);
  $("#main").innerHTML = [head(a), book(a), power(a), moves(a), risks(a), gaps(a), log()].join("");
  document.title = `${a.name} · Account book`;
}

function renderStrip() {
  const asof = model.live?.accounts_at ?? model.as_of;
  $("#asof").innerHTML = `Data as of ${esc(new Date(asof).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))} · in-world today ${esc(day(model.today))}`;
  const live = $("#live");
  const lastCall = model.live?.last_call_at;
  const fresh = lastCall && Date.now() - Date.parse(lastCall) < 5 * 60_000;
  live.className = `live ${!model.live || !lastCall ? "off" : fresh ? "" : "stale"}`;
  $("#live-text").textContent = !model.live ? "Seed data" : !lastCall ? "Waiting for first check" : `Live · checked ${ago(lastCall)}${model.live.last_error ? " (last call failed, showing last good data)" : ""}`;
}

function renderRail(a) {
  $("#switch").innerHTML = model.accounts.map((x) => {
    const reds = x.risks.filter((r) => r.severity === "red").length;
    return `<button type="button" data-acct="${x.id}" aria-pressed="${x.id === a.id}">
      <span class="acct-name">${esc(x.name)}</span>
      <span class="acct-sub">${esc(short(x.book.total.value, x.currency))} on the book · ${reds} red</span>
    </button>`;
  }).join("");
  const reds = a.risks.filter((r) => r.severity === "red").length;
  const unbacked = a.book.segments.filter((s) => s.bucket === "told" || s.bucket === "claim").reduce((n, s) => n + s.value, 0);
  const items = [
    ["book", "What is the book worth?", `${short(a.book.total.value, a.currency)}${unbacked ? `, ${short(unbacked, a.currency)} unbacked` : ", all agreed or backed"}`],
    ["power", "Who holds the power?", `${a.power.length} deals mapped`],
    ["moves", "What do you do first?", a.moves[0] ? `First: ${day(a.moves[0].due)}` : "Nothing planned"],
    ["risks", "What is about to go wrong?", `<span class="${reds ? "red" : ""}">${reds} red</span>, ${a.risks.length - reds} amber`],
    ["gaps", "What do you still not know?", `${a.gaps.length} gaps`],
  ];
  $("#toc").innerHTML = items.map(([id, q, s]) => `<li><a href="#${a.id}-${id}"><span class="q">${q}</span><span class="status">${s}</span></a></li>`).join("");
}

function head(a) {
  const u = a.usage;
  const usage = u ? `${u.docks - u.idle} of ${u.docks} docks flew at least once in the four weeks from ${day(u.from)}; ${u.idle} flew nothing. The busiest five flew ${Math.round(u.top_share * 100)}% of all ${u.flights} flights.` : "No usage log on file.";
  return `<header class="acct-head">
    <h1>${esc(a.name)}</h1>
    ${a.headline ? `<p class="headline">${esc(a.headline)}</p>${chips(a.headline_cites)}` : ""}
    <div class="story">
      <div><div class="label">What the account sheet says (unverified)</div><p class="claimed">${esc(a.official_story)}</p></div>
      <div><div class="label">What the logs say</div><p>${esc(usage)}</p>${u ? chips(u.cites) : ""}</div>
    </div>
  </header>`;
}

function qhead(a, id, n, title, aside = "") {
  return `<div class="q-head"><span class="n">${n}</span><h2 id="${a.id}-${id}-h">${title}</h2>${aside ? `<span class="aside">${aside}</span>` : ""}</div>`;
}

function book(a) {
  const b = a.book;
  const total = b.total.value || 1;
  const segs = b.segments.filter((s) => s.value > 0);
  const deals = [...b.deals.filter((d) => d.bucket !== "unvalued"), ...b.offers.filter((o) => o.bucket !== "lost")];
  const rows = deals.map((d) => `<tr class="${d.bucket}">
      <td><div class="title">${esc(d.title)}</div>
        ${d.blocker ? `<div class="blocker ${esc(d.blocker.status)}">Blocker (${esc(d.blocker.status)}): ${esc(d.blocker.text)}</div>` : ""}
        ${chips(d.cites)}</td>
      <td>${d.stage ? esc(d.stage) : esc(d.status)}${d.pitch_to ? `<div class="small muted">to ${esc(d.pitch_to)}</div>` : ""}</td>
      <td><span class="tag ${d.bucket}">${esc(BUCKET[d.bucket]?.label ?? d.bucket)}</span>
        ${d.backing ? `<div class="small muted">${d.backing.verified.length + d.backing.file.length} verified or file · ${d.backing.told.length} told · ${d.backing.claim.length} claim</div>` : ""}</td>
      <td class="num">${esc(money(d.value, a.currency))}${d.basis ? `<div class="basis">${esc(d.basis.text)}</div>${chips(d.basis.cites)}` : ""}</td>
    </tr>`).join("");
  const apart = [
    ...b.unvalued.map((u) => `<tr class="unvalued"><td><div class="title">${esc(u.title)}</div>${chips(u.cites)}</td><td><span class="tag unvalued">No value yet</span></td><td class="small">${esc(u.basis?.text ?? "Still at identified: not enough known to size it.")}${chips(u.basis?.cites)}</td></tr>`),
    ...b.claimed.map((c) => `<tr class="unvalued"><td><div class="title">"${esc(c.text)}"</div><div class="small muted">${esc(c.said_by)}</div>${chips(c.cites)}</td><td><span class="tag claim">Claim, not counted</span></td><td class="small">A number nobody has backed with a file.</td></tr>`),
    ...b.lost.map((l) => `<tr class="lost"><td><div class="title">${esc(l.title)}</div>${chips(l.cites)}</td><td><span class="tag lost">Declined</span></td><td class="num">${esc(money(l.value, a.currency))}</td></tr>`),
  ].join("");
  return `<section class="q" id="${a.id}-book" aria-labelledby="${a.id}-book-h">
    ${qhead(a, "book", 1, "What is the book worth?", "Values are deal sizes from the account export (worth_up_to)")}
    <div class="prov">
      <div class="total"><span class="big">${esc(money(b.total.value, a.currency))}</span><span class="muted">on the book, split by how well each part is backed</span></div>
      <div class="bar" role="img" aria-label="${segs.map((s) => `${BUCKET[s.bucket].label} ${money(s.value, a.currency)}`).join(", ")}">
        ${segs.map((s) => `<button type="button" class="seg ${s.bucket}" style="flex:${s.value / total}" data-jump="${a.id}-book-table" title="${BUCKET[s.bucket].label}: ${money(s.value, a.currency)} (${Math.round((100 * s.value) / total)}%)"><span class="visually-hidden">${BUCKET[s.bucket].label}</span></button>`).join("")}
      </div>
      <div class="key">${b.segments.map((s) => `<div><i class="${s.bucket}"></i><span><b>${BUCKET[s.bucket].label}</b> ${esc(money(s.value, a.currency))} <span class="muted">· ${BUCKET[s.bucket].hint}</span></span></div>`).join("")}</div>
    </div>
    <div class="ledger-wrap"><table class="ledger" id="${a.id}-book-table">
      <thead><tr><th>Deal or offer, and what backs it</th><th>Stage</th><th>Backing</th><th class="num">Value</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${apart ? `<h3 class="sub">Shown apart, not in the total</h3><div class="ledger-wrap"><table class="ledger"><tbody>${apart}</tbody></table></div>` : ""}
  </section>`;
}

const RISK_TYPE = { deadline: "Deadline", stuck: "Stuck deal", cold: "Going cold", usage: "Usage", signal: "Live event", relationship: "Relationship" };

const ROLE_LABEL = { decides: "Decides", pays: "Pays", uses: "Uses it", blocks: "Could block", champion: "Champions" };

function power(a) {
  const blocks = a.power.map((p) => {
    const dl = Object.keys(ROLE_LABEL).map((role) => {
      const people = p[role];
      const dd = people.length
        ? people.map((e) => `<div class="person"><span class="who">${esc(e.name)}</span>${e.role ? `<span class="small muted">, ${esc(e.role)}</span>` : ""}${e.person ? `<span class="stance ${esc(e.stance)}">${esc(e.stance)}</span>` : ""}
            ${e.note ? `<div class="small">${esc(e.note)}</div>` : ""}${chips([...(e.person ? [e.person] : []), ...e.cites])}</div>`).join("")
        : `<span class="none">Nobody yet${role === "champion" ? ": this deal has no champion" : ""}</span>`;
      return `<dt>${ROLE_LABEL[role]}</dt><dd>${dd}</dd>`;
    }).join("");
    return `<article class="deal-power"><h3>${esc(p.title)} <span class="tag ${p.stage === "agreed" ? "closed" : "backed"}">${esc(p.stage)}</span></h3>
      <dl class="roles">${dl}</dl>
      ${p.waiting_on ? `<p class="waiting"><b>Waiting on:</b> ${esc(p.waiting_on)}</p>` : ""}
    </article>`;
  }).join("");
  return `<section class="q" id="${a.id}-power" aria-labelledby="${a.id}-power-h">
    ${qhead(a, "power", 2, "Who holds the power?", "Stance = relationship from the account export")}
    <div class="power">${blocks}</div>
  </section>`;
}

function moveItem(m) {
  return `<li class="move ${m.source === "signal" ? "signal" : ""}">
    <div class="rank" aria-label="Rank ${m.rank}">${m.rank}</div>
    <div>
      ${m.source === "signal" ? `<div class="live-label">New live event, not yet reviewed</div>` : ""}
      <p class="action">${esc(m.action)}</p>
      <div class="facts"><span><b>Owner</b> ${esc(m.owner)}</span><span><b>By</b> ${esc(day(m.due))}</span><span><b>Moves</b> ${esc((m.deals ?? []).map((d) => model.sources[d]?.title ?? d).join("; ") || "the account")}</span></div>
      ${m.inside ? `<div class="inside"><b>Inside:</b> ${esc(m.inside)}</div>` : ""}
      <p class="why">${esc(m.why)}</p>
      ${chips(m.cites)}
    </div>
  </li>`;
}

function moves(a) {
  const top = a.moves.slice(0, 3);
  const rest = a.moves.slice(3);
  return `<section class="q" id="${a.id}-moves" aria-labelledby="${a.id}-moves-h">
    ${qhead(a, "moves", 3, "What do you do first?", "Ranked by value at stake and how soon it turns bad")}
    <ol class="moves">${top.map(moveItem).join("")}</ol>
    ${rest.length ? `<details class="later"><summary>Then ${rest.length} more</summary><ol class="moves">${rest.map(moveItem).join("")}</ol></details>` : ""}
  </section>`;
}

function risks(a) {
  const rows = a.risks.map((r) => `<tr class="risk ${esc(r.severity)}">
      <td class="sev"><i aria-hidden="true"></i><span class="visually-hidden">${esc(r.severity)}</span></td>
      <td><div class="title">${r.live ? '<span class="tag red">Live</span> ' : ""}${esc(r.title)}</div>
        ${r.turns_bad ? `<div class="turns"><b>Turns bad:</b> ${esc(r.turns_bad)}</div>` : `<div class="turns muted">No date on file for when this turns bad.</div>`}
        ${chips(r.cites)}</td>
      <td><span class="tag ${esc(r.severity)}">${esc(r.severity)}</span><div class="small muted">${esc(RISK_TYPE[r.type] ?? "")}</div></td>
    </tr>`).join("");
  return `<section class="q" id="${a.id}-risks" aria-labelledby="${a.id}-risks-h">
    ${qhead(a, "risks", 4, "What is about to go wrong?", "Deadlines, stuck deals, cold people, live events")}
    <div class="ledger-wrap"><table class="ledger"><thead><tr><th></th><th>Risk, and when it turns bad</th><th>Level</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

function gaps(a) {
  const rows = a.gaps.map((g) => `<tr>
      <td><div class="title">${esc(g.title)}</div>${chips(g.cites)}</td>
      <td class="small">${esc(g.why ?? "")}</td>
      <td class="small">${g.who ? `<b>${esc(g.who)}</b>${g.how ? `<div class="muted">${esc(g.how)}</div>` : ""}` : `<span class="none">No one identified yet</span>`}</td>
    </tr>`).join("");
  return `<section class="q" id="${a.id}-gaps" aria-labelledby="${a.id}-gaps-h">
    ${qhead(a, "gaps", 5, "What do you still not know?", "Claims nobody checked, deals with no value, missing records")}
    <div class="ledger-wrap"><table class="ledger"><thead><tr><th>What we do not know</th><th>Why it matters</th><th>Who could tell us</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

function log() {
  const l = model.live;
  const written = l?.notes_written ?? [];
  const pending = (model.pending_notes ?? []).length - written.length;
  return `<footer class="log">
    <h2>How this page stays live</h2>
    <p>The server reads the game's MCP once a minute at most: new live events, fresh account data, and notes written back with <span class="mono">write_note</span>. New events reach this page without a code change or a redeploy.</p>
    <ul>
      <li>Last MCP call: ${l?.last_call_at ? `${esc(l.last_tool)} ${esc(ago(l.last_call_at))}` : "none yet from this server"}${l?.last_error ? ` · <span class="err">${esc(l.last_error.tool)} failed: ${esc(l.last_error.message)}</span>` : ""}</li>
      <li>Live events last read: ${esc(l?.signals_at ? ago(l.signals_at) : "not yet")} · accounts last read: ${esc(l?.accounts_at ? ago(l.accounts_at) : "seed snapshot")}</li>
      <li>Notes written back: ${written.length}${pending > 0 ? ` (${pending} queued)` : ""}${written.length ? `, latest "${esc(written.at(-1).title)}" ${esc(ago(written.at(-1).at))}` : ""}</li>
      <li>Ids cited that are missing from the data: ${model.invalid_cites?.length ? `<span class="err">${model.invalid_cites.length}</span>` : "none"}</li>
    </ul>
  </footer>`;
}

// ---------- evidence drawer ----------

function csvTable(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2 || !lines[0].includes(",")) return null;
  const parse = (l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')).slice(0, -1);
  const [h, ...rows] = lines.map(parse);
  const shown = rows.slice(0, 200);
  return `<div class="csv-wrap"><table class="csv"><thead><tr>${h.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${shown.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${rows.length > shown.length ? `<p class="small muted">First ${shown.length} of ${rows.length} rows.</p>` : ""}`;
}

function fileBody(content) {
  if (content == null) return `<p class="muted small">File contents not loaded.</p>`;
  const text = typeof content === "string" ? content : content.content ?? content.text ?? content.csv ?? content.body ?? null;
  if (typeof text === "string") return csvTable(text) ?? `<pre>${esc(text)}</pre>`;
  return `<pre>${esc(JSON.stringify(content, null, 1))}</pre>`;
}

const KIND = { fact: "Fact", file: "File we hold", person: "Person", deal: "Deal", offer: "Offer", record: "Paperwork record", signal: "Live event", team: "FlytBase team", debrief: "Morning debrief" };

function openDrawer(id) {
  const s = model.sources[id];
  lastFocus = document.activeElement;
  $("#drawer-kind").textContent = s ? KIND[s.kind] ?? s.kind : "Unknown id";
  $("#drawer-title").textContent = s?.title ?? (s?.kind === "fact" ? s.said_by : id);
  $("#drawer-id").textContent = id;
  let html = "";
  if (!s) html = `<p class="err">This id is not in the data.</p>`;
  else if (s.kind === "fact") {
    html = `<blockquote>${esc(s.text)}</blockquote><dl>
      <dt>Said by</dt><dd>${esc(s.said_by)}</dd>
      <dt>Status</dt><dd><span class="tag ${s.status === "verified" ? "backed" : s.status === "claim" ? "claim" : "told"}">${esc(s.status)}</span> ${s.status === "claim" ? "may be wrong" : s.status === "told" ? "what a person said" : "backed by a file we hold"}</dd>
      <dt>Learned</dt><dd>Minute ${esc(s.learned_at_minute)} of the morning</dd>
      <dt>Account</dt><dd>${esc(s.account)}</dd>
      ${s.verified_by ? `<dt>Verified by</dt><dd>${chips([s.verified_by])}</dd>` : ""}
    </dl>`;
    if (s.verified_by && model.sources[s.verified_by]) html += `<h3 class="sub">${esc(model.sources[s.verified_by].title)}</h3>${fileBody(model.sources[s.verified_by].content)}`;
  } else if (s.kind === "file") {
    html = `<dl><dt>Account</dt><dd>${esc(s.account)}</dd><dt>Path</dt><dd class="mono">${esc(s.path)}</dd></dl>${fileBody(s.content)}`;
  } else if (s.kind === "person") {
    html = `<dl><dt>Role</dt><dd>${esc(s.role)}</dd><dt>Stance</dt><dd>${esc(s.relationship)}</dd><dt>Available</dt><dd>${s.available === false ? "No" : "Yes"}</dd><dt>Account</dt><dd>${esc(s.account)}</dd></dl>`;
    const said = Object.values(model.sources).filter((x) => x.kind === "fact" && x.said_by === s.title);
    if (said.length) html += `<h3 class="sub">What ${esc(s.title)} told us</h3>${said.map((f) => `<blockquote class="small">${esc(f.text)} ${chips([f.id])}</blockquote>`).join("")}`;
  } else if (s.kind === "deal") {
    html = `<dl><dt>Stage</dt><dd>${esc(s.stage)}</dd><dt>Worth up to</dt><dd>${esc(s.worth_up_to == null ? "not sized" : s.worth_up_to.toLocaleString("en-GB"))}</dd><dt>Account</dt><dd>${esc(s.account)}</dd></dl>`;
  } else if (s.kind === "offer") {
    html = `<dl><dt>Status</dt><dd>${esc(s.status)}</dd><dt>Value</dt><dd>${esc(s.value?.toLocaleString("en-GB"))}</dd><dt>Pitched to</dt><dd>${esc(s.pitch_to)}</dd><dt>Account</dt><dd>${esc(s.account)}</dd></dl>`;
  } else if (s.kind === "record") {
    html = `<dl><dt>Account</dt><dd>${esc(s.account)}</dd><dt>Type</dt><dd>${esc(s.record_kind)}</dd></dl>${csvTable(s.text) ?? `<pre>${esc(s.text)}</pre>`}`;
  } else if (s.kind === "signal") {
    html = `<blockquote>${esc(s.text)}</blockquote><dl><dt>Date</dt><dd>${esc(s.date ?? "not given")}</dd><dt>Account</dt><dd>${esc(s.account ?? "not given")}</dd></dl>`;
  } else if (s.kind === "debrief") {
    html = s.text.split("\n\n").map((p, i) => (i ? `<blockquote class="small">${esc(p)}</blockquote>` : `<p class="small muted" style="margin-bottom:12px">${esc(p)}</p>`)).join("");
  } else {
    html = `<dl><dt>Role</dt><dd>${esc(s.role ?? "")}</dd></dl>`;
  }
  $("#drawer-body").innerHTML = html;
  $("#drawer").classList.add("open");
  $("#scrim").classList.add("show");
  $("#drawer-close").focus();
}

function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#scrim").classList.remove("show");
  lastFocus?.focus?.();
}

// ---------- new-since-you-looked ----------

function checkNew() {
  const all = model.accounts.flatMap((a) => a.signals.map((s) => ({ ...s, acct: a.name })));
  let seen;
  try { seen = new Set(JSON.parse(safeGet(SEEN_KEY) ?? "[]")); } catch { seen = new Set(); }
  const fresh = all.filter((s) => !seen.has(s.id));
  const bar = $("#newbar");
  if (!fresh.length) { bar.classList.remove("show"); return; }
  $("#newbar-text").textContent = `${fresh.length} new live event${fresh.length > 1 ? "s" : ""} since you last looked.`;
  $("#newbar-detail").textContent = fresh.map((s) => `${s.acct}: ${s.text.slice(0, 90)}${s.text.length > 90 ? "…" : ""}`).join(" · ");
  bar.classList.remove("show");
  void bar.offsetWidth; // restart the one reveal animation
  bar.classList.add("show");
  $("#newbar-ok").onclick = () => {
    safeSet(SEEN_KEY, JSON.stringify([...seen, ...fresh.map((s) => s.id)]));
    bar.classList.remove("show");
  };
}

// ---------- data ----------

async function load() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const next = await r.json();
    const y = window.scrollY;
    const drawerOpen = $("#drawer").classList.contains("open");
    const first = !model;
    model = next;
    lastOk = Date.now();
    if (!drawerOpen) { render(); window.scrollTo(0, y); } else renderStrip();
    // Deep links such as #B-risks only resolve once the page has rendered.
    if (first && /^#[AB]-\w+$/.test(location.hash)) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    checkNew();
  } catch (err) {
    if (!model) $("#main").innerHTML = `<p class="loading err">Could not load the accounts (${esc(err.message)}). Retrying in a minute.</p>`;
    else $("#live-text").textContent = `Offline since ${ago(new Date(lastOk).toISOString())}, showing last good data`;
  }
}

// ---------- events ----------

document.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-src]");
  if (chip) return openDrawer(chip.dataset.src);
  const acct = e.target.closest("[data-acct]");
  if (acct) {
    current = acct.dataset.acct;
    safeSet("crm-account", current);
    history.replaceState(null, "", `#${current}`);
    render();
    $("#main").focus();
    window.scrollTo(0, 0);
    return;
  }
  const jump = e.target.closest("[data-jump]");
  if (jump) document.getElementById(jump.dataset.jump)?.scrollIntoView({ block: "start" });
});
window.addEventListener("hashchange", () => {
  const m = location.hash.match(/^#(A|B)$/);
  if (m && m[1] !== current && model) { current = m[1]; render(); window.scrollTo(0, 0); }
});
$("#drawer-close").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#drawer").classList.contains("open")) closeDrawer(); });

load();
setInterval(load, POLL_MS);
setInterval(() => model && renderStrip(), 15_000);
