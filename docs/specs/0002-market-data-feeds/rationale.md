# 0002. Market data feeds: rationale

## Context

The bot needs live and historical candles on the backend for 12 pairs (5 crypto, 7 forex) on 1m, 5m, 15m, and 1h. Today the browser fetches Binance and Frankfurter directly, and Frankfurter only has daily reference rates, which can't drive intraday forex trading.

Forces:
- One user on a personal PC, localhost only.
- The database is Neon, about 280 ms away per round trip, on a free plan with a small storage cap.
- The worker already runs all the time and holds the single worker lock (spec 0001).
- Paper fills later need real forex bid/ask spreads.
- Backtests need history, and their data must match what the live bot sees.
- Market data sources disconnect, rate limit, and close at weekends (forex).

## Options considered

### Option 1: Direct Binance and OANDA clients inside the worker, closed candles only
Binance public REST and kline WebSocket, OANDA practice REST and pricing stream, both written with `fetch` and `ws`. Forming candles stay in memory; each closed candle is written once.

**Pros**: no new dependencies; exactly one feed (the worker lock); the strategy runner reads candles in process; light write load on Neon.
**Cons**: feed code shares a process with trading; two venue clients to maintain by hand.

### Option 2: ccxt for both history and live data
One library wraps Binance and many other exchanges.

**Pros**: easier to add exchanges later; one interface.
**Cons**: heavy dependency; its live candle streams are less precise about candle close; it doesn't cover OANDA forex, so a second client is needed anyway.

### Option 3: A separate feed process
The same clients in their own program, writing candles that the worker reads from the database.

**Pros**: a feed crash never touches trading.
**Cons**: a third process with its own lock; the worker reads candles across a ~280 ms link instead of from memory.

### Option 4: Twelve Data for forex instead of OANDA
**Pros**: simple market data API, no broker account.
**Cons**: the free tier is far below 7 pairs on 4 timeframes; real use is paid; it can't become the live forex broker later.

## Rationale

Option 1 fits the forces best. The worker is already the always on, single instance process, so putting the feed there gives single ownership for free and lets the paper bot read candles and quotes from memory instead of over the slow link to Neon. Writing only closed candles keeps Neon writes to about 50 a minute, and storing forex as mid candles plus in memory bid/ask keeps both clean indicators and real spreads.

OANDA's practice account gives free streaming bid/ask and candle history, and the same broker can run live forex later. That beats a data only vendor whose free tier can't cover 7 pairs. Binance direct is what the UI already uses and needs no key.

Live 5m, 15m, and 1h candles are built from closed 1m candles instead of separate streams and polls (a cross check finding). That cuts live load about four times and removes the timing problem of polling every timeframe at its boundary. The cost is that, on quiet OANDA minutes, a built candle can differ slightly from OANDA's own.

The retention windows (30 days of 1m, 90 days of the rest) keep storage near 170 MB on Neon's free plan instead of about 370 MB. That costs backtest depth, which you accepted.
