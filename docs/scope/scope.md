# Scope: Trading Bot

A personal trading bot for forex and crypto, for you only. A backend runs rule based strategies (proven by backtesting) and trades on its own; the existing React frontend is the control panel. It paper trades first and goes live only after paper results earn it.

**Localhost only (for now):** the API, worker, and UI run on your PC and are reachable only from it (`127.0.0.1`). One user, no login, no public hosting. The database stays on Neon. Opening it up to other devices or people is deferred, and needs login first.

**Build approach:** Tracer Bullet (one thin, real thread through backend, bot, and UI first, then thicken it).
**Workflow:** Alpha (after `/develop`, run `/check verify`). Live trading is tagged `· GA` because it moves real money.

_Recommendations, not requirements. Skip what does not fit. Success is measured by net profit after fees and drawdown (biggest drop from a peak), not win rate alone._

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| 1 | Market dashboard, signals, history, sessions | Existing | existing |
| 2 | Backend foundation | Foundation | done |
| 3 | Market data feeds | Foundation | in-progress |
| 4 | Paper trading bot | Slice 1 | in-progress |
| 5 | Control panel | Slice 1 | in-progress |
| 6 | Backtesting, stats & alerts | Slice 2 | planned |
| 7 | Live trading | Slice 3 | planned |

## Already built

