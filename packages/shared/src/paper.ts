import { Decimal } from 'decimal.js';
import { Money, toDecimal } from './decimal.js';

// The paper trading cost model and fixed lists (spec 0003). Pure, so backtests reuse it.

export const ORDER_REASONS = ['entry', 'stop_loss', 'take_profit', 'opposite_signal', 'kill', 'manual'] as const;
export type OrderReason = (typeof ORDER_REASONS)[number];
export type CloseReason = Exclude<OrderReason, 'entry'>;

// In the order the entry checks run: the first failure is the one saved.
export const SKIP_REASONS = [
  'bot_stopped',
  'direction_not_allowed',
  'trend_disagrees',
  'feed_not_live',
  'market_closed',
  'already_open',
  'max_open_trades',
  'daily_loss_halt',
  'no_conversion_rate',
  'insufficient_margin',
  'size_below_min',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type AssetClass = 'crypto' | 'forex';
export type Side = 'buy' | 'sell';

export const FEE_RATE: Record<AssetClass, Decimal> = { crypto: new Money('0.001'), forex: new Money('0') };
export const SLIPPAGE: Record<AssetClass, Decimal> = { crypto: new Money('0.0005'), forex: new Money('0') };
export const LEVERAGE: Record<AssetClass, Decimal> = { crypto: new Money('1'), forex: new Money('20') };

export const MARK_INTERVAL_MS = 5_000;
export const EQUITY_SNAPSHOT_MS = 15 * 60_000;

// The latest price for an instrument, as the feed keeps it (decimal strings).
export type PaperQuote = { kind: 'crypto'; last: string } | { kind: 'forex'; bid: string; ask: string };

export const oppositeSide = (side: Side): Side => (side === 'buy' ? 'sell' : 'buy');
export const sideSign = (side: Side): number => (side === 'buy' ? 1 : -1);

export function roundToTick(price: Decimal, tick: Decimal, mode: 'nearest' | 'up' | 'down'): Decimal {
  const steps = price.div(tick);
  const whole = mode === 'up' ? steps.ceil() : mode === 'down' ? steps.floor() : steps.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
  return whole.mul(tick);
}

// The price a market order of `side` gets right now. Crypto: last moved by the slippage against
// you, rounded to the tick against you. Forex: buys at the ask, sells at the bid.
export function paperFillPrice(quote: PaperQuote, side: Side, tick: Decimal): Decimal {
  if (quote.kind === 'forex') return toDecimal(side === 'buy' ? quote.ask : quote.bid);
  const last = toDecimal(quote.last);
  const slip = SLIPPAGE.crypto;
  return side === 'buy' ? roundToTick(last.mul(slip.plus(1)), tick, 'up') : roundToTick(last.mul(new Money(1).minus(slip)), tick, 'down');
}

// The price an open position would close at, without slippage (its mark, and the SL/TP trigger).
export function exitSidePrice(quote: PaperQuote, positionSide: Side): Decimal {
  if (quote.kind === 'crypto') return toDecimal(quote.last);
  return toDecimal(positionSide === 'buy' ? quote.bid : quote.ask);
}
