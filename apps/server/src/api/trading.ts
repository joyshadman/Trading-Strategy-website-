import { Router, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  EQUITY_LIMIT_MAX,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  Money,
  toDecimal,
  type AccountResponse,
  type EquitySnapshotResponse,
  type PositionResponse,
  type SignalResponse,
  type StrategyResponse,
} from '@trading/shared';
import type { Prisma, PrismaClient } from '../db/prisma.js';
import { marginUsd } from '../trader/accounting.js';
import { loadTodayRealized } from '../trader/store.js';
import { PAPER_ACCOUNT_NAME } from '../worker/constants.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const ZERO = new Money(0);

// Cursors are opaque: base64url of { t: ISO time, id }, so rows with the same time aren't skipped.
export const encodeCursor = (t: Date, id: string) => Buffer.from(JSON.stringify({ t: t.toISOString(), id })).toString('base64url');
const cursorSchema = z.object({ t: z.iso.datetime(), id: z.string() });
export const cursorParam = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    try {
      const c = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
      return { t: new Date(c.t), id: c.id };
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid cursor' });
      return z.NEVER;
    }
  });

export const limitParam = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);

const positionsQuery = z.object({
  status: z.enum(['open', 'closed']).default('open'),
  strategyId: z.string().regex(UUID_RE).optional(),
  symbol: z.string().min(1).optional(),
  limit: limitParam(LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX),
  cursor: cursorParam,
});

const signalsQuery = z.object({
  strategyId: z.string().regex(UUID_RE).optional(),
  symbol: z.string().min(1).optional(),
  outcome: z.enum(['ordered', 'skipped']).optional(),
  limit: limitParam(LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX),
  cursor: cursorParam,
});

