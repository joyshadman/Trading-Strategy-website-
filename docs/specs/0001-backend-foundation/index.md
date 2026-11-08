# 0001. Backend foundation: TypeScript API and worker on PostgreSQL

**Date**: 2026-10-27
**Status**: Accepted

## Summary

The bot gets a backend written in TypeScript (JavaScript with types). It runs as two programs: an Express API that the React frontend talks to, and a separate worker that runs the bot all the time. Both share one hosted Neon Postgres database accessed through Prisma, and prices and money are stored as exact decimals. For now it is localhost only and just for you: the API and worker run on your PC, reachable only from it, with no login.

## Requirements

**User stories**:
- As the bot owner, I want the bot to keep trading when my browser is closed, so that it never misses a signal.
- As the bot owner, I want every signal, order, fill, and position saved exactly, so that stats and debugging are trustworthy.

**Acceptance criteria**:
- **AC-1**: The repo is npm workspaces with `apps/web` (the existing frontend, still working through `npm run dev`), `apps/server`, and `packages/shared`; one `npm install` at the root sets up all three.
- **AC-2**: `apps/server` runs two processes, the API and the worker, each restartable without stopping the other. A second worker started while one runs exits with a clear message.
- **AC-3**: `GET /api/health` returns the API status, the database status, and the worker status (`up` \| `down` \| `none`) with its last heartbeat and age in seconds.
- **AC-4**: The Prisma schema holds every entity in the data model below; `prisma migrate deploy` creates them on an empty database, and the seed creates the paper account.
- **AC-5**: All prices, quantities, fees, balances, and profit are stored as NUMERIC, handled in code as `Decimal`, and sent over the wire as decimal strings; never JavaScript floats.
- **AC-6**: Creating two orders with the same `clientOrderId` fails at the database level.
- **AC-7**: A command posted to the API (start, stop, kill) is handled by the worker, and a connected WebSocket client receives `command.handled` within 2 seconds of the POST.
- **AC-8**: Each process validates its own environment variables at startup; a missing or invalid one stops that process with a clear message.
- **AC-9**: Lint and build pass for every workspace, and type check passes for `apps/server` and `packages/shared`.

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Decision

**Chosen option**: Option 1: TypeScript monorepo, Express API + worker, PostgreSQL via Prisma.

The backend is an npm workspace with an Express REST + WebSocket API and a separate always on worker, sharing PostgreSQL through Prisma, with shared types, schemas, and indicators in `packages/shared`.

**Implementation skills**: `prisma-orm-setup` · `prisma-client-api` · `prisma-cli` (all `prisma/skills`, `.agents/skills/<skill>/`)

