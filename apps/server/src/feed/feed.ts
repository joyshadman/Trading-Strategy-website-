import type { Logger } from 'pino';
import { FEED_TIMEFRAMES, TIMEFRAME_MS, type BotEvent, type FeedState } from '@trading/shared';
import type { PrismaClient } from '../db/prisma.js';
import { backfillSeries, BACKFILL_CONCURRENCY, runPool, type SeriesFetcher } from './backfill.js';
import { BINANCE_BLOCKED, fetchKlines, fetchServerTime, fetchSymbolRules, klineSpanMs, openKlineStream } from './binance.js';
import { HigherTimeframeBuilder } from './builder.js';
import { lastClosedOpenTime, loadRecent, pruneOldCandles } from './candleStore.js';
import { HttpError } from './http.js';
import type { Venue } from './instruments.js';
import { MarketData, RING_SIZE } from './marketData.js';
import {
  candleSpanMs,
  describeOandaError,
  fetchCandles,
  fetchInstrumentRules,
  OANDA_NOT_CONFIGURED,
  OANDA_REJECTED,
  openPricingStream,
  type OandaConfig,
} from './oanda.js';
import { FeedStatusTracker } from './status.js';
import type { FeedCandle } from './types.js';
import { CandleWriter } from './writer.js';

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const HEALTHY_RESET_MS = 5 * 60_000;
const ERROR_RETRY_MS = 5 * 60_000;
const RETENTION_EVERY_MS = 24 * 3_600_000;
const WAKE_CHECK_MS = 5_000;
const WAKE_GAP_MS = 35_000;
const MAX_CLOCK_SKEW_MS = 2_000;
const OANDA_POLL_DELAYS_MS = [3_000, 6_000, 10_000];
const MINUTE = TIMEFRAME_MS['1m'];

interface Inst {
  id: string;
  symbol: string;
  venue: Venue;
  venueSymbol: string;
}

interface Shared {
  prisma: PrismaClient;
  log: Logger;
  status: FeedStatusTracker;
  writer: CandleWriter;
  marketData: MarketData;
  builder: HigherTimeframeBuilder;
}

// Logs a repeated error once instead of on every retry.
class OnceLogger {
  private last = new Map<string, string>();
  constructor(private readonly log: Logger) {}
  error(key: string, message: string, extra: object = {}): void {
    if (this.last.get(key) === message) return;
    this.last.set(key, message);
    this.log.error(extra, message);
  }
  clear(key: string): void {
    this.last.delete(key);
  }
}

