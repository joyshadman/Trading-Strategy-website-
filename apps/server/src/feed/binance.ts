import type { Logger } from 'pino';
import WebSocket from 'ws';
import { TIMEFRAME_MS, type FeedTimeframe } from '@trading/shared';
import { getJson, HttpError } from './http.js';
import type { FeedCandle, TimeRange } from './types.js';

const REST = 'https://api.binance.com';
const STREAM = 'wss://stream.binance.com:9443/stream';
export const BINANCE_BLOCKED = 'Binance is not available from your network';

// Raw kline row: [openTime, open, high, low, close, volume, closeTime, ...]
type KlineRow = [number, string, string, string, string, string, number, ...unknown[]];

export interface KlineEvent {
  symbol: string;
  openTime: Date;
  closed: boolean;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

function mapError(err: unknown): never {
  if (err instanceof HttpError && err.status === 451) throw new HttpError(451, BINANCE_BLOCKED);
  throw err;
}

export async function fetchKlines(
  venueSymbol: string,
  instrumentId: string,
  timeframe: FeedTimeframe,
  range: TimeRange,
): Promise<FeedCandle[]> {
  const url = `${REST}/api/v3/klines?symbol=${venueSymbol}&interval=${timeframe}&startTime=${range.start.getTime()}&endTime=${range.end.getTime()}&limit=1000`;
  const rows = await getJson<KlineRow[]>(url).catch(mapError);
  const now = Date.now();
  return rows
    .filter((r) => r[6] < now) // closeTime passed: closed candles only
    .map((r) => ({
      instrumentId,
      timeframe,
      openTime: new Date(r[0]),
      open: r[1],
      high: r[2],
      low: r[3],
      close: r[4],
      volume: r[5],
    }));
}

export const klineSpanMs = (timeframe: FeedTimeframe) => 1000 * TIMEFRAME_MS[timeframe];

interface ExchangeInfo {
  symbols: Array<{ symbol: string; filters: Array<{ filterType: string; tickSize?: string; stepSize?: string }> }>;
}

// tickSize from PRICE_FILTER; minQty is LOT_SIZE stepSize (spec 0001 rounds sizes to this step).
export async function fetchSymbolRules(venueSymbols: string[]): Promise<Map<string, { tickSize: string; minQty: string }>> {
  const url = `${REST}/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(venueSymbols))}`;
  const info = await getJson<ExchangeInfo>(url).catch(mapError);
  const out = new Map<string, { tickSize: string; minQty: string }>();
  for (const s of info.symbols) {
    const tickSize = s.filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize;
    const minQty = s.filters.find((f) => f.filterType === 'LOT_SIZE')?.stepSize;
    if (tickSize && minQty) out.set(s.symbol, { tickSize, minQty });
  }
  return out;
}

export async function fetchServerTime(): Promise<number> {
  const body = await getJson<{ serverTime: number }>(`${REST}/api/v3/time`).catch(mapError);
  return body.serverTime;
}

interface StreamMessage {
  stream: string;
  data: { e: string; s: string; k: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean } };
}

export function parseKlineMessage(raw: string): KlineEvent | null {
  const msg = JSON.parse(raw) as Partial<StreamMessage>;
  const d = msg.data;
  if (!d || d.e !== 'kline') return null;
  return {
    symbol: d.s,
    openTime: new Date(d.k.t),
    closed: d.k.x,
    open: d.k.o,
    high: d.k.h,
    low: d.k.l,
    close: d.k.c,
    volume: d.k.v,
  };
}

const WATCHDOG_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

// One combined 1m kline stream for every Binance pair. Closes itself when no frame (message or
// ping) arrives for 60 seconds; the caller reconnects.
export function openKlineStream(
  venueSymbols: string[],
  log: Logger,
  handlers: { onOpen: () => void; onKline: (k: KlineEvent) => void; onClose: () => void },
): { close: () => void } {
  const streams = venueSymbols.map((s) => `${s.toLowerCase()}@kline_1m`).join('/');
  // Some networks stall Binance handshakes and reset them ~25s later; give up after 10s and
  // let the reconnect backoff try again sooner.
  const ws = new WebSocket(`${STREAM}?streams=${streams}`, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
  let lastFrame = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastFrame > WATCHDOG_MS) {
      log.warn('binance stream silent for 60s, reconnecting');
      ws.terminate();
    }
  }, 5_000);

  ws.on('open', () => {
    lastFrame = Date.now();
    handlers.onOpen();
  });
  ws.on('ping', () => (lastFrame = Date.now())); // ws answers the pong itself
  ws.on('message', (data) => {
    lastFrame = Date.now();
    try {
      const k = parseKlineMessage(data.toString());
      if (k) handlers.onKline(k);
    } catch (err) {
      log.warn({ err }, 'unparseable binance message');
    }
  });
  ws.on('unexpected-response', (_req, res) => {
    log.error({ status: res.statusCode }, res.statusCode === 451 ? BINANCE_BLOCKED : 'binance stream rejected');
  });
  ws.on('error', (err) => log.warn({ err: err.message }, 'binance stream error'));
  ws.on('close', () => {
    clearInterval(watchdog);
    handlers.onClose();
  });

  return {
    close: () => {
      clearInterval(watchdog);
      ws.removeAllListeners('close');
      ws.terminate();
    },
  };
}
