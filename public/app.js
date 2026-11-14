// Account book: renders /api/state. No token, no secrets here: the server
// holds the token and does the MCP calls. Polls once a minute.

const POLL_MS = 60_000;
const SEEN_KEY = "crm-seen-signals";
const $ = (s, el = document) => el.querySelector(s);

let model = null;
let current = (location.hash.match(/^#(A|B)\b/) ?? [])[1] ?? safeGet("crm-account") ?? "A";
let lastOk = null;
let lastFocus = null;
let railObserver = null;

// ---------- helpers ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

const sym = (cur) => (cur === "GBP" ? "£" : cur === "EUR" ? "€" : "");
function money(v, cur) {
  if (v == null) return "no value";
  return sym(cur) + Math.round(v).toLocaleString("en-GB");
}
function short(v, cur) {
  if (v == null) return "no value";
  if (v >= 1e6) return `${sym(cur)}${(v / 1e6).toFixed(2).replace(/\.?0+$/, "")}m`;
  if (v >= 1e3) return `${sym(cur)}${Math.round(v / 1e3)}k`;
  return sym(cur) + v;
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
const icon = (name) => `<i class="ph ph-${name}" aria-hidden="true"></i>`;

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
};
const BUCKET_COLOR = { closed: "#e8edf1", backed: "#4c82b6", told: "#8aa6c1", claim: "#e4b83a" };
const RISK_TYPE = { deadline: "Deadline", stuck: "Stuck deal", cold: "Going cold", usage: "Usage", signal: "Live event", relationship: "Relationship" };
const ROLE_LABEL = { decides: "Decides", pays: "Pays", uses: "Uses it", blocks: "Could block", champion: "Champions" };
const SECTIONS = [
  ["since", "lightning", "Since this morning"],
  ["book", "coins", "What is the book worth?"],
  ["power", "users-three", "Who holds the power?"],
  ["moves", "list-checks", "What do you do first?"],
  ["risks", "warning", "What is about to go wrong?"],
  ["gaps", "question", "What do you still not know?"],
];

// ---------- render ----------

function render() {
  const a = model.accounts.find((x) => x.id === current) ?? model.accounts[0];
  current = a.id;
  renderStrip();
  renderSwitch(a);
  renderRail(a);
  $("#main").innerHTML = [hero(a), sinceAndLogs(a), book(a), power(a), moves(a), risks(a), gaps(a), log()].join("");
  document.title = `${a.name} · Account book`;
  watchSections(a);
}

function renderStrip() {
  const asof = model.live?.accounts_at ?? model.as_of;
  $("#asof").textContent = `Data ${new Date(asof).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}, in-world ${day(model.today)}`;
  const live = $("#live");
  const lastCall = model.live?.last_call_at;
  const fresh = lastCall && Date.now() - Date.parse(lastCall) < 5 * 60_000;
  live.className = `pill live ${!model.live || !lastCall ? "off" : fresh ? "" : "stale"}`;
  $("#live-text").textContent = !model.live ? "Seed data" : !lastCall ? "Waiting for first check" : `Live, checked ${ago(lastCall)}${model.live.last_error ? " (last call failed)" : ""}`;
}

function renderSwitch(a) {
  $("#switch").innerHTML = model.accounts.map((x) => {
    const reds = x.risks.filter((r) => r.severity === "red").length;
    const words = x.name.split(/\s+/);
    const shortName = words.length > 2 ? `${words[0]} ${words.at(-1)}` : x.name;
    return `<button type="button" data-acct="${x.id}" aria-pressed="${x.id === a.id}" aria-label="${esc(x.name)}"><span class="full">${esc(x.name)}</span><span class="short">${esc(shortName)}</span>${reds ? `<span class="count" aria-label="${reds} red risks">${reds}</span>` : ""}</button>`;
  }).join("");
}

function renderRail(a) {
  $("#rail").innerHTML = SECTIONS.map(([id, ic, label], i) => `${i === 1 ? "<hr>" : ""}<a href="#${a.id}-${id}" aria-label="${esc(label)}" data-section="${a.id}-${id}">${icon(ic)}</a>`).join("");
}

function watchSections(a) {
  railObserver?.disconnect();
  if (!("IntersectionObserver" in window)) return;
  railObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      document.querySelectorAll("#rail a").forEach((el) => el.classList.toggle("active", el.dataset.section === en.target.id));
    }
  }, { rootMargin: "-30% 0px -60% 0px" });
  SECTIONS.forEach(([id]) => { const el = document.getElementById(`${a.id}-${id}`); if (el) railObserver.observe(el); });
}

