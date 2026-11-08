# 0004. Control panel: rationale

The decision record behind [index.md](index.md). `/develop` builds from index.md and can skip this file.

## Context

The bot (spec 0003) trades on paper inside the worker, and so far the only way to steer it is `POST /api/bot/commands` with `start`, `stop`, or `kill` from a terminal. The existing React app shows market charts and browser side signals, but nothing from the bot itself: not its state, its positions, its trades, or why it skipped a signal. You can't see whether the bot is doing anything without reading the database.

The workspace is a monorepo: `apps/web` (React 19, Vite, Tailwind, plain JavaScript, no router), `apps/server` (Express API and a separate worker process, TypeScript, Prisma, Neon Postgres about 300 ms away), and `packages/shared` (zod schemas and the pure trading code). Spec 0003 set a load bearing rule: only the worker writes trading tables, and the trader keeps open positions and strategies cached in memory, reloading strategies every 60 seconds. Any change made outside the worker can be invisible to the trader for up to a minute, or race an evaluation already in flight.

The API runs on `127.0.0.1` with no login, for one user. That is safe for reads, but more write actions raise the stakes: any web page open in the same browser can try to send requests to localhost, and a DNS rebinding page can make itself look same origin. Live updates already exist over `/ws`, with small event payloads (spec 0001's rule), and no event carries per position marks.

The panel has to stay honest under failure: the backend, the database, and the worker can each be down on their own, and a control that looks usable while the worker is down would queue a command that silently goes stale after 60 seconds.

## Options considered

### Option 1: Every action is a worker command (chosen)

New `BotCommand` types for enabling and disabling a strategy and closing a position, each with a typed target column. The API checks the request and inserts the command; the worker runs it in the trader's serial queue as one statement that applies the change and records the result.

**Pros**:
- Keeps spec 0003's "only the worker writes" rule, so the trader's cache and the database can't disagree.
- Serial with entries and exits: a toggle can't land halfway through an evaluation, and a close can't race an SL fill.
- One audited path: every action is a row with its result, which is the action log for free.
- Reuses the existing wake (NOTIFY) and 1 second poll, so there's no new plumbing.

**Cons**:
- Every action has a round trip through the database and the worker, so it feels slower than a direct write.
- Nothing works while the worker is down, even a plain flag flip.
- The command handler grows a second path next to the spec 0001 state statement.

### Option 2: The API writes config directly and wakes the worker

`PATCH /api/strategies/:id` updates `Strategy.enabled` itself and NOTIFYs the worker to reload strategies. A manual close would still need a worker command, because it is a fill.

**Pros**:
- The toggle is instant and works while the worker is down.
- A plain REST shape that's familiar.

**Cons**:
- Breaks the "only the worker writes" rule, so the trader can act on a stale cached flag until the reload lands (a signal evaluated just after you disabled the strategy).
- Two write paths (direct for config, commands for trades) to keep consistent and test.
- No built in record of what was changed and when, unless an audit table is added.

### Option 3: Worker polls a config table, no commands

The API writes a desired config row; the worker compares it to the live state on each loop and reconciles.

**Pros**:
- Declarative: the panel sets what it wants, and the worker converges even after a crash.
- Works for future bulk edits (pairs, risk limits) without new command types.

**Cons**:
- Polling adds lag and steady database traffic on a remote database.
- Reconciling a manual close declaratively is awkward (a close is an event, not a state).
- The most new machinery of the three, for a panel with three actions today.

Smaller choices settled in the interview, each with its runner up:
- **Navigation**: hash tabs, no library. Runner up: React Router, worth it only once there are many pages.
- **Data layer**: plain fetch and small hooks. Runner up: TanStack Query, which adds caching, dedupe, and retry, but also a dependency the app doesn't need for about 8 endpoints.
- **Live marks**: refetch open positions on `account.updated`. Runner up: a new marks event, which keeps no refetch but breaks the small payload rule.
- **Command target**: two nullable FK columns with a CHECK. Runner up: one JSON `args` column, more flexible but with no foreign key safety.
- **Write guard**: Origin and Host checks. Runner up: rely on CORS preflight, which leaves DNS rebinding open.
- **Disable behaviour**: keep SL and TP only (as spec 0003 already does). Runners up: close everything on disable, or keep opposite signal exits.
- **Close on a shut market**: pending until tradeable, like a kill. Runner up: reject and let you retry.

## Rationale

Option 1 wins because of spec 0003's own design. The trader caches strategies and positions and runs every write through one serial queue, precisely so that open trade counts, margin, and "one exit per position" can never be broken by interleaving. A direct API write (Option 2) slips past that queue: a 15 minute close can be mid evaluation on the cached `enabled = true` while the API sets it false, and a close written by the API would have to repeat the fill model the trader already owns. Routing the action through the queue keeps every guarantee spec 0003 paid for, at the cost of about a second of latency on a control you click a few times a week. Option 3 would make sense once there are many settings to edit (pairs, risk limits), which this spec defers, and it fits a one off event like "close this position" badly.

The manual close deliberately reuses the kill exit shape (`x:<positionId>`, pending until a live tradeable price). That gives it every property the kill path already has for free: the unique `clientOrderId` means a manual close and a later kill can't both fill, the pending order survives restarts, and forex on a weekend just waits. The cost is that a weekend close can fill far from where you clicked, which is the same tradeoff the kill switch already makes.

The rest follows "boring and small". Two pages don't need a router, and about 8 read endpoints with event driven refetch don't need a query library; both runners up stay easy to add later (a Follow-up names when). Bot state goes into `/api/health` because the page must poll health anyway to detect offline, so one request answers both questions. Refetch on `account.updated` keeps the spec 0001 rule of tiny event payloads, and its 5 second cadence matches how often the worker marks positions anyway, so pushing marks faster would show nothing newer. The Origin and Host guard is about an hour of work and closes the one realistic attack on a no login localhost API: another tab in the same browser.
