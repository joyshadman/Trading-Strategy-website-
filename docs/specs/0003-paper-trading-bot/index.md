# 0003. Paper trading bot: event driven paper engine in the worker

**Date**: 2026-10-28
**Status**: In Progress

## Summary

The worker gets a paper trading engine. Each time a 15 minute candle closes, it runs your Strong Buy/Strong Sell rule (EMA stack, MACD, RSI, zScore) on 12 pairs, with a 1 hour trend filter. Trades it takes are pretend orders that fill at realistic prices, with fees and slippage (the small price loss when an order fills). Every trade passes risk checks first: 1% of equity at risk, stop loss and take profit, max open trades, leverage limits, and a daily loss halt. Everything is saved in the database, so a restart loses nothing and no order can happen twice. The API gets read only endpoints and live events, which the control panel (feature 5) will show.

## Requirements

**User stories**:
- As the bot owner, I want the bot to trade my Strong signals on paper with the browser closed, so that I learn whether the rule makes money after fees before risking real money.
- As the bot owner, I want every trade to pass the risk limits first, so that one bad day or one bad pair can't wipe out the account.
- As the bot owner, I want state to survive restarts and nothing to be ordered twice, so that I can trust the paper results.

**Acceptance criteria**:
- **AC-1**: The seed (safe to run again) creates two enabled strategies on `paper-main`, both kind `ema_rsi_macd` on `15m` with the 1h trend filter: `crypto-trend` (the 5 Binance pairs, long only, SL 1.4%, TP 2.8%, max position $3,000) and `forex-trend` (the 7 OANDA pairs, both directions, SL 0.09%, TP 0.18%, max position $150,000). Both have 3 max open trades, a $300 daily loss limit, and 1% risk per trade.
- **AC-2**: When a 15m candle closes for an instrument in an enabled strategy, the worker evaluates the strategy once (no browser needed) on the last 200 closed 15m candles. The 1h filter uses the last 200 1h candles whose close time (open time + 1h) is at or before that 15m candle's close time (open time + 15m). Evaluation is one pure function in `packages/shared`, so the same inputs always give the same signal.
- **AC-3**: Every Strong signal whose write succeeds is saved as a `Signal` row with outcome `ordered` (it opened or closed a position) or `skipped`, and a skipped one carries a reason from the fixed list in `packages/shared`. A `signal.created` event is pushed. A candle is never evaluated twice for the same strategy, enforced by a unique key on the database.
- **AC-4**: New entries happen only while the bot is `running` and the strategy is enabled. Crypto opens long only; forex opens long and short.
- **AC-5**: Before every entry, these checks run in this fixed order, and the first one that fails is saved as the `skipped` reason, with no order made: the bot is `running`; the direction is allowed; the 1h bias agrees; the feed is `live` (and for forex, the pair is tradeable); no open position for that strategy and instrument; open positions are below `maxOpenTrades`; the strategy's daily halt has not tripped; a conversion rate to USD exists; there is enough free margin; and the size is at least `minQty`. Size = (`riskPerTradePct` of equity) divided by (loss at the stop plus both fees plus exit slippage, in USD), then the smallest of that, the `maxPositionSize` cap (USD notional), and the free margin cap (leverage 1:1 crypto, 20:1 forex), rounded down to the `minQty` step.
- **AC-6**: Crypto market orders fill at the last price moved 0.05% against you, rounded to the tick against you, and pay a 0.10% fee per side in USDT. Forex buys fill at the ask, and sells fill at the bid, with no fee. Each fill writes its `Order`, `Fill`, `Position`, and `Account` changes in one all or nothing transaction.
- **AC-7**: Each position stores its stop loss and take profit at entry: entry price moved by `stopLossPct` and `takeProfitPct`, rounded to the tick. On every fresh live price, open positions are checked. When the exit side price reaches the SL or TP, the position closes at that price (crypto with slippage and fee), so gaps count against you.
- **AC-8**: An opposite Strong signal closes the open position with reason `opposite_signal`, whatever the 1h bias, in any bot state except `killed`. Forex then opens the other way if every AC-5 check passes. Crypto never opens a short.
- **AC-9**: When a strategy's realized PnL (after fees) from positions closed since 00:00 UTC today reaches minus `dailyLossLimit`, that strategy opens nothing new until the next UTC day. Its open positions keep their SL, TP, and opposite signal exits. `risk.halted` is pushed once, from the close that crosses the limit.
- **AC-10**: `stop` blocks new entries, but open positions are still managed (SL, TP, opposite signal). `kill` sets the state to `killed`. Then, inside the trader's queue, it creates a pending exit order with reason `kill` for every open position that doesn't have one yet. Each one fills at the first `live` price (at once when the feed is live; forex at the first tradeable price). Pending kill orders survive a later `start`. Nothing new opens until the next `start`.
- **AC-11**: No order happens twice. An entry's `clientOrderId` is `e:<signalId>`, an exit's is `x:<positionId>`, and the database allows at most one `open` position per strategy and instrument. A repeated candle event, a retried write, or a restart can't create a second entry or a second exit.
- **AC-12**: After a worker restart, open positions and pending kill orders load from the database. SL/TP checks resume on the first fresh price, and pending kill orders fill when their market is tradeable. The bot starts `idle` (spec 0001) and still manages open positions while idle. 15m closes missed while the worker was down are not replayed.
- **AC-13**: While a pair's feed is `stale`, `error`, `backfilling`, or (forex) not tradeable, nothing opens on it, and open positions on it are held. The first fresh tradeable price runs the SL/TP check, and fills at that price.
- **AC-14**: Every amount is in USD (1 USDT counts as 1 USD; JPY, CAD, and GBP convert at the live mid price of your forex pairs). `realizedPnl` is net of both fees. A close changes `Account.balance` by exactly that position's `realizedPnl`, and nothing else changes the balance. Every 5 seconds the worker updates `markPrice`, `unrealizedPnl`, and `markedAt` on open positions and sets `Account.equity` = balance + the sum of `unrealizedPnl`. It pushes `account.updated` when equity changed. An `EquitySnapshot` is written every 15 minutes, on the quarter hour UTC.
- **AC-15**: If the database write for an entry fails, the entry is dropped and logged, never retried later. If an exit or kill fill fails, it is retried on the next fresh quote, whatever the price does (the triggered exit stays owed). No partial trade is ever stored.
- **AC-16**: `GET /api/account`, `/api/strategies`, `/api/positions`, `/api/positions/:id`, `/api/signals`, and `/api/equity` return every money value as a decimal string, and the lists are paginated as in the API table. `position.opened` and `position.closed` are pushed on every open and close.

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Decision

