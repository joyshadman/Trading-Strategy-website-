import { describe, expect, it } from 'vitest';
import { Money } from '@trading/shared';
import { grossPnlUsd, marginUsd, quoteToUsd, unrealizedPnlUsd } from './accounting.js';
import { markPosition, nextSnapshotAt } from './marks.js';
import { firstFailedCheck, sizeEntry, triggeredExit, type EntryCheckInput, type SizingInput } from './risk.js';

const m = (v: string | number) => new Money(v);

describe('sizeEntry (spec 0003 AC-5)', () => {
  const crypto: SizingInput = {
    price: m('100000'),
    side: 'buy',
    q2u: m(1),
    assetClass: 'crypto',
    equity: m('10000'),
    freeMargin: m('10000'),
    stopLossPct: m('1.4'),
    takeProfitPct: m('2.8'),
    maxPositionSize: m('3000'),
    riskPerTradePct: m('1'),
    minQty: m('0.00001'),
    tickSize: m('0.01'),
  };

  it('caps crypto at maxPositionSize notional and sets SL/TP from the entry', () => {
    const r = sizeEntry(crypto);
    expect(r).toEqual({ ok: true, qty: m('0.03'), stopLoss: m('98600'), takeProfit: m('102800') });
  });

  it('includes both fees and the exit slippage in the risk when uncapped', () => {
    const r = sizeEntry({ ...crypto, maxPositionSize: m('1000000') });
    // loss per unit = 100000 × (0.014 + 0.002 + 0.0005) = 1650 → 100 / 1650 = 0.0606…, step 0.00001
    expect(r.ok && r.qty.toFixed()).toBe('0.0606');
  });

  const eurusd: SizingInput = {
    ...crypto,
    price: m('1.1'),
    assetClass: 'forex',
    stopLossPct: m('0.09'),
    takeProfitPct: m('0.18'),
    maxPositionSize: m('150000'),
    minQty: m('1'),
    tickSize: m('0.00001'),
  };

  it('sizes forex at 1% risk: 100 / (1.1 × 0.0009) units, rounded down', () => {
    expect(sizeEntry(eurusd)).toEqual({ ok: true, qty: m('101010'), stopLoss: m('1.09901'), takeProfit: m('1.10198') });
  });

  it('puts a short stop above the entry', () => {
    const r = sizeEntry({ ...eurusd, side: 'sell' });
    expect(r.ok && [r.stopLoss.toFixed(), r.takeProfit.toFixed()]).toEqual(['1.10099', '1.09802']);
  });

  it('shrinks to free margin × leverage', () => {
    const r = sizeEntry({ ...eurusd, freeMargin: m('1000') });
    expect(r.ok && r.qty.toFixed()).toBe('18181');
  });

  it('reports insufficient_margin when margin is the binding cap', () => {
    expect(sizeEntry({ ...eurusd, freeMargin: m('-50') })).toEqual({ ok: false, reason: 'insufficient_margin' });
  });

  it('reports size_below_min when the step is bigger than the size', () => {
    expect(sizeEntry({ ...crypto, minQty: m('1') })).toEqual({ ok: false, reason: 'size_below_min' });
  });
});