## Proposed stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript on Node.js (current LTS), ESM in every workspace | One language with the frontend; types guard money logic. |
| Repo layout | npm workspaces: `apps/web`, `apps/server`, `packages/shared` | Shared types and indicators imported, not copied. |
| API framework | Express | Your pick; widely known, simple. |
| Request validation | zod, schemas in `packages/shared` | The same schemas validate API input and type the frontend calls. |
| Live updates | REST for actions and lists, one WebSocket (`ws` library) at `/ws` | Two way, attaches to the Express HTTP server. |
| Bot runtime | Separate worker process | Trading survives API crashes and redeploys. |
| API ↔ worker | Commands: API inserts a `BotCommand` row and sends `NOTIFY bot_commands`; the worker wakes on it, with a 1 second poll as backup. Events: the worker sends `NOTIFY bot_events`, the API `LISTEN`s and pushes to WebSocket clients | No extra broker; the row is the source of truth. |
| Primary DB | Neon (hosted Postgres) | Exact NUMERIC, concurrent writers, advisory locks, LISTEN/NOTIFY; nothing to install locally. |
| Connections | Pooled URL (`DATABASE_URL`, host has `-pooler`) for Prisma queries; direct URL (`DATABASE_URL_UNPOOLED`) for migrations, the worker lock, and LISTEN/NOTIFY | Neon's pooler is PgBouncer in transaction mode, which drops session state. |
| DB access | Prisma (current major, per `prisma-orm-setup`) for schema, migrations, queries | Your pick; `Decimal` maps to NUMERIC; raw SQL for claims and heavy aggregates. |
| Raw Postgres client | `pg`, one dedicated connection per process | Needed for LISTEN and the worker's session advisory lock; Prisma's pool cannot hold either. |
| Decimal math | `decimal.js` in `packages/shared` (Prisma's `Decimal` on the server is the same library) | One decimal type everywhere; the browser never imports Prisma. |
| Config | zod parsing of env vars at startup; a base schema plus `apiConfig` and `workerConfig` | Each process needs and checks only its own settings. |
| Logging | pino structured JSON logs | Cheap, fast, readable in any host. |
| Tests | Vitest against a real Postgres test database | Constraints like AC-6 can't be proven on a mock. |
| Dev runtime | `tsx` watch for API and worker; `concurrently` for one root `dev` | Quick start on your PC. |
| Hosting | Localhost only: API, worker, and UI on your PC, API bound to loopback. Database on Neon | One user, no login needed; cloud hosting is deferred on the scope. |

**Folder layout**:
```
apps/web/               existing React + Vite frontend (moved from root, stays JavaScript)
apps/server/
  prisma/schema.prisma
  prisma/seed.ts
  src/api/main.ts       Express app, routes, WebSocket, LISTEN client
  src/worker/main.ts    lock, command handling, heartbeat
  src/db/               Prisma client, pg client, notify helpers
  src/config.ts         zod env schemas (base, api, worker)
  .env.example
packages/shared/        types, zod schemas, event union, decimal helpers, indicators (EMA, RSI, MACD)
```

**Workspace mechanics**:
- Root `package.json` holds only `workspaces` and scripts that fan out with `npm -w`: `dev` (web + api + worker via `concurrently`), `build`, `lint`, `typecheck`, `test`, `db:migrate` (`prisma migrate deploy`), `db:seed`.
- `apps/server` scripts: `dev:api`, `dev:worker`, `start:api`, `start:worker`. Neither process runs migrations on its own.
- `packages/shared` `exports` points at its `src/*.ts`; `tsx` and Vite compile it directly, and `tsc -b` with project references builds it for production.
- `apps/web` stays JavaScript; its `typecheck` script prints a skip. Moving it to TypeScript is a later choice.
- Vite dev server proxies `/api` and `/ws` to the API, so the browser stays same origin.
- `.env` lives in `apps/server/`, read by `config.ts` and by the Prisma CLI run from that folder. `.env.example` lists every variable; `.env` is never committed.
- Database: one Neon project; `prisma.config.ts` points the CLI at `DATABASE_URL_UNPOOLED`. Tests use a separate Neon branch (for example `test`) via `DATABASE_URL_TEST`.
- The frontend move (into `apps/web`, carrying `src`, `public`, `index.html`, `vite.config.js`, `eslint.config.js`, and its dependencies) is its own commit, so git history follows the files.

## Data model

**Column rules**:
- Prices, sizes, fees, balances, profit, `tickSize`, `minQty`, `dailyLossLimit`: `NUMERIC(30,12)`.
- Percentages (`stopLossPct`, `takeProfitPct`): `NUMERIC(10,4)`, stored as percent (`2` means 2%).
- Rounding: `ROUND_HALF_EVEN`, set once in `packages/shared`. Order sizes round down to the instrument's `minQty` step.
- Every `DateTime` is annotated `@db.Timestamptz(3)`; defaults use `@default(now())`, so the database clock sets them. Both processes set `TZ=UTC`.
- IDs are UUIDs unless noted. Fixed value sets are Prisma enums (`AssetClass`, `AccountMode`, `Side`, `OrderType`, `OrderStatus`, `PositionStatus`, `SignalOutcome`, `BotState`, `CommandType`, `CommandStatus`). `Strategy.kind`, `venue`, and `currency` are strings, with `kind` checked against a registry in `packages/shared`.
- `Timeframe` is a string from a fixed list in `packages/shared`: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`.
- Every relation uses `onDelete: Restrict`; history is never deleted.

| Entity | Fields | Keys and rules |
|---|---|---|
| Instrument | id, symbol, assetClass, venue, baseAsset, quoteAsset, tickSize, minQty, active | unique (venue, symbol) |
| Candle | instrumentId, timeframe, openTime, open, high, low, close, volume | PK (instrumentId, timeframe, openTime); `openTime` is the UTC open aligned to the timeframe; upsert on the PK (the live candle is revised until it closes); rows never deleted |
| Account | id, name (unique), mode, venue, currency, balance, equity, createdAt | `equity` stored, updated by the worker (equals balance in this slice) |
| Strategy | id, name, kind, params (JSON), timeframe, enabled, accountId, createdAt | FK Account |
| StrategyInstrument | strategyId, instrumentId | PK (strategyId, instrumentId) |
| RiskSettings | strategyId, stopLossPct, takeProfitPct, maxPositionSize, maxOpenTrades, dailyLossLimit | PK and FK strategyId (1:1); `dailyLossLimit` is an amount in account currency |
| Signal | id, strategyId, instrumentId, side, indicators (JSON), outcome, skipReason (nullable), candleTime, createdAt | index (strategyId, createdAt) |
| Order | id, clientOrderId, accountId, strategyId, instrumentId, signalId (nullable), side, type, qty, price (nullable), status, venueOrderId (nullable), createdAt, updatedAt | unique clientOrderId; unique signalId (one order per signal); index (accountId, status) |
| Fill | id, orderId, price, qty, fee, feeCurrency, filledAt | index orderId |
| Position | id, accountId, instrumentId, strategyId, side, qty, entryPrice, stopLoss (nullable), takeProfit (nullable), status, realizedPnl (nullable), openedAt, closedAt (nullable) | `entryPrice` is the volume weighted average of opening fills; index (accountId, status) |
| BotRun | id, state, startedAt, stoppedAt (nullable), stopReason (nullable), lastHeartbeatAt | the newest row is the current run |
| BotCommand | id, type, status, error (nullable), createdAt, handledAt (nullable) | index (status, createdAt) |

**JSON columns**: `Strategy.params` and `Signal.indicators` hold plain numbers for indicator settings and values (display and debugging only). Any price inside JSON is stored as a decimal string.

**Seed** (`prisma db seed`, safe to run again): upserts account `paper-main` with mode `paper`, venue `paper`, currency `USD`, balance and equity from `PAPER_START_BALANCE` (default `10000`). The worker refuses to start if `paper-main` is missing.

**State transitions**:
- Order: `pending` → `open` → `partially_filled` → `filled`; or `pending`/`open` → `canceled` \| `rejected`.
- Position: `open` → `closed` (a closing fill sets `realizedPnl`, `closedAt`).
- BotRun.state: `idle` → `running` (start) → `idle` (stop) · any → `killed` (kill). `killed` returns to `running` only on a new `start`.
- BotCommand: `pending` → `done` \| `failed`.

**Key invariants**:
- No float ever touches a money or size value; money crosses the wire as a string matching `^-?\d+(\.\d+)?$`, and the frontend only formats it for display.
- `clientOrderId` is generated before an order is sent and is unique, so a retry cannot double order.
- Exactly one worker runs at a time (advisory lock below).

## Worker behavior

- **Single worker lock**: at startup the worker opens its dedicated `pg` connection and calls `pg_try_advisory_lock(727001)`. If it isn't granted, it logs "another worker is running" and exits with code 1. The lock frees on its own if the process dies.
- **Startup recovery** (after the lock): any `BotRun` with `stoppedAt` null gets `stoppedAt = now()`, `stopReason = 'crashed'`. A new `BotRun` is created with `state = idle`. Pending commands older than 60 seconds are marked `failed` with error `stale at startup`, so an old `start` never runs on its own after an outage.
- **Heartbeat**: every 5 seconds, `UPDATE "BotRun" SET "lastHeartbeatAt" = now()` on the current run.
- **Command claim**: on a `bot_commands` NOTIFY or the 1 second poll, in one transaction: `SELECT … FROM "BotCommand" WHERE status = 'pending' ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`, apply it, set `status` and `handledAt`, commit, then publish `command.handled`. Repeat until none are pending.
- **Command meaning** (this slice has no trading, so each one changes state and emits an event):
  - `start`: state `running`, emit `bot.started`.
  - `stop`: finish current work, take no new signals, state `idle`, emit `bot.stopped`.
  - `kill`: stop immediately (later slices also cancel open orders and close positions), state `killed`, emit `bot.killed`.
  - An unknown type or a handler error sets `failed` with the error text.
- **Shutdown**: on SIGINT/SIGTERM, stop the poller, set the run's `stoppedAt` and `stopReason = 'shutdown'`, release the lock, and disconnect. On Windows, where a kill may skip this, startup recovery and the lock cover it.

## API surface (foundation only)

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/health` | GET | none | `{ api: 'ok', db: 'ok' \| 'down', worker: { status, lastHeartbeatAt, ageSeconds } }` | none for now | 503 only when the db is down |
| `/api/bot/commands` | POST | `type`: `start` \| `stop` \| `kill` | `{ id, type, status }` | none for now | 422 bad type · 409 a command of that type is already pending |
| `/api/bot/commands/:id` | GET | id | `{ id, type, status, error, handledAt }` | none for now | 404 |
| `/ws` | WebSocket | none | events (below) | none for now | rejects a mismatched Origin |

**WebSocket contract** (a zod discriminated union in `packages/shared`): every message is `{ type, payload, at }`, `at` an ISO 8601 UTC string.
- `hello` (sent on connect): `{ serverTime }`
- `bot.started` · `bot.stopped` · `bot.killed`: `{ runId }`
- `command.handled`: `{ commandId, status, error? }`
- No heartbeat events; the frontend polls `/api/health` for that.
- The server pings every 30 seconds and drops clients that miss a pong. The Origin header must match `WEB_ORIGIN`.

**NOTIFY rules**: payloads are only the event JSON above (well under the 8000 byte limit; details are fetched over REST). The worker sends with `SELECT pg_notify('bot_events', $1)` using a bound parameter, after its write commits. The API's LISTEN client has an `error` handler and reconnects with backoff (1s doubling to 30s), running `LISTEN` again on each connect. Events sent while the API is down are lost; on WebSocket reconnect, the frontend reloads state over REST.

**Value sourcing**:
| Action | Value | Source |
|---|---|---|
| health | db | a `SELECT 1` on request |
| health | worker.status, ageSeconds | one query on the newest `BotRun` using `now() - "lastHeartbeatAt"`: `none` if no row, `down` if `stoppedAt` is set or age > 15 seconds, else `up` |
| POST command | status | `BotCommand.status` (always `pending` at creation) |
| GET command | status, error, handledAt | the `BotCommand` row, updated by the worker |
| ws `command.handled` | payload | the worker, after its commit, via `NOTIFY bot_events` |
| ws `hello` | serverTime | the API clock at connect |
| seed | starting balance | `PAPER_START_BALANCE` |

**Security model**: single user (you), localhost only, no login. The API binds to loopback only: `API_HOST` must be `127.0.0.1`, `localhost`, or `::1`, and any other value stops the API at startup. Reaching it from another device is deferred on the scope and needs login first. No exchange keys exist in this slice.

**Configuration required**:
- Base (both): `DATABASE_URL` (Neon pooled), `DATABASE_URL_UNPOOLED` (Neon direct; optional only for a plain local Postgres, where it falls back to `DATABASE_URL`; a `-pooler` host here is refused), `LOG_LEVEL` (default `info`), `NODE_ENV` (default `development`).
- API: `API_HOST` (default `127.0.0.1`, loopback values only), `API_PORT` (default `4000`), `WEB_ORIGIN` (default `http://localhost:5173`).
- Worker: none beyond base. Heartbeat (5s), poll (1s), stale command age (60s), and the lock key (`727001`) are constants in code.
- Seed: `PAPER_START_BALANCE` (default `10000`).
- Tests: `DATABASE_URL_TEST`, a separate database reset between test files.

**Critical test scenarios**:
- Happy path: start the API and the worker; health shows the worker `up` with age under 6 seconds; verifies **AC-2**, **AC-3**.
- Command loop: connect a WebSocket client, POST `start`, receive `command.handled` with `done` in under 2 seconds, measured from the POST; verifies **AC-7**.
- Second worker: start a second worker while one runs; it exits with code 1 and the message; verifies **AC-2**.
- Dead worker: stop the worker without shutdown; within 16 seconds health shows `down`; verifies **AC-3**.
- Failure: insert two orders with one `clientOrderId`; the second fails; verifies **AC-6**.
- Failure: start the API with no `DATABASE_URL`; it exits with a clear message. Start the worker with no `API_PORT`; it runs fine; verifies **AC-8**.
- Money: write `0.1 + 0.2` worth of fee as decimals, read it back as exactly `0.3`, and the API returns it as the string `"0.3"`; verifies **AC-5**.
- Migrate on an empty test database, seed twice, find exactly one `paper-main`; verifies **AC-4**.
- Frontend: `npm run dev` at root serves the existing UI with the same behavior; verifies **AC-1**.

## Consequences

**Positive**:
- The bot keeps running without the browser, and every decision is saved.
- Indicators live once in `packages/shared`, so the UI and the bot agree.
- No message broker or cache; Postgres covers commands, events, and the single worker lock.

**Negative / tradeoffs**:
- Moving the frontend into `apps/web` touches every path and the Vite config once.
- Two processes to run locally, two kinds of database client (Prisma and `pg`), and two Neon URLs to keep straight.
- The worker's 5 second heartbeat keeps the Neon compute awake the whole time it runs, so it never scales to zero. Running around the clock can use up a free plan's monthly compute allowance; check your plan's limits, or stop the worker when you aren't trading.
- Every query crosses the internet to Neon, so it is slower than a local database (fine for this workload), and the bot stops if your internet drops.
- The bot runs only while your PC is on, awake, and online; sleep or a dropped connection pauses trading.
- Express and Prisma need more manual setup than the recommended Fastify and Drizzle (validation, WebSocket, raw SQL for claims and stats).
- No login: you can only use the panel from this PC, not from your phone or another machine.
- Events sent while the API is down are lost; the frontend must reload over REST on reconnect.

**Neutral**:
- A lint rule bans `parseFloat`, `Number(`, and `+` on fields typed as decimal strings in `apps/server` and `packages/shared`, backing AC-5 beyond one test.

## Follow-up

- [ ] Login and remote access are deferred on the scope; decide login and API protection in their own spec before the API ever leaves loopback.
- [ ] The exchange and forex data library is decided in the market data feeds spec (feature 3); `ccxt/ccxt` has an official agent skill worth installing then.
- [ ] Run `/audit` after the scaffold so root `AGENTS.md` records this stack, the installed Prisma skills, and the declined MCP servers (Prisma MCP, Postgres MCP).
