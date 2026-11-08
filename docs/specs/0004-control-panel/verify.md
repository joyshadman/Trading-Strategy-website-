# Verify: control panel · spec 0004 · updated 2026-10-29
_Steps derived from spec 0004 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones._

Setup: `npm run dev` (web, api, worker), open `http://localhost:5173/#/bot` (exactly `localhost`, not `127.0.0.1`).

## UI / manual
- [ ] Open `#/bot`, refresh → still on Bot; click Market in the top nav, then browser Back → Bot again; open `#/anything` → Market → AC-1
- [ ] Bot `idle`: Start enabled, Stop disabled, Kill enabled; click Start → spinner on Start, then "Done", state shows `running`, Stop enabled, Start disabled → AC-2
- [ ] With 3 positions open click Kill → dialog says "3 open positions will be closed…"; Cancel → no new row in the action log; Kill again and confirm → state `killed`, Kill disabled, Start enabled → AC-2
- [ ] Bot `running`: switch `forex-trend` off → switch shows a spinner at its old value, then off; the next 15m forex close writes no `Signal` row for `forex-trend`; refresh keeps it off → AC-1, AC-3
- [ ] With a `crypto-trend` position open, switch `crypto-trend` off, then let a quote cross its SL → it closes `stop_loss`; an opposite Strong signal does not close it → AC-3
- [ ] Bot `killed`: a strategy switch still works and shows "applies on next start" when off → AC-3, state table
- [ ] Close an open BTCUSDT position → dialog "Close BTCUSDT long at market?"; confirm → row shows "closing, waiting for a tradeable price" (briefly on a live feed), then moves to Closed trades with reason `manual`; balance moves by its realized PnL, no reload → AC-4, AC-6
- [ ] Close a forex position on the weekend → row stays "closing"; restart the worker → still pending; send Kill → no second exit order (`x:<positionId>` only once); at reopen it fills `manual` → AC-4
- [ ] With a manual exit pending on a stale feed, the first fresh quote is also past SL → close reason is `manual`; an opposite Strong signal meanwhile is saved `skipped` / `already_open` → AC-4
- [ ] Queue `close_position` then `kill` for the same position → it closes `manual`, not `kill` → AC-4, AC-5
- [ ] With a position open, watch the row: mark and unrealized PnL change within about 5 seconds of `account.updated`, no reload → AC-6
- [ ] Stop the API for 20 seconds → "Backend offline" banner, all controls disabled, sections dimmed with "last updated" times; start the API → banner clears within 5 seconds, every section refetches, controls enable → AC-6, AC-7
- [ ] Stop only the worker → within about 20 seconds the banner says "Worker down since <time> UTC", bot state shows "(worker down)", every control disabled → AC-7 (seen working during the build)
- [ ] With the database unreachable → banner says "Database down", not "Worker down" → AC-7
- [ ] Kill only the WebSocket (for example the API restarts while health is fine) → "Live updates paused" shows only when nothing else applies, and controls stay enabled → AC-7
- [ ] Every AC-8 section renders, including empty states: "No open positions", "No closed trades yet", "No signals yet", "No snapshots yet (first one at the next quarter hour)", "No actions yet" → AC-8
- [ ] Closed trades and signals: "Load more" fetches the next page and keeps the first; a new close after that adds to the top without duplicates → AC-8
- [ ] Equity chart: 1 day, 7 days, 30 days each load; 30 days with over 1,000 snapshots follows `nextCursor`; it refreshes about 10 seconds after each quarter hour UTC → AC-8
- [ ] Signals: expand a row → `ema9`, `ema21`, `ema50`, `rsi`, `macdHist`, `z` to 4 decimals and `trend` → AC-8
- [ ] An XRPUSDT price shows the decimals of its `tickSize`, qty the decimals of its `minQty` (truncated, never rounded up); a USDJPY PnL shows 2 decimals; a zero PnL shows `0.00`, never `-0.00`; every time ends in `UTC` → AC-9
- [ ] After a start, a disable, and a close, the action log lists all three newest first with status and target (`all`, the strategy name, the symbol) → AC-11
- [ ] Each strategy shows its pairs and risk limits with no edit control → AC-12

## Commands
- [ ] `curl -X POST localhost:4000/api/bot/commands -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -d '{"type":"stop"}'` → 403 `forbidden origin` → AC-10 (passed during the build)
- [ ] `curl -H 'Host: evil.example' localhost:4000/api/health` → 403 `forbidden host`; `Host: [::1]:4000` → 200 → AC-10 (passed)
- [ ] `/ws` upgrade with `Host: evil.example` → 403 → AC-10 (passed)
- [ ] `curl -X POST` with no Origin → 201; the same POST through the Vite proxy (`localhost:5173`) with `Origin: http://localhost:5173` → 201 → AC-10 (passed)
- [ ] POST `close_position` twice quickly → 201 then 409; for a closed position → 409 `position not open`; for a random UUID → 404; `enable_strategy` with an unknown id → 404; a second `disable_strategy` for the same strategy while one is pending → 409 with `details.id` → AC-5 (404s and the duplicate 409 passed)
- [ ] Insert a `close_position` command, let an SL close the position before the worker handles it → command `failed` / `position not open`, no extra order → AC-5
- [ ] Make `trader.runCommand` throw once → that command ends `failed` with the error text, the next command still runs → AC-5
- [ ] `GET /api/bot/commands?limit=2` → newest first, `nextCursor` set; following it returns the next two → AC-11 (passed)
- [ ] `GET /api/health` → includes `bot: { runId, state, startedAt }`; with the database down → 503 with `db: 'down'` and `bot: null` → AC-2, AC-7 (first part passed)
- [ ] `grep -rn "RiskSettings\|StrategyInstrument\|params" apps/server/src/api` shows no write → AC-12

## Value sourcing
- [ ] Page from `location.hash`; bot state and run id from `/api/health` `bot` (start a new worker run → the run id changes) → AC-1, AC-2
- [ ] Kill dialog count equals `/api/account` `openPositions` (includes positions already closing) → AC-2
- [ ] Switch value from `/api/strategies` `enabled`; the worker sets `true` for `enable_strategy`, `false` for `disable_strategy` (check the `Strategy` row) → AC-3
- [ ] Manual exit order: side opposite the position, qty equals the position's, `clientOrderId` `x:<positionId>`, reason `manual` (query `Order`) → AC-4
- [ ] Closing badge follows `/api/positions` `pendingClose` for both kill and manual pending orders → AC-4
- [ ] "Last updated" is the browser clock in UTC at the last successful fetch; stop the API and confirm it freezes → AC-7
- [ ] Price and qty decimals follow `/api/instruments` `tickSize` and `minQty` (change one instrument's `tickSize` in the database, reload, the decimals change) → AC-9

## Acceptance-criteria coverage
- AC-1 nav and hash · AC-2 status bar, buttons, Kill dialog, health `bot` · AC-3 switch, disabled strategy keeps exits · AC-4 manual close, pending exit wins, restart and kill · AC-5 conflicts, race, throwing job, ordering · AC-6 live refetches and marks · AC-7 banner order and disabled controls · AC-8 every section and empty state · AC-9 formatting · AC-10 guard curls and proxy · AC-11 action log · AC-12 read only limits
