// GET /api/state: the five answers for both accounts, with every source.
// May spend one MCP call to stay live (see lib/live.js). Never exposes the token.
import { getState } from "../lib/live.js";
import { invalidCites } from "../lib/analyze.js";

export async function GET() {
  try {
    const model = await getState();
    return Response.json(
      { ...model, invalid_cites: invalidCites(model) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("state failed:", err);
    return Response.json({ error: "Could not build the CRM state." }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
