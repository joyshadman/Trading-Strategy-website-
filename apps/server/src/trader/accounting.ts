import { FEE_RATE, LEVERAGE, Money, sideSign, type AssetClass, type Side } from '@trading/shared';

type Decimal = Money;

// Paper accounting in USD (spec 0003). Pure functions; every value is a Decimal.

const ONE = new Money(1);
export const MONEY_DP = 12;

// What the database stores (NUMERIC(30,12)), so memory and rows always agree.
export const stored = (d: Decimal): Decimal => d.toDecimalPlaces(MONEY_DP, Money.ROUND_HALF_EVEN);

// Mid price of a forex pair by symbol (`GBPUSD`), or undefined when unknown.
export type MidLookup = (symbol: string) => Decimal | undefined;

// Quote currency to USD. USDT counts as USD. Others use C/USD's mid, or 1 / USD/C's mid.
export function quoteToUsd(quoteAsset: string, mid: MidLookup): Decimal | undefined {
  if (quoteAsset === 'USD' || quoteAsset === 'USDT') return ONE;
  const direct = mid(`${quoteAsset}USD`);
  if (direct && direct.gt(0)) return direct;
  const inverse = mid(`USD${quoteAsset}`);
  if (inverse && inverse.gt(0)) return ONE.div(inverse);
  return undefined;
}

// Price move in USD before fees: (exit − entry) × dir × qty × q2u.
export function grossPnlUsd(entry: Decimal, exit: Decimal, side: Side, qty: Decimal, q2u: Decimal): Decimal {
  return exit.minus(entry).mul(sideSign(side)).mul(qty).mul(q2u);
}

// Fee for one fill, in the quote currency (USDT for crypto; 0 for forex).
export function feeInQuote(price: Decimal, qty: Decimal, assetClass: AssetClass): Decimal {
  return FEE_RATE[assetClass].mul(price).mul(qty);
}

export function marginUsd(qty: Decimal, entryPrice: Decimal, entryQ2u: Decimal, assetClass: AssetClass): Decimal {
  return qty.mul(entryPrice).mul(entryQ2u).div(LEVERAGE[assetClass]);
}

// Unrealized PnL: the move at the mark, net of the fees paid so far (the exit fee isn't estimated).
export function unrealizedPnlUsd(
  entry: Decimal,
  mark: Decimal,
  side: Side,
  qty: Decimal,
  q2u: Decimal,
  feesPaid: Decimal,
): Decimal {
  return grossPnlUsd(entry, mark, side, qty, q2u).minus(feesPaid);
}

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
