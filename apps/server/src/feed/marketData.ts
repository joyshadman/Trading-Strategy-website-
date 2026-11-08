import type { FeedTimeframe } from '@trading/shared';
import { seriesKey, type FeedCandle } from './types.js';

export const RING_SIZE = 500;

export type Quote =
  | { kind: 'forex'; bid: string; ask: string; tradeable: boolean; at: Date }
  | { kind: 'crypto'; last: string; at: Date };

export type CandleListener = (candle: FeedCandle) => void;
export type QuoteListener = (instrumentId: string, quote: Quote) => void;

// In process market data for the worker (spec 0002): the last 500 closed candles per series
// and the latest quote per instrument. The paper bot reads from here, not from the database.
export class MarketData {
  private readonly rings = new Map<string, FeedCandle[]>();
  private readonly quotes = new Map<string, Quote>();
  private readonly listeners = new Set<CandleListener>();
  private readonly quoteListeners = new Set<QuoteListener>();

  getQuote(instrumentId: string): Quote | undefined {
    return this.quotes.get(instrumentId);
  }

  // Listeners run synchronously on every price, so they must stay cheap (spec 0003).
  setQuote(instrumentId: string, quote: Quote): void {
    this.quotes.set(instrumentId, quote);
    for (const listener of this.quoteListeners) listener(instrumentId, quote);
  }

  onQuote(listener: QuoteListener): () => void {
    this.quoteListeners.add(listener);
    return () => this.quoteListeners.delete(listener);
  }

  // Newest `n` closed candles, oldest first.
  getCandles(instrumentId: string, timeframe: FeedTimeframe, n = RING_SIZE): FeedCandle[] {
    const ring = this.rings.get(seriesKey(instrumentId, timeframe)) ?? [];
    return ring.slice(-n);
  }

  onCandleClosed(listener: CandleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Replaces a series with candles loaded from the database (after backfill).
  load(instrumentId: string, timeframe: FeedTimeframe, candles: FeedCandle[]): void {
    this.rings.set(seriesKey(instrumentId, timeframe), candles.slice(-RING_SIZE));
  }

  // Adds a newly stored live candle (kept in time order) and tells listeners.
  add(candle: FeedCandle, announce: boolean): void {
    const key = seriesKey(candle.instrumentId, candle.timeframe);
    const ring = this.rings.get(key) ?? [];
    ring.push(candle);
    ring.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
    this.rings.set(key, ring);
    if (!announce) return;
    for (const listener of this.listeners) listener(candle);
  }
}