describe('firstFailedCheck (spec 0003 AC-5 order)', () => {
  const pass: EntryCheckInput = {
    botState: 'running',
    side: 'buy',
    allowShort: false,
    trend: 'bull',
    feedState: 'live',
    assetClass: 'crypto',
    tradeable: null,
    hasQuote: true,
    hasOpenPosition: false,
    openCount: 0,
    maxOpenTrades: 3,
    todayRealizedPnl: m(0),
    dailyLossLimit: m(300),
    hasConversionRate: true,
  };

  it('passes when everything is fine', () => expect(firstFailedCheck(pass)).toBeNull());

  it('reports the first failure in the fixed order', () => {
    expect(firstFailedCheck({ ...pass, botState: 'idle', side: 'sell', trend: 'bear' })).toBe('bot_stopped');
    expect(firstFailedCheck({ ...pass, side: 'sell', trend: 'bear', openCount: 9 })).toBe('direction_not_allowed');
    expect(firstFailedCheck({ ...pass, trend: 'neutral', feedState: 'stale' })).toBe('trend_disagrees');
    expect(firstFailedCheck({ ...pass, feedState: 'stale', hasOpenPosition: true })).toBe('feed_not_live');
    expect(firstFailedCheck({ ...pass, assetClass: 'forex', tradeable: false })).toBe('market_closed');
    expect(firstFailedCheck({ ...pass, hasOpenPosition: true, openCount: 3 })).toBe('already_open');
    expect(firstFailedCheck({ ...pass, openCount: 3 })).toBe('max_open_trades');
    expect(firstFailedCheck({ ...pass, todayRealizedPnl: m('-300') })).toBe('daily_loss_halt');
    expect(firstFailedCheck({ ...pass, todayRealizedPnl: m('-299.99') })).toBeNull();
    expect(firstFailedCheck({ ...pass, hasConversionRate: false })).toBe('no_conversion_rate');
  });
});

describe('triggeredExit (spec 0003 AC-7)', () => {
  it('checks a long against the exit side price, SL before TP', () => {
    expect(triggeredExit('buy', m('98600'), m('98600'), m('102800'))).toBe('stop_loss');
    expect(triggeredExit('buy', m('102800'), m('98600'), m('102800'))).toBe('take_profit');
    expect(triggeredExit('buy', m('100000'), m('98600'), m('102800'))).toBeNull();
  });

  it('checks a short the other way round', () => {
    expect(triggeredExit('sell', m('1.10099'), m('1.10099'), m('1.09802'))).toBe('stop_loss');
    expect(triggeredExit('sell', m('1.098'), m('1.10099'), m('1.09802'))).toBe('take_profit');
  });
});

describe('accounting (spec 0003 AC-14)', () => {
  const mids: Record<string, string> = { USDJPY: '150', GBPUSD: '1.25', USDCAD: '1.4' };
  const mid = (s: string) => (mids[s] ? m(mids[s]) : undefined);

  it('converts quote currencies to USD with the live mids; USDT is USD', () => {
    expect(quoteToUsd('USDT', mid)?.toFixed()).toBe('1');
    expect(quoteToUsd('USD', mid)?.toFixed()).toBe('1');
    expect(quoteToUsd('GBP', mid)?.toFixed()).toBe('1.25');
    expect(quoteToUsd('JPY', mid)?.mul(150).toFixed()).toBe('1');
    expect(quoteToUsd('CHF', mid)).toBeUndefined();
  });

  it('computes PnL in USD with direction', () => {
    expect(grossPnlUsd(m('150'), m('151'), 'buy', m('1000'), m(1).div(150)).mul(150).toFixed()).toBe('1000');
    expect(grossPnlUsd(m('1.1'), m('1.09'), 'sell', m('10000'), m(1)).toFixed()).toBe('100');
    expect(unrealizedPnlUsd(m('100'), m('101'), 'buy', m('2'), m(1), m('0.2')).toFixed()).toBe('1.8');
  });

  it('margin is notional over leverage', () => {
    expect(marginUsd(m('101010'), m('1.1'), m(1), 'forex').toFixed()).toBe('5555.55');
    expect(marginUsd(m('0.03'), m('100000'), m(1), 'crypto').toFixed()).toBe('3000');
  });

  it('marks at the exit side price', () => {
    const r = markPosition({ side: 'buy', qty: m('10000'), entryPrice: m('1.1'), fees: m(0), q2u: m(1) }, { kind: 'forex', bid: '1.101', ask: '1.1012' });
    expect([r.markPrice.toFixed(), r.unrealizedPnl.toFixed()]).toEqual(['1.101', '10']);
  });

  it('schedules snapshots on the next quarter hour', () => {
    expect(new Date(nextSnapshotAt(Date.UTC(2026, 9, 28, 10, 7, 30))).toISOString()).toBe('2026-10-28T10:15:00.000Z');
    expect(new Date(nextSnapshotAt(Date.UTC(2026, 9, 28, 10, 15))).toISOString()).toBe('2026-10-28T10:30:00.000Z');
  });
});
