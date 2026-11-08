import { z } from 'zod';
import type { Timeframe } from './timeframes.js';

// Timeframes the market data feed stores (spec 0002). 1m is live; the rest are built from 1m.
export const FEED_TIMEFRAMES = ['1m', '5m', '15m', '1h'] as const satisfies readonly Timeframe[];
export type FeedTimeframe = (typeof FEED_TIMEFRAMES)[number];
export const feedTimeframeSchema = z.enum(FEED_TIMEFRAMES);

const DAY_MS = 86_400_000;

// How far back candles are kept (and backfilled), per timeframe.
export const RETENTION_MS: Record<FeedTimeframe, number> = {
  '1m': 30 * DAY_MS,
  '5m': 90 * DAY_MS,
  '15m': 90 * DAY_MS,
  '1h': 90 * DAY_MS,
};

export const FEED_STATES = ['backfilling', 'live', 'stale', 'closed', 'error'] as const;
export const feedStateSchema = z.enum(FEED_STATES);
export type FeedState = z.infer<typeof feedStateSchema>;
