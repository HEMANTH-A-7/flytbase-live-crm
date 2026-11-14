import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, invalidCites, normaliseSignals, classifySignal, backingOf, usageFrom, notesToWrite, parseDate } from "../lib/analyze.js";
import { loadSeed, loadPlan } from "../lib/store.js";
import * as liveMod from "../lib/live.js";

const seed = loadSeed();
const plan = loadPlan();
const build = (extra = {}) => buildModel({
  exp: seed.export, files: seed.files, signals: seed.signals, plan, debrief: seed.debrief,
  team: seed.team, paperwork: seed.paperwork, playerCard: seed.playerCard, ...extra,
});

test("every id the CRM cites exists in the data (no invented ids)", () => {
  const bad = invalidCites(build());
  assert.deepEqual(bad, [], `invented or mistyped ids: ${JSON.stringify(bad.slice(0, 10))}`);
});

test("every person, deal and signal id in plan.json is real", () => {
  const src = build().sources;
  for (const [acct, p] of Object.entries(plan.accounts)) {
    for (const [deal, roles] of Object.entries(p.power)) {
      assert.ok(src[deal], `${acct}: unknown deal ${deal}`);
      for (const list of Object.values(roles)) {
        if (!Array.isArray(list)) continue;
        for (const e of list) if (e.person) assert.ok(src[e.person], `${acct}/${deal}: unknown person ${e.person}`);
      }
    }
    for (const m of p.moves) for (const d of m.deals) assert.ok(src[d], `move ${m.key}: unknown deal ${d}`);
  }
});

test("book: closed is agreed deals plus won offers, and claims are never added", () => {
  const m = build();
  for (const a of m.accounts) {
    const exp = seed.export.accounts.find((x) => x.id === a.id);
    const closed = exp.opportunities.filter((o) => o.stage === "agreed").reduce((n, o) => n + o.worth_up_to, 0)
      + exp.offers.filter((o) => o.status === "won").reduce((n, o) => n + o.value, 0);
    assert.equal(a.book.segments.find((s) => s.bucket === "closed").value, closed);
    assert.equal(a.book.total.value, a.book.segments.reduce((n, s) => n + s.value, 0));
    for (const c of a.book.claimed) assert.ok(!a.book.total.cites.includes(c.id));
  }
});

test("five answers exist for both accounts, and moves are ranked, owned and dated", () => {
  const m = build();
  assert.equal(m.accounts.length, 2);
  for (const a of m.accounts) {
    assert.ok(a.book.deals.length > 0, `${a.id} book`);
    assert.ok(a.power.every((p) => p.decides.length > 0), `${a.id}: every deal names who decides`);
    assert.ok(a.moves.length >= 3, `${a.id} moves`);
    for (const mv of a.moves.slice(0, 3)) {
      assert.ok(mv.owner && /^\d{4}-\d{2}-\d{2}$/.test(mv.due) && mv.deals?.length, `${a.id} move ${mv.key} needs owner, date, deal`);
    }
    assert.deepEqual(a.moves.map((x) => x.rank), a.moves.map((_, i) => i + 1));
    assert.ok(a.risks.length > 0 && a.gaps.length > 0);
    assert.ok(a.risks.every((r) => r.cites.length > 0), `${a.id}: every risk cites a source`);
  }
});

test("the first three moves are in the order you would do them, each inside a stated deadline", () => {
  for (const a of build().accounts) {
    const top = a.moves.slice(0, 3);
    const dues = top.map((m) => m.due);
    assert.deepEqual(dues, [...dues].sort(), `${a.id}: rank order and due dates disagree: ${dues}`);
    for (const m of top) assert.ok(m.inside, `${a.id} ${m.key}: say which deadline it sits inside`);
  }
});

test("risks and gaps read as sentences: no raw ids or undefined in titles", () => {
  for (const a of build().accounts) {
    for (const r of a.risks) {
      assert.ok(!/undefined|\b[ab]_[a-z]+\b/.test(`${r.title} ${r.turns_bad ?? ""}`), `${a.id} ${r.key}: "${r.title}"`);
    }
    for (const g of a.gaps) assert.ok(g.why && g.who, `${a.id} gap ${g.key} needs why and who`);
  }
});

test("backing: a held file or verified fact backs a deal; claims alone do not", () => {
  const src = { f: { kind: "fact", status: "claim" }, v: { kind: "fact", status: "verified" }, file1: { kind: "file" } };
  assert.equal(backingOf(["f"], src).level, "claim");
  assert.equal(backingOf(["f", "v"], src).level, "verified");
  assert.equal(backingOf(["file1"], src).level, "verified");
  assert.deepEqual(backingOf(["nope"], src).missing, ["nope"]);
});