**Chosen option**: Option 1: an event driven paper engine inside the worker, behind a broker interface.

A `Trader` module in the worker listens to closed 15m candles and live quotes from the existing `MarketData` module. It runs the pure strategy function from `packages/shared`, and sends orders through a `Broker` interface whose only implementation for now is `PaperBroker`. It keeps open positions in memory for fast SL/TP checks, but the database is always the source of truth.

**Implementation skills**: `prisma-client-api` · `prisma-cli` (both `prisma/skills`, `.agents/skills/<skill>/`)

## Feature design

**Where the code lives**:
```
packages/shared/src/
  strategies.ts     add: params schema (zod), evaluateEmaRsiMacd(), trendBias(), zScore()
  paper.ts          new: fee, slippage, leverage constants; SKIP_REASONS; ORDER_REASONS
  events.ts         add: signal.created, position.opened, position.closed, risk.halted, account.updated
  api.ts            add: response schemas for the new endpoints
apps/server/src/
  trader/trader.ts       new: listens to candles and quotes, runs the serial queue, entries and exits
  trader/risk.ts         new: entry checks and sizing (pure)
  trader/accounting.ts   new: quoteToUsd, PnL, margin, equity (pure)
  trader/broker.ts       new: Broker interface + PaperBroker (fill model + transactions)
  trader/marks.ts        new: 5 second marks, equity, 15 minute snapshots
  feed/marketData.ts     change: add onQuote(listener)
  feed/feed.ts           change: expose getFeedState(instrumentId)
  feed/builder.ts        change: build 1h, then 15m, then 5m (largest first)
  api/trading.ts         new: the read endpoints
```