// Shared lifecycle for a venue: connect → hold live candles → backfill → live, with
// reconnect backoff (1s doubling to 60s, reset after 5 minutes of healthy data).
abstract class VenueRunner {
  protected generation = 0;
  protected held: FeedCandle[] | null = null;
  protected stopped = false;
  private backoffMs = MIN_BACKOFF_MS;
  private openedAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    protected readonly s: Shared,
    protected readonly instruments: Inst[],
    protected readonly once: OnceLogger,
  ) {}

  protected abstract open(gen: number): void;
  protected abstract closeConnection(): void;
  protected abstract fetcherFor(inst: Inst, timeframe: (typeof FEED_TIMEFRAMES)[number]): SeriesFetcher;

  get ids(): string[] {
    return this.instruments.map((i) => i.id);
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.closeConnection();
  }

  reconnectNow(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.closeConnection();
    this.connect();
  }

  protected connect(): void {
    const gen = ++this.generation;
    this.held = [];
    for (const i of this.instruments) if (this.s.status.status(i.id) !== 'error') this.s.status.set(i.id, 'backfilling');
    this.open(gen);
  }

  protected scheduleReconnect(delayMs?: number): void {
    if (this.stopped) return;
    if (this.openedAt && Date.now() - this.openedAt > HEALTHY_RESET_MS) this.backoffMs = MIN_BACKOFF_MS;
    const wait = delayMs ?? this.backoffMs;
    if (delayMs === undefined) this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), wait);
  }

  // A live closed 1m candle: held during backfill, written straight away after.
  protected onClosedOneMinute(candle: FeedCandle): void {
    if (this.held) this.held.push(candle);
    else void this.s.writer.write([candle], true);
  }

  // Runs once the connection is open. Returns false if this generation was superseded or failed.
  protected async backfillThenLive(gen: number): Promise<boolean> {
    this.openedAt = Date.now();
    const startedAt = Date.now();
    const series = this.instruments
      .filter((i) => this.s.status.status(i.id) !== 'error')
      .flatMap((inst) => FEED_TIMEFRAMES.map((tf) => ({ inst, tf })));
    let stored = 0;
    await runPool(series, BACKFILL_CONCURRENCY, async ({ inst, tf }) => {
      const n = await backfillSeries(this.s, inst.id, tf, this.fetcherFor(inst, tf), startedAt);
      stored += n; // after the await, so parallel runners don't overwrite each other
    });
    if (gen !== this.generation || this.stopped) return false;

    // Memory first, so candles built from held 1m candles see the full history.
    await runPool(series, 8, async ({ inst, tf }) => {
      this.s.marketData.load(inst.id, tf, await loadRecent(this.s.prisma, inst.id, tf, RING_SIZE));
    });
    this.s.builder.markBackfilled(this.ids, startedAt);
    const held = this.held ?? [];
    this.held = null;
    await this.s.writer.write(held, true);
    this.s.log.info({ venue: this.instruments[0]?.venue, stored, seconds: Math.round((Date.now() - startedAt) / 1000) }, 'backfill done');
    return true;
  }
}

class BinanceRunner extends VenueRunner {
  private stream: { close: () => void } | undefined;
  private readonly bySymbol = new Map(this.instruments.map((i) => [i.venueSymbol, i]));

  protected fetcherFor(inst: Inst, timeframe: (typeof FEED_TIMEFRAMES)[number]): SeriesFetcher {
    return { fetch: (range) => fetchKlines(inst.venueSymbol, inst.id, timeframe, range), maxSpanMs: klineSpanMs(timeframe) };
  }

  protected closeConnection(): void {
    this.stream?.close();
    this.stream = undefined;
  }

  protected open(gen: number): void {
    this.stream = openKlineStream(
      this.instruments.map((i) => i.venueSymbol),
      this.s.log,
      {
        onOpen: () => void this.afterOpen(gen),
        onKline: (k) => {
          const inst = this.bySymbol.get(k.symbol);
          if (!inst) return;
          const now = new Date();
          this.s.status.tick(inst.id, now);
          this.s.marketData.setQuote(inst.id, { kind: 'crypto', last: k.close, at: now });
          if (this.s.status.status(inst.id) === 'stale') this.s.status.set(inst.id, 'live');
          if (k.closed) {
            this.onClosedOneMinute({ instrumentId: inst.id, timeframe: '1m', openTime: k.openTime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume });
          }
        },
        onClose: () => {
          if (gen === this.generation) this.scheduleReconnect();
        },
      },
    );
  }

  private async afterOpen(gen: number): Promise<void> {
    try {
      if (!(await this.backfillThenLive(gen))) return;
      this.once.clear('binance');
      for (const id of this.ids) this.s.status.set(id, 'live');
    } catch (err) {
      if (err instanceof HttpError && err.message === BINANCE_BLOCKED) {
        this.once.error('binance', BINANCE_BLOCKED);
        for (const id of this.ids) this.s.status.set(id, 'error', BINANCE_BLOCKED);
        this.closeConnection();
        this.generation++;
        this.scheduleReconnect(ERROR_RETRY_MS);
        return;
      }
      this.s.log.error({ err }, 'binance backfill failed, reconnecting');
      this.closeConnection();
      this.generation++;
      this.scheduleReconnect();
    }
  }
}

