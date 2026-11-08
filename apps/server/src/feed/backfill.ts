import type { Logger } from 'pino';
import { TIMEFRAME_MS, alignToTimeframe, type FeedTimeframe } from '@trading/shared';
import type { PrismaClient } from '../db/prisma.js';
import { findGaps, lastClosedOpenTime, mergeRanges, retentionStart } from './candleStore.js';
import type { CandleWriter } from './writer.js';
import type { FeedCandle, TimeRange } from './types.js';

export const BACKFILL_CONCURRENCY = 3;
// Gaps closer than this are fetched in one go (quiet forex minutes, weekends).
const JOIN_GAPS_MS = 6 * 3_600_000;

export interface SeriesFetcher {
  // Closed candles with open times inside [range.start, range.end].
  fetch: (range: TimeRange) => Promise<FeedCandle[]>;
  // Largest time span one request may cover for this timeframe.
  maxSpanMs: number;
}

export async function runPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(runners);
}

// Drops candles a source returned outside the asked range or off the timeframe grid.
export function keepAligned(candles: FeedCandle[], timeframe: FeedTimeframe, range: TimeRange, log: Logger): FeedCandle[] {
  return candles.filter((c) => {
    if (c.openTime.getTime() !== alignToTimeframe(c.openTime, timeframe).getTime()) {
      log.warn({ timeframe, openTime: c.openTime }, 'dropped misaligned candle');
      return false;
    }
    return c.openTime >= range.start && c.openTime <= range.end;
  });
}

// Fills every gap of one series inside its retention window, oldest first. Gaps a source
// has no candles for (OANDA market closed) stay gaps; nothing is invented.
export async function backfillSeries(
  deps: { prisma: PrismaClient; writer: CandleWriter; log: Logger },
  instrumentId: string,
  timeframe: FeedTimeframe,
  fetcher: SeriesFetcher,
  now = Date.now(),
): Promise<number> {
  const window = { start: retentionStart(timeframe, now), end: lastClosedOpenTime(timeframe, now) };
  const gaps = mergeRanges(await findGaps(deps.prisma, instrumentId, timeframe, window), JOIN_GAPS_MS);
  let stored = 0;
  const step = TIMEFRAME_MS[timeframe];
  for (const gap of gaps) {
    for (let from = gap.start.getTime(); from <= gap.end.getTime(); from += fetcher.maxSpanMs) {
      const range = { start: new Date(from), end: new Date(Math.min(from + fetcher.maxSpanMs - step, gap.end.getTime())) };
      const candles = keepAligned(await fetcher.fetch(range), timeframe, range, deps.log);
      stored += (await deps.writer.write(candles, false)).length;
    }
  }
  return stored;
}