function hero(a) {
  const b = a.book;
  const closed = b.segments.find((s) => s.bucket === "closed");
  const reds = a.risks.filter((r) => r.severity === "red").length;
  const first = a.moves[0];
  const stat = (ic, value, label, target, cls = "") => `<button type="button" class="stat ${cls}" data-jump="${a.id}-${target}">
      <span class="ic">${icon(ic)}</span><span><b>${esc(value)}</b><span>${esc(label)}</span></span></button>`;
  return `<section class="hero">
      <h1>${esc(a.name)}</h1>
      <div class="stats">
        ${stat("coins", money(b.total.value, a.currency), "on the book, every part sourced", "book")}
        ${stat("seal-check", money(closed?.value ?? 0, a.currency), "agreed or won", "book")}
        ${stat("warning", `${reds} red`, `of ${a.risks.length} risks`, "risks", reds ? "red" : "")}
        ${stat("calendar-dots", first ? day(first.due) : "None", "first move due", "moves")}
      </div>
    </section>
    ${a.headline ? `<div class="headline"><span class="ic">${icon("pulse")}</span><div><p>${esc(a.headline)}</p>${chips(a.headline_cites)}</div></div>` : ""}`;
}

function panelHead(n, title, note = "") {
  return `<div class="panel-head">${n ? `<span class="qn">${n}</span>` : ""}<h2>${title}</h2>${note ? `<span class="note">${note}</span>` : ""}</div>`;
}

function sinceAndLogs(a) {
  const l = model.live;
  const checked = l?.signals_at ? `Live events last checked ${ago(l.signals_at)}.` : l ? "First check pending." : "This copy runs on the seed snapshot, without a token.";
  const items = [
    ...a.signals.map((s) => `<li class="ev"><span class="ic">${icon("lightning")}</span><div><div class="when">${esc(s.date ?? "Undated")} · live event</div><p>${esc(s.text)}</p>${chips([s.id, ...s.people])}</div></li>`),
    ...a.changes.map((c) => `<li class="ev change"><span class="ic">${icon("broadcast")}</span><div><div class="when">Account data</div><p>${esc(c.text)}</p>${chips(c.cites)}</div></li>`),
  ];
  const u = a.usage;
  return `<div class="grid">
    <section class="panel q span-7" id="${a.id}-since" aria-labelledby="${a.id}-since-h">
      <div class="panel-head"><h2 id="${a.id}-since-h">Since this morning</h2></div>
      ${items.length ? `<ol class="events">${items.join("")}</ol>` : `<div class="empty"><span class="ic">${icon("clock")}</span><p>Nothing new on this account yet. Live events and account changes from the MCP land here, and in the risks and moves below, without a reload.</p></div>`}
      <p class="checked">${esc(checked)}</p>
    </section>
    <section class="panel span-5" aria-label="The account sheet against the logs">
      <div class="panel-head"><h2>The sheet against the logs</h2></div>
      <div class="compare">
        <div><div class="label">What the account sheet says (unverified)</div><p class="claimed">${esc(a.official_story)}</p></div>
        <div><div class="label">What the usage log shows, four weeks from ${esc(u ? day(u.from) : "")}</div>
          ${u ? `<div class="metric-row">
            <div><b>${u.docks - u.idle} of ${u.docks}</b><span>docks flew at least once</span></div>
            <div><b>${u.idle}</b><span>flew nothing</span></div>
            <div><b>${Math.round(u.top_share * 100)}%</b><span>of ${u.flights} flights from the top five</span></div>
          </div>${chips(u.cites)}` : `<p class="muted">No usage log on file.</p>`}
        </div>
      </div>
    </section>
  </div>`;
}