class OandaRunner extends VenueRunner {
  private stream: { close: () => void } | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly bySymbol = new Map(this.instruments.map((i) => [i.venueSymbol, i]));

  constructor(
    s: Shared,
    instruments: Inst[],
    once: OnceLogger,
    private readonly config: OandaConfig | undefined,
  ) {
    super(s, instruments, once);
  }

  override start(): void {
    if (!this.config) {
      this.once.error('oanda', OANDA_NOT_CONFIGURED);
      for (const id of this.ids) this.s.status.set(id, 'error', OANDA_NOT_CONFIGURED);
      return;
    }
    super.start();
  }

  override stop(): void {
    clearTimeout(this.pollTimer);
    super.stop();
  }

  override reconnectNow(): void {
    if (this.config) super.reconnectNow();
  }

  protected fetcherFor(inst: Inst, timeframe: (typeof FEED_TIMEFRAMES)[number]): SeriesFetcher {
    return { fetch: (range) => fetchCandles(this.config!, inst.venueSymbol, inst.id, timeframe, range), maxSpanMs: candleSpanMs(timeframe) };
  }

  protected closeConnection(): void {
    this.stream?.close();
    this.stream = undefined;
  }

  protected open(gen: number): void {
    this.stream = openPricingStream(this.config!, this.instruments.map((i) => i.venueSymbol), this.s.log, {
      onOpen: () => void this.afterOpen(gen),
      onMessage: (m) => {
        const now = new Date();
        if (m.type === 'HEARTBEAT') {
          this.s.status.heartbeat('oanda', now);
          return;
        }
        const inst = this.bySymbol.get(m.instrument);
        if (!inst) return;
        this.s.status.tick(inst.id, now);
        this.s.marketData.setQuote(inst.id, { kind: 'forex', bid: m.bid, ask: m.ask, tradeable: m.tradeable, at: now });
        const status = this.s.status.status(inst.id);
        if (!m.tradeable && (status === 'live' || status === 'stale')) this.s.status.set(inst.id, 'closed');
        if (m.tradeable && (status === 'closed' || status === 'stale')) this.s.status.set(inst.id, 'live');
      },
      onEnd: (err) => {
        if (gen !== this.generation) return;
        this.handleFailure(err);
      },
    });
  }

  private handleFailure(err: unknown): void {
    const message = describeOandaError(err);
    if (message === OANDA_REJECTED) {
      this.once.error('oanda', OANDA_REJECTED);
      for (const id of this.ids) this.s.status.set(id, 'error', OANDA_REJECTED);
      this.closeConnection();
      this.generation++;
      this.scheduleReconnect(ERROR_RETRY_MS);
      return;
    }
    if (err) this.s.log.warn({ err: message }, 'oanda stream ended, reconnecting');
    this.scheduleReconnect();
  }

  private async afterOpen(gen: number): Promise<void> {
    try {
      if (!(await this.backfillThenLive(gen))) return;
      this.once.clear('oanda');
      for (const inst of this.instruments) {
        const quote = this.s.marketData.getQuote(inst.id);
        this.s.status.set(inst.id, quote?.kind === 'forex' && !quote.tradeable ? 'closed' : 'live');
      }
      this.schedulePoll();
    } catch (err) {
      this.closeConnection();
      this.generation++;
      this.handleFailure(err);
    }
  }

  // M1 polls at 3, 6, and 10 seconds after each minute, each asking for everything after the
  // newest stored 1m candle, so a missed poll heals itself.
  private schedulePoll(): void {
    clearTimeout(this.pollTimer);
    const now = Date.now();
    const nextMinute = Math.floor(now / MINUTE) * MINUTE + MINUTE;
    this.pollTimer = setTimeout(() => void this.pollCycle(), nextMinute + OANDA_POLL_DELAYS_MS[0]! - now);
  }

