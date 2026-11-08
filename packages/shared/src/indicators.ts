// Indicator math shared by the browser UI and the bot, so both compute identical signals.
// Inputs are plain numbers: indicator values are for signals and display, never money.

export const calculateEMA = (data: number[], period: number): number => {
  if (data.length < period) return data[data.length - 1] ?? 0;
  const alpha = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i]! * alpha + ema * (1 - alpha);
  }
  return ema;
};

export const calculateEMASeries = (data: number[], period: number): number[] => {
  if (data.length === 0) return [];
  const alpha = 2 / (period + 1);
  const seedLen = Math.min(period, data.length);
  let ema = data.slice(0, seedLen).reduce((a, b) => a + b, 0) / seedLen;
  const out = new Array<number>(data.length);
  for (let i = 0; i < seedLen; i++) out[i] = ema;
  for (let i = seedLen; i < data.length; i++) {
    ema = data[i]! * alpha + ema * (1 - alpha);
    out[i] = ema;
  }
  return out;
};

export const calculateRSI = (data: number[], period = 14): number => {
  if (data.length <= period) return 50;
  // Wilder-style RSI over the last `period` deltas.
  let gains = 0;
  let losses = 0;
  const start = Math.max(1, data.length - period);
  for (let i = start; i < data.length; i++) {
    const diff = data[i]! - data[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};

export interface Macd {
  line: number;
  signal: number;
  hist: number;
}

export const calculateMACD = (data: number[]): Macd => {
  // Standard MACD(12,26,9): MACD line = EMA12 - EMA26; Signal = EMA9(MACD line)
  if (data.length < 35) return { line: 0, signal: 0, hist: 0 };
  const ema12 = calculateEMASeries(data, 12);
  const ema26 = calculateEMASeries(data, 26);
  const macdSeries = data.map((_, i) => ema12[i]! - ema26[i]!);
  const signalSeries = calculateEMASeries(macdSeries, 9);
  const macdLine = macdSeries[macdSeries.length - 1] ?? 0;
  const signalLine = signalSeries[signalSeries.length - 1] ?? 0;
  return { line: macdLine, signal: signalLine, hist: macdLine - signalLine };
};