test("usage: idle docks and concentration are computed from the weekly log", () => {
  const csv = "week_start,dock_id,flights,days_online\n2026-10-05,D1,10,7\n2026-10-05,D2,0,7\n2026-10-12,D1,5,7\n2026-10-12,D2,0,7";
  const u = usageFrom(csv, "X/usage_weekly.csv");
  assert.equal(u.docks, 2);
  assert.equal(u.idle, 1);
  assert.equal(u.flights, 15);
  assert.equal(u.regular, 1);
});

test("a new live event is picked up without a code or plan change", () => {
  // Live events only accumulate, so new ones arrive on top of the real ones.
  const signals = { signals: [
    ...seed.signals.signals,
    { id: "sig_x", account: "A", date: "18 Nov", text: "Insp. Karen Mbeki wrote directly ahead of a public event on 5 Dec. Nobody has replied." },
    { text: "Ewan Brooks says Metro Central has frozen new spending until April. No successor for the budget line." },
  ] };
  const m = build({ signals });
  const a = m.accounts.find((x) => x.id === "A");
  assert.equal(a.signals.length, 4, "both new events land on account A, the second by the person it names");
  const intake = a.moves.filter((m) => m.source === "signal");
  assert.ok(intake.length >= 1 && intake.some((m) => m.rank <= 3), "an unreviewed event lands in the first three moves");
  assert.ok(intake.some((m) => m.cites.includes("karen_mbeki")));
  assert.ok(a.risks.some((r) => r.key === "signal:sig_x" && r.severity === "red"));
  assert.deepEqual(invalidCites(m), []);
});

test("signals with unknown shapes still normalise to id, text and date", () => {
  const [s] = normaliseSignals([{ message: "Three docks stopped flying", when: "2026-11-30" }]);
  assert.ok(s.id && s.text === "Three docks stopped flying" && s.date === "2026-11-30");
  assert.deepEqual(classifySignal(s, []).kinds, ["usage_drop"]);
  assert.equal(parseDate("30 Nov", 2026).toISOString().slice(0, 10), "2026-11-30");
});

