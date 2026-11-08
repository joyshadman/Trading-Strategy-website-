import { z } from 'zod';

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const timeframeSchema = z.enum(TIMEFRAMES);

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

// Candle times are the UTC open time, aligned to the timeframe.
export function alignToTimeframe(at: Date, timeframe: Timeframe): Date {
  const ms = TIMEFRAME_MS[timeframe];
  return new Date(Math.floor(at.getTime() / ms) * ms);
}
