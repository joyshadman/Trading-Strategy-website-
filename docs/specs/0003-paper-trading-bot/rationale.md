# 0003. Paper trading bot: rationale

## Context

> ⚠️ Premise note: this bot paper trades a rule that has never been backtested. On 15m bars with strict Strong conditions and a 1h filter, it may take a few trades a day across 12 pairs, so it can take weeks of paper trading to learn that the rule loses after fees. A backtest over the 90 days of stored candles would answer that in minutes. The scope puts backtesting in Slice 2, after this. That order is fine for building (the paper engine is the thing a backtest replays), but treat early paper results as a check of the plumbing, not proof of an edge. Keep the strategy and fill model pure so feature 6 can replay them unchanged.

The workspace is `apps/server` (the worker) plus `packages/shared`, building on spec 0001 (worker, data model, commands, events) and spec 0002 (`MarketData`: closed candles on 1m to 1h for 12 pairs, live crypto last prices, live forex bid/ask with a `tradeable` flag, and feed states). Today the trading rule exists only in the browser (`PredictorCard.jsx`), running on ticks while the page is open. Nothing trades, and nothing is saved.

The bot must trade on paper with the browser closed, run every order through risk checks, never place an order twice, and keep its state across restarts (scope feature 4). It runs on your PC against Neon, about 300 ms per round trip, so a restart, a sleep, or a dropped connection is normal, not rare. The worker already holds a single worker lock, so only one process ever trades.

Two later features constrain this one. Backtesting (feature 6) must run "the same code as live", so the rule and the fill model can't be tangled with I/O. Live trading (feature 7) must switch a strategy from paper to live "with no code change", so paper fills must sit behind the same boundary a real exchange will. Results are judged by net profit after fees and drawdown, so the fill model has to charge realistic costs, or the paper record lies.

## Options considered

### Option 1: Event driven paper engine in the worker, behind a broker interface

A `Trader` module in the worker reacts to `onCandleClosed` (15m) for signals and to every quote for SL/TP. A serial queue runs the actions one at a time. Open positions sit in an in memory cache, and the database is the source of truth. Orders go through a `Broker` interface; `PaperBroker` applies the fill model inside one database transaction per fill.

**Pros**:
- SL/TP react within a second or two of the price, with no database polling.
- Uses the live quotes and candles already in worker memory (spec 0002); no new process or broker.
- The pure rule plus the broker boundary serve both backtesting and live trading.

**Cons**:
- An in memory cache must be kept in step with the database (loaded at start, updated only after commit).
- The serial queue lets one slow write delay the next check.

### Option 2: A polling loop over the database

Every few seconds the worker reads open positions, the latest candles, and quotes, then decides. There is no cache and no events; each loop starts from the database.

**Pros**:
- Simplest to reason about; no cache to go stale.
- Restart behaviour is the same as normal running.

**Cons**:
- Each loop costs several Neon round trips (about 300 ms each), so SL checks lag by seconds, and the compute never rests.
- Quotes live only in memory anyway, so it still needs the in process data.

### Option 3: A separate trader process

A third process (next to API and worker) runs the trading, with its own lock, and gets prices from the worker over Postgres NOTIFY or its own feed connections.

**Pros**:
- A feed crash can't take trading down, and the other way round.

**Cons**:
- Quotes would need to cross processes many times a second (NOTIFY is not built for that), or the feeds would be duplicated, against OANDA's limit of 2 pricing streams.
- One more process to run on your PC, and another lock and recovery path.

### Option 4: An off the shelf bot in dry run mode (for example Freqtrade)

Run a mature open source bot in its paper (dry run) mode with the rule ported to its strategy format.

**Pros**:
- Battle tested fills, backtesting, and stats out of the box.

**Cons**:
- Python, a second stack outside your TypeScript monorepo, and its own database.
- Crypto exchanges only; no OANDA forex.
- Your control panel and data model (specs 0001, 0002) would be bypassed.

## Rationale

Option 1 is chosen because the forces in Context all point to the worker. The prices the bot needs (live quotes, the last 500 candles) already live in worker memory. The worker already owns the single lock, the commands, and the event channel. And Neon's round trip cost rules out a database polling design for SL checks (Option 2). A separate process (Option 3) buys isolation the project doesn't need yet, at the cost of shipping quotes across processes, which Postgres NOTIFY is poor at. Freqtrade (Option 4) can't trade OANDA forex and would throw away the backend just built.

The "never twice" and "survives restart" requirements are carried by the database, not by memory: deterministic `clientOrderId`s (`e:<signalId>`, `x:<positionId>`), a unique signal per candle, a partial unique index on open positions, a guarded `UPDATE … WHERE status = 'open'` for exits, and a kill sweep that runs inside the trader's queue (so it can't race an entry) and runs again at startup after a crash. The cache only makes checks fast; losing it loses nothing. The serial queue is the simplest way to keep max open trades and margin correct when 12 candles close in the same second. Quotes never enter the queue: triggers are tested in memory, and only a fired exit becomes a job, so the queue can't back up on price updates. With at most 6 open positions, the throughput cost is small.

Each rule choice follows your answers: Strong signals only on 15m with a 1h filter (fewest trades, so fees bite least), risk based sizing that includes both fees (so every stop loss costs about 1%), leverage of 1:1 for crypto (spot parity for feature 7) and 20:1 for forex, and realistic costs (0.10% fee, 0.05% slippage, real bid/ask). The 1h timing fix (build the largest timeframe first) is a small change to spec 0002 code, and makes the 1h input deterministic, so a backtest can use the exact same rule without seeing future data. The runner up for that fix was using only the 1h candle closed before the 15m candle opened, which needs no change but leaves the filter up to 45 minutes stale at the top of each hour.

Recommendations settled in the spec, each with its runner up: the trading tables are written only by the worker, with the API only reading them (runner up: API writes, rejected because two writers break the single lock model). Exits ignore the 1h bias (runner up: also gate exits, rejected because it keeps losing trades open). Margin is shared across both strategies on one account (runner up: split it per strategy, rejected for now because the account is one pot of money, as it will be live). The unrealized PnL counts the entry fee but not a future exit fee (runner up: estimate the exit fee, rejected as a guess).
