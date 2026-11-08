# 0002. Market data feeds: Binance and OANDA candles in the worker

**Date**: 2026-10-27
**Status**: In Progress

## Summary

The worker collects price data for your 12 pairs. Crypto comes from Binance's free public API and forex from a free OANDA practice account. It loads recent history, then saves each 1 minute candle (one bar of open, high, low, close) when it closes, and builds the 5m, 15m, and 1h candles from those. Each feed reports whether it is live, stale, or closed, and the API serves candles and feed health. The UI keeps its own data sources for now.

## Requirements

**User stories**:
- As the bot owner, I want live and historical candles stored on the backend, so that the paper bot and backtests run on the same data.
- As the bot owner, I want to see when a feed is stale or broken, so that the bot never trades on old prices without me knowing.

**Acceptance criteria**:
- **AC-1**: The 12 instruments exist (BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT on `binance`; EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, EURGBP, GBPJPY on `oanda`), each with its `venueSymbol`. `tickSize` and `minQty` are refreshed from the source each time the worker starts.
- **AC-2**: After the first start, every instrument has candles up to its last closed candle: 1m for the last 30 days, and 5m, 15m, 1h for the last 90 days, with no duplicates. Binance series have no gaps. OANDA series have gaps only where OANDA itself returns no candle (market closed, or no ticks in that minute).
- **AC-3**: Every closed Binance 1m candle is stored within 10 seconds of its close, and each 5m, 15m, 1h candle within 10 seconds of its last 1m candle closing.
- **AC-4**: Every closed OANDA 1m mid candle is stored within 15 seconds of its close during market hours, and each 5m, 15m, 1h candle within 15 seconds of its last 1m candle closing. The latest bid and ask for each forex pair are available in worker memory.
- **AC-5**: `FeedStatus` shows each instrument as `backfilling`, `live`, `stale`, `closed`, or `error`. A live feed turns `stale` within 60 seconds of its data stopping, and forex shows `closed` while OANDA marks it not tradeable (for example at the weekend).
- **AC-6**: After a dropped connection, a worker restart, or the PC waking from sleep, the feed reconnects with backoff and backfills every gap, so no closed candle is missing.
- **AC-7**: `GET /api/instruments` and `GET /api/candles` return data with every price as a decimal string; candles are paginated (at most 1000 per page).
- **AC-8**: Once a day, 1m candles older than 30 days and 5m, 15m, 1h candles older than 90 days are deleted.
- **AC-9**: With OANDA settings missing or rejected, forex instruments go to `error` with a clear reason and crypto keeps running. The OANDA token never appears in logs or API responses.
- **AC-10**: A `feed.status` WebSocket event is pushed whenever an instrument's status changes.

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Decision

**Chosen option**: Option 1: direct Binance and OANDA clients inside the worker, closed candles only.

The worker runs one Binance 1m kline WebSocket plus REST history, and one OANDA pricing stream plus 1m candle polling. Live 5m, 15m, and 1h candles are built from closed 1m candles. Forming candles and live quotes stay in memory, and each candle is written once when it closes.

## Feature design

**Lifecycle**: the feed belongs to the worker, not to the bot. It starts when the worker starts and runs for the worker's whole life, whether the bot is `idle`, `running`, or `killed`; `start`, `stop`, and `kill` never touch it. Worker startup order: lock → recovery → heartbeat and command loop → feed init (in the background, so health shows `up` right away). The bot may `start` while feeds are backfilling; the strategy runner (a later feature) skips instruments that aren't `live`. On shutdown the feed closes its sockets and flushes the write queue before the lock is released.

**Sources**:
| Venue | History (backfill) | Live | Closed 1m signal |
|---|---|---|---|
| Binance (public, no key) | `GET /api/v3/klines` per timeframe, 1000 per request | One combined stream `wss://stream.binance.com:9443/stream?streams=<sym>@kline_1m/…` (5 streams) | Kline message with `k.x = true` |
| OANDA (practice account) | `GET /v3/instruments/{inst}/candles?price=M&granularity=<M1,M5,M15,H1>&smooth=false` with `from` and `to`, chunked under 5000 candles (about 3.4 days of M1 per request) | Pricing stream `GET /v3/accounts/{id}/pricing/stream` for bid, ask, `tradeable`, and a heartbeat every 5s | Poll M1 candles `from` the last stored open time, at 3, 6, and 10 seconds after each minute boundary until `complete = true` |

Hosts: OANDA `api-fxpractice.oanda.com` and `stream-fxpractice.oanda.com` when `OANDA_ENV=practice` (`api-fxtrade` / `stream-fxtrade` for `live`). Every OANDA request sends `Accept-Datetime-Format: RFC3339`; times are parsed to milliseconds (nanoseconds cut off). The OANDA stream is newline separated JSON across chunks, so the client keeps a line buffer.

