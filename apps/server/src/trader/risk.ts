import {
  FEE_RATE,
  LEVERAGE,
  Money,
  SLIPPAGE,
  roundDownToStep,
  roundToTick,
  sideSign,
  type AssetClass,
  type FeedState,
  type Side,
  type SkipReason,
  type TrendBias,
} from '@trading/shared';

type Decimal = Money;

// Entry checks and sizing (spec 0003 AC-5). Pure, so the order of checks and the math are
// easy to test and backtests can reuse them.

export interface EntryCheckInput {
  botState: 'idle' | 'running' | 'killed';
  side: Side;
  allowShort: boolean;
  trend: TrendBias;
  feedState: FeedState | null;
  assetClass: AssetClass;
  // Forex only: OANDA's `tradeable` on the latest price. Null for crypto.
  tradeable: boolean | null;
  hasQuote: boolean;
  hasOpenPosition: boolean;
  openCount: number;
  maxOpenTrades: number;
  todayRealizedPnl: Decimal;
  dailyLossLimit: Decimal;
  hasConversionRate: boolean;
}

// Every check except sizing, in the fixed order of SKIP_REASONS. Null when all pass.
export function firstFailedCheck(i: EntryCheckInput): SkipReason | null {
  if (i.botState !== 'running') return 'bot_stopped';
  if (i.side === 'sell' && !i.allowShort) return 'direction_not_allowed';
  if ((i.side === 'buy' && i.trend !== 'bull') || (i.side === 'sell' && i.trend !== 'bear')) return 'trend_disagrees';
  if (i.assetClass === 'forex' && (i.feedState === 'closed' || i.tradeable === false)) return 'market_closed';
  if (i.feedState !== 'live' || !i.hasQuote) return 'feed_not_live';
  if (i.hasOpenPosition) return 'already_open';
  if (i.openCount >= i.maxOpenTrades) return 'max_open_trades';
  if (i.todayRealizedPnl.lte(i.dailyLossLimit.neg())) return 'daily_loss_halt';
  if (!i.hasConversionRate) return 'no_conversion_rate';
  return null;
}

export interface SizingInput {
  price: Decimal;
  side: Side;
  q2u: Decimal;
  assetClass: AssetClass;
  equity: Decimal;
  freeMargin: Decimal;
  stopLossPct: Decimal;
  takeProfitPct: Decimal;
  maxPositionSize: Decimal;
  riskPerTradePct: Decimal;
  minQty: Decimal;
  tickSize: Decimal;
}

export type SizingResult =
  | { ok: true; qty: Decimal; stopLoss: Decimal; takeProfit: Decimal }
  | { ok: false; reason: 'insufficient_margin' | 'size_below_min' };

const HUNDRED = new Money(100);
const ZERO = new Money(0);

export function sizeEntry(i: SizingInput): SizingResult {
  const sl = i.stopLossPct.div(HUNDRED);
  const tp = i.takeProfitPct.div(HUNDRED);
  const unitUsd = i.price.mul(i.q2u);
  // Loss per unit at the stop: the move, both fees, and the exit slippage.
  const lossPerUnit = unitUsd.mul(sl.plus(FEE_RATE[i.assetClass].mul(2)).plus(SLIPPAGE[i.assetClass]));
  if (unitUsd.lte(0) || lossPerUnit.lte(0)) return { ok: false, reason: 'size_below_min' };

  const raw = i.equity.mul(i.riskPerTradePct).div(HUNDRED).div(lossPerUnit);
  const cap1 = i.maxPositionSize.div(unitUsd);
  const cap2 = Money.max(i.freeMargin, ZERO).mul(LEVERAGE[i.assetClass]).div(unitUsd);
  const best = Money.min(raw, cap1, cap2);
  const qty = Money.max(best, ZERO).gt(0) ? roundDownToStep(best, i.minQty) : ZERO;
  if (qty.lt(i.minQty) || qty.lte(0)) {
    return { ok: false, reason: cap2.lte(raw) && cap2.lte(cap1) ? 'insufficient_margin' : 'size_below_min' };
  }

  const dir = sideSign(i.side);
  return {
    ok: true,
    qty,
    stopLoss: roundToTick(i.price.mul(new Money(1).minus(sl.mul(dir))), i.tickSize, 'nearest'),
    takeProfit: roundToTick(i.price.mul(new Money(1).plus(tp.mul(dir))), i.tickSize, 'nearest'),
  };
}

// Which exit (if any) the latest exit side price triggers. SL is checked before TP.
export function triggeredExit(
  side: Side,
  exitPrice: Decimal,
  stopLoss: Decimal | null,
  takeProfit: Decimal | null,
): 'stop_loss' | 'take_profit' | null {
  if (side === 'buy') {
    if (stopLoss && exitPrice.lte(stopLoss)) return 'stop_loss';
    if (takeProfit && exitPrice.gte(takeProfit)) return 'take_profit';
  } else {
    if (stopLoss && exitPrice.gte(stopLoss)) return 'stop_loss';
    if (takeProfit && exitPrice.lte(takeProfit)) return 'take_profit';
  }
  return null;
}
