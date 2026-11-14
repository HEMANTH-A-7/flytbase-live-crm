# Account book

**Live:** https://flytbase-live-crm-psi.vercel.app

A live CRM for the FlytBase accounts in Account Quest: Eastern Counties Police Alliance (A) and Aldermoor Industrial Group (B) from the morning, plus any account the game releases later, such as Kestrel Estates (K). It is the page you would hand your manager on Monday. For each account it answers five questions, and every number on it opens the record it came from.

1. **What is the book worth?** Each deal at its value, split by how well it is backed: agreed or won, backed by a verified fact or a file we hold, told only, or claimed only. Deals with no value and numbers nobody has backed are shown apart and never added.
2. **Who holds the power?** For each deal: who decides, who pays, who uses it, who could block it, who champions it, where each stands with us, and what each person is waiting on.
3. **What do you do first?** Moves ranked by a score (value at stake × chance it works × urgency), each with an owner, a date, the deal it moves, the deadline it sits inside, and a ready draft.
4. **What is about to go wrong?** A red, amber or green radar per deal, then every risk (deadlines, stuck deals, cold deciders and payers, live events) with when it turns bad.
5. **What do you still not know?** Claims nobody checked, deals with no value and missing records, with why each matters and who could fill it.

Data comes from the Account Quest MCP. New data renders by itself: live events, changed accounts and newly released accounts appear without a code change or a redeploy, and the top moves and red risks are written back to the game with `write_note`. A strip at the top shows the morning result from the game's leaderboard (rank, score, closed, insight, people unlocked, moves), checked against the closed total this CRM computes.

## Run it

Requires Node 22.9 or later. One runtime dependency, `@vercel/blob`, for the live state shared between server copies.

```sh
npm install
cp .env.example .env          # then put your token after AQ_TOKEN=
npm test                      # 34 tests, including "no invented ids"
npm run dev                   # http://localhost:3000
```

Without a token the page runs on the committed seed snapshot (`data/seed/`) and says so in the header. On a laptop the live state is kept in `.cache/overlay.json`.

To re-take the seed snapshot (about 20 minutes, one call a minute):

```sh
npm run snapshot
```

## Deploy (Vercel)

```sh
vercel link
grep '^AQ_TOKEN=' .env | cut -d= -f2- | tr -d '\n' | vercel env add AQ_TOKEN production --sensitive --yes
vercel blob create-store crm-live-state --access private --environment production --yes
vercel --prod
```

The token is read from `.env` and stored as a secret, never pasted. The Blob store adds its own access key to the project. Turn off deployment protection, so the page opens in a private window without a Vercel login.

## How it stays live

The game allows **one call per minute per token**, writes included. There is no long-running process. Instead, every request to `/api/state` may spend at most one call, and only when the minute window is open (`lib/live.js`, `nextJob`). In order of priority:

1. `whoami`, first on a fresh server copy, to learn about released accounts and which accounts are open
2. `get_new_account` for any released account not yet held
3. `get_signals`, the live events
4. `get_new_account_file` for each file of a released account, then `get_all_paperwork` for any open account whose paperwork is not held
5. `list_notes`, once, so notes already on the server are never sent again
6. `write_note` for the next pending note (top three moves per account, every red risk), never twice in a row
7. otherwise a rotation of `get_signals`, `whoami` and `get_my_accounts`

The live state (events, released accounts, files, paperwork, notes already written) is shared between server copies through a private Vercel Blob. Copies merge what they learn instead of overwriting each other (`mergeOverlays`), and re-read the shared state at most once a minute. Events only accumulate: the snapshot and every live read are merged by id, so a stale read never hides one.

The browser polls once a minute. A failed or rate-limited call keeps the last good data and is reported in the page footer. Data that arrives while the evidence drawer is open renders when it closes.

A new live event the plan has never seen:

- lands on the right account, by its `account` field or by the person it names (events for an account not loaded yet still reach the banner)
- brings its records (a new email, rows added to a log) in as citable sources, and new usage rows count in the usage window
- becomes a red risk
- gets a move, scored like the rest, with a draft to the person it names or the account's main contact
- raises a "new since you last looked" banner and appears under "Since this morning"

Once someone has reviewed the event, its id goes into the account's `handled_signals` in `data/plan.json`, with a move written for it.

The token stays in a server environment variable. It never reaches the browser, and `/api/health` reports only whether it is set.

## Accounts released later

