import { describe, expect, it } from 'vitest';
import { Money } from './decimal.js';
import { exitSidePrice, paperFillPrice, roundToTick } from './paper.js';
import { DEFAULT_EMA_RSI_MACD_PARAMS, evaluateEmaRsiMacd, trendBias, zScore, type EmaRsiMacdParams } from './strategies.js';

const params: EmaRsiMacdParams = { ...DEFAULT_EMA_RSI_MACD_PARAMS, allowShort: true };
// A loose copy for wiring tests: a smooth accelerating series has RSI 100 and a high zScore.
const loose: EmaRsiMacdParams = { ...params, rsiLongMax: 101, rsiShortMin: -1, zMax: 5, trendRsiLongMax: 101, trendRsiShortMin: -1 };

const rising = (n: number) => Array.from({ length: n }, (_, i) => 100 + (i * i) / 400);
const falling = (n: number) => rising(n).map((x) => 300 - x);

describe('evaluateEmaRsiMacd (spec 0003 AC-2)', () => {
  it('gives buy when the stack, MACD, RSI, and zScore all agree', () => {
    const r = evaluateEmaRsiMacd(rising(200), rising(200), loose);
    expect(r.side).toBe('buy');
    expect(r.indicators?.trend).toBe('bull');
  });

  it('gives sell on the mirror image', () => {
    const r = evaluateEmaRsiMacd(falling(200), falling(200), loose);
    expect(r.side).toBe('sell');
    expect(r.indicators?.trend).toBe('bear');
  });

  it('rejects an overbought rise with the default RSI cap', () => {
    expect(evaluateEmaRsiMacd(rising(200), rising(200), params).side).toBeNull();
  });

  it('needs the full lookback on both timeframes', () => {
    expect(evaluateEmaRsiMacd(rising(199), rising(200), loose)).toEqual({ side: null, indicators: null });
    expect(evaluateEmaRsiMacd(rising(200), rising(199), loose)).toEqual({ side: null, indicators: null });
  });

  it('gives no signal on a flat series (stdDev 0)', () => {
    expect(evaluateEmaRsiMacd(Array(200).fill(5), rising(200), loose)).toEqual({ side: null, indicators: null });
  });

  it('is deterministic and only looks at the last `lookback` closes', () => {
    const long = [...falling(300), ...rising(200)];
    expect(evaluateEmaRsiMacd(long, rising(200), loose)).toEqual(evaluateEmaRsiMacd(rising(200), rising(200), loose));
  });

  it('trendBias is neutral when the stack is mixed', () => {
    expect(trendBias([...rising(150), ...falling(50)], params)).not.toBe('bull');
  });

  it('zScore is null for an empty or flat series', () => {
    expect(zScore([])).toBeNull();
    expect(zScore([1, 1, 1])).toBeNull();
    expect(zScore([1, 2, 3])).toBeCloseTo(1.2247, 4);
  });
});

describe('paper fill model (spec 0003 AC-6)', () => {
  const tick = new Money('0.01');

  it('moves crypto 0.05% against you and rounds to the tick against you', () => {
    expect(paperFillPrice({ kind: 'crypto', last: '100000' }, 'buy', tick).toFixed()).toBe('100050');
    expect(paperFillPrice({ kind: 'crypto', last: '100.003' }, 'buy', tick).toFixed()).toBe('100.06');
    expect(paperFillPrice({ kind: 'crypto', last: '100.003' }, 'sell', tick).toFixed()).toBe('99.95');
  });

  it('fills forex buys at the ask and sells at the bid', () => {
    const q = { kind: 'forex' as const, bid: '1.10000', ask: '1.10012' };
    expect(paperFillPrice(q, 'buy', tick).toFixed()).toBe('1.10012');
    expect(paperFillPrice(q, 'sell', tick).toFixed()).toBe('1.1');
    expect(exitSidePrice(q, 'buy').toFixed()).toBe('1.1');
    expect(exitSidePrice(q, 'sell').toFixed()).toBe('1.10012');
  });

  it('rounds to the nearest tick half to even', () => {
    expect(roundToTick(new Money('1.005'), tick, 'nearest').toFixed()).toBe('1');
    expect(roundToTick(new Money('1.015'), tick, 'nearest').toFixed()).toBe('1.02');
  });
});
