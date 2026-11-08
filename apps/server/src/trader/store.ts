import {
  emaRsiMacdParamsSchema,
  feedTimeframeSchema,
  toDecimal,
  type AssetClass,
  type EmaRsiMacdParams,
  type FeedTimeframe,
  type Money,
  type Side,
  type SignalIndicators,
  type SkipReason,
} from '@trading/shared';
import type { PrismaClient } from '../db/prisma.js';

type Decimal = Money;

// The trader's reads and small writes (spec 0003). Fills live in broker.ts.

export interface InstrumentInfo {
  id: string;
  symbol: string;
  assetClass: AssetClass;
  quoteAsset: string;
  tickSize: Decimal;
  minQty: Decimal;
}

export interface RiskInfo {
  stopLossPct: Decimal;
  takeProfitPct: Decimal;
  maxPositionSize: Decimal;
  maxOpenTrades: number;
  dailyLossLimit: Decimal;
  riskPerTradePct: Decimal;
}

export interface StrategyInfo {
  id: string;
  name: string;
  enabled: boolean;
  timeframe: FeedTimeframe;
  params: EmaRsiMacdParams;
  instrumentIds: Set<string>;
  risk: RiskInfo | null;
}

export interface PositionRow {
  id: string;
  strategyId: string;
  instrumentId: string;
  side: Side;
  qty: Decimal;
  entryPrice: Decimal;
  stopLoss: Decimal | null;
  takeProfit: Decimal | null;
  fees: Decimal;
  entryQuoteToUsd: Decimal;
  markPrice: Decimal | null;
  unrealizedPnl: Decimal | null;
}

// Prisma's Decimal → the shared one.
const d = (v: { toFixed(): string }): Decimal => toDecimal(v.toFixed());
const dn = (v: { toFixed(): string } | null): Decimal | null => (v === null ? null : d(v));

export async function loadInstruments(prisma: PrismaClient): Promise<InstrumentInfo[]> {
  const rows = await prisma.instrument.findMany({ where: { active: true } });
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    assetClass: r.assetClass,
    quoteAsset: r.quoteAsset,
    tickSize: d(r.tickSize),
    minQty: d(r.minQty),
  }));
}

// Strategies with params that don't parse are skipped with a log by the caller (returned as errors).
export async function loadStrategies(
  prisma: PrismaClient,
  accountId: string,
): Promise<{ strategies: StrategyInfo[]; invalid: Array<{ name: string; error: string }> }> {
  const rows = await prisma.strategy.findMany({ where: { accountId }, include: { instruments: true, risk: true } });
  const strategies: StrategyInfo[] = [];
  const invalid: Array<{ name: string; error: string }> = [];
  for (const r of rows) {
    const params = emaRsiMacdParamsSchema.safeParse(r.params);
    const timeframe = feedTimeframeSchema.safeParse(r.timeframe);
    if (r.kind !== 'ema_rsi_macd' || !params.success || !timeframe.success) {
      invalid.push({ name: r.name, error: params.success ? `unsupported kind or timeframe` : params.error.message });
      continue;
    }
    strategies.push({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      timeframe: timeframe.data,
      params: params.data,
      instrumentIds: new Set(r.instruments.map((i) => i.instrumentId)),
      risk: r.risk
        ? {
            stopLossPct: d(r.risk.stopLossPct),
            takeProfitPct: d(r.risk.takeProfitPct),
            maxPositionSize: d(r.risk.maxPositionSize),
            maxOpenTrades: r.risk.maxOpenTrades,
            dailyLossLimit: d(r.risk.dailyLossLimit),
            riskPerTradePct: d(r.risk.riskPerTradePct),
          }
        : null,
    });
  }
  return { strategies, invalid };
}

export async function loadOpenPositions(prisma: PrismaClient, accountId: string): Promise<PositionRow[]> {
  const rows = await prisma.position.findMany({ where: { accountId, status: 'open' } });
  return rows.map((r) => ({
    id: r.id,
    strategyId: r.strategyId,
    instrumentId: r.instrumentId,
    side: r.side,
    qty: d(r.qty),
    entryPrice: d(r.entryPrice),
    stopLoss: dn(r.stopLoss),
    takeProfit: dn(r.takeProfit),
    fees: d(r.fees),
    entryQuoteToUsd: d(r.entryQuoteToUsd),
    markPrice: dn(r.markPrice),
    unrealizedPnl: dn(r.unrealizedPnl),
  }));
}