Rule: new data from the MCP renders by itself. The reviewed plan only adds judgement on top; nothing waits for it.

A released account appears next to the others with all five answers, and its arrival shows under "Since this morning". Until it is reviewed in `data/plan.json` it is analysed by rule and labelled "analysed by rule, not reviewed yet":

- roles are inferred from role titles and from what each person said (`inferPower`), each marked as inferred
- moves come from open blockers and unsized deals (`defaultMoves`)
- deadlines counted in game minutes become days left on that account's own clock (`daysLeft`)
- the headline states the open blockers and unconfirmed claims, and quotes the account sheet

## The six ideas from the toolkit

- **Next best action:** every move is scored as value at stake × chance it works × urgency, and ranked by the score (`scoreMove`). Agreed deals count at a tenth, because a move protects them rather than wins them. Urgency is 21 ÷ days to the deadline, kept between 0.4 and 3 (1 for a known deadline with no date, 0.5 with no deadline). The working is printed on every move.
- **Risk radar:** red, amber or green per deal for the deadline, the deciders and payers (red if one is leaving, amber if one is cold or not met), and the blocker (`riskRadar`).
- **Book with receipts:** every deal at its value, with the ids that back it, and what cannot be backed shown apart (`bookFor`).
- **Power map:** who decides, pays, uses, blocks and champions each deal, where each stands, and what each person is waiting on from us (`powerFor`).
- **Blind-spot finder:** claims nobody checked, deals with no value and missing records, with why each matters and who could fill it (`gapsFor`).
- **Draft writer:** each move has a ready message to the customer, quoting the evidence with its ids and never a claim, plus the internal request with an owner and a date (`draftFor`).

## How it decides

- **Book.** Value is the deal's `worth_up_to` from the export. An agreed deal or won offer counts as agreed or won. An open deal is *backed* if at least one of its evidence ids is a verified fact or a file we hold, *told* if it rests only on what people said, and *claimed* if only on claims. Claims that contain a number (for example "ROI is proven, about 1.2 million euros a year saved") are listed apart and never summed.
- **Power.** For reviewed accounts, analyst judgement in `data/plan.json` with a source for every role; otherwise inferred, as above. A stance comes from the export's relationship field.
- **Risks.** Derived where possible: deadlines not yet passed (on deals and on the account), open blockers, people who are neutral or guarded while holding a deciding, paying or blocking role, and live events. The plan adds when each turns bad, and risks the data cannot derive (single-threading, unanswered emails, idle docks).
- **Usage.** Computed from each account's `usage_weekly.csv`, plus rows that arrive with events, over the last four logged weeks: docks with no flights, and the share flown by the busiest five.
- **Gaps.** Every `claim` fact, every deal with no value, and the missing records in the plan, each with why it matters and who could fill it.
- **In-world date.** "Today" follows the latest dated live event, so moves that slip show as overdue.

## No invented ids

Every `cites` list is checked against the data: export facts, people, deals, offers and files; paperwork records (cited as `A/<path>`); live events and the records they bring (`<path>`, or `<path>#<event>` for a row added to an existing log); the FlytBase team; the morning debrief; and the morning scorecard (`player_card`). `test/analyze.test.js` fails if any id is missing, and `/api/state` reports `invalid_cites` at runtime as well.

## Layout

```
api/state.js       GET: the five answers for every account, with every source
api/health.js      GET: is a token configured (never its value)
lib/mcp.js         JSON-RPC client: JSON or SSE replies, one-call-a-minute gate, 429 backoff
lib/live.js        one due call per request, call priority, account discovery, shared-state merge
lib/analyze.js     pure functions: raw data in, five answers out
lib/store.js       seed snapshot loader, and the live state shared through a private Vercel Blob
data/seed/         snapshot of the game data: export, paperwork, files, events, released
                   accounts (drop_<id>.json), debrief and scorecard (no secrets)
data/plan.json     analyst judgement: power roles, ranked moves, drafts, risk timing, gap owners
public/            the page: vanilla HTML, CSS and JS, no build step
scripts/           dev server, the snapshot script, and fetch-drop for a released account
test/              node:test suites
```

## What it does not do yet

- Re-rank the reviewed plan after an event: a new event gets a scored default move and a draft until someone reviews it.
- Re-read paperwork: it is read once (into the seed for A and B, live when a released account arrives), because it is history and the call budget is one a minute.
- Learn the chance of success from outcomes: the chances are estimates, each shown with its reason.
- Send the drafts: a person reviews and sends them.
