import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@trading/shared';
import { createPrisma, type PrismaClient } from '../db/prisma.js';
import { PAPER_ACCOUNT_NAME } from '../worker/constants.js';
import { isOpenPositionConflict, PaperBroker } from './broker.js';
import * as store from './store.js';

// The paper trading SQL against a real, migrated and seeded Postgres (spec 0003). Every test
// runs inside one transaction that is rolled back, so it leaves nothing behind.
// Skipped when DATABASE_URL_TEST is not set.
const url = process.env.DATABASE_URL_TEST;

class Rollback extends Error {}

// Each statement is a round trip to the remote database, so allow well over the 5s default.
describe.skipIf(!url)('paper trading SQL (DATABASE_URL_TEST)', { timeout: 60_000 }, () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma(url!);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  // Runs `fn` in a transaction and always rolls it back.
  async function inRollback(fn: (tx: PrismaClient) => Promise<void>): Promise<void> {
    await prisma
      .$transaction(
        async (tx) => {
          await fn(tx as unknown as PrismaClient);
          throw new Rollback();
        },
        { timeout: 60_000, maxWait: 20_000 },
      )
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  }

  async function fixtures(tx: PrismaClient) {
    const account = await tx.account.findUniqueOrThrow({ where: { name: PAPER_ACCOUNT_NAME } });
    const strategy = await tx.strategy.findFirstOrThrow({ where: { accountId: account.id, name: 'crypto-trend' } });
    const instrument = await tx.instrument.findFirstOrThrow({ where: { symbol: 'BTCUSDT' } });
    return { account, strategy, instrument };
  }

  it('opens, refuses a second open, kills, and closes with exact accounting (AC-6, AC-10, AC-11, AC-14)', async () => {
    await inRollback(async (tx) => {
      const { account, strategy, instrument } = await fixtures(tx);
      const broker = new PaperBroker(tx);
      const m = (v: string) => new Money(v);

      const signalId = randomUUID();
      const signal = { id: signalId, strategyId: strategy.id, instrumentId: instrument.id, side: 'buy' as const, candleTime: new Date('2000-01-01T00:00:00Z') };
      const indicators = { ema9: 1, ema21: 1, ema50: 1, rsi: 50, macdHist: 0.1, z: 0.2, trend: 'bull' as const };
      expect(await store.insertSignal(tx, { ...signal, indicators })).toBe(true);
      expect(await store.insertSignal(tx, { ...signal, id: randomUUID(), indicators })).toBe(false); // AC-3: candle claimed once

      const entry = {
        signalId,
        accountId: account.id,
        strategyId: strategy.id,
        instrumentId: instrument.id,
        side: 'buy' as const,
        qty: m('0.03'),
        price: m('100050'),
        stopLoss: m('98649.3'),
        takeProfit: m('102851.4'),
        fee: m('3.0015'),
        feeCurrency: 'USDT',
        feeUsd: m('3.0015'),
        entryQuoteToUsd: m('1'),
      };
      const opened = await broker.openPosition(entry);
      const sig = await tx.signal.findUniqueOrThrow({ where: { id: signalId } });
      expect(sig.outcome).toBe('ordered');
      const order = await tx.order.findUniqueOrThrow({ where: { clientOrderId: `e:${signalId}` } });
      expect([order.reason, order.status, order.positionId]).toEqual(['entry', 'filled', opened.positionId]);

      // A second open position on the same strategy and pair is refused by the partial index.
      const signal2 = randomUUID();
      await store.insertSignal(tx, { ...signal, id: signal2, candleTime: new Date('2000-01-01T00:15:00Z'), indicators });
      await expect(broker.openPosition({ ...entry, signalId: signal2 })).rejects.toSatisfy(isOpenPositionConflict);
    });
  });

  it('closes through a pending kill order and moves the balance by exactly realizedPnl (AC-10, AC-14)', async () => {
    await inRollback(async (tx) => {
      const { account, strategy, instrument } = await fixtures(tx);
      const broker = new PaperBroker(tx);
      const m = (v: string) => new Money(v);
      const signalId = randomUUID();
      await store.insertSignal(tx, {
        id: signalId,
        strategyId: strategy.id,
        instrumentId: instrument.id,
        side: 'buy',
        candleTime: new Date('2000-01-02T00:00:00Z'),
        indicators: { ema9: 1, ema21: 1, ema50: 1, rsi: 50, macdHist: 0.1, z: 0.2, trend: 'bull' },
      });
      const opened = await broker.openPosition({
        signalId,
        accountId: account.id,
        strategyId: strategy.id,
        instrumentId: instrument.id,
        side: 'buy',
        qty: m('0.03'),
        price: m('100050'),
        stopLoss: m('98649.3'),
        takeProfit: m('102851.4'),
        fee: m('3.0015'),
        feeCurrency: 'USDT',
        feeUsd: m('3.0015'),
        entryQuoteToUsd: m('1'),
      });
      const before = await tx.account.findUniqueOrThrow({ where: { id: account.id } });

      expect(await store.createKillOrders(tx, account.id)).toBe(1);
      expect(await store.createKillOrders(tx, account.id)).toBe(0); // idempotent
      expect((await store.loadPendingKills(tx, account.id)).has(opened.positionId)).toBe(true);

      // Exit at 99950 (last 100000 minus slippage): gross = (99950 − 100050) × 0.03 = −3; fees 3.0015 + 2.9985.
      const exit = {
        positionId: opened.positionId,
        strategyId: strategy.id,
        instrumentId: instrument.id,
        side: 'sell' as const,
        qty: m('0.03'),
        price: m('99950'),
        reason: 'kill' as const,
        grossPnlUsd: m('-3'),
        fee: m('2.9985'),
        feeCurrency: 'USDT',
        feeUsd: m('2.9985'),
        closeQuoteToUsd: m('1'),
      };
      const closed = await broker.closePosition(exit);
      expect(closed?.realizedPnl.toFixed()).toBe('-9');
      expect(closed?.balance.toFixed()).toBe(new Money(before.balance.toFixed()).minus(9).toFixed());
      expect(await broker.closePosition(exit)).toBeNull(); // AC-11: never closed twice

      const pos = await tx.position.findUniqueOrThrow({ where: { id: opened.positionId } });
      expect([pos.status, pos.closeReason, pos.fees.toFixed(), pos.exitPrice?.toFixed()]).toEqual(['closed', 'kill', '6', '99950']);
      const kill = await tx.order.findUniqueOrThrow({ where: { clientOrderId: `x:${opened.positionId}` }, include: { fills: true } });
      expect([kill.status, kill.reason, kill.fills.length]).toEqual(['filled', 'kill', 1]);

      const today = await store.loadTodayRealized(tx, account.id);
      expect(today.byStrategy.get(strategy.id)?.lte(-9)).toBe(true);
    });
  });

  it('writes marks, equity, and a snapshot (AC-14)', async () => {
    await inRollback(async (tx) => {
      const { account } = await fixtures(tx);
      const m = (v: string) => new Money(v);
      await store.writeMarks(tx, account.id, [], m('12345.5'));
      expect((await tx.account.findUniqueOrThrow({ where: { id: account.id } })).equity.toFixed()).toBe('12345.5');
      const at = new Date('2000-01-01T00:15:00Z');
      await store.insertSnapshot(tx, account.id, at, m('10000'), m('12345.5'), 0);
      await store.insertSnapshot(tx, account.id, at, m('10000'), m('1'), 0); // same quarter: ignored
      const snaps = await tx.equitySnapshot.findMany({ where: { accountId: account.id, takenAt: at } });
      expect(snaps.map((s) => s.equity.toFixed())).toEqual(['12345.5']);
    });
  });
});
