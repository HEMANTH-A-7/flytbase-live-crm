import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, invalidCites, normaliseSignals, classifySignal, backingOf, usageFrom, notesToWrite, parseDate } from "../lib/analyze.js";
import { loadSeed, loadPlan } from "../lib/store.js";

const seed = loadSeed();
const plan = loadPlan();
const build = (extra = {}) => buildModel({
  exp: seed.export, files: seed.files, signals: seed.signals, plan, debrief: seed.debrief,
  team: seed.team, paperwork: seed.paperwork, ...extra,
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
  const signals = { signals: [
    { id: "sig_x", account: "A", date: "18 Nov", text: "Insp. Karen Mbeki wrote directly ahead of a public event on 5 Dec. Nobody has replied." },
    { text: "Rhys Calder leaves the drone programme in January. No successor." },
  ] };
  const m = build({ signals });
  const a = m.accounts.find((x) => x.id === "A");
  assert.equal(a.signals.length, 2, "both events land on account A, the second by the person it names");
  assert.equal(a.moves[0].source, "signal", "an unreviewed event goes to the top of the list");
  assert.ok(a.moves[0].cites.includes("karen_mbeki"));
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
