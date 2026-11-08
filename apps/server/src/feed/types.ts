import type { FeedTimeframe } from '@trading/shared';

// A closed candle. Prices and volume stay decimal strings straight from the source.
export interface FeedCandle {
  instrumentId: string;
  timeframe: FeedTimeframe;
  openTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface TimeRange {
  start: Date;
  end: Date;
}

export const seriesKey = (instrumentId: string, timeframe: string) => `${instrumentId}:${timeframe}`;
