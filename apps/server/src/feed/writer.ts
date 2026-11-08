import type { Logger } from 'pino';
import type { PrismaClient } from '../db/prisma.js';
import { insertCandles } from './candleStore.js';
import type { MarketData } from './marketData.js';
import { seriesKey, type FeedCandle } from './types.js';

export const MAX_QUEUE = 10_000;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

export interface WriterHooks {
  // A live candle was actually stored (not a duplicate).
  onStored: (candle: FeedCandle) => void;
  // The retry queue overflowed; these instruments lost candles and need a backfill.
  onOverflow: (instrumentIds: string[]) => void;
}

// Writes closed candles once. Repeats (the same kline from the stream, from REST, after a
// reconnect) are skipped in memory and by ON CONFLICT DO NOTHING; only rows the insert really
// added reach memory and listeners. Failed writes wait in a bounded retry queue.
export class CandleWriter {
  private readonly lastWritten = new Map<string, number>();
  private queue: Array<{ candle: FeedCandle; live: boolean }> = [];
  private retryMs = MIN_RETRY_MS;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly marketData: MarketData,
    private readonly log: Logger,
    private readonly hooks: WriterHooks,
  ) {}

  // `live` candles are added to memory and announced; backfilled ones are only stored.
  async write(candles: FeedCandle[], live: boolean): Promise<FeedCandle[]> {
    const fresh = live
      ? candles.filter((c) => c.openTime.getTime() > (this.lastWritten.get(seriesKey(c.instrumentId, c.timeframe)) ?? 0))
      : candles;
    if (fresh.length === 0) return [];
    try {
      const inserted = await insertCandles(this.prisma, fresh);
      const added = new Set(inserted.map((r) => `${seriesKey(r.instrumentId, r.timeframe)}:${r.openTime.getTime()}`));
      const stored = fresh.filter((c) => added.has(`${seriesKey(c.instrumentId, c.timeframe)}:${c.openTime.getTime()}`));
      for (const c of fresh) this.markWritten(c);
      if (live) {
        for (const c of stored) {
          this.marketData.add(c, true);
          this.hooks.onStored(c);
        }
      }
      return stored;
    } catch (err) {
      this.log.error({ err, count: fresh.length }, 'candle write failed, queued for retry');
      this.enqueue(fresh, live);
      return [];
    }
  }

  queuedCount(): number {
    return this.queue.length;
  }

  // Tries the queue one last time (on shutdown).
  async flush(): Promise<void> {
    clearTimeout(this.retryTimer);
    await this.drain();
  }

  private markWritten(c: FeedCandle): void {
    const key = seriesKey(c.instrumentId, c.timeframe);
    if (c.openTime.getTime() > (this.lastWritten.get(key) ?? 0)) this.lastWritten.set(key, c.openTime.getTime());
  }

  private enqueue(candles: FeedCandle[], live: boolean): void {
    this.queue.push(...candles.map((candle) => ({ candle, live })));
    if (this.queue.length > MAX_QUEUE) {
      const dropped = this.queue.splice(0, this.queue.length - MAX_QUEUE);
      const ids = [...new Set(dropped.map((d) => d.candle.instrumentId))];
      this.log.error({ dropped: dropped.length, instruments: ids.length }, 'candle retry queue overflowed, oldest dropped');
      this.hooks.onOverflow(ids);
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.drain();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private async drain(): Promise<void> {
    if (this.queue.length === 0) return;
    const pending = this.queue;
    this.queue = [];
    const live = pending.filter((p) => p.live).map((p) => p.candle);
    const backfill = pending.filter((p) => !p.live).map((p) => p.candle);
    // Clear the in memory guard for these so the live path doesn't skip them.
    for (const c of live) this.lastWritten.delete(seriesKey(c.instrumentId, c.timeframe));
    await this.write(backfill, false);
    await this.write(live, true);
    if (this.queue.length === 0) this.retryMs = MIN_RETRY_MS;
  }
}