const equityQuery = z
  .object({
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    limit: limitParam(EQUITY_LIMIT_MAX, EQUITY_LIMIT_MAX),
    cursor: cursorParam,
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must be before to' });

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const str = (d: { toFixed(): string }) => d.toFixed();
const strOrNull = (d: { toFixed(): string } | null) => (d ? d.toFixed() : null);

const positionInclude = {
  strategy: { select: { id: true, name: true } },
  instrument: { select: { symbol: true } },
  // Any pending exit order (kill or manual, spec 0004) means the position is closing.
  orders: { where: { reason: { in: ['kill', 'manual'] }, status: 'pending' }, select: { id: true } },
} satisfies Prisma.PositionInclude;

type PositionWithRefs = Prisma.PositionGetPayload<{ include: typeof positionInclude }>;

function toPosition(p: PositionWithRefs): PositionResponse {
  return {
    id: p.id,
    strategy: p.strategy,
    symbol: p.instrument.symbol,
    side: p.side,
    qty: str(p.qty),
    entryPrice: str(p.entryPrice),
    stopLoss: strOrNull(p.stopLoss),
    takeProfit: strOrNull(p.takeProfit),
    status: p.status,
    markPrice: strOrNull(p.markPrice),
    unrealizedPnl: strOrNull(p.unrealizedPnl),
    markedAt: iso(p.markedAt),
    exitPrice: strOrNull(p.exitPrice),
    closeReason: p.closeReason === 'entry' ? null : p.closeReason,
    fees: str(p.fees),
    realizedPnl: strOrNull(p.realizedPnl),
    pendingClose: p.orders.length > 0,
    openedAt: p.openedAt.toISOString(),
    closedAt: iso(p.closedAt),
  };
}

// Newest first by (time, id): rows strictly after the cursor in that order.
export const before = (field: 'openedAt' | 'closedAt' | 'createdAt', c: { t: Date; id: string } | undefined) =>
  c ? { OR: [{ [field]: { lt: c.t } }, { [field]: c.t, id: { lt: c.id } }] } : {};

// Paper trading reads (spec 0003). Read only: only the worker writes trading tables.
export function tradingRoutes(prisma: PrismaClient, log: Logger): Router {
  const router = Router();

  // Every read here is a database read; a failure means the database is down (503).
  const read = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try {
      await handler(req, res);
    } catch (err) {
      log.error({ err, path: req.path }, 'trading read failed');
      res.status(503).json({ error: 'database unavailable' });
    }
  };

  const paperAccount = () => prisma.account.findUnique({ where: { name: PAPER_ACCOUNT_NAME } });

  router.get(
    '/api/account',
    read(async (_req, res) => {
      const account = await paperAccount();
      if (!account) {
        res.status(404).json({ error: 'paper account missing, run npm run db:seed' });
        return;
      }
      const open = await prisma.position.findMany({
        where: { accountId: account.id, status: 'open' },
        include: { instrument: { select: { assetClass: true } } },
      });
      const margin = open.reduce(
        (sum, p) =>
          sum.plus(marginUsd(toDecimal(str(p.qty)), toDecimal(str(p.entryPrice)), toDecimal(str(p.entryQuoteToUsd)), p.instrument.assetClass)),
        ZERO,
      );
      const today = await loadTodayRealized(prisma, account.id);
      const todayTotal = [...today.byStrategy.values()].reduce((a, b) => a.plus(b), ZERO);
      const equity = toDecimal(str(account.equity));
      const body: AccountResponse = {
        id: account.id,
        name: account.name,
        currency: account.currency,
        balance: str(account.balance),
        equity: equity.toFixed(),
        marginUsed: margin.toDecimalPlaces(12).toFixed(),
        freeMargin: equity.minus(margin).toDecimalPlaces(12).toFixed(),
        openPositions: open.length,
        todayRealizedPnl: todayTotal.toFixed(),
      };
      res.json(body);
    }),
  );

  router.get(
    '/api/strategies',
    read(async (_req, res) => {
      const account = await paperAccount();
      if (!account) {
        res.json([]);
        return;
      }
      const rows = await prisma.strategy.findMany({
        where: { accountId: account.id },
        orderBy: { name: 'asc' },
        include: { risk: true, instruments: { include: { instrument: { select: { symbol: true } } } } },
      });
      const openCounts = await prisma.position.groupBy({ by: ['strategyId'], where: { accountId: account.id, status: 'open' }, _count: true });
      const today = await loadTodayRealized(prisma, account.id);
      const body: StrategyResponse[] = rows.map((s) => {
        const realized = today.byStrategy.get(s.id) ?? ZERO;
        return {
          id: s.id,
          name: s.name,
          kind: s.kind,
          timeframe: s.timeframe,
          enabled: s.enabled,
          params: s.params,
          symbols: s.instruments.map((i) => i.instrument.symbol).sort(),
          risk: s.risk
            ? {
                stopLossPct: str(s.risk.stopLossPct),
                takeProfitPct: str(s.risk.takeProfitPct),
                maxPositionSize: str(s.risk.maxPositionSize),
                maxOpenTrades: s.risk.maxOpenTrades,
                dailyLossLimit: str(s.risk.dailyLossLimit),
                riskPerTradePct: str(s.risk.riskPerTradePct),
              }
            : null,
          openPositions: openCounts.find((c) => c.strategyId === s.id)?._count ?? 0,
          todayRealizedPnl: realized.toFixed(),
          halted: s.risk ? realized.lte(toDecimal(str(s.risk.dailyLossLimit)).neg()) : false,
        };
      });
      res.json(body);
    }),
  );

  router.get(
    '/api/positions',
    read(async (req, res) => {
      const parsed = positionsQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({ error: 'invalid query', details: parsed.error.issues });
        return;
      }
      const q = parsed.data;
      const timeField = q.status === 'open' ? 'openedAt' : 'closedAt';
      const rows = await prisma.position.findMany({
        where: {
          status: q.status,
          ...(q.strategyId ? { strategyId: q.strategyId } : {}),
          ...(q.symbol ? { instrument: { symbol: q.symbol } } : {}),
          ...before(timeField, q.cursor),
        },
        orderBy: [{ [timeField]: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        include: positionInclude,
      });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      res.json({
        positions: page.map(toPosition),
        nextCursor: rows.length > q.limit && last ? encodeCursor((last[timeField] ?? last.openedAt) as Date, last.id) : null,
      });
    }),
  );

  router.get(
    '/api/positions/:id',
    read(async (req, res) => {
      const id = String(req.params.id);
      const p = UUID_RE.test(id)
        ? await prisma.position.findUnique({
            where: { id },
            include: positionInclude,
          })
        : null;
      if (!p) {
        res.status(404).json({ error: 'position not found' });
        return;
      }
      const orders = await prisma.order.findMany({ where: { positionId: id }, orderBy: { createdAt: 'asc' }, include: { fills: true } });
      res.json({
        ...toPosition(p),
        orders: orders.map((o) => ({
          id: o.id,
          clientOrderId: o.clientOrderId,
          reason: o.reason,
          side: o.side,
          type: o.type,
          qty: str(o.qty),
          status: o.status,
          createdAt: o.createdAt.toISOString(),
        })),
        fills: orders.flatMap((o) =>
          o.fills.map((f) => ({
            id: f.id,
            orderId: f.orderId,
            price: str(f.price),
            qty: str(f.qty),
            fee: str(f.fee),
            feeCurrency: f.feeCurrency,
            filledAt: f.filledAt.toISOString(),
          })),
        ),
      });
    }),
  );

  router.get(
    '/api/signals',
    read(async (req, res) => {
      const parsed = signalsQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({ error: 'invalid query', details: parsed.error.issues });
        return;
      }
      const q = parsed.data;
      const rows = await prisma.signal.findMany({
        where: {
          ...(q.strategyId ? { strategyId: q.strategyId } : {}),
          ...(q.symbol ? { instrument: { symbol: q.symbol } } : {}),
          ...(q.outcome ? { outcome: q.outcome } : {}),
          ...before('createdAt', q.cursor),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        include: {
          strategy: { select: { id: true, name: true } },
          instrument: { select: { symbol: true } },
          order: { select: { id: true } },
        },
      });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const signals: SignalResponse[] = page.map((s) => ({
        id: s.id,
        strategy: s.strategy,
        symbol: s.instrument.symbol,
        side: s.side,
        outcome: s.outcome,
        skipReason: s.skipReason,
        indicators: s.indicators,
        candleTime: s.candleTime.toISOString(),
        createdAt: s.createdAt.toISOString(),
        orderId: s.order?.id ?? null,
      }));
      res.json({ signals, nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null });
    }),
  );

  // Oldest first, for charts.
  router.get(
    '/api/equity',
    read(async (req, res) => {
      const parsed = equityQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({ error: 'invalid query', details: parsed.error.issues });
        return;
      }
      const q = parsed.data;
      const account = await paperAccount();
      if (!account) {
        res.json({ snapshots: [], nextCursor: null });
        return;
      }
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * DAY_MS);
      const rows = await prisma.equitySnapshot.findMany({
        where: {
          accountId: account.id,
          takenAt: { ...(q.cursor ? { gt: q.cursor.t } : { gte: from }), ...(q.to ? { lte: new Date(q.to) } : {}) },
        },
        orderBy: { takenAt: 'asc' },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const snapshots: EquitySnapshotResponse[] = page.map((r) => ({
        takenAt: r.takenAt.toISOString(),
        balance: str(r.balance),
        equity: str(r.equity),
        openPositions: r.openPositions,
      }));
      res.json({ snapshots, nextCursor: rows.length > q.limit && last ? encodeCursor(last.takenAt, last.id) : null });
    }),
  );

  return router;
}
