// The 12 pairs the feed collects (spec 0002), matching the UI's list in apps/web/src/App.jsx.
export type Venue = 'binance' | 'oanda';

export interface InstrumentDef {
  symbol: string;
  venue: Venue;
  venueSymbol: string;
  assetClass: 'crypto' | 'forex';
  baseAsset: string;
  quoteAsset: string;
}

const crypto = (base: string): InstrumentDef => ({
  symbol: `${base}USDT`,
  venue: 'binance',
  venueSymbol: `${base}USDT`,
  assetClass: 'crypto',
  baseAsset: base,
  quoteAsset: 'USDT',
});

const forex = (base: string, quote: string): InstrumentDef => ({
  symbol: `${base}${quote}`,
  venue: 'oanda',
  venueSymbol: `${base}_${quote}`,
  assetClass: 'forex',
  baseAsset: base,
  quoteAsset: quote,
});

export const INSTRUMENTS: readonly InstrumentDef[] = [
  crypto('BTC'),
  crypto('ETH'),
  crypto('SOL'),
  crypto('BNB'),
  crypto('XRP'),
  forex('EUR', 'USD'),
  forex('GBP', 'USD'),
  forex('USD', 'JPY'),
  forex('AUD', 'USD'),
  forex('USD', 'CAD'),
  forex('EUR', 'GBP'),
  forex('GBP', 'JPY'),
];

// Overwritten from the venue at every worker start.
export const PLACEHOLDER_STEP = '0.00000001';
