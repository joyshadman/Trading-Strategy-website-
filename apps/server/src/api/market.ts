import { Router } from 'express';
import { z } from 'zod';
import { FEED_TIMEFRAMES, feedTimeframeSchema } from '@trading/shared';
import type { PrismaClient } from '../db/prisma.js';

const MAX_LIMIT = 1000;

const candlesQuery = z
  .object({
    symbol: z.string().min(1),
    timeframe: feedTimeframeSchema,
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(500),
    cursor: z.iso.datetime().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must be before to' });

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Market data routes (spec 0002). Prices are decimal strings, never JSON numbers.
export function marketRoutes(prisma: PrismaClient): Router {
  const router = Router();

  // A bounded set (12 instruments), so no pagination.
  router.get('/api/instruments', async (_req, res) => {
    const rows = await prisma.instrument.findMany({ orderBy: { symbol: 'asc' }, include: { feedStatus: true } });
    res.json(
      rows.map((r) => ({
        id: r.id,
        symbol: r.symbol,
        assetClass: r.assetClass,
        venue: r.venue,
        tickSize: r.tickSize.toFixed(),
        minQty: r.minQty.toFixed(),
        timeframes: FEED_TIMEFRAMES,
        feed: {
          status: r.feedStatus?.status ?? 'backfilling',
          lastTickAt: iso(r.feedStatus?.lastTickAt ?? null),
          lastCandleAt: iso(r.feedStatus?.lastCandleAt ?? null),
          lastError: r.feedStatus?.lastError ?? null,
        },
      })),
    );
  });

  // Oldest first. `cursor` is the openTime of the last candle on the previous page.
  router.get('/api/candles', async (req, res) => {
    const parsed = candlesQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ error: 'invalid query', details: parsed.error.issues });
      return;
    }
    const q = parsed.data;
    const instrument = await prisma.instrument.findFirst({ where: { symbol: q.symbol } });
    if (!instrument) {
      res.status(404).json({ error: `unknown symbol ${q.symbol}` });
      return;
    }
    const openTime = {
      ...(q.cursor ? { gt: new Date(q.cursor) } : q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(q.to) } : {}),
    };
    const rows = await prisma.candle.findMany({
      where: { instrumentId: instrument.id, timeframe: q.timeframe, openTime },
      orderBy: { openTime: 'asc' },
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    res.json({
      candles: page.map((c) => ({
        openTime: c.openTime.toISOString(),
        open: c.open.toFixed(),
        high: c.high.toFixed(),
        low: c.low.toFixed(),
        close: c.close.toFixed(),
        volume: c.volume.toFixed(),
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.openTime.toISOString() : null,
    });
  });

  return router;
}