function book(a) {
  const b = a.book;
  const total = b.total.value || 1;
  const rows = [...b.deals.filter((d) => d.bucket !== "unvalued"), ...b.offers.filter((o) => o.bucket !== "lost")]
    .sort((x, y) => (y.value ?? 0) - (x.value ?? 0));
  const max = Math.max(...rows.map((r) => r.value ?? 0), 1);
  const dealRows = rows.map((d) => `<div class="deal-row">
      <div>
        <div class="title">${esc(d.title)}</div>
        <div class="meta"><span class="tag"><i class="b-${d.bucket}"></i>${esc(BUCKET[d.bucket]?.label ?? d.bucket)}</span>
          <span>${esc(d.stage ?? d.status)}${d.pitch_to ? `, to ${esc(d.pitch_to)}` : ""}</span>
          ${d.backing ? `<span>${d.backing.verified.length + d.backing.file.length} verified or file, ${d.backing.told.length} told, ${d.backing.claim.length} claim</span>` : ""}</div>
        ${d.blocker ? `<div class="blocker ${esc(d.blocker.status)}">Blocker (${esc(d.blocker.status)}): ${esc(d.blocker.text)}</div>` : ""}
        ${chips(d.cites)}
      </div>
      <div><div class="val">${esc(money(d.value, a.currency))}</div>${d.basis ? `<div class="basis">${esc(d.basis.text)}</div>${chips(d.basis.cites)}` : ""}</div>
      <div class="track" aria-hidden="true"><i class="b-${d.bucket}" style="width:${Math.max(1, (100 * (d.value ?? 0)) / max)}%"></i></div>
    </div>`).join("");
  const apart = [
    ...b.unvalued.map((u) => `<div class="apart-row"><div class="title">${esc(u.title)}</div><div class="side"><span class="tag amber">No value yet</span></div><div class="why">${esc(u.basis?.text ?? "Still at identified: not enough known to size it.")}${chips([...u.cites, ...(u.basis?.cites ?? [])])}</div></div>`),
    ...b.claimed.map((c) => `<div class="apart-row"><div class="title">"${esc(c.text)}"</div><div class="side"><span class="tag amber">Claim, not counted</span></div><div class="why">${esc(c.said_by)}. A number nobody has backed with a file.${chips(c.cites)}</div></div>`),
    ...b.lost.map((l) => `<div class="apart-row"><div class="title">${esc(l.title)}</div><div class="side">Declined, ${esc(money(l.value, a.currency))}</div><div class="why">${chips(l.cites)}</div></div>`),
  ].join("");

  // Donut: one ring segment per bucket, in a fixed order.
  const R = 70, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = b.segments.filter((s) => s.value > 0).map((s) => {
    const len = (C * s.value) / total;
    const arc = `<circle r="${R}" cx="90" cy="90" stroke="${BUCKET_COLOR[s.bucket]}" stroke-dasharray="${Math.max(0, len - 3)} ${C}" stroke-dashoffset="${-offset}"></circle>`;
    offset += len;
    return arc;
  }).join("");
  const backedShare = Math.round((100 * b.segments.filter((s) => s.bucket === "closed" || s.bucket === "backed").reduce((n, s) => n + s.value, 0)) / total);

  return `<div class="grid">
    <section class="panel q span-8" id="${a.id}-book" aria-labelledby="${a.id}-book-h">
      ${panelHead(1, `<span id="${a.id}-book-h">What is the book worth?</span>`, "Deal sizes from the account export (worth_up_to)")}
      <div class="big"><b>${esc(money(b.total.value, a.currency))}</b><span>on the book, split by how well each part is backed</span></div>
      <div class="bucket-chips">${b.segments.map((s) => `<span class="tag"><i class="b-${s.bucket}"></i>${BUCKET[s.bucket].label} <span>${esc(short(s.value, a.currency))}</span></span>`).join("")}</div>
      <div class="deal-rows">${dealRows}</div>
      ${apart ? `<div class="apart"><h3>Shown apart, not in the total</h3>${apart}</div>` : ""}
    </section>
    <section class="panel span-4" aria-label="How well the book is backed">
      ${panelHead(0, "How well it is backed")}
      <p class="panel-sub">${backedShare}% of the book is agreed, won, or backed by a verified fact or a file we hold.</p>
      <div class="donut-wrap">
        <svg class="donut" viewBox="0 0 180 180" role="img" aria-label="${b.segments.map((s) => `${BUCKET[s.bucket].label} ${money(s.value, a.currency)}`).join(", ")}"><circle class="bg" r="${R}" cx="90" cy="90"></circle>${arcs}</svg>
        <div class="donut-center"><b>${esc(short(b.total.value, a.currency))}</b><span>on the book</span></div>
      </div>
      <div class="legend">${b.segments.map((s) => `<div><i class="b-${s.bucket}"></i><b>${BUCKET[s.bucket].label}</b>${esc(short(s.value, a.currency))}<span>${Math.round((100 * s.value) / total)}%, ${BUCKET[s.bucket].hint}</span></div>`).join("")}</div>
    </section>
  </div>`;
}

