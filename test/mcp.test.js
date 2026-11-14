import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRpcBody, unwrapRpc, createGate, callTool, RateLimitedError } from "../lib/mcp.js";

const rpc = (obj) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(obj) }] } });

test("parses plain JSON and SSE replies", () => {
  assert.deepEqual(unwrapRpc(parseRpcBody(rpc({ a: 1 }))), { a: 1 });
  const sse = `event: message\ndata: ${rpc({ b: 2 })}\n\n`;
  assert.deepEqual(unwrapRpc(parseRpcBody(sse)), { b: 2 });
});

test("raises on tool errors and rpc errors", () => {
  assert.throws(() => unwrapRpc({ result: { isError: true, content: [{ text: "bad" }] } }), /tool error: bad/);
  assert.throws(() => unwrapRpc({ error: { message: "nope" } }), /nope/);
});

test("gate allows one call per window and honours seeds and backoff", () => {
  let t = 1_000_000;
  const g = createGate({ minGapMs: 60_000, now: () => t });
  g.take();
  assert.throws(() => g.take(), RateLimitedError);
  t += 60_000;
  g.take();
  g.seed(t + 30_000); // another instance called later
  t += 60_000;
  assert.throws(() => g.take(), RateLimitedError);
  t += 31_000;
  g.take();
  g.backoff(120_000);
  t += 61_000;
  assert.ok(g.waitMs() > 0, "backoff pushes the next slot past the normal window");
});

test("callTool sends the bearer token and handles 429", async () => {
  let seen;
  const g = createGate({ minGapMs: 0 });
  const ok = async (url, init) => { seen = init; return new Response(rpc({ ok: true }), { status: 200 }); };
  assert.deepEqual(await callTool("whoami", {}, { token: "t0k", fetchImpl: ok, g }), { ok: true });
  assert.equal(seen.headers.authorization, "Bearer t0k");
  assert.equal(JSON.parse(seen.body).params.name, "whoami");

  const limited = async () => new Response("", { status: 429, headers: { "retry-after": "30" } });
  await assert.rejects(callTool("whoami", {}, { token: "t", fetchImpl: limited, g }), RateLimitedError);
});

test("callTool refuses to run without a token", async () => {
  await assert.rejects(callTool("whoami", {}, { token: "" }), /AQ_TOKEN/);
});