**Strategy rule** (`evaluateEmaRsiMacd(closes15m, closes1h, params)`, pure, takes plain numbers):
- Closes are converted from decimal strings with one helper in `packages/shared` (indicator use only, never money), so the lint rule against `Number(` on decimal strings still holds.
- Needs at least `lookback` (200) closes of each timeframe; with fewer, it returns no signal and saves no row. Gaps in the history (OANDA quiet minutes, spec 0002) are not filled; the function uses the candles that exist.
- On the 15m closes: `ema9 = EMA(9)`, `ema21 = EMA(21)`, `ema50 = EMA(50)`, `rsi = RSI(14)`, `macd = MACD(12,26,9)` (the existing shared functions). `z = (lastClose − mean) / stdDev` over the 200 closes (population standard deviation). If `stdDev` is 0, there is no signal.
- **Strong Buy**: `ema9 > ema21 > ema50`, `macd.hist > 0`, `rsi < 65`, `z < 1.5`.
- **Strong Sell**: `ema9 < ema21 < ema50`, `macd.hist < 0`, `rsi > 35`, `z > −1.5`.
- **1h bias** (`trendBias`, the browser's `computeBiasFromCloses`): `bull` when the 1h EMA stack is up, `hist > 0`, and `rsi < 72`; `bear` when the stack is down, `hist < 0`, and `rsi > 28`; otherwise `neutral`. An entry needs `bull` for a buy and `bear` for a sell. Exits ignore the bias.
- Every threshold above lives in `Strategy.params` (validated by a zod schema): `emaFast 9, emaMid 21, emaSlow 50, rsiPeriod 14, rsiLongMax 65, rsiShortMin 35, zMax 1.5, lookback 200, trendTimeframe '1h', trendRsiLongMax 72, trendRsiShortMin 28, allowShort`. `allowShort` is `false` for `crypto-trend` and `true` for `forex-trend`.
- Returns `{ side: 'buy' | 'sell' | null, indicators: { ema9, ema21, ema50, rsi, macdHist, z, trend } }`. The indicators go into `Signal.indicators`.
- **1h timing**: the builder (spec 0002) is changed to build the largest timeframe first, so when the 15m candle closing at the top of the hour is announced, that hour's 1h candle is already in memory. The 1h input follows the AC-2 rule. Backtests (feature 6) use the same rule, so no future data leaks in.

**Data model sketch** (changes to spec 0001 and 0002; one migration):
| Entity | Change | Keys and rules |
|---|---|---|
| Order | add `reason` (new enum `OrderReason`: `entry` · `stop_loss` · `take_profit` · `opposite_signal` · `kill`, required); add `positionId` (UUID, nullable: entry orders get it in the same transaction that inserts the Position; exit orders, including pending kill orders, have it from creation) | FK Position (Restrict). `signalId` stays unique and is set only on entry orders. `clientOrderId` is `e:<signalId>` for entries, `x:<positionId>` for exits. An exit order has `side` opposite the position, `type` `market`, `qty` = the position's qty, `price` null, and the position's `strategyId`, `accountId`, and `instrumentId` |
| Position | add `exitPrice` (nullable), `closeReason` (`OrderReason`, nullable, never `entry`), `fees` (NUMERIC, USD, default 0), `entryQuoteToUsd` (NUMERIC, required), `closeQuoteToUsd` (nullable), `markPrice` (nullable), `unrealizedPnl` (nullable, USD), `markedAt` (timestamptz, nullable). `realizedPnl` means USD after both fees | Partial unique index (raw SQL in the migration): `(strategyId, instrumentId) WHERE status = 'open'` |
| Signal | no new columns; `candleTime` = the 15m candle's open time; `skipReason` is one of `SKIP_REASONS` | add unique `(strategyId, instrumentId, candleTime)` |
| RiskSettings | add `riskPerTradePct` NUMERIC(10,4), default `1` (percent) | unchanged 1:1 Strategy |
| EquitySnapshot (new) | `id`, `accountId`, `balance`, `equity`, `openPositions` (Int), `takenAt` (timestamptz) | FK Account (Restrict), N:1; unique `(accountId, takenAt)`; index `(accountId, takenAt)` |
| Account | no change. `balance` = cash after closed trades; `equity` = balance + open `unrealizedPnl` | |

`SKIP_REASONS`, in the AC-5 check order (the first failure wins): `bot_stopped` · `direction_not_allowed` · `trend_disagrees` · `feed_not_live` · `market_closed` · `already_open` · `max_open_trades` · `daily_loss_halt` · `no_conversion_rate` · `insufficient_margin` · `size_below_min`. A crypto Strong Sell with no long to close is `skipped` with `direction_not_allowed`.

**Seed** (extends 0001/0002, safe to run again): upserts `crypto-trend` and `forex-trend` by name, their `StrategyInstrument` rows, and their `RiskSettings` with the AC-1 values. Both are `enabled = true`; the bot still waits for `start`.

**Event flow in the worker**:
- **One serial queue.** Every trader action that writes (a candle evaluation, a triggered exit, a kill sweep or kill fill, the 5 second mark) runs one at a time, in arrival order. When 12 candles close together, open trade counts and margin are always counted correctly. With Neon about 300 ms away, each fill takes at most 2 round trips: a raw SQL statement (CTE) where practical, or a Prisma transaction with explicit `timeout` and `maxWait` set above the defaults.
- **In memory cache.** Open positions and pending kill orders per instrument, the cached balance, the cached `unrealizedPnl` per position, and today's realized PnL per strategy, keyed by UTC date (a new date starts at 0). Loaded from the database at start and updated only after a commit. The database stays the source of truth.
- **On 15m candle closed** (`MarketData.onCandleClosed`, timeframe `15m`; backfilled candles never fire): for each strategy holding that instrument, skip it if the strategy is disabled or the bot is `killed`. Otherwise evaluate. If there's no Strong signal, stop. Then:
  1. Generate the signal's UUID and `INSERT … ON CONFLICT DO NOTHING` the `Signal` as `skipped` (no reason yet). If no row was inserted, the candle was already handled: stop.
  2. If an open position is on the other side, close it (`opposite_signal`).
  3. Run the AC-5 checks. If they pass, the entry transaction also sets the row to `ordered`. If they fail, set the `skipReason`, or set `ordered` when step 2 closed a position.
  4. Push `signal.created` after the final write.
  In `idle`, steps 1 to 3 still run, so exits happen, and the entry check stops at `bot_stopped`.
- **Exits for disabled strategies**: SL, TP, and kill exits run for every open position whatever the strategy's `enabled` flag. Only evaluation (entries and opposite signal exits) needs it enabled.
- **On quote** (`MarketData.onQuote`, new): store the latest quote at once (no queue). For instruments with an open position or a pending kill order, and only while the feed state is `live` (forex: `tradeable`), test the triggers in memory: a pending kill, then SL, then TP. Queue a job only when one fires, at most one per position until it finishes. A failed exit or kill fill stays owed and is queued again on the next fresh quote.
- **Exit side price**: crypto long uses `last`. Forex long uses `bid`, forex short uses `ask`.
- **Commands**: `kill`'s statement in `commands.ts` only sets the state (as today). After any command commits, the trader is told the new state through its queue. On `killed`, it runs a kill sweep: `INSERT` a pending `kill` exit order (`x:<positionId>`, `ON CONFLICT DO NOTHING`) for every open position, then reloads pending kill orders into the cache. Because the sweep is in the queue, it can't race an entry or an exit. At worker start, if the previous run ended `killed` with positions still open, the sweep runs again, so a crash between the kill and the sweep still closes everything.
- **Lock loss**: the worker already exits when it loses its lock connection (spec 0001), and the trader stops with it. Startup recovery covers the rest.

**Paper fill model** (`PaperBroker`):
| Venue | Buy fills at | Sell fills at | Fee per fill |
|---|---|---|---|
| Binance (crypto) | `last × 1.0005`, rounded up to the tick | `last × 0.9995`, rounded down to the tick | 0.10% of the fill's notional, in USDT |
| OANDA (forex) | `ask` | `bid` | 0 (the spread is the cost); `feeCurrency` = the quote currency |

Every fill is one transaction:
- **Entry**: insert `Signal` (`ordered`), `Order` (`entry`, `filled`), `Position` (`open`, with SL, TP, `entryQuoteToUsd`, `fees` = the entry fee in USD), and `Fill`, then set `Order.positionId`. The balance does not change at entry.
- **Exit**: `UPDATE "Position" SET status = 'closed', "exitPrice", "closeReason", "closeQuoteToUsd", fees = fees + exitFeeUsd, "realizedPnl", "closedAt" = now() WHERE id = $1 AND status = 'open'`. If that touches 0 rows, roll back (already closed). Then insert, or for a kill update, the exit `Order` (`x:<positionId>`, `filled`) and its `Fill`, and add `realizedPnl` to `Account.balance`. `exitFeeUsd = feeRate × exitPrice × qty × closeQuoteToUsd`.
- **Timestamps**: `openedAt`, `closedAt`, and `Fill.filledAt` all use the database clock (`now()`), the same clock the daily halt and the API use for "today".
- Events are published only after the commit. After every close, the trader also pushes `account.updated` with the new balance and the equity from the cache.

**Sizing** (pure, `trader/risk.ts`), for an entry at fill price `p` (the AC-6 price):
- `dir` = +1 for a buy, −1 for a sell. `q2u` = quote currency to USD (below). `feeRate` = 0.001 (crypto) or 0 (forex). `slip` = 0.0005 (crypto) or 0 (forex). `sl` = `stopLossPct / 100`.
- Loss per unit in USD = `p × q2u × (sl + 2 × feeRate + slip)`.
- Equity = the cached balance + the sum of cached `unrealizedPnl` at this moment (not the last 5 second mark), so several signals in one second size on current numbers.
- Risk budget = `equity × riskPerTradePct / 100`. Raw qty = budget ÷ loss per unit.
- Cap 1 qty = `maxPositionSize ÷ (p × q2u)`.
- Cap 2 qty = `max(0, free margin) × leverage ÷ (p × q2u)`, where free margin = equity − margin used by open positions. Leverage is 1 for crypto, 20 for forex.
- qty = the smallest of raw, cap 1, and cap 2, rounded down to the `minQty` step (`roundDownToStep`; `minQty` is the venue's step, spec 0002). If cap 2 is the smallest and the rounded qty is below `minQty`, the reason is `insufficient_margin`. Any other qty below `minQty` gives `size_below_min`.
- SL = `p × (1 − dir × sl)`, TP = `p × (1 + dir × tp)`, both rounded to the nearest tick.

**Accounting** (pure, `trader/accounting.ts`):
- `q2u` for quote currency C: `1` for USD or USDT. Otherwise, the mid `(bid + ask) / 2` of the pair `C/USD` (GBP uses GBPUSD), or `1 / mid` of `USD/C` (JPY uses USDJPY, CAD uses USDCAD). Entries need that pair to be `live`, else `no_conversion_rate`. Marks and exits use the latest known mid, even if it's old.
- `realizedPnl = (exitPrice − entryPrice) × dir × qty × closeQuoteToUsd − fees` (both fees in USD).
- `markPrice` = the exit side price without slippage (crypto `last`, forex long `bid`, short `ask`).
- `unrealizedPnl = (markPrice − entryPrice) × dir × qty × current q2u − fees` (entry fee only; the future exit fee isn't estimated).
- After a restart, before the first quote arrives, the stored `markPrice` and `unrealizedPnl` stand, and `entryQuoteToUsd` is the fallback `q2u`. At start, the cached equity = `Account.balance` + the sum of stored `unrealizedPnl`.
- Margin used = sum over open positions of `qty × entryPrice × entryQuoteToUsd ÷ leverage`.
- Today's realized PnL per strategy = sum of `realizedPnl` where `closedAt ≥` today 00:00 UTC.
- Money math uses `Money` (`decimal.js`, half even) and is stored at 12 decimal places.

**Marks and snapshots** (`trader/marks.ts`): every 5 seconds, as a queue job, compute the mark price and `unrealizedPnl` for each open position from the latest quote. Write only the positions whose values changed, plus `Account.equity`, in one statement, then push `account.updated` if equity differs from the last value pushed. At every quarter hour UTC (00, 15, 30, 45), on a timer aligned to the boundary (`setTimeout` to the next quarter, then again), insert an `EquitySnapshot` with `takenAt` = the boundary and the cached balance and equity (`ON CONFLICT DO NOTHING` on `(accountId, takenAt)`), whatever the bot state. Quarters missed while the worker was down or asleep are not backfilled.

**State transitions**:
- Position: `open` → `closed`, with `closeReason` one of `stop_loss` · `take_profit` · `opposite_signal` · `kill`.
- Entry Order: created `filled` in one step (paper fills at once).
- Kill Order: `pending` (created by the kill sweep) → `filled` (at the first `live` price; forex also needs it tradeable).
- What the bot does in each state (BotRun.state, spec 0001):
| State | Entries | SL / TP | Opposite signal exit | Pending kill fills |
|---|---|---|---|---|
| `running` | yes | yes | yes | yes |
| `idle` (stop, or fresh start of the worker) | no (`bot_stopped`) | yes | yes | yes |
| `killed` | no (not evaluated) | only through the kill orders | no | yes |

**API surface** (localhost only, no login, read only; edits come with the control panel spec):
| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/account` | GET | none | `{ id, name, currency, balance, equity, marginUsed, freeMargin, openPositions, todayRealizedPnl }` | none (localhost) | 503 db down |
| `/api/strategies` | GET | none | `[{ id, name, kind, timeframe, enabled, params, symbols[], risk: { stopLossPct, takeProfitPct, maxPositionSize, maxOpenTrades, dailyLossLimit, riskPerTradePct }, openPositions, todayRealizedPnl, halted }]` | none (localhost) | 503 |
| `/api/positions` | GET | `status` (`open` \| `closed`, default `open`), `strategyId` (opt), `symbol` (opt), `limit` (opt, default 50, max 200), `cursor` (opt) | `{ positions: [{ id, strategy, symbol, side, qty, entryPrice, stopLoss, takeProfit, status, markPrice, unrealizedPnl, markedAt, exitPrice, closeReason, fees, realizedPnl, pendingClose, openedAt, closedAt }], nextCursor }`, newest first (open by `openedAt`, closed by `closedAt`) | none (localhost) | 422 bad params · 503 |
| `/api/positions/:id` | GET | id | the position plus its `orders[]` (with `reason`, `clientOrderId`, `status`) and `fills[]` | none (localhost) | 404 · 503 |
| `/api/signals` | GET | `strategyId`, `symbol`, `outcome` (all opt), `limit` (default 50, max 200), `cursor` | `{ signals: [{ id, strategy, symbol, side, outcome, skipReason, indicators, candleTime, createdAt, orderId }], nextCursor }`, newest first | none (localhost) | 422 · 503 |
| `/api/equity` | GET | `from` (ISO, default now − 7 days), `to` (opt), `limit` (default 1000, max 1000), `cursor` | `{ snapshots: [{ takenAt, balance, equity, openPositions }], nextCursor }`, oldest first | none (localhost) | 422 · 503 |
| `/ws` | push | none | `signal.created { signalId, strategyId, symbol, side, outcome, skipReason? }` · `position.opened { positionId, strategyId, symbol, side }` · `position.closed { positionId, symbol, closeReason, realizedPnl }` · `risk.halted { strategyId, todayRealizedPnl, dailyLossLimit }` · `account.updated { accountId, balance, equity }` | Origin check (0001) | none |

Response details (zod schemas in `packages/shared/src/api.ts`):
- `/api/account` returns the `paper-main` account.
- `strategy` in positions and signals is `{ id, name }`.
- `symbol` is `Instrument.symbol` (`BTCUSDT`, `EURUSD`), and `side` is `buy` or `sell`.
- `signals[].orderId` is the entry order's id, or null.
- `orders[]` items are `{ id, clientOrderId, reason, side, type, qty, status, createdAt }`.
- `fills[]` items are `{ id, orderId, price, qty, fee, feeCurrency, filledAt }`.
- A malformed cursor gives 422.

Cursors are opaque strings encoding (time, id), so rows with the same time aren't skipped. Every money value is a decimal string (`toDecimalString`). Event payloads stay small (spec 0001 NOTIFY rule).

**Value sourcing**:
| Action | Value | Source |
|---|---|---|
| evaluate | 15m and 1h closes | `MarketData.getCandles(id, tf, 200)`, 1h filtered by the open time rule above |
| evaluate | thresholds, `allowShort` | `Strategy.params` (zod parsed) |
| evaluate | bot state | `BotRun.state` of the current run, held in memory after each command |
| entry check | feed live / tradeable | `MarketDataFeed.getFeedState(id)` (new) and the forex quote's `tradeable` |
| entry check | open count, today's realized PnL | in memory cache, loaded from `Position` at start |
| sizing | equity | cached balance + sum of cached `unrealizedPnl` (at start: `Account.balance` + stored `unrealizedPnl`) |
| fill, close | `openedAt`, `closedAt`, `filledAt` | database `now()` |
| kill sweep | which positions | open `Position` rows without an `x:<positionId>` order, read inside the queue |
| sizing | `q2u` | live forex mid per the accounting rule; `1` for USD and USDT |
| sizing | leverage, fee rate, slippage | constants in `packages/shared/src/paper.ts` |
| sizing | SL %, TP %, caps, risk % | `RiskSettings` columns |
| sizing | `minQty`, `tickSize` | `Instrument` (refreshed at worker start, spec 0002) |
| fill | price | crypto `Quote.last` with slippage; forex `Quote.bid` / `Quote.ask` |
| fill | `clientOrderId` | `e:<signalId>` or `x:<positionId>` |
| SL/TP check | exit side price | the latest `Quote` from `onQuote` |
| close | `realizedPnl`, `closeQuoteToUsd` | the accounting rule at the moment of the fill |
| mark | `markPrice`, `unrealizedPnl`, equity | latest quote and `q2u`, written every 5s |
| `/api/account` | `marginUsed`, `freeMargin` | derived in SQL from open `Position` (`qty`, `entryPrice`, `entryQuoteToUsd`) and the asset class leverage; `freeMargin = equity − marginUsed` |
| `/api/account`, `/api/strategies` | `todayRealizedPnl`, `halted` | SQL sum of `realizedPnl` with `closedAt ≥ date_trunc('day', now() AT TIME ZONE 'UTC')`; `halted` when that sum ≤ minus `dailyLossLimit` |
| `/api/positions` | `pendingClose` | a `pending` Order with reason `kill` exists for the position |
| `/api/positions` | `markPrice`, `unrealizedPnl` | `Position` columns (up to 5s old) |
| `/api/equity` | snapshots | `EquitySnapshot` rows |
| `risk.halted` | trigger | the close whose `realizedPnl` takes today's sum from above to at or below minus the limit |
| `account.updated` | balance, equity | the worker after the mark write commits |

**Key invariants**:
- At most one `open` position per (strategy, instrument), enforced by the partial unique index.
- One entry per signal (`signalId` unique, `clientOrderId = e:<signalId>`), and one exit per position (`clientOrderId = x:<positionId>`).
- A candle is evaluated at most once per strategy (unique `Signal (strategyId, instrumentId, candleTime)`).
- `Account.balance` changes only when a position closes, and only by that position's `realizedPnl`.
- No entry without passing every AC-5 check. Exits never check risk limits.
- Crypto positions are always `buy` (long).
- No float touches money: indicators use plain numbers, and every price, size, fee, and PnL is `Money`.
- Events go out only after their transaction commits.
- Only the worker writes trading tables. The API only reads them.

**Security model**: single user, localhost only, no login (spec 0001). Every new endpoint is read only. No new secrets: paper trading uses only the public market data from spec 0002. Live keys arrive in feature 7.

**Observability** (pino): `info` for each signal (with outcome and reason), fill, and close (with reason and PnL); `warn` for a daily halt; `error` for a dropped entry or a failed exit write (with `clientOrderId`). A skip from too little history is `debug`.

**Configuration required**: no new environment variables. Fee (0.10%), slippage (0.05%), leverage (1 and 20), mark interval (5s), and snapshot interval (15m) are constants in `packages/shared/src/paper.ts`; risk limits live in `RiskSettings`.

**Critical test scenarios**:
- Pure rule: a fixed close series built to meet the Strong Buy conditions gives `buy`; flip it, and `sell`; a flat series (stdDev 0) or 199 candles gives no signal; verifies **AC-2**.
- Happy path: with the bot `running`, feed a BTCUSDT 15m close that triggers Strong Buy with a bull 1h. One `Signal` (`ordered`), one entry `Order` `e:<signalId>`, one `Fill` at `last × 1.0005` with a 0.10% fee, and one open `Position` with SL and TP at ±1.4% / ±2.8%. `signal.created` and `position.opened` arrive on `/ws`; verifies **AC-2**, **AC-3**, **AC-6**, **AC-7**, **AC-16**.
- Sizing: with equity $10,000, crypto risk $100, and SL 1.4%, the qty is capped at $3,000 notional. For EURUSD at 1.1, qty ≈ 101,010 units, round down; verifies **AC-5**.
- SL hit: push a quote below SL; the position closes `stop_loss` at that quote with slippage, `realizedPnl` = gross − both fees, and the balance moves by exactly that; verifies **AC-7**, **AC-14**.
- Duplicate: deliver the same 15m candle twice, and run a retry of an exit; there is still one signal, one entry, one exit; verifies **AC-11**.
- Reverse: a forex long open, then a Strong Sell with a bear 1h, closes `opposite_signal` and opens a short; the same on crypto closes only; verifies **AC-8**, **AC-4**.
- Halt: closes summing to −$300 today; the next signal is skipped `daily_loss_halt`, `risk.halted` was pushed once, and open SL/TP still fire. After 00:00 UTC entries resume; verifies **AC-9**.
- Limits: with 3 open positions, the 4th signal is `max_open_trades`; a signal on a pair with an open same side position is `already_open`; verifies **AC-5**.
- Kill on the weekend: forex not tradeable, crypto live, `kill`. Crypto closes at once; forex shows `pendingClose` and closes `kill` at the first tradeable price. A `start` before reopen leaves the pending kill in place; verifies **AC-10**, **AC-13**.
- Kill race: send `kill` while an entry is in flight; the new position also gets a kill order. Crash the worker between the kill and the sweep; after the restart the sweep runs and everything closes; verifies **AC-10**, **AC-12**.
- Restart: open a position, stop the worker without shutdown, restart. The position is still open; SL/TP fire on the next price; no missed candle is replayed; verifies **AC-12**.
- Stale feed: mark BTCUSDT `stale` with a position open; a quote past SL isn't acted on until the feed is `live` again; verifies **AC-13**.
- DB down: make the entry transaction fail; there is no `Order`, `Position`, or `Signal`, and there's an error log. Make an exit fail; it closes on the next fresh quote even if the price has moved back above SL; verifies **AC-15**.
- Accounting: a USDJPY trade's PnL converts at 1 / USDJPY mid. Marks update equity within 5 seconds and push `account.updated`. A snapshot appears at the next quarter hour; verifies **AC-14**.
- API: `/api/positions?status=closed&limit=2` returns 2 rows and a `nextCursor`, with money as strings; `limit=500` gives 422; verifies **AC-16**.
- Seed twice: exactly two strategies with AC-1 values; verifies **AC-1**.

## Build plan

Tracer Bullet: first one real thread (BTCUSDT 15m signal → paper fill → database → API and `/ws`), then thicken it with exits, risk, forex, lifecycle, and accounting.

1. [x] Migration and seed: `OrderReason`, the Order, Position, and RiskSettings columns, the partial unique index, the Signal unique key, `EquitySnapshot`; seed both strategies; satisfies **AC-1**, **AC-11**.
2. [x] Shared core: the params schema, `evaluateEmaRsiMacd`, `trendBias`, `zScore`, `paper.ts` constants and lists, the new event types, and the builder change to largest timeframe first; unit tests for the pure rule; satisfies **AC-2**, **AC-3**.
3. [x] Thin thread: `Trader` with the serial queue on `onCandleClosed` for BTCUSDT only, `PaperBroker` crypto entry transaction (fixed qty from the sizing rule without caps), `Signal` save, `signal.created` and `position.opened`, `GET /api/positions`; satisfies **AC-2**, **AC-3**, **AC-4**, **AC-6**, **AC-11**, **AC-16**.
4. [x] Exits: `MarketData.onQuote`, `getFeedState`, SL/TP checks, exit transaction, `realizedPnl` and balance, `position.closed`, the in memory cache; satisfies **AC-7**, **AC-11**, **AC-13**, **AC-14**.
5. [x] Risk: full sizing (risk %, both fees, caps, margin, `minQty`), every AC-5 check and skip reason, max open trades, daily halt and `risk.halted`; satisfies **AC-5**, **AC-9**.
6. [x] Forex and the full set: bid/ask fills, shorts for `forex-trend`, `q2u` conversion, opposite signal exit and reverse, closed and stale handling; widen to all 12 pairs and both strategies; satisfies **AC-4**, **AC-6**, **AC-8**, **AC-13**, **AC-14**.
7. [x] Lifecycle: `stop` and `idle` behaviour, the kill sweep in the queue and its rerun at startup, kill fills, startup load of positions and pending kills, no replay; satisfies **AC-10**, **AC-12**.
8. [x] Marks and the rest of the API: the 5 second marks, equity, `account.updated`, quarter hour snapshots, `/api/account`, `/api/strategies`, `/api/positions/:id`, `/api/signals`, `/api/equity`; satisfies **AC-14**, **AC-16**.
9. [x] Failure handling and logs: entry drop, exit retry on the next price, the log lines above; satisfies **AC-15**.

## Consequences

**Positive**:
- The bot trades on its own with the browser closed, and every decision (taken or skipped, and why) is saved.
- The strategy and the fill model are pure code in `packages/shared`, so backtesting (feature 6) can run exactly the same logic over stored candles.
- Live trading (feature 7) adds a real `Broker` next to `PaperBroker`; strategy, risk, and accounting don't change.
- No new tools or services: Postgres constraints carry the "never twice" guarantees.

**Negative / tradeoffs**:
- The Strong rule has never been backtested. Paper results take weeks to mean anything (15m bars and strict rules give few trades), and the rule may simply lose after fees.
- Paper fills are kinder than reality in places: no partial fills, no order book depth, no fee on forex beyond the spread, and the TP fills at the crossing price instead of being a resting limit order.
- Holding forex over the weekend means real gap losses past the stop, by design.
- The serial queue means a slow Neon write delays the next SL check by a few hundred milliseconds.
- The 5 second mark writes add steady database traffic next to the heartbeat; while the worker runs, Neon never scales to zero (already true from spec 0001).
- Trading shares the worker with the feed: a crash in either restarts both (recovery covers it).
- Positions held while the PC sleeps are unmanaged until it wakes; a stop can be blown through.
- Both strategies share one account's margin. Crypto at 1:1 ties up a lot of it: 3 crypto trades at $3,000 leave about $1,000 free, which shrinks a forex trade to about $20,000 notional. Forex then often enters smaller than its 1% risk, and results between the two strategies aren't fully independent.

**Neutral**:
- Spec 0002's builder order changes (1h, then 15m, then 5m); the candles stored are unchanged.
- Spec 0001's kill command statement is unchanged; the trader's kill sweep adds the pending exit orders right after it.
- The `maxPositionSize` cap binds crypto well before 1% risk: at $3,000, a full stop costs about $50 (0.5% of equity). Raise the cap later if you want crypto at full risk.
- `Order.positionId` is nullable so a future live order can exist before its fill.

## Follow-up

- [ ] Control panel spec (feature 5): editing strategies and risk limits, and what may change while a position is open.
- [ ] Backtesting spec (feature 6): reuse `evaluateEmaRsiMacd`, the 1h timing rule, the sizing, and the fill model as is; compare against this paper record.
- [ ] `/sync` should note the builder order change in spec 0002 and the kill behaviour in spec 0001.
- [ ] Root `AGENTS.md` is still missing; `/audit` should record this stack and the Prisma skills (also listed in spec 0001).