test("write-back notes have stable titles, so a redeploy never sends one twice", () => {
  const a = notesToWrite(build()).map((n) => n.title);
  const b = notesToWrite(build()).map((n) => n.title);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

test("changes that arrive through get_my_accounts are listed with their ids", async () => {
  const { diffAccount } = await import("../lib/analyze.js");
  const before = seed.export.accounts.find((a) => a.id === "B");
  const after = structuredClone(before);
  after.facts.push({ id: "nr_budget_1", text: "Finance will fund the renewal from the group budget.", said_by: "Nadia Rahman", status: "told", learned_at_minute: 150 });
  after.opportunities.find((o) => o.id === "b_idle").blocker.status = "cleared";
  after.stakeholders.find((p) => p.id === "nadia_rahman").relationship = "warm";
  const kinds = diffAccount(before, after).map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["blocker", "new_fact", "stance"]);
  const m = build({ exp: { ...seed.export, accounts: seed.export.accounts.map((a) => (a.id === "B" ? after : a)) }, seedExport: seed.export });
  assert.equal(m.accounts.find((a) => a.id === "B").changes.length, 3);
  assert.deepEqual(invalidCites(m), [], "the new fact id is citable once it arrives");
});

test("a dated live event moves in-world today forward, and older moves show as overdue", () => {
  const m = build({ signals: { signals: [{ id: "s_late", account: "A", date: "15 Dec", text: "Something happened." }] } });
  assert.equal(m.today, "2026-12-15");
  assert.ok(m.accounts.find((a) => a.id === "A").moves.some((x) => x.overdue));
  assert.ok(build().accounts.every((a) => a.moves.every((x) => !x.overdue)));
});

test("next best action: score is value at stake x chance x urgency, and ranks follow the score", async () => {
  const { scoreMove } = await import("../lib/analyze.js");
  const acct = seed.export.accounts.find((x) => x.id === "A");
  const today = new Date("2026-11-18T00:00:00Z");
  const s = scoreMove({ deals: ["a_renewal", "a_westmere"], chance: 0.5, deadline_date: "2026-12-09" }, acct, today);
  assert.equal(s.value, 350000 + 250000 * 0.1, "agreed deals count at a tenth");
  assert.equal(s.urgency, 1, "21 days out is urgency 1");
  assert.equal(s.score, Math.round(375000 * 0.5 * 1));
  assert.equal(scoreMove({ deals: ["a_tarn"], chance: 1 }, acct, today).urgency, 0.5, "no deadline");
  assert.equal(scoreMove({ deals: ["a_tarn"], chance: 1, deadline_date: "2026-11-19" }, acct, today).urgency, 3, "three days or less is the cap");
  for (const a of build().accounts) {
    const scores = a.moves.map((m) => m.score.score);
    assert.deepEqual(scores, [...scores].sort((x, y) => y - x), `${a.id}: ranks follow the score`);
  }
});

test("risk radar: one row per deal with red, amber or green for deadline, people and blocker", () => {
  const a = build().accounts.find((x) => x.id === "A");
  assert.equal(a.radar.length, a.book.deals.length);
  const renewal = a.radar.find((r) => r.deal === "a_renewal");
  assert.equal(renewal.blocker.rag, "red", "open blocker");
  assert.equal(renewal.people.rag, "red", "Rhys Calder decides and the live event says he is leaving");
  assert.ok(renewal.people.cites.includes("champion_leaves"));
  assert.equal(a.radar.find((r) => r.deal === "a_tender").deadline.rag, "green", "spec lock passed and met");
});

test("draft writer: every draft has a recipient, evidence from the record, and never quotes a claim", () => {
  const m = build();
  for (const a of m.accounts) {
    for (const mv of a.moves) {
      assert.ok(mv.draft.to, `${a.id} ${mv.key}: draft needs a recipient`);
      for (const e of mv.draft.evidence) assert.notEqual(m.sources[e.id].status, "claim", `${mv.key} quotes claim ${e.id}`);
    }
  }
  const karen = m.accounts.find((x) => x.id === "A").moves.find((x) => x.key === "a_karen_event");
  assert.equal(karen.draft.internal.to, "Pranjal Suyal");
});

test("the real live events are read: date, records and reviewed moves", () => {
  const a = build().accounts.find((x) => x.id === "A");
  assert.deepEqual(a.signals.map((s) => s.id).sort(), ["champion_leaves", "urgent_request"]);
  assert.equal(a.signals.find((s) => s.id === "urgent_request").date, "2026-11-18");
  assert.ok(build().sources["A/emails/2026-11-18_karen_event.txt"], "event records are citable");
  assert.ok(build().sources["A/requests.csv#urgent_request"], "a row added to an existing log gets its own id");
  assert.ok(a.moves.every((m) => m.source !== "signal"), "both events are reviewed in the plan");
  assert.equal(a.moves[0].key, "a_karen_event");
});

test("the morning scorecard is cited, and its closed total matches the one the CRM computes", () => {
  const m = build();
  assert.ok(m.sources.player_card, "scorecard is a citable source");
  assert.equal(m.player.closed, 1905000);
  assert.equal(m.player.computed_closed, 1905000);
  assert.ok(m.player.closed_matches);
  assert.deepEqual(invalidCites(m), []);
});

test("a released account with no plan still gets all five answers, by rule", () => {
  const { currentExport } = liveMod;
  const m = build({ exp: currentExport(seed.export, null, seed.drops) });
  const k = m.accounts.find((a) => a.id === "K");
  assert.ok(k, "account K is in the model");
  assert.equal(k.reviewed, false);
  assert.ok(k.headline.startsWith("New account"));
  assert.ok(k.book.deals.length && k.power.every((p) => p.decides.length), "decider inferred for every deal");
  assert.ok(k.moves.length >= 1 && k.moves.every((x) => x.source === "rule" && x.draft.to));
  assert.ok(k.risks.some((r) => r.type === "deadline" && r.severity === "red"), "a deadline about two days out is red");
  assert.ok(k.radar.length && k.gaps.length);
  assert.deepEqual(invalidCites(m), []);
});

test("usage rows that arrive with an event are added before the four weeks are taken", () => {
  const b = build().accounts.find((a) => a.id === "B");
  assert.equal(b.usage.to, "2026-11-23", "the window now ends with the event's rows");
  assert.ok(b.usage.cites.includes("B/usage_weekly.csv#usage_drop"));
});

test("an event for an account that has not loaded yet is still surfaced", () => {
  const m = build({ signals: { signals: [...seed.signals.signals, { id: "z1", account: "Z", text: "Something at a new account." }] } });
  assert.ok(m.unassigned_signals.some((s) => s.id === "z1"));
});

test("account-level deadlines that belong to no deal are shown too", () => {
  const k = build({ exp: liveMod.currentExport(seed.export, null, seed.drops) }).accounts.find((a) => a.id === "K");
  const plan = k.risks.find((r) => r.title === "Go-live plan promised to Dana");
  assert.ok(plan, "the go-live plan deadline is a risk");
  assert.equal(plan.severity, "red");
  assert.match(plan.turns_bad, /about 2 days/);
});