export type ExitReason = 'kill' | 'manual';

// Every pending exit order (a kill or a manual close, spec 0004), by position.
export async function loadPendingExits(prisma: PrismaClient, accountId: string): Promise<Map<string, ExitReason>> {
  const rows = await prisma.order.findMany({
    where: { accountId, reason: { in: ['kill', 'manual'] }, status: 'pending', positionId: { not: null } },
    select: { positionId: true, reason: true },
  });
  return new Map(rows.map((r) => [r.positionId!, r.reason as ExitReason]));
}

export async function loadBalance(prisma: PrismaClient, accountId: string): Promise<Decimal> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  return d(account.balance);
}

// Realized PnL per strategy since 00:00 UTC, by the database clock, plus that day's key.
export async function loadTodayRealized(
  prisma: PrismaClient,
  accountId: string,
): Promise<{ day: string; byStrategy: Map<string, Decimal> }> {
  const rows = await prisma.$queryRaw<Array<{ day: string; strategyId: string | null; total: string | null }>>`
    WITH today AS (SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start)
    SELECT to_char(today.start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, p."strategyId", sum(p."realizedPnl")::text AS total
    FROM today
    LEFT JOIN "Position" p ON p."accountId" = ${accountId}::uuid AND p.status = 'closed' AND p."closedAt" >= today.start
    GROUP BY 1, 2`;
  const byStrategy = new Map<string, Decimal>();
  for (const r of rows) if (r.strategyId && r.total) byStrategy.set(r.strategyId, toDecimal(r.total));
  return { day: rows[0]!.day, byStrategy };
}

