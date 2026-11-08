# 0001. Backend foundation: rationale

## Context

Today all logic lives in the browser (`src/components/PredictorCard.jsx`). Price feeds, EMA/RSI/MACD signals, and history stop when the tab closes, and nothing is saved. An automated trader has to keep running, remember every order, and never place the same order twice.

Forces: one developer, one user (you), existing code in JavaScript with React + Vite, money math where rounding errors are real bugs, paper trading first with live money later, and hosting that is free or your own PC for now. The scope's later features (market data, paper bot, control panel, backtesting, live trading) all build on what is decided here, so the data model is the costliest part to redo.

## Options considered

### Option 1: TypeScript monorepo, Express API + worker, PostgreSQL via Prisma
One language across front and back, indicator code shared in a package, two processes on one database.

**Pros**: reuses the existing JS indicator code and your skills; types protect order and money logic; a worker crash never takes the API down, and the reverse.
**Cons**: two processes to run; npm workspaces mean moving the frontend into `apps/web` once.

### Option 2: Python backend (API + worker) with a TypeScript frontend
**Pros**: the richest quant and backtesting ecosystem.
**Cons**: two languages to maintain, indicator code rewritten, shared types lost.

### Option 3: Single Node process (API and bot together) on SQLite
**Pros**: the least setup, one file database, one thing to run.
**Cons**: any API crash or redeploy stops trading; SQLite is weak with concurrent writers once a worker is split out later.

## Rationale

The bot must run when the browser is closed and survive restarts, which forces a backend and a persistent database; a separate worker keeps trading isolated from API crashes. TypeScript keeps one language with your frontend and lets the existing indicator code move into `packages/shared`, so the backend and the UI compute signals identically. PostgreSQL with exact NUMERIC columns removes rounding drift in fees and profit, handles two processes writing at once, and its advisory locks and LISTEN/NOTIFY cover single worker safety and live events without adding a broker.

You picked Express over the recommended Fastify. Express works well here; the cost is adding request validation (zod) and the WebSocket server (`ws`) by hand, both small. Prisma was picked over Drizzle; it is fine for the CRUD paths, and the stats and backtest queries later should use raw SQL through Prisma where aggregation gets heavy. Prisma cannot LISTEN or hold a session lock, so a plain `pg` client handles those two jobs.

