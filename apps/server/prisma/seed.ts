import 'dotenv/config';
import { DECIMAL_STRING_RE, DEFAULT_EMA_RSI_MACD_PARAMS } from '@trading/shared';
import { createPrisma, type PrismaClient } from '../src/db/prisma.js';
import { PAPER_ACCOUNT_NAME } from '../src/worker/constants.js';
import { INSTRUMENTS, PLACEHOLDER_STEP } from '../src/feed/instruments.js';

// Safe to run again: upserts the paper account, the 12 instruments, and the two paper
// strategies, and leaves an existing balance (and refreshed tick sizes) alone.
export async function seed(prisma: PrismaClient, startBalance: string): Promise<void> {
  for (const def of INSTRUMENTS) {
    await prisma.instrument.upsert({
      where: { venue_symbol: { venue: def.venue, symbol: def.symbol } },
      update: { venueSymbol: def.venueSymbol },
      create: { ...def, tickSize: PLACEHOLDER_STEP, minQty: PLACEHOLDER_STEP },
    });
  }
  if (!DECIMAL_STRING_RE.test(startBalance)) {
    throw new Error(`PAPER_START_BALANCE must be a decimal string, got "${startBalance}"`);
  }
  const account = await prisma.account.upsert({
    where: { name: PAPER_ACCOUNT_NAME },
    update: {},
    create: {
      name: PAPER_ACCOUNT_NAME,
      mode: 'paper',
      venue: 'paper',
      currency: 'USD',
      balance: startBalance,
      equity: startBalance,
    },
  });
  await seedStrategies(prisma, account.id);
}

// The two paper strategies (spec 0003 AC-1). Created only when missing, so later edits to
// settings or risk limits survive a second seed; pair links are always made sure of.
const STRATEGIES = [
  {
    name: 'crypto-trend',
    assetClass: 'crypto' as const,
    allowShort: false,
    risk: { stopLossPct: '1.4', takeProfitPct: '2.8', maxPositionSize: '3000' },
  },
  {
    name: 'forex-trend',
    assetClass: 'forex' as const,
    allowShort: true,
    risk: { stopLossPct: '0.09', takeProfitPct: '0.18', maxPositionSize: '150000' },
  },
];

async function seedStrategies(prisma: PrismaClient, accountId: string): Promise<void> {
  for (const def of STRATEGIES) {
    const existing = await prisma.strategy.findFirst({ where: { accountId, name: def.name } });
    const strategy =
      existing ??
      (await prisma.strategy.create({
        data: {
          name: def.name,
          kind: 'ema_rsi_macd',
          params: { ...DEFAULT_EMA_RSI_MACD_PARAMS, allowShort: def.allowShort },
          timeframe: '15m',
          enabled: true,
          accountId,
        },
      }));
    await prisma.riskSettings.upsert({
      where: { strategyId: strategy.id },
      update: {},
      create: { strategyId: strategy.id, ...def.risk, maxOpenTrades: 3, dailyLossLimit: '300', riskPerTradePct: '1' },
    });
    const instruments = await prisma.instrument.findMany({ where: { assetClass: def.assetClass, venue: { in: ['binance', 'oanda'] } } });
    await prisma.strategyInstrument.createMany({
      data: instruments.map((i) => ({ strategyId: strategy.id, instrumentId: i.id })),
      skipDuplicates: true,
    });
  }
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('prisma/seed.ts');
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. See apps/server/.env.example.');
    process.exit(1);
  }
  const prisma = createPrisma(url);
  try {
    await seed(prisma, process.env.PAPER_START_BALANCE ?? '10000');
    console.log(`seeded account "${PAPER_ACCOUNT_NAME}"`);
  } finally {
    await prisma.$disconnect();
  }
}
