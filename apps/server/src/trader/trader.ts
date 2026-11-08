import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  MARK_INTERVAL_MS,
  Money,
  TIMEFRAME_MS,
  evaluateEmaRsiMacd,
  exitSidePrice,
  makeEvent,
  oppositeSide,
  paperFillPrice,
  toDecimal,
  toDecimalString,
  toIndicatorNumber,
  type BotEvent,
  type CloseReason,
  type FeedState,
  type Side,
  type SkipReason,
  type TrendBias,
} from '@trading/shared';
import type { PrismaClient } from '../db/prisma.js';
import type { MarketData, Quote } from '../feed/marketData.js';
import type { FeedCandle } from '../feed/types.js';
import { failCommand, type BotState, type TraderCommand } from '../worker/commands.js';
import { feeInQuote, grossPnlUsd, marginUsd, quoteToUsd, stored, utcDay } from './accounting.js';
import { isOpenPositionConflict, type Broker } from './broker.js';
import { markPosition, nextSnapshotAt } from './marks.js';
import { firstFailedCheck, sizeEntry, triggeredExit } from './risk.js';
import * as store from './store.js';
import type { InstrumentInfo, StrategyInfo } from './store.js';

type Decimal = Money;

const STRATEGY_REFRESH_MS = 60_000;
const ZERO = new Money(0);

interface OpenPosition extends store.PositionRow {
  unrealized: Decimal;
  // A pending exit order (kill or manual) fires first, at the first live tradeable price.
  pendingExit: store.ExitReason | null;
  // An exit that triggered but didn't get written yet; retried on the next fresh quote.
  owed: CloseReason | null;
  queued: boolean;
}

export type CommandResult = { status: 'done' } | { status: 'failed'; error: string };

export interface TraderDeps {
  prisma: PrismaClient;
  log: Logger;
  marketData: MarketData;
  feedState: (instrumentId: string) => FeedState | null;
  broker: Broker;
  publish: (events: BotEvent[]) => Promise<void>;
  accountId: string;
  // The state the previous worker run ended in; `killed` reruns the kill sweep at start.
  previousState: string | null;
}

// The paper trader (spec 0003). Every action that writes runs in ONE serial queue, so open
// counts and margin are always counted correctly. Quotes never enter the queue: triggers are
// tested in memory and only a fired exit becomes a job. The database is the source of truth;
// the caches here only make checks fast and are updated after each commit.
export class Trader {
  private botState: BotState = 'idle';
  private chain: Promise<void> = Promise.resolve();
  private instruments = new Map<string, InstrumentInfo>();
  private bySymbol = new Map<string, InstrumentInfo>();
  private strategies: StrategyInfo[] = [];
  private strategiesLoadedAt = 0;
  private positions = new Map<string, OpenPosition>();
  private balance = ZERO;
  private today = { day: '', byStrategy: new Map<string, Decimal>() };
  private lastWrittenEquity: Decimal | null = null;
  private lastPushedEquity: Decimal | null = null;
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe: Array<() => void> = [];
  private stopped = false;
  private started = false;

  constructor(private readonly d: TraderDeps) {
    void this.enqueue('load', () => this.load());
  }

  // Called after each command commits (spec 0003: kill sweeps inside the queue).
  setBotState(state: BotState): void {
    this.botState = state;
    if (state === 'killed') void this.enqueue('kill sweep', () => this.killSweep());
  }

