// GET /api/health: is the server configured? Says whether a token is set, never what it is.
export function GET() {
  return Response.json({
    ok: true,
    token_configured: Boolean(process.env.AQ_TOKEN),
    mcp_calls_per_minute: 1,
  }, { headers: { "cache-control": "no-store" } });
}
