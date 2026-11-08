import type { Logger } from 'pino';
import { TIMEFRAME_MS, type FeedTimeframe } from '@trading/shared';
import { getJson, HttpError } from './http.js';
import type { FeedCandle, TimeRange } from './types.js';

export const OANDA_NOT_CONFIGURED = 'OANDA is not configured (set OANDA_API_TOKEN and OANDA_ACCOUNT_ID)';
export const OANDA_REJECTED = 'OANDA rejected the token';

export interface OandaConfig {
  token: string;
  accountId: string;
  env: 'practice' | 'live';
}

const hosts = (env: OandaConfig['env']) =>
  env === 'live'
    ? { api: 'https://api-fxtrade.oanda.com', stream: 'https://stream-fxtrade.oanda.com' }
    : { api: 'https://api-fxpractice.oanda.com', stream: 'https://stream-fxpractice.oanda.com' };

const GRANULARITY: Record<FeedTimeframe, string> = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '1h': 'H1' };

// The token goes only in this header; it is never logged (pino redact) or returned.
const authHeaders = (c: OandaConfig) => ({
  authorization: `Bearer ${c.token}`,
  'accept-datetime-format': 'RFC3339',
});

// OANDA times carry nanoseconds; JS dates keep milliseconds.
export function parseOandaTime(time: string): Date {
  return new Date(time.replace(/\.(\d{3})\d*Z$/, '.$1Z'));
}

export function describeOandaError(err: unknown): string {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return OANDA_REJECTED;
  if (err instanceof HttpError && err.status === 400) return `OANDA rejected the request: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

interface CandlesResponse {
  candles: Array<{ complete: boolean; volume: number; time: string; mid?: { o: string; h: string; l: string; c: string } }>;
}

// Stays under OANDA's 5000 candles per request.
export const candleSpanMs = (timeframe: FeedTimeframe) => 4_900 * TIMEFRAME_MS[timeframe];

// Complete mid candles with open times in [range.start, range.end].
export async function fetchCandles(
  config: OandaConfig,
  venueSymbol: string,
  instrumentId: string,
  timeframe: FeedTimeframe,
  range: TimeRange,
): Promise<FeedCandle[]> {
  const to = new Date(Math.min(range.end.getTime() + TIMEFRAME_MS[timeframe], Date.now()));
  const params = new URLSearchParams({
    price: 'M',
    granularity: GRANULARITY[timeframe],
    smooth: 'false',
    from: range.start.toISOString(),
    to: to.toISOString(),
  });
  const url = `${hosts(config.env).api}/v3/instruments/${venueSymbol}/candles?${params}`;
  const body = await getJson<CandlesResponse>(url, authHeaders(config), 1_000);
  return body.candles
    .filter((c) => c.complete && c.mid)
    .map((c) => ({
      instrumentId,
      timeframe,
      openTime: parseOandaTime(c.time),
      open: c.mid!.o,
      high: c.mid!.h,
      low: c.mid!.l,
      close: c.mid!.c,
      volume: String(c.volume),
    }));
}

interface InstrumentsResponse {
  instruments: Array<{ name: string; displayPrecision: number; minimumTradeSize: string }>;
}

// tickSize = 10^-displayPrecision (0.001 for JPY pairs); minQty = minimumTradeSize in units.
export function tickFromPrecision(precision: number): string {
  return precision <= 0 ? '1' : `0.${'0'.repeat(precision - 1)}1`;
}

export async function fetchInstrumentRules(config: OandaConfig): Promise<Map<string, { tickSize: string; minQty: string }>> {
  const url = `${hosts(config.env).api}/v3/accounts/${config.accountId}/instruments`;
  const body = await getJson<InstrumentsResponse>(url, authHeaders(config), 1_000);
  return new Map(body.instruments.map((i) => [i.name, { tickSize: tickFromPrecision(i.displayPrecision), minQty: i.minimumTradeSize }]));
}

export type PricingMessage =
  | { type: 'PRICE'; instrument: string; time: Date; bid: string; ask: string; tradeable: boolean }
  | { type: 'HEARTBEAT'; time: Date };

// The stream is newline separated JSON that can split anywhere across chunks.
export class LineBuffer {
  private rest = '';

  push(chunk: string): string[] {
    const text = this.rest + chunk;
    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    return lines.map((l) => l.trim()).filter((l) => l.length > 0);
  }
}

export function parsePricingLine(line: string): PricingMessage | null {
  const msg = JSON.parse(line) as {
    type?: string;
    instrument?: string;
    time?: string;
    tradeable?: boolean;
    bids?: Array<{ price: string }>;
    asks?: Array<{ price: string }>;
  };
  if (msg.type === 'HEARTBEAT' && msg.time) return { type: 'HEARTBEAT', time: parseOandaTime(msg.time) };
  const bid = msg.bids?.[0]?.price;
  const ask = msg.asks?.[0]?.price;
  if (msg.type === 'PRICE' && msg.instrument && msg.time && bid && ask) {
    return { type: 'PRICE', instrument: msg.instrument, time: parseOandaTime(msg.time), bid, ask, tradeable: msg.tradeable !== false };
  }
  return null;
}

const STREAM_WATCHDOG_MS = 15_000;

// One pricing stream for every OANDA pair (OANDA allows only 2 per account). Ends itself when
// no line (price or the 5 second heartbeat) arrives for 15 seconds; the caller reconnects.
export function openPricingStream(
  config: OandaConfig,
  venueSymbols: string[],
  log: Logger,
  handlers: { onOpen: () => void; onMessage: (m: PricingMessage) => void; onEnd: (err?: unknown) => void },
): { close: () => void } {
  const abort = new AbortController();
  let lastLine = Date.now();
  let closedByUs = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastLine > STREAM_WATCHDOG_MS) {
      log.warn('oanda stream silent for 15s, reconnecting');
      abort.abort();
    }
  }, 2_000);

  const url = `${hosts(config.env).stream}/v3/accounts/${config.accountId}/pricing/stream?instruments=${venueSymbols.join(',')}`;
  void (async () => {
    let failure: unknown;
    try {
      const res = await fetch(url, { headers: authHeaders(config), signal: abort.signal });
      if (!res.ok || !res.body) throw new HttpError(res.status, `${res.status} from the OANDA pricing stream`);
      lastLine = Date.now();
      handlers.onOpen();
      const buffer = new LineBuffer();
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        for (const line of buffer.push(decoder.decode(chunk, { stream: true }))) {
          lastLine = Date.now();
          try {
            const m = parsePricingLine(line);
            if (m) handlers.onMessage(m);
          } catch (err) {
            log.warn({ err }, 'unparseable oanda line');
          }
        }
      }
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(watchdog);
      if (!closedByUs) handlers.onEnd(failure);
    }
  })();

  return {
    close: () => {
      closedByUs = true;
      clearInterval(watchdog);
      abort.abort();
    },
  };
}
