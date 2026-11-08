# Verify: market data feeds · spec 0002 · updated 2026-10-27
_Steps derived from spec 0002 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Needs Neon settings in `apps/server/.env` (spec 0001). The OANDA steps also need `OANDA_API_TOKEN` and `OANDA_ACCOUNT_ID` from a free OANDA practice account.

## Commands
- [x] `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` → all pass → AC-1, AC-7
- [x] `npm run db:migrate` then `npm run db:seed` → 12 instruments, each with `venueSymbol` (`BTCUSDT`, `EUR_USD` style) → AC-1

## Running app (API + worker)
- [x] Start the worker on an empty `Candle` table → health `up` at once; crypto pairs reach `live`; each has about 43,200 1m (30 days) and 25,920 5m, 8,640 15m, 2,160 1h candles (90 days) → AC-2
- [x] After start, `/api/instruments` shows Binance `tickSize` and `minQty` from the venue (for example BTCUSDT 0.01 and 0.00001), not the `0.00000001` placeholder → AC-1
- [x] Restart the worker with no downtime → backfill stores 0 to a few rows; candle counts don't double → AC-2
- [x] Poll the database across a minute boundary → each crypto 1m candle is stored within 10 seconds of its close → AC-3
- [x] After a 5 minute boundary → the built BTCUSDT 5m candle equals Binance's own 5m kline (open, high, low, close, volume) → AC-3
- [x] Kill the worker for over 2 minutes, then restart → no missing 1m candles in the last hour and no missing 5m candles, for all 5 pairs → AC-6
- [x] Watch `/ws` during a restart → `feed.status` events: each instrument `backfilling`, then `live` (crypto) or `error` (forex without settings) → AC-5, AC-10
- [x] `GET /api/candles?symbol=BTCUSDT&timeframe=1m&limit=3` → 3 candles oldest first, prices as strings, a `nextCursor`; `timeframe=4h` → 422; `symbol=NOPE` → 404 → AC-7
- [x] Without OANDA settings → forex instruments `error` with "OANDA is not configured", crypto stays `live` → AC-9
- [ ] Block Binance for over 30 seconds while running (for example disconnect the network) → crypto turns `stale`, then back to `live` after reconnect and backfill → AC-5, AC-6
- [x] A day after the first start (or with `RETENTION_MS` lowered in a scratch run) → 1m candles older than 30 days are gone → AC-8

## OANDA (needs a practice token)
- [ ] With valid OANDA settings → forex pairs backfill and reach `live` (or `closed` at the weekend); `tickSize` is 0.001 for USDJPY and GBPJPY, 0.00001 for the rest; `minQty` 1 → AC-1, AC-2, AC-5
- [ ] Poll across a minute boundary during market hours → each forex 1m mid candle is stored within 15 seconds of its close; 5m, 15m, 1h are built at their boundaries → AC-4
- [ ] At the weekend (or when OANDA marks a pair not tradeable) → forex shows `closed`, never `stale` → AC-5
- [ ] With a wrong `OANDA_API_TOKEN` → forex `error` "OANDA rejected the token", crypto `live`; the token text appears nowhere in the worker log → AC-9

## Acceptance-criteria coverage
- AC-1: seed, metadata, OANDA rules · AC-2: first start, no doubling, OANDA backfill · AC-3: 1m latency, built 5m · AC-4: OANDA 1m latency · AC-5: events, stale, weekend · AC-6: kill and restart, network drop · AC-7: candles API, commands · AC-8: retention · AC-9: not configured, wrong token · AC-10: events
