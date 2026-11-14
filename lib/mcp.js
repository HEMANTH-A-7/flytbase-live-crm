// JSON-RPC client for the Account Quest MCP endpoint.
// The token stays server-side (process.env.AQ_TOKEN). The game allows one call
// per minute per token, writes included, so every call goes through `gate`.

export const MCP_URL = "https://questathon.aihackerscollective.com/api/public/mcp";
export const MIN_GAP_MS = 61_000;

export class RateLimitedError extends Error {
  constructor(waitMs) {
    super(`rate limited, next call in ${Math.ceil(waitMs / 1000)}s`);
    this.waitMs = waitMs;
  }
}

// Accepts a plain JSON body or an SSE stream of `data: {...}` lines.
export function parseRpcBody(body) {
  const t = String(body).trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const lines = t.split("\n").filter((l) => l.startsWith("data:"));
  if (!lines.length) throw new Error(`unreadable MCP reply: ${t.slice(0, 120)}`);
  return JSON.parse(lines.at(-1).slice(5));
}

// Unwraps result.content[0].text, raising on JSON-RPC or tool errors.
export function unwrapRpc(msg) {
  if (msg.error) throw new Error(`MCP error: ${msg.error.message ?? JSON.stringify(msg.error)}`);
  const text = msg.result?.content?.[0]?.text;
  if (msg.result?.isError) throw new Error(`tool error: ${text}`);
  if (text == null) throw new Error("MCP reply had no content");
  try { return JSON.parse(text); } catch { return { text }; }
}

// Single-slot limiter. `lastCallAt` can be seeded from persisted state so a
// fresh serverless instance respects a call made by another instance.
export function createGate({ minGapMs = MIN_GAP_MS, now = () => Date.now() } = {}) {
  let lastCallAt = 0;
  return {
    get lastCallAt() { return lastCallAt; },
    seed(t) { if (t > lastCallAt) lastCallAt = t; },
    waitMs() { return Math.max(0, lastCallAt + minGapMs - now()); },
    take() {
      const w = this.waitMs();
      if (w > 0) throw new RateLimitedError(w);
      lastCallAt = now();
    },
    // Called on 429: push the next slot out by the server's Retry-After.
    backoff(ms) { lastCallAt = Math.max(lastCallAt, now() + ms - minGapMs); },
  };
}

export const gate = createGate();

export async function callTool(name, args = {}, { token = process.env.AQ_TOKEN, fetchImpl = fetch, timeoutMs = 15_000, g = gate } = {}) {
  if (!token) throw new Error("AQ_TOKEN is not set");
  g.take();
  const res = await fetchImpl(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after")) || 60;
    g.backoff(retry * 1000);
    throw new RateLimitedError(retry * 1000);
  }
  const body = await res.text();
  if (!res.ok && !body.trim()) throw new Error(`MCP HTTP ${res.status}`);
  return unwrapRpc(parseRpcBody(body));
}