function power(a) {
  const cols = a.power.map((p) => {
    const deal = a.book.deals.find((d) => d.id === p.deal);
    const cards = Object.keys(ROLE_LABEL).flatMap((role) => {
      const people = p[role];
      if (!people.length) return [`<div class="card none">${ROLE_LABEL[role]}: nobody yet${role === "champion" ? ". This deal has no champion" : ""}</div>`];
      return people.map((e) => `<div class="card ${e.person ? esc(e.stance) : ""}">
          <div class="role"><span>${ROLE_LABEL[role]}</span>${e.person ? `<span>${esc(e.stance)}</span>` : ""}</div>
          <div class="who">${esc(e.name)}</div>
          ${e.role ? `<div class="what">${esc(e.role)}</div>` : ""}
          ${e.note ? `<div class="note">${esc(e.note)}</div>` : ""}
          ${chips([...(e.person ? [e.person] : []), ...e.cites])}
        </div>`);
    }).join("");
    return `<div class="col">
      <div class="col-head">
        <span class="stage"><i class="b-${deal?.bucket === "unvalued" ? "claim" : deal?.bucket ?? "told"}"></i>${esc(p.stage)}</span>
        <h3>${esc(p.title)}</h3>
        <span class="v">${esc(money(deal?.value, a.currency))}</span>
      </div>
      ${cards}
      ${p.waiting_on ? `<div class="waiting"><b>Waiting on:</b> ${esc(p.waiting_on)}</div>` : ""}
    </div>`;
  }).join("");
  return `<section class="panel q" id="${a.id}-power" aria-labelledby="${a.id}-power-h" style="margin-bottom:18px">
    ${panelHead(2, `<span id="${a.id}-power-h">Who holds the power?</span>`, "Blue: ally or warm. Yellow: neutral. Grey: not met")}
    <div class="board">${cols}</div>
  </section>`;
}

function initials(owner) {
  return owner.split(";").map((s) => s.replace(/\(.*?\)/g, "").replace(/\b(for|to)\b.*$/i, "").trim()).filter(Boolean).map((n) => {
    if (/^[A-Z]{2,4}$/.test(n)) return n;
    return n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  });
}