  private async pollCycle(): Promise<void> {
    if (this.stopped) return;
    const cycleMinute = Math.floor(Date.now() / MINUTE) * MINUTE;
    const expected = lastClosedOpenTime('1m', cycleMinute + 1);
    let pending = this.instruments.filter((i) => this.s.status.status(i.id) === 'live' || this.s.status.status(i.id) === 'stale');
    for (let attempt = 0; attempt < OANDA_POLL_DELAYS_MS.length && pending.length > 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, OANDA_POLL_DELAYS_MS[attempt]! - OANDA_POLL_DELAYS_MS[attempt - 1]!));
      const results = await Promise.all(pending.map(async (inst) => ({ inst, done: await this.pollOne(inst, expected) })));
      pending = results.filter((r) => !r.done).map((r) => r.inst);
    }
    await this.s.builder.flushDue(this.ids).catch((err: unknown) => this.s.log.error({ err }, 'building forex candles failed'));
    if (!this.stopped) this.schedulePoll();
  }

  // True once the expected minute is stored (or OANDA has nothing newer to give).
  private async pollOne(inst: Inst, expected: Date): Promise<boolean> {
    const ring = this.s.marketData.getCandles(inst.id, '1m', 1);
    const newest = ring[0]?.openTime.getTime() ?? expected.getTime() - 5 * MINUTE;
    if (newest >= expected.getTime()) return true;
    try {
      const candles = await fetchCandles(this.config!, inst.venueSymbol, inst.id, '1m', { start: new Date(newest + MINUTE), end: expected });
      const fresh = candles.filter((c) => c.openTime.getTime() > newest && c.openTime <= expected);
      for (const c of fresh) this.onClosedOneMinute(c);
      return fresh.some((c) => c.openTime.getTime() === expected.getTime());
    } catch (err) {
      this.s.log.warn({ symbol: inst.symbol, err: describeOandaError(err) }, 'oanda poll failed');
      return false;
    }
  }
}

export interface FeedDeps {
  prisma: PrismaClient;
  log: Logger;
  publish: (event: BotEvent) => Promise<void>;
  oanda: OandaConfig | undefined;
}

// The market data feed (spec 0002). Lives for the worker's whole life, whatever the bot does.
export class MarketDataFeed {
  readonly marketData = new MarketData();
  private status!: FeedStatusTracker;
  private writer!: CandleWriter;
  private runners: VenueRunner[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly deps: FeedDeps) {}

  // The instrument's feed state, or null before the feed has started (spec 0003).
  getFeedState(instrumentId: string): FeedState | null {
    return this.status?.status(instrumentId) ?? null;
  }

