import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { createPrisma, type PrismaClient } from './db/prisma.js';
import { PAPER_ACCOUNT_NAME } from './worker/constants.js';

// Needs a real, migrated Postgres test database (constraints can't be proven on a mock).
// Skipped when DATABASE_URL_TEST is not set.
const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)('database (DATABASE_URL_TEST)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createPrisma(url!);
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Fill", "Order", "Signal", "Position", "RiskSettings", "StrategyInstrument", "Strategy", "Candle", "Instrument", "Account", "BotRun", "BotCommand" CASCADE',
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('seeds exactly one paper account, even when run twice (AC-4)', async () => {
    await seed(prisma, '10000');
    await seed(prisma, '10000');
    expect(await prisma.account.count({ where: { name: PAPER_ACCOUNT_NAME } })).toBe(1);
  });

  it('keeps decimals exact through the database (AC-5)', async () => {
    const account = await prisma.account.update({
      where: { name: PAPER_ACCOUNT_NAME },
      data: { balance: '0.3', equity: '0.1' },
    });
    expect(account.balance.toFixed()).toBe('0.3');
    expect(account.balance.minus(account.equity).toFixed()).toBe('0.2');
  });

  it('rejects a second order with the same clientOrderId (AC-6)', async () => {
    const account = await prisma.account.findUniqueOrThrow({ where: { name: PAPER_ACCOUNT_NAME } });
    const instrument = await prisma.instrument.create({
      data: {
        symbol: 'BTCUSDT',
        assetClass: 'crypto',
        venue: 'test',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        tickSize: '0.01',
        minQty: '0.00001',
      },
    });
    const strategy = await prisma.strategy.create({
      data: { name: 't', kind: 'ema_rsi_macd', params: {}, timeframe: '1m', accountId: account.id },
    });
    const order = {
      clientOrderId: 'dup-1',
      accountId: account.id,
      strategyId: strategy.id,
      instrumentId: instrument.id,
      side: 'buy' as const,
      type: 'market' as const,
      qty: '0.001',
    };
    await prisma.order.create({ data: order });
    await expect(prisma.order.create({ data: order })).rejects.toThrow();
  });
});
