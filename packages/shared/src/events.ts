import { z } from 'zod';
import { decimalString } from './decimal.js';
import { feedStateSchema } from './feeds.js';
import { SKIP_REASONS } from './paper.js';
import { commandTypeSchema } from './api.js';

const sideSchema = z.enum(['buy', 'sell']);

// Every WebSocket message (and every bot_events NOTIFY payload) is one of these.
// Payloads stay tiny: details are fetched over REST.

const at = z.iso.datetime();

export const botEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), payload: z.object({ serverTime: at }), at }),
  z.object({ type: z.literal('bot.started'), payload: z.object({ runId: z.string() }), at }),
  z.object({ type: z.literal('bot.stopped'), payload: z.object({ runId: z.string() }), at }),
  z.object({ type: z.literal('bot.killed'), payload: z.object({ runId: z.string() }), at }),
  z.object({
    type: z.literal('command.handled'),
    // type and target let the panel know what to refetch without a lookup (spec 0004).
    payload: z.object({
      commandId: z.string(),
      type: commandTypeSchema,
      status: z.enum(['done', 'failed']),
      error: z.string().optional(),
      strategyId: z.string().optional(),
      positionId: z.string().optional(),
    }),
    at,
  }),
  // Trading events (spec 0003). Money is a decimal string.
  z.object({
    type: z.literal('signal.created'),
    payload: z.object({
      signalId: z.string(),
      strategyId: z.string(),
      symbol: z.string(),
      side: sideSchema,
      outcome: z.enum(['ordered', 'skipped']),
      skipReason: z.enum(SKIP_REASONS).optional(),
    }),
    at,
  }),
  z.object({
    type: z.literal('position.opened'),
    payload: z.object({ positionId: z.string(), strategyId: z.string(), symbol: z.string(), side: sideSchema }),
    at,
  }),
  z.object({
    type: z.literal('position.closed'),
    payload: z.object({
      positionId: z.string(),
      symbol: z.string(),
      closeReason: z.enum(['stop_loss', 'take_profit', 'opposite_signal', 'kill', 'manual']),
      realizedPnl: decimalString,
    }),
    at,
  }),
  z.object({
    type: z.literal('risk.halted'),
    payload: z.object({ strategyId: z.string(), todayRealizedPnl: decimalString, dailyLossLimit: decimalString }),
    at,
  }),
  z.object({
    type: z.literal('account.updated'),
    payload: z.object({ accountId: z.string(), balance: decimalString, equity: decimalString }),
    at,
  }),
  z.object({
    type: z.literal('feed.status'),
    payload: z.object({
      instrumentId: z.string(),
      symbol: z.string(),
      status: feedStateSchema,
      lastError: z.string().optional(),
    }),
    at,
  }),
]);

export type BotEvent = z.infer<typeof botEventSchema>;
export type BotEventType = BotEvent['type'];

export const BOT_EVENTS_CHANNEL = 'bot_events';
export const BOT_COMMANDS_CHANNEL = 'bot_commands';

export function makeEvent<T extends BotEventType>(
  type: T,
  payload: Extract<BotEvent, { type: T }>['payload'],
): Extract<BotEvent, { type: T }> {
  return { type, payload, at: new Date().toISOString() } as Extract<BotEvent, { type: T }>;
}