  async start(): Promise<void> {
    const { prisma, log } = this.deps;
    const rows = await prisma.instrument.findMany({ where: { active: true }, orderBy: { symbol: 'asc' } });
    if (rows.length === 0) {
      log.error('no instruments found, run "npm run db:seed"; market data feed not started');
      return;
    }
    const instruments: Inst[] = rows.map((r) => ({ id: r.id, symbol: r.symbol, venue: r.venue as Venue, venueSymbol: r.venueSymbol }));

    this.status = new FeedStatusTracker(prisma, this.deps.publish, log, instruments);
    // The builder writes through the writer, and the writer feeds the builder.
    const ref: { builder?: HigherTimeframeBuilder } = {};
    this.writer = new CandleWriter(prisma, this.marketData, log, {
      onStored: (c) => {
        this.status.candle(c.instrumentId, c.openTime);
        if (c.timeframe === '1m') void ref.builder?.onOneMinute(c).catch((err: unknown) => log.error({ err }, 'building candle failed'));
      },
      onOverflow: (ids) => {
        for (const id of ids) this.status.set(id, 'backfilling');
        for (const r of this.runners) if (r.ids.some((id) => ids.includes(id))) r.reconnectNow();
      },
    });
    const builder = new HigherTimeframeBuilder(this.marketData, this.writer);
    ref.builder = builder;
    const shared: Shared = { prisma, log, status: this.status, writer: this.writer, marketData: this.marketData, builder };
    const once = new OnceLogger(log);

    for (const i of instruments) this.status.set(i.id, 'backfilling');
    this.status.start();

    await this.refreshRules(instruments);
    void this.checkClock();
    void this.prune();
    this.timers.push(setInterval(() => void this.prune(), RETENTION_EVERY_MS));

    this.runners = [
      new BinanceRunner(shared, instruments.filter((i) => i.venue === 'binance'), once),
      new OandaRunner(shared, instruments.filter((i) => i.venue === 'oanda'), once, this.deps.oanda),
    ];
    for (const r of this.runners) r.start();
    this.watchForWake();
    log.info({ instruments: instruments.length, oanda: Boolean(this.deps.oanda) }, 'market data feed started');
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const r of this.runners) r.stop();
    await this.writer?.flush();
    await this.status?.stop();
  }

  // tickSize and minQty from each venue, in one statement (spec 0002 value sourcing).
  private async refreshRules(instruments: Inst[]): Promise<void> {
    const updates: Array<{ id: string; tickSize: string; minQty: string }> = [];
    try {
      const binance = await fetchSymbolRules(instruments.filter((i) => i.venue === 'binance').map((i) => i.venueSymbol));
      for (const i of instruments) {
        const r = i.venue === 'binance' ? binance.get(i.venueSymbol) : undefined;
        if (r) updates.push({ id: i.id, ...r });
      }
    } catch (err) {
      this.deps.log.warn({ err: err instanceof Error ? err.message : err }, 'could not refresh binance tick sizes');
    }
    if (this.deps.oanda) {
      try {
        const oanda = await fetchInstrumentRules(this.deps.oanda);
        for (const i of instruments) {
          const r = i.venue === 'oanda' ? oanda.get(i.venueSymbol) : undefined;
          if (r) updates.push({ id: i.id, ...r });
        }
      } catch (err) {
        this.deps.log.warn({ err: describeOandaError(err) }, 'could not refresh oanda tick sizes');
      }
    }
    if (updates.length === 0) return;
    await this.deps.prisma.$executeRawUnsafe(
      `UPDATE "Instrument" i SET "tickSize" = v.tick, "minQty" = v.min
       FROM unnest($1::uuid[], $2::numeric[], $3::numeric[]) AS v(id, tick, min) WHERE i.id = v.id`,
      updates.map((u) => u.id),
      updates.map((u) => u.tickSize),
      updates.map((u) => u.minQty),
    );
  }

  private async checkClock(): Promise<void> {
    try {
      const sent = Date.now();
      const server = await fetchServerTime();
      const skew = server - (sent + (Date.now() - sent) / 2);
      if (Math.abs(skew) > MAX_CLOCK_SKEW_MS) {
        this.deps.log.warn({ skewMs: Math.round(skew) }, 'your clock differs from Binance by more than 2 seconds; candle timing may be off');
      }
    } catch (err) {
      this.deps.log.warn({ err: err instanceof Error ? err.message : err }, 'clock check failed');
    }
  }

  private async prune(): Promise<void> {
    try {
      const deleted = await pruneOldCandles(this.deps.prisma, FEED_TIMEFRAMES, Date.now());
      if (deleted > 0) this.deps.log.info({ deleted }, 'old candles deleted');
    } catch (err) {
      this.deps.log.error({ err }, 'candle retention failed');
    }
  }

  // A timer that fires far later than it should means the PC slept: reconnect and backfill.
  private watchForWake(): void {
    let last = Date.now();
    this.timers.push(
      setInterval(() => {
        const now = Date.now();
        if (now - last > WAKE_GAP_MS) {
          this.deps.log.warn({ sleptSeconds: Math.round((now - last) / 1000) }, 'woke from sleep, reconnecting feeds');
          for (const r of this.runners) r.reconnectNow();
        }
        last = now;
      }, WAKE_CHECK_MS),
    );
  }
}