### 1. Market dashboard, signals, history, sessions · existing
Asset list with live charts, browser side EMA/RSI/MACD signals (the seed for the bot's strategy), signal history, forex session timeline. code in `src/App.jsx`, `src/components/`

## Foundations

### 2. Backend foundation · done
A backend running on your PC next to the frontend, plus the data model: strategies, signals, orders, positions, trades, paper and live balances.
**Done when:** the backend boots and passes build, the model holds paper and live trades side by side, and lint/format run clean.
- [x] Design it (spec): `/architect backend foundation`
- [x] Build it: `/develop backend foundation`
   - [x] Workspaces: move the frontend to `apps/web`, add `apps/server` and `packages/shared`, root scripts (AC-1, AC-9)
   - [x] Database: Neon Postgres, Prisma schema, migration, seed (AC-4, AC-5, AC-6)
   - [x] Worker: lock, recovery, heartbeat, command claim (AC-2, AC-7)
   - [x] API: health, commands, WebSocket, LISTEN client, config checks (AC-3, AC-7, AC-8)
- [x] Verify it: `/check verify backend foundation`
Spec [0001](../specs/0001-backend-foundation/index.md) · code in `apps/server/`, `packages/shared/`, `apps/web/`

### 3. Market data feeds · in-progress
Live candles and history on the backend for crypto and forex. The current forex feed only has reference rates, so forex needs a real intraday source.
**Done when:** live candles arrive for crypto and forex, history is kept for backtests, and dropped connections recover on their own with stale data flagged.
- [x] Design it (spec): `/architect market data feeds`
- [ ] Build it: `/develop market data feeds`
   - [x] Thin thread: migration and seed, BTCUSDT 1m live to database, `/api/candles` (AC-1, AC-3, AC-7)
   - [x] Feed health: FeedStatus, stale timer, `feed.status` event, `/api/instruments` (AC-5, AC-7, AC-10)
   - [x] Binance in full: backfill, built 5m/15m/1h, reconnect and limits, all 5 pairs (AC-2, AC-3, AC-6)
   - [ ] OANDA forex: pricing stream, 1m polling, backfill, errors, token safety (AC-4, AC-5, AC-6, AC-9) (code written; only the "not configured" path is tested until OANDA settings are in `.env`)
   - [x] Finish: metadata refresh, clock and sleep checks, `MarketData` module, retention (AC-1, AC-4, AC-6, AC-8)
- [ ] Verify it: `/check verify market data feeds`
Spec [0002](../specs/0002-market-data-feeds/index.md) · code in `apps/server/src/feed/`, `apps/server/src/api/market.ts` · needs an OANDA practice account and token before the forex milestone

## Slice 1: Paper trading bot

### 4. Paper trading bot · in-progress
The engine: runs your EMA/RSI/MACD rules on many pairs at once, fills paper orders with fees and slippage, and enforces risk limits (stop loss, take profit, max size, max open trades, daily loss halt). Forex pauses outside market hours.
**Done when:** it trades on paper with the browser closed, every order passes the risk checks, no order is placed twice, and state survives a restart.
- [x] Design it (spec): `/architect paper trading bot`
- [x] Build it: `/develop paper trading bot`
   - [x] Data and rule: migration, seed of both strategies, pure strategy function, builder builds largest timeframe first (AC-1, AC-2, AC-3)
   - [x] Thin thread and exits: BTCUSDT signal to paper fill, SL/TP on live prices, `/api/positions` (AC-3, AC-4, AC-6, AC-7, AC-11, AC-13, AC-16)
   - [x] Risk and forex: full sizing and checks, daily halt, bid/ask fills, shorts and reverse, all 12 pairs (AC-4, AC-5, AC-6, AC-8, AC-9, AC-13, AC-14)
   - [x] Lifecycle and accounting: stop and kill sweep, restart, marks and snapshots, the rest of the API, failure handling (AC-10, AC-12, AC-14, AC-15, AC-16)
- [ ] Verify it: `/check verify paper trading bot`
Spec [0003](../specs/0003-paper-trading-bot/index.md) · code in `apps/server/src/trader/`, `apps/server/src/api/trading.ts`, `packages/shared/src/` · forex trades need real OANDA settings in `.env` (feature 3; the account id is still the placeholder)

### 5. Control panel · in-progress
A page to start and stop the bot, pick pairs and strategies, edit risk limits, and watch positions and trades update live. No login: it's localhost only and just for you.
**Done when:** the controls work from `localhost`, updates appear without reload, and a stopped bot or offline backend is clearly shown.
- [x] Design it (spec): `/architect control panel`
- [x] Build it: `/develop control panel`
   - [x] Thin thread: migration, command checks and guard, worker command path, Bot page with status bar and strategy switches (AC-1, AC-2, AC-3, AC-5, AC-10)
   - [x] Manual close: `pendingExit`, manual exit orders, open positions with Close (AC-4, AC-5, AC-8)
   - [x] Other sections: account, closed trades, signals, equity chart, feed health, action log, formatting (AC-8, AC-9, AC-11, AC-12)
   - [x] Live and offline: event map, reconnect resync, banners, disabled controls, command fallback (AC-2, AC-6, AC-7)
- [ ] Verify it: `/check verify control panel`
Spec [0004](../specs/0004-control-panel/index.md) · code in `apps/web/src/`, `apps/server/src/api/`, `apps/server/src/worker/`, `apps/server/src/trader/` · Bot page built in the Market dashboard style (no Figma frames were given) · pair and risk editing deferred (see Deferred)

## Slice 2: Prove it

### 6. Backtesting, stats & alerts · needs a decision
Backtest any strategy on past candles with the same code as live, show stats (win rate, net profit, drawdown, per strategy and pair, backtest vs paper), and notify you on trades, risk halts, and errors.
**Done when:** a backtest returns trades and stats with no future data leaking in, stats match trade history, and alerts arrive within a minute and can be toggled.
- [ ] Design it (spec): `/architect backtesting, stats & alerts`

## Slice 3: Real money

### 7. Live trading · needs a decision · GA
Encrypted API key storage, a real crypto exchange and forex broker behind the paper engine's interface, a go live gate (paper results you set), and a kill switch.
**Done when:** keys never reach the browser or logs, a strategy switches paper to live with no code change, live stays locked until the gate is met, and the kill switch closes everything.
- [ ] Design it (spec): `/architect live trading`

## Deferred
- **AI signal filter** · **Machine learning strategy** · **Strategy optimizer** · **Multiple users**
- **Login & remote access**: reach the panel from your phone or another machine; needs login and API protection first · needs a decision · GA
- **Cloud hosting**: run the API and worker on a server instead of your PC · needs a decision
- **Edit pairs and risk limits from the panel**: after backtesting can show a change helps; decide what may change while positions are open · needs a decision · from spec 0004

## Legend
- **Next step** = the first unticked box. **needs a decision** = run `/architect` first, else `/develop`.
- `/architect` fills each feature with `Build it` milestones and check boxes when its spec is captured; build tasks live in the spec.
- **Status** `planned` → `in-progress` → `done`, plus `existing` and `dropped`. A `· GA` tag adds `/test`, `/check review`, and `/document` for that feature.
