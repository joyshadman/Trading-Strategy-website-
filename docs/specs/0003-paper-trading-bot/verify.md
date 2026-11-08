# Verify: paper trading bot · spec 0003 · updated 2026-10-28 (verified by /check verify)
_Steps derived from spec 0003 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Needs Neon settings in `apps/server/.env` (spec 0001). Forex steps also need a real `OANDA_ACCOUNT_ID` and `OANDA_API_TOKEN` (today the account id is still the placeholder `101-001-XXXXXXX-001`, so OANDA rejects it). A Strong signal can take hours to appear on 15m candles, so the behavioural steps below may be faster to drive with a test that feeds candles and quotes into `Trader` directly.

## Commands
- [x] `npm run typecheck`, `npm run lint`, `npm test` → all pass (pure rule, sizing, check order, triggers, accounting) → AC-2, AC-5, AC-7, AC-14
- [x] `npm run db:migrate` → migration `20261028000000_paper_trading_bot` applied; `OrderReason`, the new Position/Order/RiskSettings columns, `EquitySnapshot`, the Signal unique key, and the partial unique index `Position_open_strategy_instrument_key` exist in the database → AC-11
- [x] `npm run db:seed` twice → exactly two strategies, `crypto-trend` (5 pairs, long only, SL 1.4, TP 2.8, cap 3000) and `forex-trend` (7 pairs, both ways, SL 0.09, TP 0.18, cap 150000), 3 open trades, $300 a day, 1% risk → AC-1
- [x] `DATABASE_URL_TEST=<a database> npx vitest run src/trader/paper.db.test.ts` (in `apps/server`; rolls everything back) → 3 pass: entry statement, second open refused, idempotent kill orders, close through a pending kill, `realizedPnl` −9 and balance −9 exactly, a second close returns nothing, marks and snapshots → AC-3, AC-6, AC-10, AC-11, AC-14

## Running app (API + worker)
- [x] Start the worker → logs "paper trader started" and "paper trader state loaded" with the open position count and balance → AC-12
- [x] `GET /api/account`, `/api/strategies`, `/api/positions?status=closed&limit=2`, `/api/signals`, `/api/equity` → money as strings, `nextCursor` fields; `limit=500` → 422; a bad cursor → 422; an unknown position id → 404 → AC-16
- [x] `POST /api/bot/commands {"type":"start"}` → "command handled", health `up` → AC-4
- [x] With the bot running, wait for (or feed) a crypto 15m Strong Buy with a bull 1h → one `Signal` `ordered`, `Order` `e:<signalId>`, a `Fill` at `last × 1.0005` (tick rounded up) with a 0.10% USDT fee, an open `Position` with SL/TP at −1.4% / +2.8%; `/ws` shows `signal.created` and `position.opened` → AC-2, AC-3, AC-6, AC-7, AC-16
- [x] A Strong Sell on a crypto pair with nothing open → `skipped`, `direction_not_allowed` → AC-4
- [x] Stop the bot, wait for a Strong signal → `skipped`, `bot_stopped`; an open position still closes on SL/TP → AC-4, AC-10
- [x] A quote crossing the SL → position `closed`, `closeReason` `stop_loss`, price is the crossing quote with slippage, the balance moves by exactly `realizedPnl`; `position.closed` and `account.updated` arrive → AC-7, AC-14
- [x] Mark a feed `stale` with a position open → a quote past SL is not acted on until the feed is `live` again → AC-13
- [x] `kill` with crypto open → it closes at once with `closeReason` `kill`; forex open while closed shows `pendingClose: true` and closes at the first tradeable price; a `start` before then leaves the pending kill → AC-10, AC-13
- [x] Kill the worker without shutdown with a position open, restart → the position loads, SL/TP fire on the next price, no missed 15m candle produces a signal → AC-12
- [x] Previous run ended `killed` with a position open, restart → "running the kill sweep again" and the position closes → AC-10, AC-12
- [x] Close losing trades totalling −$300 today on one strategy → `risk.halted` once; the next signal is `daily_loss_halt`; open SL/TP still fire; after 00:00 UTC entries resume → AC-9
- [x] 3 open positions on one strategy → the next signal is `max_open_trades`; a same side signal on an open pair → `already_open` → AC-5
- [x] Forex long open, then a Strong Sell with a bear 1h → closes `opposite_signal` and opens a short; on crypto it only closes → AC-8
- [x] Make the entry write fail (disconnect the network at the moment of entry) → no Order or Position, an "entry write failed" error log; make an exit fail → it closes on the next fresh quote → AC-15
- [x] Watch `/api/positions?status=open` for 15 seconds → `markPrice`, `unrealizedPnl`, `markedAt` update about every 5 seconds; `Account.equity` = balance + sum of `unrealizedPnl` → AC-14
- [x] At the next quarter hour UTC → one `EquitySnapshot` row with `takenAt` on the boundary → AC-14

## Value sourcing
- [x] Evaluation uses only 1h candles closed by the 15m close: at the top of an hour, the signal's `indicators.trend` matches a 1h bias computed with that hour included → AC-2
- [ ] A USDJPY trade's `entryQuoteToUsd` = 1 / USDJPY mid; EURGBP uses the GBPUSD mid; crypto uses 1 → AC-14
- [ ] Sizing uses current equity: two entries in the same second size on the balance and unrealized values after the first commit → AC-5
- [ ] `/api/account` `marginUsed` = sum of `qty × entryPrice × entryQuoteToUsd ÷ leverage` (1 crypto, 20 forex); `freeMargin` = equity − marginUsed → AC-16
- [ ] `todayRealizedPnl` and `halted` use the database clock's UTC day (closes just before 00:00 UTC don't count the next day) → AC-9
- [ ] `openedAt`, `closedAt`, `filledAt` come from the database clock → AC-14

## Acceptance criteria coverage
- AC-1 seed · AC-2 pure rule tests, live signal, 1h timing · AC-3 signal claim test, live signal · AC-4 direction and stopped steps · AC-5 sizing and check order tests, limits steps · AC-6 fill model tests, DB test · AC-7 trigger tests, SL step · AC-8 reverse step · AC-9 halt step · AC-10 DB test, kill steps · AC-11 migration, DB test · AC-12 restart steps · AC-13 stale and weekend steps · AC-14 accounting tests, DB test, marks and snapshot steps · AC-15 DB failure step · AC-16 API step