**Higher timeframes** (live): when the last 1m candle of a 5m, 15m, or 1h bucket is stored, build that bucket's candle: open of the first 1m, max high, min low, close of the last, sum of volume. If any 1m candle in the bucket is missing (allowed on OANDA quiet minutes), build from the 1m candles present; if none are present, write nothing. Backfill still uses each venue's own 5m, 15m, 1h REST candles.

**Data model sketch** (changes to spec 0001; one migration):
| Entity | Change |
|---|---|
| Instrument | add `venueSymbol` (String, required), unique (venue, venueSymbol). Seeded: Binance `BTCUSDT` style, OANDA `EUR_USD` style. `venue` values: `binance`, `oanda`. |
| FeedStatus (new) | `instrumentId` (PK, FK Instrument, Restrict), `status` (enum `FeedState`: `backfilling` · `live` · `stale` · `closed` · `error`), `lastTickAt` (timestamptz, nullable), `lastCandleAt` (timestamptz, nullable), `lastError` (String, nullable), `updatedAt` (timestamptz) |
| Candle | unchanged. Written only when closed. Prices for forex are mid prices; `volume` is the source's volume (OANDA: tick count). |

**Seed** (extends the 0001 seed, safe to run again): upserts the 12 instruments with `assetClass`, `venue`, `venueSymbol`, `baseAsset`, `quoteAsset`, and placeholder `tickSize`/`minQty` (`0.00000001`) that the worker overwrites at start.

**Candle writes** (all paths: live, built, backfill, retry):
- Every write is raw SQL `INSERT … ON CONFLICT (instrumentId, timeframe, openTime) DO NOTHING`, multi row, up to 5000 rows per statement. Backfill runs 2 to 3 inserts at once. Expected first load: about 960k rows, about 3 to 5 minutes; storage about 150 to 170 MB.
- The worker keeps the last written `openTime` per series in memory and skips repeats (the same closed kline from the stream, from REST, and after a reconnect).
- `onCandleClosed` fires only for live candles the insert actually added, never for backfilled ones.
- A failed write goes to an in memory retry queue (up to 10,000 candles), retried with backoff (1s doubling to 60s). Overflow drops the oldest, logs an error, and sets those instruments to `backfilling` so the next backfill refills the hole.

**Backfill**: runs at worker start, after every reconnect, and after a wake from sleep, one venue at a time.
- Order: open the live stream first and hold its closed candles in memory → backfill up to now → write the held candles (duplicates skipped) → `live`.
- Per series, find the oldest gap inside the retention window (a gap query on stored `openTime`s, not just "newest plus one"), so a candle stuck in the retry queue is never skipped for good.
- Binance gaps must all be filled. OANDA gaps that OANDA itself returns no candle for are accepted as gaps; nothing is invented.
- After backfill, load the last 500 closed candles per series (48 series, about 5 MB) into memory from the database.

**In memory (worker only)**:
- Forming 1m candle per instrument; latest quote per instrument: forex `{ bid, ask, at }` from the pricing stream, crypto `{ last, at }` from every kline message (forming ones too, `k.c`).
- `lastTickAt` per instrument, flushed to `FeedStatus` for all 12 in one statement every 30 seconds, and at once on any status change (so `/api/instruments` can lag 30 seconds on `lastTickAt`).
- The last 500 closed candles per series, and a `MarketData` module for the paper bot: `getQuote(instrumentId)`, `getCandles(instrumentId, timeframe, n)`, `onCandleClosed(listener)`.

