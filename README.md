# Account book

A live CRM for two FlytBase accounts: Eastern Counties Police Alliance (A) and Aldermoor Industrial Group (B). It is the page you would hand your manager on Monday. For each account it answers five questions, and every number on it opens the record it came from.

1. **What is the book worth?** Each deal at its value, split by how well it is backed: agreed or won, backed by a verified fact or a file we hold, told only, or claimed only. Deals with no value and numbers nobody has backed are shown apart and never added.
2. **Who holds the power?** For each deal: who decides, who pays, who uses it, who could block it, who champions it, and where each stands with us.
3. **What do you do first?** Moves ranked by value at stake and how soon things turn bad, each with an owner, a date and the deal it moves.
4. **What is about to go wrong?** Deadlines, stuck deals, cold deciders and payers, and live events, with when each one turns bad.
5. **What do you still not know?** Claims nobody checked, deals with no value and missing records, with who could fill each gap.

Data comes from the Account Quest MCP. Live events arrive while the page is open, without a code change or a redeploy, and the top moves and red risks are written back to the game with `write_note`.

## Run it

Requires Node 22.9 or later. There are no runtime dependencies.

```sh
cp .env.example .env          # then put your token after AQ_TOKEN=
npm test                      # 18 tests, including "no invented ids"
npm run dev                   # http://localhost:3000
```

Without a token the page runs on the committed seed snapshot (`data/seed/`) and says so in the header.

To re-take the seed snapshot (about 20 minutes, one call a minute):

```sh
npm run snapshot
```

## Deploy (Vercel)

```sh
vercel link
vercel env add AQ_TOKEN production    # paste the token when asked; it is stored encrypted
vercel --prod
```

Turn off deployment protection, so the page opens in a private window without a Vercel login.

## How it stays live

The game allows **one call per minute per token**, writes included. There is no long-running process. Instead, every request to `/api/state` may spend at most one call, and only when the minute window is open (`lib/live.js`):

1. `get_signals`, the first time an instance starts
2. `list_notes`, once, so notes already on the server are never sent again
3. `write_note` for the next pending note (top three moves per account, every red risk), never twice in a row
4. otherwise `get_signals`, with `get_my_accounts` every third call

The browser polls once a minute. A failed or rate-limited call keeps the last good data and is reported in the page footer. A new live event the plan has never seen:

- lands on the right account, by its `account` field or by the person it names
- becomes a red risk
- goes to the top of the moves as "reply to the person it names, next working day, owner: account owner"
- raises a "new since you last looked" banner

None of this needs a code change. Once someone has reviewed the event, its id goes into `handled_signals` in `data/plan.json`.

The token stays in a server environment variable. It never reaches the browser, and `/api/health` reports only whether it is set.

## How it decides

- **Book.** Value is the deal's `worth_up_to` from the export. An agreed deal or won offer counts as agreed or won. An open deal is *backed* if at least one of its evidence ids is a verified fact or a file we hold, *told* if it rests only on what people said, and *claimed* if only on claims. Claims that contain a number (for example "ROI is proven, about 1.2 million euros a year saved") are listed apart and never summed.
- **Power.** Analyst judgement, in `data/plan.json`, with a source for every role. A stance comes from the export's relationship field.
- **Risks.** Derived where possible: deadlines not yet passed, open blockers, and people who are neutral or guarded while holding a deciding, paying or blocking role. The plan adds when each turns bad, and risks the data cannot derive (single-threading, unanswered emails, idle docks).
- **Usage.** Computed from each account's `usage_weekly.csv` over the last four logged weeks: docks with no flights, and the share flown by the busiest five.
- **Gaps.** Every `claim` fact, every deal with no value, and the missing records in the plan, each with who could fill it.

## No invented ids

Every `cites` list is checked against the data, which covers export facts, people, deals, offers and files, paperwork records (cited as `A/<path>`), live events, the FlytBase team and the morning debrief. `test/analyze.test.js` fails if any id is missing, and `/api/state` reports `invalid_cites` at runtime as well.

## Layout

```
api/state.js      GET: the five answers for both accounts, with every source
api/health.js     GET: is a token configured (never its value)
lib/mcp.js        JSON-RPC client: JSON or SSE replies, one-call-a-minute gate, 429 backoff
lib/live.js       one due call per request, call priority, write-back de-duplication
lib/analyze.js    pure functions: raw data in, five answers out
lib/store.js      seed snapshot loader and the small live overlay
data/seed/        snapshot of the game data (no secrets)
data/plan.json    analyst judgement: power roles, ranked moves, risk timing, gap owners
public/           the page: vanilla HTML, CSS and JS, no build step
scripts/          dev server and the snapshot script
test/             node:test suites
```

## What it does not do yet

- Moves come from the plan. A new event gets a sensible default move, but re-ranking the whole plan after an event still takes a person.
- Paperwork is read once into the seed. Only accounts and live events are re-read live, because the paperwork is history and the call budget is one a minute.
- The live overlay is kept per server instance. A cold start rebuilds it within a call or two.
