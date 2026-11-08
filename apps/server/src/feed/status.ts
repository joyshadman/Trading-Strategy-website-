import type { Logger } from 'pino';
import { makeEvent, type BotEvent, type FeedState } from '@trading/shared';
import type { PrismaClient } from '../db/prisma.js';
import type { Venue } from './instruments.js';

export const CRYPTO_STALE_MS = 30_000;
export const FOREX_STALE_MS = 60_000;
const STALE_CHECK_MS = 5_000;
const FLUSH_MS = 30_000;

export interface TrackedInstrument {
  id: string;
  symbol: string;
  venue: Venue;
}

interface State {
  // null until this process sets it, so the first status is always written (the row may
  // still say `live` from before a crash).
  status: FeedState | null;
  lastTickAt: Date | null;
  lastCandleAt: Date | null;
  lastError: string | null;
}

// Decides when a live feed has gone quiet (pure, so it's easy to test).
export function isStale(
  venue: Venue,
  state: { status: FeedState | null; lastTickAt: Date | null },
  venueHeartbeatAt: Date | null,
  now: number,
): boolean {
  if (state.status !== 'live') return false; // the timer is paused in every other state
  const lastSign = Math.max(state.lastTickAt?.getTime() ?? 0, venue === 'oanda' ? (venueHeartbeatAt?.getTime() ?? 0) : 0);
  return now - lastSign > (venue === 'binance' ? CRYPTO_STALE_MS : FOREX_STALE_MS);
}

// Feed health per instrument. Status changes are written at once (and pushed as `feed.status`
// events); lastTickAt and lastCandleAt are flushed for all instruments every 30 seconds.
export class FeedStatusTracker {
  private readonly states = new Map<string, State>();
  private readonly heartbeats = new Map<Venue, Date>();
  private readonly writeChains = new Map<string, Promise<void>>();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaClient,
    private readonly publish: (event: BotEvent) => Promise<void>,
    private readonly log: Logger,
    private readonly instruments: TrackedInstrument[],
  ) {
    for (const i of instruments) {
      this.states.set(i.id, { status: null, lastTickAt: null, lastCandleAt: null, lastError: null });
    }
  }

  start(): void {
    this.timers.push(setInterval(() => this.checkStale(), STALE_CHECK_MS));
    this.timers.push(setInterval(() => void this.flush(), FLUSH_MS));
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.all(this.writeChains.values());
    await this.flush();
  }

  status(instrumentId: string): FeedState | undefined {
    return this.states.get(instrumentId)?.status ?? undefined;
  }

  idsFor(venue: Venue): string[] {
    return this.instruments.filter((i) => i.venue === venue).map((i) => i.id);
  }

  tick(instrumentId: string, at: Date): void {
    const s = this.states.get(instrumentId);
    if (s) s.lastTickAt = at;
  }

  candle(instrumentId: string, openTime: Date): void {
    const s = this.states.get(instrumentId);
    if (s && (!s.lastCandleAt || openTime > s.lastCandleAt)) s.lastCandleAt = openTime;
  }

  heartbeat(venue: Venue, at: Date): void {
    this.heartbeats.set(venue, at);
  }

  set(instrumentId: string, status: FeedState, error?: string): void {
    const s = this.states.get(instrumentId);
    const inst = this.instruments.find((i) => i.id === instrumentId);
    if (!s || !inst) return;
    const lastError = status === 'error' ? (error ?? 'unknown error') : null;
    if (s.status === status && s.lastError === lastError) return;
    s.status = status;
    s.lastError = lastError;
    // A fresh `live` starts its stale clock now.
    if (status === 'live') s.lastTickAt = s.lastTickAt && Date.now() - s.lastTickAt.getTime() < 5_000 ? s.lastTickAt : new Date();

    const write = async () => {
      await this.prisma.feedStatus.upsert({
        where: { instrumentId },
        create: { instrumentId, status, lastError, lastTickAt: s.lastTickAt, lastCandleAt: s.lastCandleAt },
        update: { status, lastError, lastTickAt: s.lastTickAt, lastCandleAt: s.lastCandleAt },
      });
      await this.publish(
        makeEvent('feed.status', {
          instrumentId,
          symbol: inst.symbol,
          status,
          ...(lastError ? { lastError } : {}),
        }),
      );
    };
    // Writes for one instrument run in order, so a quick backfilling → live can't land reversed.
    const chain = (this.writeChains.get(instrumentId) ?? Promise.resolve())
      .then(write)
      .catch((err: unknown) => this.log.error({ err, instrumentId, status }, 'feed status write failed'));
    this.writeChains.set(instrumentId, chain);
  }

  setVenue(venue: Venue, status: FeedState, error?: string): void {
    for (const id of this.idsFor(venue)) this.set(id, status, error);
  }

  private checkStale(): void {
    const now = Date.now();
    for (const inst of this.instruments) {
      const s = this.states.get(inst.id);
      if (s && isStale(inst.venue, s, this.heartbeats.get(inst.venue) ?? null, now)) {
        this.log.warn({ symbol: inst.symbol }, 'feed went stale');
        this.set(inst.id, 'stale');
      }
    }
  }

  // One statement for all instruments.
  private async flush(): Promise<void> {
    const ids = [...this.states.keys()];
    const ticks = ids.map((id) => this.states.get(id)?.lastTickAt?.toISOString() ?? null);
    const candles = ids.map((id) => this.states.get(id)?.lastCandleAt?.toISOString() ?? null);
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE "FeedStatus" f SET "lastTickAt" = v.tick, "lastCandleAt" = v.candle, "updatedAt" = now()
         FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS v(id, tick, candle)
         WHERE f."instrumentId" = v.id`,
        ids,
        ticks,
        candles,
      );
    } catch (err) {
      this.log.warn({ err }, 'feed status flush failed');
    }
  }
}
