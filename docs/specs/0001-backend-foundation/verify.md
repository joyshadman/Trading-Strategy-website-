# Verify: backend foundation · spec 0001 · updated 2026-10-27
_Steps derived from spec 0001 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Needs a Neon project and `apps/server/.env` with its pooled `DATABASE_URL` and direct `DATABASE_URL_UNPOOLED` (see `.env.example`).

## Commands
- [x] `npm install` then `npm run typecheck`, `npm run lint`, `npm run build` → all pass → AC-1, AC-9
- [x] `npm run db:migrate` → 12 tables exist (check with `\dt` or Prisma Studio) → AC-4
- [x] `npm run db:seed` twice → exactly one `paper-main` account, balance `10000` USD → AC-4
- [x] Set `DATABASE_URL_TEST` to a migrated test database, `npm test` → DB tests pass (exact decimals, duplicate `clientOrderId` rejected) → AC-5, AC-6
- [x] Start the API with `DATABASE_URL` unset → exits with a clear message; start the worker without `API_PORT` → runs → AC-8

## UI / manual
- [x] `npm run dev` → the UI at `http://localhost:5173` looks and behaves as before (charts, signals, history) → AC-1
- [x] `GET /api/health` with the worker running → `worker.status` is `up`, `ageSeconds` under 6 (source: `BotRun.lastHeartbeatAt` vs DB `now()`) → AC-3
- [x] `GET /api/health` before any worker has ever run → `worker.status` is `none` → AC-3
- [x] Start a second worker while one runs → it exits with code 1, "another worker is running" → AC-2
- [x] Kill the worker without a clean shutdown → within 16 seconds health shows `down`; restart it → the old run is closed as `crashed` → AC-2, AC-3
- [x] Point `DATABASE_URL` at an unreachable host → health returns 503 with `db: down` → AC-3
- [x] Start the API with `API_HOST=0.0.0.0` → refuses to start ("localhost only, no login") → AC-8
- [x] Set `DATABASE_URL_UNPOOLED` to a `-pooler` URL → the worker and API refuse to start → AC-8
- [x] Connect a WebSocket to `/ws` (Origin `http://localhost:5173`) → receives `hello` → AC-7
- [x] POST `/api/bot/commands` `{"type":"start"}` → 201 `pending`; WebSocket receives `command.handled` with `done` in under 2 seconds; `GET /api/bot/commands/:id` shows `done` → AC-7
- [x] POST `start` twice before the worker handles it (stop the worker first) → second returns 409 → AC-7
- [x] POST `{"type":"bad"}` → 422 → AC-7
- [x] Stop the worker, POST a command, wait over 60 seconds, start the worker → the command is marked `failed` with `stale at startup`, not run → AC-7
- [x] Connect to `/ws` with a different Origin → rejected with 403 → AC-7
- [x] Restart the API while the worker runs → the listener reconnects and events reach new WebSocket clients again → AC-7

## Acceptance criteria coverage
- AC-1: commands step 1, UI step 1 · AC-2: second worker, crash restart · AC-3: health steps · AC-4: migrate, seed · AC-5: DB tests · AC-6: DB tests · AC-7: WebSocket and command steps · AC-8: config step · AC-9: commands step 1
