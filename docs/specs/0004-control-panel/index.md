# 0004. Control panel: a Bot page driven by worker commands

**Date**: 2026-10-29
**Status**: In Progress

## Summary

The web app gets a second page, Bot, next to the existing Market dashboard. From it you start, stop, and kill the bot, switch each strategy on or off, close one position by hand, and watch the account, positions, trades, signals, equity, and feed health update live. Every action you take is sent as a command that the worker carries out, so the worker stays the only writer of trading data and every action is recorded. Pair and risk limit editing is deferred until backtesting can show whether a change helps.

## Requirements

**User stories**:
- As the bot owner, I want to start, stop, and kill the bot from a page on `localhost`, so that I don't need a terminal or curl to control it.
- As the bot owner, I want to switch a strategy off without stopping the whole bot, so that I can pause one market (say, forex before news) and keep the other trading.
- As the bot owner, I want to close one position by hand, so that I can exit a single trade without killing everything.
- As the bot owner, I want everything on the page to update on its own and to tell me clearly when the bot, the worker, or the backend is down, so that I never act on stale numbers.

**Acceptance criteria**:
- **AC-1**: The web app has two pages, Market (today's dashboard, unchanged) and Bot, switched from the top nav. The page is chosen by the URL hash (`#/bot` for Bot; empty or anything else is Market), so a refresh keeps the page and the browser back button works. No router library is added.
- **AC-2**: The Bot page status bar shows the bot state (`running`, `idle`, `killed`), the worker status (`up`, `down`, `none`), and the last heartbeat time. Start is enabled in `idle` and `killed`, Stop in `running`, and Kill in `running` and `idle`. Kill opens a confirm dialog that names how many positions are open. Start and Stop act at once with no dialog. While a command is pending, its button shows a spinner and is disabled, and the result (`done`, or `failed` with the error) shows when `command.handled` arrives for that command id.
- **AC-3**: Each strategy row has an on/off switch. Flipping it sends an `enable_strategy` or `disable_strategy` command. The worker sets `Strategy.enabled` and the trader uses the new value from its next queue job (no wait for the 60 second strategy refresh). A disabled strategy is not evaluated, so it makes no new entries and no opposite signal exits. Its open positions still close by SL, TP, kill, or a manual close (spec 0003 behaviour). Sending the value the strategy already has is `done` and changes nothing.
- **AC-4**: Each open position row with no pending exit order has a Close button (in any bot state) that opens a confirm dialog ("Close BTCUSDT long at market?"). Confirming sends a `close_position` command. The worker creates a pending exit order (`clientOrderId` `x:<positionId>`, reason `manual`). It fills the same way a kill exit does: at once if the feed is `live` (forex: tradeable), else at the first live tradeable price. The position closes with `closeReason` `manual`. The pending order survives a worker restart and a later `kill` (the kill sweep skips a position that already has an exit order). Until it fills, the row shows a "closing, waiting for a tradeable price" badge and no Close button. If an SL or TP fires on the same quote, the close reason is still `manual` (a pending exit wins, as a pending kill does today). While a manual exit is pending, an opposite Strong signal does not close the position again; that signal is saved `skipped` with `already_open`.
- **AC-5**: Commands are checked before they are queued. An unknown strategy or position gives 404. A position that is closed, or already has a pending exit order (kill or manual), gives 409. A second command with the same type and the same target while one is pending gives 409 (today's rule, now per target). If the state changes between that check and the worker handling it, the command ends `failed` with one of these errors: `position not open`, `position already closing`, `trader not running`. Nothing else is written. A command whose job throws is marked `failed` with the error text and never stays `pending`, so it can't block the commands behind it. Commands run one at a time, oldest first, across every type.
- **AC-6**: The page updates without a reload. Each WebSocket event refetches the sections it affects (the map in *Live updates*). Open position marks and unrealized PnL refresh on `account.updated`, so they are never more than about 5 seconds behind the worker's own marks. After a WebSocket reconnect, every section refetches.
- **AC-7**: When the backend can't be reached, the page shows a "Backend offline" banner. When `/api/health` reports the database down, the banner says "Database down" (the worker block is ignored then). When the worker is `down` or `none`, it says "Worker down since <last heartbeat, UTC>" ("Worker never started" with no heartbeat), and the bot state shows dimmed with "(worker down)". Only the first that applies shows, in that order; "Live updates paused" (socket closed, all else fine) comes last. In the first three, every control (Start, Stop, Kill, switches, Close) is disabled, data stays on screen dimmed with its "last updated" time, and the page retries every 5 seconds and recovers on its own when the backend is back.
- **AC-8**: The Bot page shows these sections: status bar and controls; account summary (balance, equity, margin used, free margin, today's realized PnL, open positions count); strategies (name, switch, pairs, risk limits read only, open positions, today's PnL, a "halted" badge when the daily loss limit tripped); open positions (symbol, strategy, side, qty, entry, SL, TP, mark, unrealized PnL, opened at, closing badge, Close); closed trades (newest first, close reason including `manual`, realized PnL, fees, "Load more" paging); signals log (newest first, outcome, skip reason, indicators on expand, "Load more"); equity chart (equity line from the 15 minute snapshots, 1 day, 7 days, or 30 days); feed health (each pair's feed state, last tick time, last error); action log (your last 20 commands with type, target, status, and error).
- **AC-9**: Every money value is formatted from its decimal string without floating point math: USD amounts to 2 decimals (half even), prices to the decimals of the instrument's `tickSize`, quantities to the decimals of its `minQty` (both truncated, never rounded up). The decimals are the digits after the point in that string with trailing zeros trimmed (`"0.010"` gives 2). `-0.00` shows as `0.00`. The one exception is the equity chart's series, which needs plain numbers for drawing; its tooltip still formats with `Money`. Every time is shown in UTC as `YYYY-MM-DD HH:mm:ss UTC` (the equity chart axis in UTC too).
- **AC-10**: Every API request whose `Host` is missing or not a loopback name (`localhost`, `127.0.0.1`, `[::1]`, any port, case insensitive) gets 403, and so does a `/ws` upgrade. Every non GET `/api` request that carries an `Origin` other than exactly `WEB_ORIGIN` gets 403. A request with no `Origin` at all (curl, scripts) is allowed, because only browsers can be tricked into cross site requests and browsers always send `Origin` on a non GET.
- **AC-11**: `GET /api/bot/commands` returns your commands newest first (default 20, max 100, cursor paged), each with its type, target (strategy name or position symbol), status, error, created and handled times. Every panel action is a `BotCommand` row, so this list is the full record of what you did.
- **AC-12**: Risk limits and pairs are shown read only. No endpoint in this spec changes `RiskSettings`, `StrategyInstrument`, or `Strategy.params`.

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Decision

**Chosen option**: Option 1: all panel actions are worker commands; the Bot page is a hash routed page built on plain fetch hooks and the existing `/ws`.

Three new `BotCommand` types (`enable_strategy`, `disable_strategy`, `close_position`) carry a strategy or position target in two new foreign key columns. The worker runs them inside the trader's serial queue, each as one SQL statement that applies the change and marks the command done or failed together. The web app adds a `#/bot` page whose sections fetch over REST and refetch when a WebSocket event says something changed.

Smaller calls made with it (the reasoning is in rationale.md):
- **Bot state in `/api/health`**: health gains `bot: { runId, state, startedAt }`, so one 5 second poll covers offline detection and the state. Runner up: a separate `GET /api/bot`.
- **One command endpoint**: `POST /api/bot/commands` takes a zod discriminated union on `type`. Runner up: one route per action.
- **`command.handled` carries the type and target**, so the page knows what to refetch without a lookup.
- **Pending exit generalized**: the trader's `pendingKill` flag becomes `pendingExit: 'kill' | 'manual' | null`, loaded from every pending exit order. One fill path serves both.
- **Refetches are coalesced**: at most one request in flight per section, plus one trailing request if events arrived meanwhile.
- **Equity chart** uses `lightweight-charts` (already installed), following `nextCursor` for 30 days (2,880 snapshots, over the 1,000 page limit).

**Implementation skills**: `prisma-client-api` · `prisma-cli` (both `prisma/skills`, `.agents/skills/<skill>/`)

## Feature design

**Design source**: Figma (the connector is available in this workspace). The file and frame link is still to be added (see Follow-up). `/develop` pulls the Bot page frames from that link before the first UI task. Where a frame doesn't cover a state (offline banner, empty lists, confirm dialogs), follow the existing dashboard's look: dark slate background, glass cards, Tailwind, `lucide-react` icons, `motion` for transitions.

**Where the code lives**:
```
packages/shared/src/
  api.ts        change: createCommandBody becomes a discriminated union; commandListResponse;
                health gains bot; closeReason adds manual; pendingClose covers any pending exit
  events.ts     change: command.handled payload adds type, strategyId?, positionId?;
                position.closed closeReason adds manual
  paper.ts      change: ORDER_REASONS adds manual
apps/server/
  prisma/schema.prisma + one migration   CommandType (+3), OrderReason (+manual), BotCommand FKs + CHECK
  src/api/guard.ts      new: Host check (all requests, and /ws upgrades), Origin check (non GET /api)
  src/api/app.ts        change: command checks per type, per target dedupe, GET /api/bot/commands
  src/api/health.ts     change: add bot { runId, state, startedAt }
  src/api/ws.ts         change: Host check on upgrade (Origin check already there)
  src/api/trading.ts    change: pendingClose = any pending exit order
  src/worker/commands.ts  change: start/stop/kill claim only those types; new types go to the trader
  src/worker/main.ts    change: drain loop hands new types to the trader and awaits the result
  src/trader/trader.ts  change: runCommand() in the queue; pendingExit replaces pendingKill
  src/trader/store.ts   change: applyStrategyToggle, createManualExit, loadPendingExits
apps/web/src/
  App.jsx               change: hash page switch and nav; current dashboard moves to pages/MarketPage.jsx
  pages/MarketPage.jsx  new: today's App content, unchanged
  pages/BotPage.jsx     new: layout, owns the socket and health, passes "controls disabled" down
  lib/api.js            new: fetch wrapper (base /api, JSON, timeout 8s, OfflineError vs HttpError)
  lib/format.js         new: fmtUsd, fmtPrice(tickSize), fmtQty(minQty), fmtUtc (uses Money from @trading/shared)
  hooks/useSocket.js    new: one /ws connection, backoff 1s doubling to 10s, subscribe(type, fn), onReconnect
  hooks/useResource.js  new: fetch, refetch (coalesced), data, error, lastUpdatedAt, loadMore for cursors
  hooks/useHealth.js    new: polls /api/health every 5s
  hooks/useCommand.js   new: send a command, track it to command.handled, fallback poll after 5s
  components/bot/       new: StatusBar, OfflineBanner, AccountSummary, StrategiesPanel, OpenPositions,
                        ClosedTrades, SignalsLog, EquityChart, FeedHealth, ActionLog, ConfirmDialog
```

**Data model sketch** (one migration, changes to specs 0001 and 0003):
| Entity | Change | Keys and rules |
|---|---|---|
| `CommandType` enum | add `enable_strategy`, `disable_strategy`, `close_position` | |
| `BotCommand` | add `strategyId` (UUID, nullable), `positionId` (UUID, nullable) | FK `Strategy` (Restrict), FK `Position` (Restrict), N:1 each (nothing deletes strategies or positions, so Restrict never blocks). CHECK (raw SQL in the migration): `strategyId` is set exactly when type is `enable_strategy` or `disable_strategy`; `positionId` is set exactly when type is `close_position`; both are null for `start`, `stop`, `kill`. The CHECK compares `type::text`, because Postgres can't use an enum value in the same transaction that adds it. Existing rows already satisfy it |
| `OrderReason` enum | add `manual` | A manual exit order has `clientOrderId` `x:<positionId>`, `side` opposite the position, `type` `market`, `qty` the position's qty, `status` `pending`, `reason` `manual`, and the position's ids (the same shape as a kill order) |
| `Position` | no new columns | `closeReason` may now be `manual` |
| `Strategy` | no new columns | `enabled` is written only by the worker, from a command |

**State transitions**:
- Command: `pending` → `done` or `failed`. Created by the API, claimed by the worker. Commands pending longer than 60 seconds at worker start are failed with `stale at startup` (spec 0001), new types included.
- Strategy: `enabled` ↔ `disabled`, by command only.
- Manual exit order: `pending` (created by `close_position`) → `filled` (at the first live, tradeable price). Position: `open` → `closed` with `closeReason` `manual`.
- Which controls are enabled (all are disabled whenever the backend, database, or worker is down, AC-7):

| Bot state | Start | Stop | Kill | Strategy switch | Close |
|---|---|---|---|---|---|
| `running` | no | yes | yes | yes | yes, unless closing |
| `idle` | yes | no | yes | yes | yes, unless closing |
| `killed` | yes | no | no | yes (takes effect on the next start) | yes, unless closing (normally every position already has a kill exit) |

Close follows the position (`open` and `pendingClose` false), not the bot state. Kill also needs a successful `/api/account` fetch for its dialog count, which includes positions already closing.

**UI behaviour of controls**:
- Switches are pending, not optimistic: while the command runs, the switch shows a spinner at its old value; on `done` it refetches strategies; on `failed` it stays put and shows the error.
- A 409 "already pending" with `details.id` adopts that command id and tracks it like its own.
- A pending command is not remembered across a page reload; the action log shows its result.
- A `close_position` that ends `done` means the exit order exists, not that the position closed; the row's closing badge says so until `position.closed`.

**Command handling in the worker**:
- **One order across all types.** The drain loop reads the oldest pending command of any type (`ORDER BY "createdAt", id LIMIT 1`), then dispatches on its type. The worker is the only consumer (advisory lock, spec 0001), and the loop awaits each command before reading the next, so no row lock is needed between the read and the handling statement.
- `start`, `stop`, `kill`: the spec 0001 statement, with its claim narrowed to `WHERE id = <that id> AND status = 'pending'`.
- New types: `trader.runCommand(command)`, awaited. It runs inside the trader's serial queue, so it can't race a candle evaluation or an exit. It does **not** rely on `enqueue`'s error handling (that logs and swallows errors, [trader.ts:110](../../../apps/server/src/trader/trader.ts)). Instead it resolves its own promise with `{ status: 'done' }` or `{ status: 'failed', error }`, catching inside the job. If the job throws, the loop runs a separate `UPDATE "BotCommand" SET status = 'failed', error = <message>, "handledAt" = now() WHERE id = $1 AND status = 'pending'`. If even that update fails (database down), the drain stops and the 1 second poll retries later, so it never spins.
- Each new command is one statement that writes the change and the command's status together:
  - `enable_strategy` / `disable_strategy`: `UPDATE "Strategy" SET enabled = <value>` and mark the command `done`. Then call `loadStrategies()` (inside the same queue job) instead of flipping the cache by hand. These work even before the trader's `start()` (the trader loads strategies when it starts).
  - `close_position`: a CTE whose first steps read, with plain subselects, whether the position is `open` and whether an `x:<positionId>` order exists (a CTE can't see its own insert, so the reasons are decided from these reads). It inserts the manual exit order only when the position is open and has no exit order, and sets the command to `done`, or to `failed` with `position not open` or `position already closing`. On `done`, set `pendingExit = 'manual'` on the cached position and run the trigger check at once, so a live market fills right away. Before the trader's `start()` (an explicit `started` flag), it ends `failed` with `trader not running`.
- `command.handled` (with `status` `done` or `failed` and the error) is published only after the statement commits.

**`pendingKill` becomes `pendingExit: 'kill' | 'manual' | null`** in every place it is used today, each with its own test:
- `trader.checkInstrument`: a pending exit fires first, with its own reason.
- `trader.closePosition`: `closeReason = pos.pendingExit ?? reason`.
- `trader.evaluate`: the opposite signal close is skipped when `pendingExit` is set.
- `trader.loadPositions` and `store.loadPendingKills`, renamed `loadPendingExits`: returns a `Map<positionId, reason>` over pending orders with reason `kill` or `manual`.
- After the kill sweep reloads pending exits, a position with a manual order keeps `manual`; the sweep's `ON CONFLICT DO NOTHING` skips it.
- `api/trading.ts` `positionInclude`: the pending order filter becomes `reason IN (kill, manual)`.
- The shared `CloseReason` and `closeReason` enums add `manual`.

**API surface** (localhost only, no login; the guard in AC-10 applies to every row):
| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/bot/commands` | POST | `{ type: 'start' \| 'stop' \| 'kill' }` · `{ type: 'enable_strategy' \| 'disable_strategy', strategyId: uuid }` · `{ type: 'close_position', positionId: uuid }` | 201 `{ id, type, status, error, handledAt, strategyId, positionId }` | Origin = `WEB_ORIGIN`, loopback Host | 422 bad body · 404 unknown strategy or position · 409 duplicate pending (same type and target), position closed, or position already closing · 403 guard |
| `/api/bot/commands` | GET | `limit` (default 20, max 100), `cursor` (opt, opaque `(createdAt, id)` as in spec 0003) | `{ commands: [{ id, type, status, error, createdAt, handledAt, strategy: { id, name } \| null, position: { id, symbol } \| null }], nextCursor }`, newest first | loopback Host | 422 bad params · 503 (the same `read` wrapper as the trading routes) |
| `/api/bot/commands/:id` | GET | id | as today, plus `strategyId`, `positionId` | loopback Host | 404 |
| `/api/health` | GET | none | as today, plus `bot: { runId, state, startedAt } \| null` (newest `BotRun`; null when there is none or the database is down) | loopback Host | 503 db down (body has `db: 'down'` and `bot: null`; the web parses the 503 body) |
| `/api/positions`, `/api/positions/:id` | GET | as spec 0003 | `pendingClose` is true for any pending exit order (kill or manual); `closeReason` may be `manual` | loopback Host | as spec 0003 |
| `/api/account`, `/api/strategies`, `/api/signals`, `/api/equity`, `/api/instruments` | GET | as specs 0002 and 0003 | unchanged | loopback Host | as before |
| `/ws` | push | none | as specs 0001 to 0003; `command.handled` adds `type`, `strategyId?`, `positionId?`; `position.closed.closeReason` may be `manual` | Origin = `WEB_ORIGIN` (existing), loopback Host (new) | 403 on upgrade |

Request details:
- Duplicate check and insert stay one statement: `INSERT … WHERE NOT EXISTS (pending with the same type AND strategyId IS NOT DISTINCT FROM AND positionId IS NOT DISTINCT FROM)`. An `enable` and a `disable` for the same strategy may both be pending; they run in order.
- For `close_position`, the API checks first that the position exists, is `open`, and has no pending exit order; the worker checks again in its statement (AC-5).
- 403 bodies are `{ error: 'forbidden origin' }` or `{ error: 'forbidden host' }`, logged at `warn`.
- The guard is the first middleware (before `express.json` and every route). One `isLoopbackHost(hostHeader)` in `guard.ts` strips the port (including from `[::1]:4000`), lowercases, and accepts only `localhost`, `127.0.0.1`, `[::1]`; a missing Host fails. `ws.ts` uses the same function, and still destroys non `/ws` upgrade paths first.
- Through the Vite dev proxy (no `changeOrigin`), Host stays `localhost:5173` and the browser's `Origin` is forwarded, so both checks pass. One integration test goes through the proxy, since curl tests won't catch a proxy change.

**Live updates** (the page's event map; every refetch is coalesced per section):
| Event | Refetch |
|---|---|
| `hello` (each connect or reconnect) | everything |
| `bot.started`, `bot.stopped`, `bot.killed` | health (bot state), open positions (closing badges after a kill), action log |
| `command.handled` | action log; strategies if it carries `strategyId`; open positions if it carries `positionId`; resolves the pending button |
| `account.updated` | account summary, open positions (marks) |
| `position.opened` | open positions, account summary, strategies |
| `position.closed` | open positions, closed trades (first page), account summary, strategies |
| `signal.created` | signals log (first page) |
| `risk.halted` | strategies |
| `feed.status` | feed health (updated in place from the payload, no fetch) |

The equity chart defaults to 7 days and refetches its range 10 seconds after each quarter hour UTC (snapshots are written then, from the trader's queue, so a little late), and when the range changes. Closed trades and signals load 50 rows per page (the spec 0003 default). "Load more" pages keep what is loaded; a first page refetch replaces only the first page and drops duplicates by id.

**Offline and pending command handling (web)**:
- Health polls every 5 seconds. A fetch that throws or times out (8 seconds) means "Backend offline". A 503 with `db: 'down'` means "Database down". `worker.status` `down` or `none` means "Worker down since <lastHeartbeatAt UTC>" ("never started" when null).
- The socket reconnects with backoff (1s, 2s, 4s, 8s, then every 10s). While it's closed, the page treats the data as possibly stale: the banner shows "Live updates paused" if health is otherwise fine, and controls stay enabled (commands go over REST).
- A pending command resolves on `command.handled` with its id. If none arrives within 5 seconds, `GET /api/bot/commands/:id` is polled every 2 seconds until it is `done` or `failed`.
- A 409 or 404 from the POST shows its error next to the control; nothing is retried on its own.

**Value sourcing**:
| Action | Value | Source |
|---|---|---|
| page switch | which page | `location.hash` (`#/bot`), `hashchange` event |
| status bar | bot state, run id | `/api/health` `bot` (newest `BotRun.state`) |
| status bar | worker status, last heartbeat | `/api/health` `worker` (spec 0001) |
| Kill dialog | open positions count | `/api/account` `openPositions` |
| buttons enabled | bot state, offline state | the table under *State transitions*, from health |
| strategy switch | current value | `/api/strategies` `enabled` |
| enable or disable | target | `strategyId` in the POST body, from the strategy row |
| worker toggle | new value | the command type (`enable_strategy` → true) |
| Close dialog | symbol, side | the position row (`/api/positions`) |
| close | target | `positionId` in the POST body |
| manual exit order | side, qty, ids | the open `Position` row, read inside the worker's statement |
| manual exit fill | price, fee | spec 0003 fill model at the first live, tradeable quote |
| closing badge | pending | `/api/positions` `pendingClose` (any pending exit order) |
| account summary | balance, equity, margin used, free margin, today's PnL, open count | `/api/account` (spec 0003) |
| strategies | pairs, risk limits, open count, today's PnL, halted | `/api/strategies` (spec 0003) |
| open positions | mark, unrealized PnL, marked at | `Position` columns via `/api/positions?status=open` (up to 5s old) |
| closed trades | exit, reason, PnL, fees, closed at | `/api/positions?status=closed` with `cursor` |
| signals log | outcome, reason, indicators | `/api/signals` with `cursor` |
| equity chart | points | `/api/equity?from=<now minus range>`, following `nextCursor` |
| feed health | state, last tick, last error | `/api/instruments` `feed`, then `feed.status` payloads |
| strategies | today's PnL, halted, open count | `/api/strategies` `todayRealizedPnl`, `halted`, `openPositions` |
| account summary | field names | `/api/account` `balance`, `equity`, `marginUsed`, `freeMargin`, `todayRealizedPnl`, `openPositions` |
| open positions | marked at | `markedAt` (shown as the row's tooltip) |
| signals log | indicators on expand | `Signal.indicators` (`ema9`, `ema21`, `ema50`, `rsi`, `macdHist`, `z`, `trend`, spec 0003), each to 4 decimals |
| equity chart | axis | x: `takenAt` in UTC; y: equity in USD |
| feed health | last tick, last error | `/api/instruments` `feed.lastTickAt`, `feed.lastError`; a `feed.status` event updates `status` and `lastError` in place (it carries no tick time, so `lastTickAt` refreshes on the next instruments fetch, after `hello`) |
| action log | commands | `GET /api/bot/commands?limit=20` |
| action log | target | strategy name, position symbol, or "all" for start, stop, kill |
| empty states | text | "No open positions", "No closed trades yet", "No signals yet", "No snapshots yet (first one at the next quarter hour)", "No actions yet" |
| "last updated" | time | the browser clock when that section's last fetch succeeded, shown in UTC |
| price format | decimals | the instrument's `tickSize` from `/api/instruments` (decimals after the point) |
| qty format | decimals | the instrument's `minQty` from `/api/instruments` |
| USD format | 2 decimals, half even | `Money` from `@trading/shared` (`toDecimal(s).toFixed(2)`) |
| time format | UTC | `fmtUtc(iso)` from `lib/format.js` |
| write guard | allowed origin | `WEB_ORIGIN` (spec 0001 config) |
| write guard | allowed hosts | the fixed loopback list in `guard.ts` |

**Key invariants**:
- Only the worker writes trading tables (`Strategy`, `Order`, `Position`, and the rest). The API writes only `BotCommand`.
- Every panel action is exactly one `BotCommand` row, and its result is recorded on that row.
- At most one pending command per (type, target).
- A position has at most one exit order (`clientOrderId` `x:<positionId>` is unique), so a manual close and a kill can never both fill.
- A command's change and its `done` status commit together, or neither does.
- A disabled strategy opens nothing, and its open positions are still managed.
- The web app never does float math on money; formatting goes through `Money`.
- No page shows a control as usable while the backend, database, or worker is down.

**Security model**: single user, localhost only, no login (scope and spec 0001). The API listens on `127.0.0.1` only. Because the API now has more write actions, two checks are added. The Origin check means a web page from another site, open in your browser, can't send commands. The Host check blocks DNS rebinding (a trick where an outside domain is pointed at 127.0.0.1 so a page on it counts as same origin). No secrets are involved; nothing here touches keys (feature 7). Opening the panel to other devices stays deferred and needs login first.

**Observability** (pino): `info` for each command received (type, target) and each command handled (status, error); `warn` for each guard rejection (origin or host) and each `failed` command; the manual exit fill logs like any close (spec 0003), with reason `manual`.

**Configuration required**: no new environment variables. `WEB_ORIGIN` (spec 0001) now also guards writes, so open the panel at exactly that origin (default `http://localhost:5173`; opening `http://127.0.0.1:5173` gets 403 on writes and on `/ws`). Intervals (health 5s, socket backoff to 10s, command fallback 5s and 2s, fetch timeout 8s) are constants in the web code.

**Critical test scenarios**:
- Thin thread: on `#/bot` with the bot `running`, switch `forex-trend` off. A `disable_strategy` command is created, `command.handled` arrives, the switch shows off, and the next forex 15m close is not evaluated (no `Signal` row). Refresh: still on `#/bot`; verifies **AC-1**, **AC-3**.
- Disable keeps exits: with a `crypto-trend` position open, disable it, then push a quote past its SL. It closes `stop_loss`; an opposite Strong signal does not close it; verifies **AC-3**.
- Manual close, live: close an open BTCUSDT position. It closes `manual` at the paper fill price, `position.closed` arrives, the row moves to closed trades, and the balance moves by its `realizedPnl`; verifies **AC-4**, **AC-6**.
- Manual close, market shut: close a forex position on the weekend. The row shows "closing"; restart the worker; it is still pending and fills `manual` at the first tradeable price. Send `kill` meanwhile: no second exit order is created; verifies **AC-4**.
- Conflicts: close a position twice quickly (409 on the second); close an already closed one (409); send `close_position` for a random UUID (404); send a second `disable_strategy` for the same strategy while one is pending (409); verifies **AC-5**.
- Race: insert a `close_position` command, then let an SL close the position before the worker handles it. The command ends `failed` with `position not open`, and there is no extra order; verifies **AC-5**.
- Throwing job: make `runCommand` throw for one command. It ends `failed` with the error, the next command still runs, and the loop does not repeat the failed one; verifies **AC-5**.
- Order: queue `close_position` then `kill` for the same position. The position closes `manual`, not `kill`; verifies **AC-4**, **AC-5**.
- Pending exit wins: with a manual exit pending on a stale feed, the first fresh quote is also past SL. The close reason is `manual`; an opposite Strong signal meanwhile is saved `skipped` `already_open`; verifies **AC-4**.
- Kill dialog: Kill shows "3 open positions will be closed"; cancel sends nothing; confirm sends `kill`; Kill is then disabled and Start enabled; verifies **AC-2**.
- Live marks: with a position open, equity changes, `account.updated` arrives, and the unrealized PnL on the row changes within about 5 seconds, with no reload; verifies **AC-6**.
- Reconnect: stop the API for 20 seconds. "Backend offline" shows, controls disable, data dims with its last updated time. Start the API: the banner clears, every section refetches, controls enable; verifies **AC-6**, **AC-7**.
- Worker down: stop only the worker. Within about 20 seconds the banner says "Worker down since …" and every control is disabled; verifies **AC-7**.
- Guard: `curl -X POST` to `/api/bot/commands` with `Origin: https://evil.example` gets 403; with `Host: evil.example` any request gets 403; `curl -X POST` with no Origin works; a POST from the page through the Vite proxy works; verifies **AC-10**.
- Banner order: with the database down, the banner says "Database down", not "Worker down"; verifies **AC-7**.
- Sections: every section in AC-8 renders, including empty states (no positions, no signals, no snapshots yet); closed trades "Load more" fetches the next cursor page; the equity chart at 30 days follows `nextCursor`; verifies **AC-8**.
- Formatting: an XRPUSDT price shows the decimals of its `tickSize`; a USDJPY PnL shows 2 decimals; every time ends in `UTC`; verifies **AC-9**.
- Action log: after start, disable, and close, the log lists all three newest first with status and target; verifies **AC-11**.
- Read only limits: risk limits and pairs show on each strategy with no edit control, and no endpoint accepts a change to them; verifies **AC-12**.

## Build plan

Tracer Bullet: first one real thread from a button on the Bot page through the API, the command queue, the worker, the database, and back over `/ws` (the strategy switch, the simplest new command). Then thicken it with the manual close, the remaining sections, and the live and offline hardening. The Figma frames are needed before task 1's UI part; until the link is added, the backend half of task 1 can go first.

1. [x] Thin thread, strategy switch end to end: the migration (all enum values, `BotCommand` FKs and CHECK); shared schema changes (command union, `command.handled` fields, health `bot`); the API guard; per type checks and per target dedupe on `POST /api/bot/commands`; health `bot`; the worker drain loop picking the oldest command of any type and handing `enable_strategy`/`disable_strategy` to `trader.runCommand` (with its own result and the failed marking on a throw); in the web app, the hash page switch and nav, `MarketPage.jsx` moved out unchanged, `lib/api.js`, `useSocket`, `useHealth`, `useCommand`, `useResource`, and a Bot page with the status bar (state, Start, Stop, Kill with its dialog) and the strategies section with switches; satisfies **AC-1**, **AC-2**, **AC-3**, **AC-5**, **AC-10**.
2. [x] Manual close end to end: `pendingExit` replaces `pendingKill` at every touch point listed under *Command handling* (`loadPendingExits` as a Map), `createManualExit` in `runCommand`, `pendingClose` for any pending exit, `manual` in the shared enums; the open positions section with marks, closing badge, Close and its dialog; satisfies **AC-4**, **AC-5**, **AC-8**.
3. [x] The other sections: account summary, closed trades and signals log with "Load more", equity chart with 1 day, 7 days, 30 days, feed health, `GET /api/bot/commands` and the action log, risk limits and pairs read only; `lib/format.js` used across every section; satisfies **AC-8**, **AC-9**, **AC-11**, **AC-12**.
4. [x] Live and offline hardening: the full event map with coalesced refetches, refetch everything on `hello`, the quarter hour equity refresh, the offline banner states and dimming with last updated times, controls disabled per the table, the 5 second command fallback poll, and the log lines; satisfies **AC-6**, **AC-7**, **AC-2**.

## Consequences

**Positive**:
- You control the bot from the browser, and every action is recorded with its result.
- The spec 0003 rule (only the worker writes trading data) still holds, so the trader's cache can never drift from a change the API made behind its back.
- Commands run inside the trader's queue, so a toggle or close can never race an entry or an exit.
- The manual close reuses the kill exit path, so it inherits its safety: one exit per position, fills only on live prices, survives restarts.
- No new dependencies in the web app or the server.

**Negative / tradeoffs**:
- Every action takes a round trip through the database and the worker (about 0.5 to 1 second with Neon about 300 ms away), so the switch doesn't flip instantly; it shows pending until `command.handled`.
- With the worker down, nothing can be controlled from the panel, not even a strategy switch. That's deliberate (a command would go stale), but it means a crashed worker must be restarted from the terminal.
- Refetch on event means many small requests in a busy minute (12 pairs closing together). Coalescing caps it to one in flight per section, but it is still chattier than pushing full rows.
- Marks are up to about 5 seconds old, never tick by tick.
- The strict `WEB_ORIGIN` match means opening the panel at `127.0.0.1:5173` instead of `localhost:5173` breaks writes and live updates.
- Pair and risk editing are not here, so tuning still means editing the seed or the database until a later spec adds it.
- Plain fetch hooks are hand rolled; if the panel grows a lot (backtests, alerts in feature 6), TanStack Query may become worth adding.
- A manual close on a shut forex market can sit pending all weekend, and the price at reopen may be far from where you clicked.

**Neutral**:
- Spec 0001's command statement now handles one command picked by id; the drain loop picks the oldest pending command of any type first, and the new types take a second path.
- Spec 0003's `pendingKill` becomes `pendingExit`, and `pendingClose` now covers manual exits too.
- The existing dashboard moves to `pages/MarketPage.jsx` unchanged; its own browser side signals keep running separately from the bot.

## Follow-up

- [ ] Paste the Figma file and frame link for the Bot page into *Design source* above before `/develop` starts the UI part of task 1.
- [ ] Deferred from this spec: editing pairs per strategy and risk limits from the panel (scope feature 5 listed both). Revisit after backtesting (feature 6) can show whether a change helps; it needs its own decision on what may change while positions are open.
- [ ] `/sync` should note in specs 0001 and 0003 the new command types, the command claim split, and `pendingExit`.
- [ ] Root `AGENTS.md` is still missing; `/audit` should record the stack, the Prisma skills, and the "only the worker writes trading tables" rule.
