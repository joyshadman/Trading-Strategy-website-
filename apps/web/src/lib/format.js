import { Money, toDecimal } from '@trading/shared';

// Every money value is formatted from its decimal string, never through float math
// (spec 0004 AC-9). Times are always UTC.

const EMPTY = 'n/a';

// "-0.00" reads as a loss that isn't one.
const noNegativeZero = (s) => (/^-0(\.0+)?$/.test(s) ? s.slice(1) : s);

// Digits after the point with trailing zeros trimmed: "0.010" gives 2, "1" gives 0.
export function decimalsOf(step) {
  if (!step) return null;
  const frac = String(step).split('.')[1] ?? '';
  return frac.replace(/0+$/, '').length;
}

// USD to 2 decimals, half even (Money's rounding).
export function fmtUsd(value) {
  if (value == null) return EMPTY;
  return noNegativeZero(toDecimal(value).toFixed(2));
}

// A PnL with its sign, for gains and losses side by side.
export function fmtPnl(value) {
  if (value == null) return EMPTY;
  const s = fmtUsd(value);
  return toDecimal(value).gt(0) && s !== '0.00' ? `+${s}` : s;
}

// Prices and quantities are truncated to the instrument's step decimals, never rounded up.
function truncated(value, step) {
  if (value == null) return EMPTY;
  const dp = decimalsOf(step);
  const d = toDecimal(value);
  return noNegativeZero(dp == null ? d.toFixed() : d.toFixed(dp, Money.ROUND_DOWN));
}

export const fmtPrice = (value, tickSize) => truncated(value, tickSize);
export const fmtQty = (value, minQty) => truncated(value, minQty);

// YYYY-MM-DD HH:mm:ss UTC
export function fmtUtc(value) {
  if (value == null) return EMPTY;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return EMPTY;
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export const pnlTone = (value) => {
  if (value == null) return 'text-slate-400';
  const d = toDecimal(value);
  return d.gt(0) ? 'text-emerald-400' : d.lt(0) ? 'text-rose-400' : 'text-slate-300';
};

const LABELS = {
  stop_loss: 'stop loss',
  take_profit: 'take profit',
  opposite_signal: 'opposite signal',
  kill: 'kill',
  manual: 'manual',
  enable_strategy: 'enable',
  disable_strategy: 'disable',
  close_position: 'close',
};

// snake_case codes from the API, in plain words.
export const label = (code) => (code ? (LABELS[code] ?? code.replaceAll('_', ' ')) : EMPTY);
