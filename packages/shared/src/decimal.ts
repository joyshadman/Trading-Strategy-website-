import { Decimal } from 'decimal.js';
import { z } from 'zod';

// One decimal type everywhere. Prisma's Decimal on the server is the same library.
// Banker's rounding (half to even) so repeated fee and P&L rounding doesn't drift one way.
export const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export type Money = Decimal;

export const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

// Money and sizes cross the wire as strings, never JSON numbers.
export const decimalString = z.string().regex(DECIMAL_STRING_RE, 'must be a decimal string');

export function toDecimal(value: string | Decimal): Decimal {
  if (typeof value === 'string' && !DECIMAL_STRING_RE.test(value)) {
    throw new Error(`not a decimal string: ${value}`);
  }
  return new Money(value);
}

export function toDecimalString(value: Decimal): string {
  return value.toFixed();
}

// For indicator math only (EMA, RSI, MACD take plain numbers). Never use it for money.
export function toIndicatorNumber(value: string): number {
  return toDecimal(value).toNumber();
}

// Order sizes round DOWN to the instrument's minimum step, so we never exceed what was sized.
export function roundDownToStep(qty: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) throw new Error('step must be positive');
  return qty.div(step).floor().mul(step);
}
