import { z } from 'zod';
import { feedTimeframeSchema } from './feeds.js';
import { calculateEMA, calculateMACD, calculateRSI } from './indicators.js';

// Registry of strategy kinds. Strategy.kind in the database must be one of these.
export const STRATEGY_KINDS = ['ema_rsi_macd'] as const;
export type StrategyKind = (typeof STRATEGY_KINDS)[number];

export function isStrategyKind(value: string): value is StrategyKind {
  return (STRATEGY_KINDS as readonly string[]).includes(value);
}

// Strategy.params for `ema_rsi_macd` (spec 0003). Indicator settings are plain numbers.
export const emaRsiMacdParamsSchema = z.object({
  emaFast: z.number().int().positive(),
  emaMid: z.number().int().positive(),
  emaSlow: z.number().int().positive(),
  rsiPeriod: z.number().int().positive(),
  rsiLongMax: z.number(),
  rsiShortMin: z.number(),
  zMax: z.number().positive(),
  lookback: z.number().int().min(35),
  trendTimeframe: feedTimeframeSchema,
  trendRsiLongMax: z.number(),
  trendRsiShortMin: z.number(),
  allowShort: z.boolean(),
});
export type EmaRsiMacdParams = z.infer<typeof emaRsiMacdParamsSchema>;

// Your browser engine's Strong rule (apps/web PredictorCard) and its 1h bias rule.
export const DEFAULT_EMA_RSI_MACD_PARAMS: Omit<EmaRsiMacdParams, 'allowShort'> = {
  emaFast: 9,
  emaMid: 21,
  emaSlow: 50,
  rsiPeriod: 14,
  rsiLongMax: 65,
  rsiShortMin: 35,
  zMax: 1.5,
  lookback: 200,
  trendTimeframe: '1h',
  trendRsiLongMax: 72,
  trendRsiShortMin: 28,
};

export type TrendBias = 'bull' | 'bear' | 'neutral';

export interface SignalIndicators {
  ema9: number;
  ema21: number;
  ema50: number;
  rsi: number;
  macdHist: number;
  z: number;
  trend: TrendBias;
}

export interface StrategyEvaluation {
  // The 15m Strong signal. The trend filter is applied by the entry checks, not here, because
  // exits ignore it.
  side: 'buy' | 'sell' | null;
  indicators: SignalIndicators | null;
}

// (last − mean) / population stdDev. Null when every close is equal.
export function zScore(closes: number[]): number | null {
  if (closes.length === 0) return null;
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const variance = closes.reduce((a, x) => a + (x - mean) ** 2, 0) / closes.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return null;
  return (closes[closes.length - 1]! - mean) / sd;
}

export function trendBias(closes: number[], p: EmaRsiMacdParams): TrendBias {
  const fast = calculateEMA(closes, p.emaFast);
  const mid = calculateEMA(closes, p.emaMid);
  const slow = calculateEMA(closes, p.emaSlow);
  const rsi = calculateRSI(closes, p.rsiPeriod);
  const { hist } = calculateMACD(closes);
  if (fast > mid && mid > slow && hist > 0 && rsi < p.trendRsiLongMax) return 'bull';
  if (fast < mid && mid < slow && hist < 0 && rsi > p.trendRsiShortMin) return 'bear';
  return 'neutral';
}

// Pure: the same closes always give the same answer, so backtests (feature 6) can replay it.
// closes15m and closesTrend are oldest first and already limited to candles closed by now.
export function evaluateEmaRsiMacd(closes15m: number[], closesTrend: number[], p: EmaRsiMacdParams): StrategyEvaluation {
  if (closes15m.length < p.lookback || closesTrend.length < p.lookback) return { side: null, indicators: null };
  const closes = closes15m.slice(-p.lookback);
  const z = zScore(closes);
  if (z === null) return { side: null, indicators: null };

  const ema9 = calculateEMA(closes, p.emaFast);
  const ema21 = calculateEMA(closes, p.emaMid);
  const ema50 = calculateEMA(closes, p.emaSlow);
  const rsi = calculateRSI(closes, p.rsiPeriod);
  const { hist } = calculateMACD(closes);
  const trend = trendBias(closesTrend.slice(-p.lookback), p);
  const indicators: SignalIndicators = { ema9, ema21, ema50, rsi, macdHist: hist, z, trend };

  if (ema9 > ema21 && ema21 > ema50 && hist > 0 && rsi < p.rsiLongMax && z < p.zMax) return { side: 'buy', indicators };
  if (ema9 < ema21 && ema21 < ema50 && hist < 0 && rsi > p.rsiShortMin && z > -p.zMax) return { side: 'sell', indicators };
  return { side: null, indicators };
}