function tile(m, i) {
  const deals = (m.deals ?? []).map((d) => model.sources[d]?.title ?? d).join("; ");
  return `<article class="tile ${m.source === "signal" ? "signal" : i === 0 ? "first" : ""}">
    <div class="tile-top"><span>${m.source === "signal" ? `<span class="live-label">New live event</span>` : `By ${esc(day(m.due))}`}${m.overdue ? ` <span class="tag red">Overdue</span>` : ""}</span><span class="rank" aria-label="Rank ${m.rank}">${m.rank}</span></div>
    <p class="action">${esc(m.action)}</p>
    <p class="deals">Moves: ${esc(deals || "the account")}</p>
    ${m.inside ? `<p class="inside">${icon("flag")}<span>${esc(m.inside)}</span></p>` : ""}
    <p class="why">${esc(m.why)}</p>
    <div class="tile-foot">
      <div style="display:flex;align-items:center;gap:8px"><span class="owners">${initials(m.owner).map((x) => `<span>${esc(x)}</span>`).join("")}</span><span class="owner-name">${esc(m.owner)}</span></div>
    </div>
    ${chips(m.cites)}
  </article>`;
}

function moves(a) {
  const top = a.moves.slice(0, 3);
  const rest = a.moves.slice(3);
  return `<section class="panel q" id="${a.id}-moves" aria-labelledby="${a.id}-moves-h" style="margin-bottom:18px">
    ${panelHead(3, `<span id="${a.id}-moves-h">What do you do first?</span>`, "Ranked by value at stake and how soon it turns bad")}
    <div class="tiles">${top.map(tile).join("")}</div>
    ${rest.length ? `<details class="later"><summary>${icon("list-checks")} Then ${rest.length} more</summary><div class="tiles">${rest.map((m, i) => tile(m, i + 3)).join("")}</div></details>` : ""}
  </section>`;
}

function risks(a) {
  const rows = a.risks.map((r) => `<div class="risk ${esc(r.severity)}">
      <div>
        <div class="title">${esc(r.title)}</div>
        <div class="turns">${r.turns_bad ? `<b>Turns bad:</b> ${esc(r.turns_bad)}` : "No date on file for when this turns bad."}</div>
        ${chips(r.cites)}
      </div>
      <div class="side"><span class="tag ${r.severity === "red" ? "red" : "amber"}">${r.live ? "Live, " : ""}${esc(r.severity)}</span><span class="type">${esc(RISK_TYPE[r.type] ?? "")}</span></div>
    </div>`).join("");
  return `<section class="panel q" id="${a.id}-risks" aria-labelledby="${a.id}-risks-h" style="margin-bottom:18px">
    ${panelHead(4, `<span id="${a.id}-risks-h">What is about to go wrong?</span>`, "Deadlines, stuck deals, cold people, live events")}
    <div class="risk-list">${rows}</div>
  </section>`;
}

function gaps(a) {
  const cards = a.gaps.map((g) => `<article class="gap ${g.type === "claim" ? "claim" : ""}">
      <p class="title">${esc(g.title)}</p>
      <p class="why">${esc(g.why ?? "")}</p>
      ${chips(g.cites)}
      <div class="who"><span class="ic">${icon("user-circle")}</span><div>${g.who ? `<b>${esc(g.who)}</b>${g.how ? `<div class="how">${esc(g.how)}</div>` : ""}` : `<span class="err">No one identified yet</span>`}</div></div>
    </article>`).join("");
  return `<section class="panel q" id="${a.id}-gaps" aria-labelledby="${a.id}-gaps-h" style="margin-bottom:18px">
    ${panelHead(5, `<span id="${a.id}-gaps-h">What do you still not know?</span>`, "Claims nobody checked, deals with no value, missing records")}
    <div class="gap-grid">${cards}</div>
  </section>`;
}

