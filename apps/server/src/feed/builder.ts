import { TIMEFRAME_MS, type FeedTimeframe } from '@trading/shared';
import { buildCandle, bucketStart } from './aggregate.js';
import { lastClosedOpenTime } from './candleStore.js';
import type { MarketData } from './marketData.js';
import { seriesKey, type FeedCandle } from './types.js';
import type { CandleWriter } from './writer.js';

// Largest first (spec 0003): when the 15m candle closing on the hour is announced, that
// hour's 1h candle is already stored, so the paper bot's 1h filter sees the hour that just closed.
export const BUILT_TIMEFRAMES = ['1h', '15m', '5m'] as const satisfies readonly FeedTimeframe[];
const MINUTE = TIMEFRAME_MS['1m'];

// Builds live 5m, 15m, and 1h candles from stored 1m candles (spec 0002).
export class HigherTimeframeBuilder {
  // Open time of the newest bucket built (or backfilled) per series.
  private readonly builtThrough = new Map<string, number>();

  constructor(
    private readonly marketData: MarketData,
    private readonly writer: CandleWriter,
  ) {}

  // After backfill, everything that has closed is already stored from REST.
  markBackfilled(instrumentIds: string[], now = Date.now()): void {
    for (const id of instrumentIds) {
      for (const tf of BUILT_TIMEFRAMES) this.builtThrough.set(seriesKey(id, tf), lastClosedOpenTime(tf, now).getTime());
    }
  }

  // A live 1m candle was stored: build any bucket it completes.
  async onOneMinute(candle: FeedCandle): Promise<void> {
    for (const tf of BUILT_TIMEFRAMES) {
      const start = bucketStart(candle.openTime, tf);
      if (candle.openTime.getTime() + MINUTE === start + TIMEFRAME_MS[tf]) await this.build(candle.instrumentId, tf, start);
    }
  }

  // Builds buckets that ended without their last minute (quiet OANDA minutes).
  async flushDue(instrumentIds: string[], now = Date.now()): Promise<void> {
    for (const id of instrumentIds) {
      for (const tf of BUILT_TIMEFRAMES) await this.build(id, tf, lastClosedOpenTime(tf, now).getTime());
    }
  }

  private async build(instrumentId: string, timeframe: FeedTimeframe, start: number): Promise<void> {
    const key = seriesKey(instrumentId, timeframe);
    if ((this.builtThrough.get(key) ?? 0) >= start) return;
    const minutes = TIMEFRAME_MS[timeframe] / MINUTE;
    const candle = buildCandle(this.marketData.getCandles(instrumentId, '1m', minutes + 5), timeframe, start);
    if (!candle) return;
    this.builtThrough.set(key, start);
    await this.writer.write([candle], true);
  }
}