**State transitions** (`FeedStatus.status`, per instrument):
- start, reconnect, or wake → `backfilling` → `live` (backfill done, live data flowing). The stale timer is paused while `backfilling` or `error`.
- `live` → `stale`: crypto gets no kline message (any of its streams) for 30 seconds; forex is tradeable but gets no price and no heartbeat for 60 seconds.
- `stale` → `backfilling` on reconnect → `live`.
- forex `live`/`stale` → `closed` when prices arrive with `tradeable = false`; `closed` → `live` on the first tradeable price. No weekend hours are hard coded (OANDA's weekly close moves with US daylight saving).
- any → `error`: OANDA settings missing or rejected (401/403), an unknown instrument (400), or Binance blocking the region (HTTP 451, message "Binance is not available from your network"). `error` retries every 5 minutes, logging a repeated error once rather than every retry, then → `backfilling`.

**Connections and limits**:
- Reconnect backoff: 1s doubling to 60s, never under 1s, reset after 5 minutes of healthy data. Binance also closes streams every 24 hours by design; that is a normal reconnect.
- Watchdogs: Binance socket with no frame (including pings) for 60 seconds, or OANDA stream with no heartbeat for 15 seconds → close and reconnect. The `ws` library answers Binance pings.
- Rate limits: Binance HTTP 429 or 418 → wait `Retry-After` (default 60s). OANDA 429 → wait 1s, doubling. OANDA allows only 2 pricing streams per account, so the worker never opens a second one.
- Clock: at start, compare the local clock with Binance `GET /api/v3/time` and warn in the log if they differ by more than 2 seconds.
- Sleep: a timer that fires more than 30 seconds late means the PC slept; the feed reconnects both venues and backfills.

**Retention**: at start and once a day, delete candles older than the window per timeframe in batches of 10,000 rows. This replaces spec 0001's "candles are never deleted" for candles only; orders, fills, and positions are still never deleted.

**API surface** (localhost only, no login, per spec 0001):
| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/instruments` | GET | none | `[{ id, symbol, assetClass, venue, tickSize, minQty, timeframes, feed: { status, lastTickAt, lastCandleAt, lastError } }]` (bounded set, no pagination) | none (localhost) | 503 db down |
| `/api/candles` | GET | `symbol` (req), `timeframe` (req, `1m`·`5m`·`15m`·`1h`), `from` (ISO, opt), `to` (ISO, opt), `limit` (opt, default 500, max 1000), `cursor` (opt, an `openTime`) | `{ candles: [{ openTime, open, high, low, close, volume }], nextCursor }` oldest first, prices as decimal strings | none (localhost) | 404 unknown symbol · 422 bad timeframe or range |
| `/ws` event `feed.status` | push | none | `{ instrumentId, symbol, status, lastError? }` | Origin check (0001) | none |

**Value sourcing**:
| Action | Value | Source |
|---|---|---|
| seed | the 12 symbols, venue, venueSymbol, base/quote | static list in the seed, matching `apps/web/src/App.jsx` |
| worker start | Binance tickSize, minQty | `GET /api/v3/exchangeInfo`: PRICE_FILTER `tickSize`; LOT_SIZE `stepSize` stored as `minQty` (spec 0001 rounds sizes down to this step) |
| worker start | OANDA tickSize, minQty | `GET /v3/accounts/{id}/instruments`: tickSize = `10^-displayPrecision` (0.001 for JPY pairs, 0.00001 for the rest); `minQty` = `minimumTradeSize` (units, kept as a decimal string) |
| `/api/instruments` | timeframes | the constant list `1m, 5m, 15m, 1h` in `packages/shared` (feed timeframes) |
| backfill | where to start | the oldest gap per series inside the retention window (gap query on `Candle.openTime`) |
| live crypto | closed 1m candle | Binance kline `k.t` open time, `o h l c v`, closed when `k.x` |
| live forex | closed 1m candle | OANDA M1 `mid.o h l c`, `volume`, `time` (RFC3339 open time), `complete = true` |
| live | 5m, 15m, 1h candle | built from that bucket's stored 1m candles |
| live forex | bid, ask, tradeable | OANDA pricing stream `bids[0].price`, `asks[0].price`, `tradeable` |
| live crypto | last price | Binance kline `k.c` on every message |
| status | stale or closed | worker clock vs last message time (30s crypto, 60s forex); OANDA `tradeable` |
| `GET /api/instruments` | feed fields | `FeedStatus` row (`lastTickAt` up to 30s old) |
| `GET /api/candles` | prices | `Candle` columns, serialized with `toDecimalString` |
| `feed.status` event | payload | worker, after the `FeedStatus` write, via `NOTIFY bot_events` |

**Key invariants**:
- A candle is stored only after its source marks it closed (or, for a built candle, after its last 1m candle is stored); a forming candle never reaches the database.
- Candle open times are UTC and aligned to their timeframe (`alignToTimeframe` in `packages/shared`); a misaligned one from a source is logged and dropped.
- Candle writes are idempotent (`ON CONFLICT DO NOTHING`), and the same candle is never announced twice.
- At most one feed runs, because it lives in the worker, which holds the single worker lock (spec 0001).
- No float reaches a stored price: source strings go straight to `Decimal`.
- The OANDA token is read from the environment only and is redacted from every log line.

**Security model**: single user, localhost only (spec 0001). Market data is public. The only secret is the OANDA practice token, stored in `apps/server/.env`. It is read only by the worker, never sent to the API or the browser, and redacted in logs (pino `redact`).

**Configuration required**:
- `OANDA_API_TOKEN`: personal access token from your OANDA practice account (prerequisite: create a free fxTrade Practice account and generate a token).
- `OANDA_ACCOUNT_ID`: the practice account id (format `101-001-XXXXXXX-001`), needed for the pricing stream.
- `OANDA_ENV`: `practice` (default) or `live`.
- These are worker settings and optional at startup: when they're missing, forex instruments go to `error` and crypto still runs (AC-9).

**Critical test scenarios**:
- Happy path: start the worker on an empty candle table; health is `up` at once, within about 5 minutes every instrument is `live`, history covers the retention windows, and a new 1m candle per pair appears each minute; verifies **AC-1**, **AC-2**, **AC-3**, **AC-4**.
- Built candles: at a 5 minute boundary, each crypto pair gets a 5m candle whose high and low match its five 1m candles; verifies **AC-3**.
- Failure: cut the network for 2 minutes; feeds turn `stale`, then reconnect, backfill the gap, and return to `live` with no missing Binance 1m candle; verifies **AC-5**, **AC-6**.
- Failure: start with a wrong OANDA token; forex is `error` with "OANDA rejected the token", crypto is `live`, and the token is absent from logs; verifies **AC-9**.
- Weekend: forex shows `closed`, not `stale`; verifies **AC-5**.
- API: `GET /api/candles?symbol=BTCUSDT&timeframe=1m&limit=1000` returns 1000 rows with string prices and a `nextCursor`; a bad timeframe gives 422; verifies **AC-7**.
- Duplicates: run backfill twice; the row count is unchanged; verifies **AC-2**.

## Build plan

Tracer Bullet: one real thread first (BTCUSDT 1m, live to database to API), then thicken.

1. Migration: `Instrument.venueSymbol` and unique key, `FeedStatus` table and `FeedState` enum; extend the seed with the 12 instruments; satisfies **AC-1**.
2. Thin thread: feed init after the heartbeat in worker startup; Binance 1m kline stream for BTCUSDT; idempotent candle writer with the retry queue; `GET /api/candles` with pagination and decimal strings; satisfies **AC-3**, **AC-7**.
3. `FeedStatus` writes, the 30 second `lastTickAt` flush, the stale timer, the `feed.status` event (shared event union plus NOTIFY), and `GET /api/instruments`; satisfies **AC-5**, **AC-10**, **AC-7**.
4. Binance backfill (hold live, gap query, multi row parallel inserts), the 1m to 5m, 15m, 1h builder, reconnect with backoff, watchdog, rate limits, the 451 error; widen to all 5 pairs; satisfies **AC-2**, **AC-3**, **AC-6**.
5. OANDA client: config, pricing stream with line buffer and heartbeat watchdog (bid/ask in memory, `tradeable` → `closed`), M1 polling at 3, 6, 10 seconds, chunked backfill, error mapping, token redaction; satisfies **AC-4**, **AC-5**, **AC-6**, **AC-9**.
6. Instrument metadata refresh at start (tickSize, minQty), the clock skew check, and wake from sleep detection; satisfies **AC-1**, **AC-6**.
7. In memory `MarketData` module (quotes, last 500 candles, `onCandleClosed`) for the paper bot; satisfies **AC-4**.
8. Daily retention job with batched deletes; satisfies **AC-8**.

## Consequences

**Positive**:
- One source of truth for candles, shared by the paper bot and backtests.
- No new libraries: Node `fetch` and the `ws` package already installed.
- Building 5m, 15m, 1h from 1m cuts live load to 5 Binance streams and about 7 OANDA polls a minute, and closed candle writes stay light on Neon (about 20 a minute).

**Negative / tradeoffs**:
- A feed problem shares the worker process with trading; a crash in feed code restarts the bot too.
- You need a free OANDA practice account and token before forex works.
- Forex candles are mid prices; spread costs only show up later, through live bid/ask in paper fills.
- Live higher timeframe candles are built locally, so on quiet OANDA minutes they can differ slightly from OANDA's own 5m, 15m, 1h candles.
- Backtests are limited to the retention windows (30 days of 1m, 90 days of the rest), and old candles are deleted for good. Storage lands around 150 to 170 MB, a large share of Neon's free plan.
- The first backfill takes about 3 to 5 minutes; feeds show `backfilling` meanwhile.
- If Binance or OANDA is blocked from your network, that venue sits in `error` until the source changes.

**Neutral**:
- The UI still calls Binance and Frankfurter directly; it switches to this API in the control panel feature.

## Follow-up

- [ ] Spec 0001 says candles are never deleted; this spec replaces that rule for candles (AC-8). `/sync` should reconcile the wording.
- [ ] Create the OANDA practice account and token before building step 5.
- [ ] Declined for this feature: Binance skills hub (no market data skill), Binance MCP, OANDA community skills and MCP servers. `/audit` should record the declines in `AGENTS.md`.