  // Called once the market data feed has started (tick sizes are fresh by then).
  start(): void {
    this.started = true;
    void this.enqueue('refresh instruments', () => this.loadInstruments());
    this.unsubscribe.push(
      this.d.marketData.onCandleClosed((c) => {
        if (this.strategies.some((s) => s.timeframe === c.timeframe)) void this.enqueue('candle', () => this.onCandle(c));
      }),
      this.d.marketData.onQuote((id) => this.checkInstrument(id)),
    );
    this.timers.push(setInterval(() => void this.enqueue('mark', () => this.mark()), MARK_INTERVAL_MS));
    this.scheduleSnapshot();
    this.d.log.info('paper trader started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const u of this.unsubscribe) u();
    await this.chain;
  }

  // A panel command (spec 0004), run inside the serial queue so it can't race a candle or an
  // exit. It doesn't use enqueue's error handling (that logs and swallows): the result comes
  // back to the caller, and a throw rejects so the caller can mark the command failed.
  runCommand(command: TraderCommand): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      void this.enqueue(`command ${command.type}`, async () => {
        try {
          resolve(await this.applyCommand(command));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  private async applyCommand(command: TraderCommand): Promise<CommandResult> {
    const { prisma } = this.d;
    if (command.type === 'enable_strategy' || command.type === 'disable_strategy') {
      // Works before start() too: the trader loads strategies when it is created.
      await store.applyStrategyToggle(prisma, command.id, command.strategyId!, command.type === 'enable_strategy');
      await this.loadStrategies();
      return { status: 'done' };
    }
    if (!this.started || this.stopped) {
      const error = 'trader not running';
      await failCommand(prisma, command.id, error);
      return { status: 'failed', error };
    }
    const positionId = command.positionId!;
    const result = await store.createManualExit(prisma, command.id, positionId);
    if (!result) return { status: 'failed', error: 'command no longer pending' };
    if (result.status === 'done') {
      const pos = this.positions.get(positionId);
      if (pos) pos.pendingExit = 'manual';
      else await this.loadPositions();
      // A live market fills right away; otherwise at the first live tradeable price.
      const instrumentId = pos?.instrumentId ?? this.positions.get(positionId)?.instrumentId;
      if (instrumentId) this.checkInstrument(instrumentId);
    }
    return result;
  }

  private enqueue(label: string, job: () => Promise<void>): Promise<void> {
    const run = this.chain.then(job).catch((err: unknown) => this.d.log.error({ err, job: label }, 'trader job failed'));
    this.chain = run;
    return run;
  }

  // ---- loading ----

  private async load(): Promise<void> {
    const { prisma, accountId } = this.d;
    await this.loadInstruments();
    await this.loadStrategies();
    await this.loadPositions();
    this.balance = await store.loadBalance(prisma, accountId);
    this.today = await store.loadTodayRealized(prisma, accountId);
    this.d.log.info({ openPositions: this.positions.size, balance: this.balance.toFixed() }, 'paper trader state loaded');
    if (this.d.previousState === 'killed' && this.positions.size > 0) {
      this.d.log.warn('the last run ended killed with positions open, running the kill sweep again');
      await this.killSweep();
    }
  }

  private async loadInstruments(): Promise<void> {
    const rows = await store.loadInstruments(this.d.prisma);
    this.instruments = new Map(rows.map((r) => [r.id, r]));
    this.bySymbol = new Map(rows.map((r) => [r.symbol, r]));
  }

  private async loadStrategies(): Promise<void> {
    const { strategies, invalid } = await store.loadStrategies(this.d.prisma, this.d.accountId);
    for (const s of invalid) this.d.log.warn({ strategy: s.name, error: s.error }, 'strategy skipped, invalid settings');
    this.strategies = strategies;
    this.strategiesLoadedAt = Date.now();
  }

  // Keeps in memory flags (queued, owed) for positions already known.
  private async loadPositions(): Promise<void> {
    const rows = await store.loadOpenPositions(this.d.prisma, this.d.accountId);
    const pending = await store.loadPendingExits(this.d.prisma, this.d.accountId);
    const next = new Map<string, OpenPosition>();
    for (const r of rows) {
      const known = this.positions.get(r.id);
      next.set(r.id, {
        ...r,
        unrealized: known?.unrealized ?? r.unrealizedPnl ?? r.fees.neg(),
        pendingExit: pending.get(r.id) ?? null,
        owed: known?.owed ?? null,
        queued: known?.queued ?? false,
      });
    }
    this.positions = next;
  }

  // ---- money state ----

  private equity(): Decimal {
    let e = this.balance;
    for (const p of this.positions.values()) e = e.plus(p.unrealized);
    return e;
  }

  private marginUsed(): Decimal {
    let m = ZERO;
    for (const p of this.positions.values()) {
      const inst = this.instruments.get(p.instrumentId);
      if (inst) m = m.plus(marginUsd(p.qty, p.entryPrice, p.entryQuoteToUsd, inst.assetClass));
    }
    return m;
  }

  // Quote currency → USD from the live forex mids. Entries need the conversion pair live.
  private q2u(quoteAsset: string, requireLive: boolean): Decimal | undefined {
    return quoteToUsd(quoteAsset, (symbol) => {
      const inst = this.bySymbol.get(symbol);
      if (!inst) return undefined;
      if (requireLive && this.d.feedState(inst.id) !== 'live') return undefined;
      const q = this.d.marketData.getQuote(inst.id);
      return q?.kind === 'forex' ? toDecimal(q.bid).plus(toDecimal(q.ask)).div(2) : undefined;
    });
  }

  private async todayRealized(strategyId: string): Promise<Decimal> {
    if (utcDay(new Date()) !== this.today.day) this.today = await store.loadTodayRealized(this.d.prisma, this.d.accountId);
    return this.today.byStrategy.get(strategyId) ?? ZERO;
  }

  // ---- 15m candles: signals, opposite exits, entries ----

  private async onCandle(candle: FeedCandle): Promise<void> {
    if (Date.now() - this.strategiesLoadedAt > STRATEGY_REFRESH_MS) await this.loadStrategies();
    const instrument = this.instruments.get(candle.instrumentId);
    if (!instrument) return;
    for (const strategy of this.strategies) {
      if (strategy.timeframe !== candle.timeframe || !strategy.instrumentIds.has(instrument.id)) continue;
      if (!strategy.enabled || this.botState === 'killed') continue;
      if (!strategy.risk) {
        this.d.log.warn({ strategy: strategy.name }, 'strategy has no risk settings, not evaluated');
        continue;
      }
      await this.evaluate(strategy, instrument, candle);
    }
  }

  private async evaluate(strategy: StrategyInfo, instrument: InstrumentInfo, candle: FeedCandle): Promise<void> {
    const p = strategy.params;
    const md = this.d.marketData;
    const closeTime = candle.openTime.getTime() + TIMEFRAME_MS[candle.timeframe];
    const trendMs = TIMEFRAME_MS[p.trendTimeframe];
    const closes = md
      .getCandles(instrument.id, candle.timeframe)
      .filter((c) => c.openTime.getTime() <= candle.openTime.getTime())
      .slice(-p.lookback)
      .map((c) => toIndicatorNumber(c.close));
    const trendCloses = md
      .getCandles(instrument.id, p.trendTimeframe)
      .filter((c) => c.openTime.getTime() + trendMs <= closeTime)
      .slice(-p.lookback)
      .map((c) => toIndicatorNumber(c.close));
    const result = evaluateEmaRsiMacd(closes, trendCloses, p);
    const log = this.d.log.child({ strategy: strategy.name, symbol: instrument.symbol, candle: candle.openTime.toISOString() });
    if (!result.indicators) {
      log.debug({ closes: closes.length, trendCloses: trendCloses.length }, 'not enough history to evaluate');
      return;
    }
    if (!result.side) return;
    const side = result.side;

    // 1. Claim the candle. If the row exists, this candle was already handled.
    const signalId = randomUUID();
    try {
      const claimed = await store.insertSignal(this.d.prisma, {
        id: signalId,
        strategyId: strategy.id,
        instrumentId: instrument.id,
        side,
        indicators: result.indicators,
        candleTime: candle.openTime,
      });
      if (!claimed) return;
    } catch (err) {
      log.error({ err }, 'signal write failed, entry dropped');
      return;
    }

    const events: BotEvent[] = [];
    // 2. An opposite Strong signal closes the open position (whatever the 1h bias).
    let closed = false;
    const open = this.positionFor(strategy.id, instrument.id);
    if (open && open.side !== side && !open.pendingExit) {
      if (this.fresh(instrument.id)) closed = await this.closePosition(open, 'opposite_signal', events);
      else open.owed ??= 'opposite_signal'; // held until the next fresh tradeable price (AC-13)
    }

    // 3. Entry checks, then the entry itself.
    let skip = await this.entryCheck(strategy, instrument, side, result.indicators.trend);
    let entered = false;
    if (!skip) {
      const outcome = await this.enter(strategy, instrument, side, signalId, events, log);
      if (outcome === 'entered') entered = true;
      else if (outcome === 'failed') {
        // AC-15: the entry is dropped and logged, never retried. A close made above still counts.
        await this.publish(events);
        return;
      } else skip = outcome;
    }
    if (!entered) {
      const reason = closed ? null : skip;
      await store.finishSignal(this.d.prisma, signalId, reason).catch((err: unknown) => log.error({ err }, 'signal update failed'));
    }

    const outcome = entered || closed ? 'ordered' : 'skipped';
    log.info({ side, outcome, skipReason: outcome === 'skipped' ? skip : undefined }, 'strong signal');
    events.push(
      makeEvent('signal.created', {
        signalId,
        strategyId: strategy.id,
        symbol: instrument.symbol,
        side,
        outcome,
        ...(outcome === 'skipped' && skip ? { skipReason: skip } : {}),
      }),
    );
    await this.publish(events);
  }

  private async entryCheck(strategy: StrategyInfo, instrument: InstrumentInfo, side: Side, trend: TrendBias): Promise<SkipReason | null> {
    const risk = strategy.risk!;
    const quote = this.d.marketData.getQuote(instrument.id);
    const openCount = [...this.positions.values()].filter((p) => p.strategyId === strategy.id).length;
    return firstFailedCheck({
      botState: this.botState,
      side,
      allowShort: strategy.params.allowShort,
      trend,
      feedState: this.d.feedState(instrument.id),
      assetClass: instrument.assetClass,
      tradeable: quote?.kind === 'forex' ? quote.tradeable : null,
      hasQuote: Boolean(quote),
      hasOpenPosition: Boolean(this.positionFor(strategy.id, instrument.id)),
      openCount,
      maxOpenTrades: risk.maxOpenTrades,
      todayRealizedPnl: await this.todayRealized(strategy.id),
      dailyLossLimit: risk.dailyLossLimit,
      hasConversionRate: Boolean(this.q2u(instrument.quoteAsset, true)),
    });
  }

  private async enter(
    strategy: StrategyInfo,
    instrument: InstrumentInfo,
    side: Side,
    signalId: string,
    events: BotEvent[],
    log: Logger,
  ): Promise<'entered' | 'failed' | SkipReason> {
    const risk = strategy.risk!;
    const quote = this.d.marketData.getQuote(instrument.id)!;
    const q2u = this.q2u(instrument.quoteAsset, true)!;
    const price = paperFillPrice(quote, side, instrument.tickSize);
    const equity = this.equity();
    const sizing = sizeEntry({
      price,
      side,
      q2u,
      assetClass: instrument.assetClass,
      equity,
      freeMargin: equity.minus(this.marginUsed()),
      stopLossPct: risk.stopLossPct,
      takeProfitPct: risk.takeProfitPct,
      maxPositionSize: risk.maxPositionSize,
      riskPerTradePct: risk.riskPerTradePct,
      minQty: instrument.minQty,
      tickSize: instrument.tickSize,
    });
    if (!sizing.ok) return sizing.reason;

    const fee = feeInQuote(price, sizing.qty, instrument.assetClass);
    const feeUsd = stored(fee.mul(q2u));
    try {
      const opened = await this.d.broker.openPosition({
        signalId,
        accountId: this.d.accountId,
        strategyId: strategy.id,
        instrumentId: instrument.id,
        side,
        qty: sizing.qty,
        price,
        stopLoss: sizing.stopLoss,
        takeProfit: sizing.takeProfit,
        fee,
        feeCurrency: instrument.quoteAsset,
        feeUsd,
        entryQuoteToUsd: stored(q2u),
      });
      this.positions.set(opened.positionId, {
        id: opened.positionId,
        strategyId: strategy.id,
        instrumentId: instrument.id,
        side,
        qty: sizing.qty,
        entryPrice: price,
        stopLoss: sizing.stopLoss,
        takeProfit: sizing.takeProfit,
        fees: feeUsd,
        entryQuoteToUsd: stored(q2u),
        markPrice: null,
        unrealizedPnl: null,
        unrealized: feeUsd.neg(),
        pendingExit: null,
        owed: null,
        queued: false,
      });
      log.info({ side, qty: sizing.qty.toFixed(), price: price.toFixed(), sl: sizing.stopLoss.toFixed(), tp: sizing.takeProfit.toFixed() }, 'paper entry filled');
      events.push(makeEvent('position.opened', { positionId: opened.positionId, strategyId: strategy.id, symbol: instrument.symbol, side }));
      return 'entered';
    } catch (err) {
      if (isOpenPositionConflict(err)) return 'already_open';
      log.error({ err, clientOrderId: `e:${signalId}` }, 'entry write failed, entry dropped');
      return 'failed';
    }
  }

  // ---- exits ----

  private positionFor(strategyId: string, instrumentId: string): OpenPosition | undefined {
    for (const p of this.positions.values()) if (p.strategyId === strategyId && p.instrumentId === instrumentId) return p;
    return undefined;
  }

  // A price may be acted on only while the feed is live (and forex is tradeable).
  private fresh(instrumentId: string): boolean {
    if (this.d.feedState(instrumentId) !== 'live') return false;
    const q = this.d.marketData.getQuote(instrumentId);
    return Boolean(q) && !(q?.kind === 'forex' && !q.tradeable);
  }

  // Runs on every quote (synchronous, in memory). Queues an exit only when one fires.
  private checkInstrument(instrumentId: string): void {
    if (this.stopped || this.positions.size === 0) return;
    let quote: Quote | undefined;
    for (const pos of this.positions.values()) {
      if (pos.instrumentId !== instrumentId || pos.queued) continue;
      if (!quote) {
        if (!this.fresh(instrumentId)) return;
        quote = this.d.marketData.getQuote(instrumentId)!;
      }
      const reason: CloseReason | null =
        pos.pendingExit ?? pos.owed ?? triggeredExit(pos.side, exitSidePrice(quote, pos.side), pos.stopLoss, pos.takeProfit);
      if (!reason) continue;
      pos.queued = true;
      void this.enqueue('exit', async () => {
        if (this.positions.get(pos.id) !== pos) return;
        const events: BotEvent[] = [];
        await this.closePosition(pos, reason, events);
        await this.publish(events);
      });
    }
  }

  // Closes at the current price. False when nothing was closed (failure: the exit stays owed).
  private async closePosition(pos: OpenPosition, reason: CloseReason, events: BotEvent[]): Promise<boolean> {
    const instrument = this.instruments.get(pos.instrumentId);
    const quote = this.d.marketData.getQuote(pos.instrumentId);
    if (!instrument || !quote) {
      pos.owed = reason;
      pos.queued = false;
      return false;
    }
    const exitSide = oppositeSide(pos.side);
    const price = paperFillPrice(quote, exitSide, instrument.tickSize);
    const q2u = this.q2u(instrument.quoteAsset, false) ?? pos.entryQuoteToUsd;
    const fee = feeInQuote(price, pos.qty, instrument.assetClass);
    // A pending exit wins over an SL or TP on the same quote (spec 0004 AC-4).
    const closeReason: CloseReason = pos.pendingExit ?? reason;
    const log = this.d.log.child({ symbol: instrument.symbol, positionId: pos.id, reason: closeReason });
    let closed;
    try {
      closed = await this.d.broker.closePosition({
        positionId: pos.id,
        strategyId: pos.strategyId,
        instrumentId: pos.instrumentId,
        side: exitSide,
        qty: pos.qty,
        price,
        reason: closeReason,
        grossPnlUsd: grossPnlUsd(pos.entryPrice, price, pos.side, pos.qty, q2u),
        fee,
        feeCurrency: instrument.quoteAsset,
        feeUsd: stored(fee.mul(q2u)),
        closeQuoteToUsd: stored(q2u),
      });
    } catch (err) {
      log.error({ err, clientOrderId: `x:${pos.id}` }, 'exit write failed, retrying on the next price');
      pos.owed = closeReason;
      pos.queued = false;
      return false;
    }
    this.positions.delete(pos.id);
    if (!closed) return false; // already closed by an earlier write
    this.balance = closed.balance;
    log.info({ price: price.toFixed(), realizedPnl: closed.realizedPnl.toFixed() }, 'paper position closed');
    events.push(
      makeEvent('position.closed', {
        positionId: pos.id,
        symbol: instrument.symbol,
        closeReason,
        realizedPnl: toDecimalString(closed.realizedPnl),
      }),
    );
    await this.recordRealized(pos.strategyId, closed.realizedPnl, closed.closedAt, events);
    events.push(this.accountEvent());
    return true;
  }

  // Adds a close to today's total and pushes risk.halted once, from the close that crosses the limit.
  private async recordRealized(strategyId: string, realized: Decimal, closedAt: Date, events: BotEvent[]): Promise<void> {
    if (utcDay(closedAt) !== this.today.day) {
      this.today = await store.loadTodayRealized(this.d.prisma, this.d.accountId);
      return;
    }
    const before = this.today.byStrategy.get(strategyId) ?? ZERO;
    const after = before.plus(realized);
    this.today.byStrategy.set(strategyId, after);
    const strategy = this.strategies.find((s) => s.id === strategyId);
    const limit = strategy?.risk?.dailyLossLimit.neg();
    if (limit && before.gt(limit) && after.lte(limit)) {
      this.d.log.warn({ strategy: strategy!.name, todayRealizedPnl: after.toFixed() }, 'daily loss limit reached, no new entries today');
      events.push(
        makeEvent('risk.halted', {
          strategyId,
          todayRealizedPnl: toDecimalString(after),
          dailyLossLimit: toDecimalString(strategy!.risk!.dailyLossLimit),
        }),
      );
    }
  }

  // ---- kill ----

  private async killSweep(): Promise<void> {
    const created = await store.createKillOrders(this.d.prisma, this.d.accountId);
    await this.loadPositions();
    this.d.log.warn({ killOrders: created, openPositions: this.positions.size }, 'kill sweep done');
    for (const id of new Set([...this.positions.values()].map((p) => p.instrumentId))) this.checkInstrument(id);
  }

  // ---- marks and snapshots ----

  private async mark(): Promise<void> {
    const marks: Array<{ id: string; markPrice: Decimal; unrealizedPnl: Decimal }> = [];
    for (const pos of this.positions.values()) {
      const instrument = this.instruments.get(pos.instrumentId);
      const quote = this.d.marketData.getQuote(pos.instrumentId);
      if (!instrument || !quote) continue;
      const q2u = this.q2u(instrument.quoteAsset, false) ?? pos.entryQuoteToUsd;
      const m = markPosition({ side: pos.side, qty: pos.qty, entryPrice: pos.entryPrice, fees: pos.fees, q2u }, quote);
      if (pos.markPrice?.eq(m.markPrice) && pos.unrealized.eq(m.unrealizedPnl)) continue;
      pos.markPrice = m.markPrice;
      pos.unrealized = m.unrealizedPnl;
      marks.push({ id: pos.id, ...m });
    }
    const equity = stored(this.equity());
    if (marks.length === 0 && this.lastWrittenEquity?.eq(equity)) return;
    await store.writeMarks(this.d.prisma, this.d.accountId, marks, equity);
    this.lastWrittenEquity = equity;
    if (!this.lastPushedEquity?.eq(equity)) await this.publish([this.accountEvent()]);
  }

  private accountEvent(): BotEvent {
    const equity = stored(this.equity());
    this.lastPushedEquity = equity;
    return makeEvent('account.updated', {
      accountId: this.d.accountId,
      balance: toDecimalString(this.balance),
      equity: toDecimalString(equity),
    });
  }

  // On every quarter hour UTC; missed quarters are not backfilled.
  private scheduleSnapshot(): void {
    if (this.stopped) return;
    const at = nextSnapshotAt(Date.now());
    const timer = setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== timer);
      void this.enqueue('snapshot', () =>
        store.insertSnapshot(this.d.prisma, this.d.accountId, new Date(at), this.balance, stored(this.equity()), this.positions.size),
      );
      this.scheduleSnapshot();
    }, at - Date.now());
    this.timers.push(timer);
  }

  private async publish(events: BotEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.d.publish(events).catch((err: unknown) => this.d.log.warn({ err }, 'could not publish trading events'));
  }
}