function log() {
  const l = model.live;
  const written = l?.notes_written ?? [];
  const pending = Math.max(0, (model.pending_notes ?? []).length - written.length);
  return `<section class="panel log" aria-label="How this page stays live">
    ${panelHead(0, "How this page stays live")}
    <p>The server reads the game's MCP once a minute at most: new live events, fresh account data, and notes written back with <span class="mono">write_note</span>. New data reaches this page without a code change or a redeploy.</p>
    <ul>
      <li>Last MCP call: ${l?.last_call_at ? `${esc(l.last_tool)} ${esc(ago(l.last_call_at))}` : "none yet from this server"}${l?.last_error ? `. <span class="err">${esc(l.last_error.tool)} failed: ${esc(l.last_error.message)}</span>` : ""}</li>
      <li>Live events last read: ${esc(l?.signals_at ? ago(l.signals_at) : "not yet")}. Accounts last read: ${esc(l?.accounts_at ? ago(l.accounts_at) : "seed snapshot")}.</li>
      <li>Notes written back from this server: ${written.length}${pending ? ` (${pending} queued)` : ""}${written.length ? `, latest "${esc(written.at(-1).title)}" ${esc(ago(written.at(-1).at))}` : ""}.</li>
      <li>Ids cited that are missing from the data: ${model.invalid_cites?.length ? `<span class="err">${model.invalid_cites.length}</span>` : "none"}.</li>
    </ul>
  </section>`;
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
      <dt>Status</dt><dd><span class="tag ${s.status === "verified" ? "blue" : s.status === "claim" ? "amber" : ""}">${esc(s.status)}</span> ${s.status === "claim" ? "may be wrong" : s.status === "told" ? "what a person said" : "backed by a file we hold"}</dd>
      <dt>Learned</dt><dd>Minute ${esc(s.learned_at_minute)} of the morning</dd>
      <dt>Account</dt><dd>${esc(s.account)}</dd>
      ${s.verified_by ? `<dt>Verified by</dt><dd>${chips([s.verified_by])}</dd>` : ""}
    </dl>`;
    if (s.verified_by && model.sources[s.verified_by]) html += `<h3>${esc(model.sources[s.verified_by].title)}</h3>${fileBody(model.sources[s.verified_by].content)}`;
  } else if (s.kind === "file") {
    html = `<dl><dt>Account</dt><dd>${esc(s.account)}</dd><dt>Path</dt><dd class="mono">${esc(s.path)}</dd></dl>${fileBody(s.content)}`;
  } else if (s.kind === "person") {
    html = `<dl><dt>Role</dt><dd>${esc(s.role)}</dd><dt>Stance</dt><dd>${esc(s.relationship)}</dd><dt>Available</dt><dd>${s.available === false ? "No" : "Yes"}</dd><dt>Account</dt><dd>${esc(s.account)}</dd></dl>`;
    const said = Object.values(model.sources).filter((x) => x.kind === "fact" && x.said_by === s.title);
    if (said.length) html += `<h3>What ${esc(s.title)} told us</h3>${said.map((f) => `<blockquote class="small">${esc(f.text)} ${chips([f.id])}</blockquote>`).join("")}`;
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
  const all = model.accounts.flatMap((a) => [
    ...a.signals.map((s) => ({ id: s.id, text: s.text, acct: a.name })),
    ...a.changes.map((c) => ({ id: `change:${c.key}`, text: c.text, acct: a.name })),
  ]);
  let seen;
  try { seen = new Set(JSON.parse(safeGet(SEEN_KEY) ?? "[]")); } catch { seen = new Set(); }
  const fresh = all.filter((s) => !seen.has(s.id));
  const bar = $("#newbar");
  if (!fresh.length) { bar.classList.remove("show"); return; }
  $("#newbar-text").textContent = `${fresh.length} new ${fresh.length > 1 ? "updates" : "update"} since you last looked.`;
  $("#newbar-detail").textContent = fresh.map((s) => `${s.acct}: ${s.text.slice(0, 90)}${s.text.length > 90 ? "…" : ""}`).join("  |  ");
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
    if (!model) $("#main").innerHTML = `<p class="loading-err">Could not load the accounts (${esc(err.message)}). Retrying in a minute.</p>`;
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
