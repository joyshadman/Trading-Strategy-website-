import { describe, expect, it } from 'vitest';
import { buildCandle } from './aggregate.js';
import { parseKlineMessage } from './binance.js';
import { lastClosedOpenTime, mergeRanges, retentionStart } from './candleStore.js';
import { LineBuffer, parseOandaTime, parsePricingLine, tickFromPrecision } from './oanda.js';
import { isStale } from './status.js';
import type { FeedCandle } from './types.js';

const T0 = Date.UTC(2026, 9, 27, 10, 0);
const m = (minute: number, o: string, h: string, l: string, c: string, v: string): FeedCandle => ({
  instrumentId: 'i1',
  timeframe: '1m',
  openTime: new Date(T0 + minute * 60_000),
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

describe('buildCandle (5m, 15m, 1h from 1m)', () => {
  it('takes first open, max high, min low, last close, summed volume', () => {
    const ones = [m(2, '3', '4', '2', '3.5', '1.1'), m(0, '1', '2', '0.5', '1.5', '0.2'), m(4, '5', '9', '4', '6', '0.7')];
    expect(buildCandle(ones, '5m', T0)).toEqual({
      instrumentId: 'i1',
      timeframe: '5m',
      openTime: new Date(T0),
      open: '1',
      high: '9',
      low: '0.5',
      close: '6',
      volume: '2',
    });
  });

  it('ignores minutes outside the bucket and returns null for an empty bucket', () => {
    expect(buildCandle([m(5, '1', '1', '1', '1', '1')], '5m', T0)).toBeNull();
  });
});

describe('time windows', () => {
  it('finds the last closed open time and the retention start on the grid', () => {
    const now = T0 + 7 * 60_000 + 30_000; // 10:07:30
    expect(lastClosedOpenTime('1m', now).toISOString()).toBe('2026-10-27T10:06:00.000Z');
    expect(lastClosedOpenTime('5m', now).toISOString()).toBe('2026-10-27T10:00:00.000Z');
    expect(retentionStart('1m', now).getTime() % 60_000).toBe(0);
  });

  it('merges gap ranges that are close together', () => {
    const r = (a: number, b: number) => ({ start: new Date(a), end: new Date(b) });
    expect(mergeRanges([r(0, 10), r(15, 20), r(100, 110)], 10)).toEqual([r(0, 20), r(100, 110)]);
  });
});

describe('binance kline messages', () => {
  it('parses a closed kline', () => {
    const raw = JSON.stringify({ stream: 'btcusdt@kline_1m', data: { e: 'kline', s: 'BTCUSDT', k: { t: T0, o: '1.0', h: '2.0', l: '0.5', c: '1.5', v: '3.25', x: true } } });
    expect(parseKlineMessage(raw)).toMatchObject({ symbol: 'BTCUSDT', closed: true, close: '1.5', volume: '3.25', openTime: new Date(T0) });
  });

  it('ignores other messages', () => {
    expect(parseKlineMessage(JSON.stringify({ result: null, id: 1 }))).toBeNull();
  });
});

describe('oanda', () => {
  it('cuts nanosecond times to milliseconds', () => {
    expect(parseOandaTime('2026-10-27T10:00:00.123456789Z').toISOString()).toBe('2026-10-27T10:00:00.123Z');
  });

  it('turns displayPrecision into a tick size (JPY pairs have 3)', () => {
    expect(tickFromPrecision(5)).toBe('0.00001');
    expect(tickFromPrecision(3)).toBe('0.001');
  });

  it('reassembles stream lines split across chunks', () => {
    const buf = new LineBuffer();
    expect(buf.push('{"type":"HEARTBEAT","time":"2026-10-27T10:00:00.000000000Z"}\n{"type":"PRI')).toHaveLength(1);
    const lines = buf.push('CE","instrument":"EUR_USD","time":"2026-10-27T10:00:01.000000000Z","tradeable":false,"bids":[{"price":"1.1"}],"asks":[{"price":"1.2"}]}\n');
    expect(lines).toHaveLength(1);
    expect(parsePricingLine(lines[0]!)).toMatchObject({ type: 'PRICE', instrument: 'EUR_USD', bid: '1.1', ask: '1.2', tradeable: false });
  });
});

describe('isStale', () => {
  const now = T0 + 120_000;
  const ago = (ms: number) => new Date(now - ms);

  it('flags crypto after 30 seconds without a message', () => {
    expect(isStale('binance', { status: 'live', lastTickAt: ago(31_000) }, null, now)).toBe(true);
    expect(isStale('binance', { status: 'live', lastTickAt: ago(29_000) }, null, now)).toBe(false);
  });

  it('counts the OANDA heartbeat as a sign of life for forex', () => {
    expect(isStale('oanda', { status: 'live', lastTickAt: ago(90_000) }, ago(5_000), now)).toBe(false);
    expect(isStale('oanda', { status: 'live', lastTickAt: ago(90_000) }, ago(70_000), now)).toBe(true);
  });

  it('pauses while backfilling, closed, or in error', () => {
    for (const status of ['backfilling', 'closed', 'error'] as const) {
      expect(isStale('binance', { status, lastTickAt: ago(600_000) }, null, now)).toBe(false);
    }
  });
});
