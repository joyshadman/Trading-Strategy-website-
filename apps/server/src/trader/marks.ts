import { EQUITY_SNAPSHOT_MS, exitSidePrice, type Money, type PaperQuote, type Side } from '@trading/shared';
import { stored, unrealizedPnlUsd } from './accounting.js';

type Decimal = Money;

// Marks and snapshots (spec 0003 AC-14). Pure helpers; the trader runs them in its queue.

export interface MarkInput {
  side: Side;
  qty: Decimal;
  entryPrice: Decimal;
  fees: Decimal;
  // Current quote to USD, or the entry rate when no live rate exists (after a restart).
  q2u: Decimal;
}

// Mark = the exit side price without slippage; PnL in USD net of the fees paid so far.
export function markPosition(p: MarkInput, quote: PaperQuote): { markPrice: Decimal; unrealizedPnl: Decimal } {
  const markPrice = exitSidePrice(quote, p.side);
  return { markPrice, unrealizedPnl: stored(unrealizedPnlUsd(p.entryPrice, markPrice, p.side, p.qty, p.q2u, p.fees)) };
}

// The next quarter hour boundary (00, 15, 30, 45 UTC) strictly after `now`.
export function nextSnapshotAt(now: number): number {
  return Math.floor(now / EQUITY_SNAPSHOT_MS) * EQUITY_SNAPSHOT_MS + EQUITY_SNAPSHOT_MS;
}
