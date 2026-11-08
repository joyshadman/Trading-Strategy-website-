import { RETENTION_MS, TIMEFRAME_MS, type FeedTimeframe } from '@trading/shared';
import type { PrismaClient } from '../db/prisma.js';
import type { FeedCandle, TimeRange } from './types.js';

const MAX_ROWS_PER_INSERT = 5000;
const DELETE_BATCH = 10_000;

interface InsertedRow {
  instrumentId: string;
  timeframe: string;
  openTime: Date;
}

// Idempotent multi row insert: rows already stored are skipped (ON CONFLICT DO NOTHING).
// Arrays are passed with unnest, so a statement uses 8 parameters however many rows it has.
// Returns only the rows this call actually added.
export async function insertCandles(prisma: PrismaClient, candles: FeedCandle[]): Promise<InsertedRow[]> {
  const inserted: InsertedRow[] = [];
  for (let i = 0; i < candles.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = candles.slice(i, i + MAX_ROWS_PER_INSERT);
    const rows = await prisma.$queryRawUnsafe<InsertedRow[]>(
      `INSERT INTO "Candle" ("instrumentId", timeframe, "openTime", open, high, low, close, volume)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::timestamptz[],
                            $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[])
       ON CONFLICT ("instrumentId", timeframe, "openTime") DO NOTHING
       RETURNING "instrumentId", timeframe, "openTime"`,
      chunk.map((c) => c.instrumentId),
      chunk.map((c) => c.timeframe),
      chunk.map((c) => c.openTime.toISOString()),
      chunk.map((c) => c.open),
      chunk.map((c) => c.high),
      chunk.map((c) => c.low),
      chunk.map((c) => c.close),
      chunk.map((c) => c.volume),
    );
    inserted.push(...rows);
  }
  return inserted;
}

// The open time of the newest candle that has closed by `now`.
export function lastClosedOpenTime(timeframe: FeedTimeframe, now: number): Date {
  const step = TIMEFRAME_MS[timeframe];
  return new Date(Math.floor(now / step) * step - step);
}

export function retentionStart(timeframe: FeedTimeframe, now: number): Date {
  const step = TIMEFRAME_MS[timeframe];
  return new Date(Math.ceil((now - RETENTION_MS[timeframe]) / step) * step);
}

// Every run of missing candles in [start, end], as contiguous ranges of open times.
// One round trip: the expected open times come from generate_series.
export async function findGaps(
  prisma: PrismaClient,
  instrumentId: string,
  timeframe: FeedTimeframe,
  range: TimeRange,
): Promise<TimeRange[]> {
  if (range.end < range.start) return [];
  const stepSeconds = TIMEFRAME_MS[timeframe] / 1000;
  const rows = await prisma.$queryRawUnsafe<{ gapStart: Date; gapEnd: Date }[]>(
    `WITH expected AS (
       SELECT t FROM generate_series($3::timestamptz, $4::timestamptz, make_interval(secs => $5)) AS t
     ),
     missing AS (
       SELECT e.t FROM expected e
       WHERE NOT EXISTS (
         SELECT 1 FROM "Candle" c
         WHERE c."instrumentId" = $1::uuid AND c.timeframe = $2 AND c."openTime" = e.t
       )
     ),
     grouped AS (
       SELECT t, t - make_interval(secs => $5) * (row_number() OVER (ORDER BY t)) AS grp FROM missing
     )
     SELECT min(t) AS "gapStart", max(t) AS "gapEnd" FROM grouped GROUP BY grp ORDER BY 1`,
    instrumentId,
    timeframe,
    range.start.toISOString(),
    range.end.toISOString(),
    stepSeconds,
  );
  return rows.map((r) => ({ start: r.gapStart, end: r.gapEnd }));
}

// Merge gap ranges closer than `joinMs`, so many small gaps (quiet forex minutes) become a
// few fetches instead of hundreds.
export function mergeRanges(ranges: TimeRange[], joinMs: number): TimeRange[] {
  const out: TimeRange[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.start.getTime() - last.end.getTime() <= joinMs) {
      if (r.end > last.end) last.end = r.end;
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

// The newest `n` candles of one series, oldest first.
export async function loadRecent(
  prisma: PrismaClient,
  instrumentId: string,
  timeframe: FeedTimeframe,
  n: number,
): Promise<FeedCandle[]> {
  const rows = await prisma.candle.findMany({
    where: { instrumentId, timeframe },
    orderBy: { openTime: 'desc' },
    take: n,
  });
  return rows.reverse().map((r) => ({
    instrumentId: r.instrumentId,
    timeframe,
    openTime: r.openTime,
    open: r.open.toFixed(),
    high: r.high.toFixed(),
    low: r.low.toFixed(),
    close: r.close.toFixed(),
    volume: r.volume.toFixed(),
  }));
}

// Deletes candles older than each timeframe's retention window, in batches.
export async function pruneOldCandles(prisma: PrismaClient, timeframes: readonly FeedTimeframe[], now: number): Promise<number> {
  let total = 0;
  for (const timeframe of timeframes) {
    const cutoff = new Date(now - RETENTION_MS[timeframe]).toISOString();
    for (;;) {
      const deleted = await prisma.$executeRawUnsafe(
        `DELETE FROM "Candle" WHERE ctid IN (
           SELECT ctid FROM "Candle" WHERE timeframe = $1 AND "openTime" < $2::timestamptz LIMIT ${DELETE_BATCH}
         )`,
        timeframe,
        cutoff,
      );
      total += deleted;
      if (deleted < DELETE_BATCH) break;
    }
  }
  return total;
}
