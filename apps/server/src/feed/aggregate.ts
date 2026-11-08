import { Decimal } from 'decimal.js';
import { TIMEFRAME_MS, toDecimal, type FeedTimeframe } from '@trading/shared';
import type { FeedCandle } from './types.js';

export const bucketStart = (openTime: Date, timeframe: FeedTimeframe): number =>
  Math.floor(openTime.getTime() / TIMEFRAME_MS[timeframe]) * TIMEFRAME_MS[timeframe];

// Builds one higher timeframe candle from the 1m candles of its bucket: open of the first,
// max high, min low, close of the last, sum of volume. Missing minutes are allowed (quiet
// OANDA minutes); no candles at all means no candle.
export function buildCandle(
  oneMinute: readonly FeedCandle[],
  timeframe: FeedTimeframe,
  start: number,
): FeedCandle | null {
  const end = start + TIMEFRAME_MS[timeframe];
  const inBucket = oneMinute
    .filter((c) => c.openTime.getTime() >= start && c.openTime.getTime() < end)
    .sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  const first = inBucket[0];
  const last = inBucket[inBucket.length - 1];
  if (!first || !last) return null;

  let high = toDecimal(first.high);
  let low = toDecimal(first.low);
  let volume = new Decimal(0);
  for (const c of inBucket) {
    high = Decimal.max(high, toDecimal(c.high));
    low = Decimal.min(low, toDecimal(c.low));
    volume = volume.plus(toDecimal(c.volume));
  }
  return {
    instrumentId: first.instrumentId,
    timeframe,
    openTime: new Date(start),
    open: first.open,
    high: high.toFixed(),
    low: low.toFixed(),
    close: last.close,
    volume: volume.toFixed(),
  };
}