// Step 1 of a signal: claim the candle. False when this strategy already evaluated it.
export async function insertSignal(
  prisma: PrismaClient,
  s: { id: string; strategyId: string; instrumentId: string; side: Side; indicators: SignalIndicators; candleTime: Date },
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "Signal" (id, "strategyId", "instrumentId", side, indicators, outcome, "candleTime")
    VALUES (${s.id}::uuid, ${s.strategyId}::uuid, ${s.instrumentId}::uuid, ${s.side}::"Side",
      ${JSON.stringify(s.indicators)}::jsonb, 'skipped', ${s.candleTime})
    ON CONFLICT ("strategyId", "instrumentId", "candleTime") DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

export async function finishSignal(prisma: PrismaClient, id: string, skipReason: SkipReason | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Signal" SET outcome = ${skipReason ? 'skipped' : 'ordered'}::"SignalOutcome", "skipReason" = ${skipReason}
    WHERE id = ${id}::uuid`;
}

// The kill sweep: a pending `kill` exit order for every open position that lacks one.
export async function createKillOrders(prisma: PrismaClient, accountId: string): Promise<number> {
  return prisma.$executeRaw`
    INSERT INTO "Order" (id, "clientOrderId", "accountId", "strategyId", "instrumentId", side, type, qty,
      status, reason, "positionId", "updatedAt")
    SELECT gen_random_uuid(), 'x:' || p.id, p."accountId", p."strategyId", p."instrumentId",
      CASE p.side WHEN 'buy' THEN 'sell'::"Side" ELSE 'buy'::"Side" END, 'market', p.qty,
      'pending', 'kill', p.id, now()
    FROM "Position" p
    WHERE p."accountId" = ${accountId}::uuid AND p.status = 'open'
    ON CONFLICT ("clientOrderId") DO NOTHING`;
}

// enable_strategy / disable_strategy (spec 0004): the switch and the command's done status
// commit together, and only while the command is still pending. False when it wasn't.
export async function applyStrategyToggle(
  prisma: PrismaClient,
  commandId: string,
  strategyId: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH cmd AS (
      UPDATE "BotCommand" SET status = 'done', "handledAt" = now()
      WHERE id = ${commandId}::uuid AND status = 'pending'
      RETURNING id
    ),
    s AS (
      UPDATE "Strategy" SET enabled = ${enabled}
      WHERE id = ${strategyId}::uuid AND EXISTS (SELECT 1 FROM cmd)
    )
    SELECT id FROM cmd`;
  return rows.length > 0;
}

export type ManualExitError = 'position not open' | 'position already closing';
export type ManualExitResult = { status: 'done' } | { status: 'failed'; error: ManualExitError };

// close_position (spec 0004): a pending manual exit order shaped like a kill order, and the
// command's status, in one statement. A CTE can't see its own insert, so the outcome is
// decided from plain reads first. Null when the command was no longer pending.
export async function createManualExit(
  prisma: PrismaClient,
  commandId: string,
  positionId: string,
): Promise<ManualExitResult | null> {
  const rows = await prisma.$queryRaw<Array<{ error: ManualExitError | null }>>`
    WITH cmd AS (
      SELECT id FROM "BotCommand" WHERE id = ${commandId}::uuid AND status = 'pending'
    ),
    verdict AS (
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM "Position" WHERE id = ${positionId}::uuid AND status = 'open') THEN 'position not open'
        WHEN EXISTS (SELECT 1 FROM "Order" WHERE "clientOrderId" = 'x:' || ${positionId}) THEN 'position already closing'
      END AS error
    ),
    ins AS (
      INSERT INTO "Order" (id, "clientOrderId", "accountId", "strategyId", "instrumentId", side, type, qty,
        status, reason, "positionId", "updatedAt")
      SELECT gen_random_uuid(), 'x:' || p.id, p."accountId", p."strategyId", p."instrumentId",
        CASE p.side WHEN 'buy' THEN 'sell'::"Side" ELSE 'buy'::"Side" END, 'market', p.qty,
        'pending', 'manual', p.id, now()
      FROM "Position" p, verdict, cmd
      WHERE p.id = ${positionId}::uuid AND verdict.error IS NULL
      ON CONFLICT ("clientOrderId") DO NOTHING
    )
    UPDATE "BotCommand" c
    SET status = (CASE WHEN verdict.error IS NULL THEN 'done' ELSE 'failed' END)::"CommandStatus",
        error = verdict.error, "handledAt" = now()
    FROM verdict, cmd
    WHERE c.id = cmd.id
    RETURNING verdict.error`;
  const row = rows[0];
  if (!row) return null;
  return row.error ? { status: 'failed', error: row.error } : { status: 'done' };
}

// Marks for open positions and the account's equity, in one statement.
export async function writeMarks(
  prisma: PrismaClient,
  accountId: string,
  marks: Array<{ id: string; markPrice: Decimal; unrealizedPnl: Decimal }>,
  equity: Decimal,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `WITH m AS (
       UPDATE "Position" p SET "markPrice" = v.mark, "unrealizedPnl" = v.pnl, "markedAt" = now()
       FROM unnest($1::uuid[], $2::numeric[], $3::numeric[]) AS v(id, mark, pnl)
       WHERE p.id = v.id AND p.status = 'open'
       RETURNING p.id
     )
     UPDATE "Account" SET equity = $4::numeric WHERE id = $5::uuid`,
    marks.map((m) => m.id),
    marks.map((m) => m.markPrice.toFixed()),
    marks.map((m) => m.unrealizedPnl.toFixed()),
    equity.toFixed(),
    accountId,
  );
}

export async function insertSnapshot(
  prisma: PrismaClient,
  accountId: string,
  takenAt: Date,
  balance: Decimal,
  equity: Decimal,
  openPositions: number,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "EquitySnapshot" (id, "accountId", balance, equity, "openPositions", "takenAt")
    VALUES (gen_random_uuid(), ${accountId}::uuid, ${balance.toFixed()}::numeric, ${equity.toFixed()}::numeric,
      ${openPositions}, ${takenAt})
    ON CONFLICT ("accountId", "takenAt") DO NOTHING`;
}

// The state the previous worker run ended in (to rerun a kill sweep after a crash).
export async function previousRunState(prisma: PrismaClient, currentRunId: string): Promise<string | null> {
  const prev = await prisma.botRun.findFirst({ where: { id: { not: currentRunId } }, orderBy: { startedAt: 'desc' } });
  return prev?.state ?? null;
}
