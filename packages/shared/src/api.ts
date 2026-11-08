import { z } from 'zod';
import { decimalString } from './decimal.js';

// start, stop and kill act on the whole bot; the rest (spec 0004) carry a target.
export const RUN_COMMAND_TYPES = ['start', 'stop', 'kill'] as const;
export const STRATEGY_COMMAND_TYPES = ['enable_strategy', 'disable_strategy'] as const;
export const COMMAND_TYPES = [...RUN_COMMAND_TYPES, ...STRATEGY_COMMAND_TYPES, 'close_position'] as const;
export const commandTypeSchema = z.enum(COMMAND_TYPES);
export type CommandType = z.infer<typeof commandTypeSchema>;
export type RunCommandType = (typeof RUN_COMMAND_TYPES)[number];

export const createCommandBody = z.discriminatedUnion('type', [
  z.object({ type: z.enum(RUN_COMMAND_TYPES) }),
  z.object({ type: z.enum(STRATEGY_COMMAND_TYPES), strategyId: z.uuid() }),
  z.object({ type: z.literal('close_position'), positionId: z.uuid() }),
]);
export type CreateCommandBody = z.infer<typeof createCommandBody>;

export const commandStatusSchema = z.enum(['pending', 'done', 'failed']);

export const commandResponse = z.object({
  id: z.string(),
  type: commandTypeSchema,
  status: commandStatusSchema,
  error: z.string().nullable(),
  handledAt: z.iso.datetime().nullable(),
  strategyId: z.string().nullable(),
  positionId: z.string().nullable(),
});
export type CommandResponse = z.infer<typeof commandResponse>;

// The action log (spec 0004 AC-11), newest first.
export const COMMAND_LIST_LIMIT_DEFAULT = 20;
export const COMMAND_LIST_LIMIT_MAX = 100;

export const commandListResponse = z.object({
  commands: z.array(
    z.object({
      id: z.string(),
      type: commandTypeSchema,
      status: commandStatusSchema,
      error: z.string().nullable(),
      createdAt: z.iso.datetime(),
      handledAt: z.iso.datetime().nullable(),
      strategy: z.object({ id: z.string(), name: z.string() }).nullable(),
      position: z.object({ id: z.string(), symbol: z.string() }).nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type CommandListResponse = z.infer<typeof commandListResponse>;

export const workerStatusSchema = z.enum(['up', 'down', 'none']);
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

export const healthResponse = z.object({
  api: z.literal('ok'),
  db: z.enum(['ok', 'down']),
  worker: z.object({
    status: workerStatusSchema,
    lastHeartbeatAt: z.iso.datetime().nullable(),
    ageSeconds: z.number().nullable(),
  }),
  // The newest BotRun (spec 0004); null when there is none or the database is down.
  bot: z
    .object({ runId: z.string(), state: z.enum(['idle', 'running', 'killed']), startedAt: z.iso.datetime() })
    .nullable(),
});
export type HealthResponse = z.infer<typeof healthResponse>;

export const errorResponse = z.object({ error: z.string(), details: z.unknown().optional() });

// Trading reads (spec 0003). Every money value is a decimal string; lists are cursor paged.

const money = decimalString;
const iso = z.iso.datetime();
const side = z.enum(['buy', 'sell']);
const ref = z.object({ id: z.string(), name: z.string() });
const closeReason = z.enum(['stop_loss', 'take_profit', 'opposite_signal', 'kill', 'manual']);

export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;
export const EQUITY_LIMIT_MAX = 1000;

export const accountResponse = z.object({
  id: z.string(),
  name: z.string(),
  currency: z.string(),
  balance: money,
  equity: money,
  marginUsed: money,
  freeMargin: money,
  openPositions: z.number().int(),
  todayRealizedPnl: money,
});
export type AccountResponse = z.infer<typeof accountResponse>;

export const strategyResponse = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  timeframe: z.string(),
  enabled: z.boolean(),
  params: z.unknown(),
  symbols: z.array(z.string()),
  risk: z
    .object({
      stopLossPct: money,
      takeProfitPct: money,
      maxPositionSize: money,
      maxOpenTrades: z.number().int(),
      dailyLossLimit: money,
      riskPerTradePct: money,
    })
    .nullable(),
  openPositions: z.number().int(),
  todayRealizedPnl: money,
  halted: z.boolean(),
});
export type StrategyResponse = z.infer<typeof strategyResponse>;

export const positionResponse = z.object({
  id: z.string(),
  strategy: ref,
  symbol: z.string(),
  side,
  qty: money,
  entryPrice: money,
  stopLoss: money.nullable(),
  takeProfit: money.nullable(),
  status: z.enum(['open', 'closed']),
  markPrice: money.nullable(),
  unrealizedPnl: money.nullable(),
  markedAt: iso.nullable(),
  exitPrice: money.nullable(),
  closeReason: closeReason.nullable(),
  fees: money,
  realizedPnl: money.nullable(),
  pendingClose: z.boolean(),
  openedAt: iso,
  closedAt: iso.nullable(),
});
export type PositionResponse = z.infer<typeof positionResponse>;

export const positionDetailResponse = positionResponse.extend({
  orders: z.array(
    z.object({
      id: z.string(),
      clientOrderId: z.string(),
      reason: z.enum(['entry', 'stop_loss', 'take_profit', 'opposite_signal', 'kill', 'manual']),
      side,
      type: z.string(),
      qty: money,
      status: z.string(),
      createdAt: iso,
    }),
  ),
  fills: z.array(
    z.object({ id: z.string(), orderId: z.string(), price: money, qty: money, fee: money, feeCurrency: z.string(), filledAt: iso }),
  ),
});

export const signalResponse = z.object({
  id: z.string(),
  strategy: ref,
  symbol: z.string(),
  side,
  outcome: z.enum(['ordered', 'skipped']),
  skipReason: z.string().nullable(),
  indicators: z.unknown(),
  candleTime: iso,
  createdAt: iso,
  orderId: z.string().nullable(),
});
export type SignalResponse = z.infer<typeof signalResponse>;

export const equitySnapshotResponse = z.object({ takenAt: iso, balance: money, equity: money, openPositions: z.number().int() });
export type EquitySnapshotResponse = z.infer<typeof equitySnapshotResponse>;
