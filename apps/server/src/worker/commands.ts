import { makeEvent, type BotEvent, type CommandType, type RunCommandType } from '@trading/shared';
import type { PrismaClient } from '../db/prisma.js';

export type BotState = 'idle' | 'running' | 'killed';

export interface PendingCommand {
  id: string;
  type: CommandType;
  strategyId: string | null;
  positionId: string | null;
}

// A command the trader runs in its queue (spec 0004).
export type TraderCommand = PendingCommand & { type: Exclude<CommandType, RunCommandType> };

export const isRunCommand = (c: PendingCommand): c is PendingCommand & { type: RunCommandType } =>
  c.type === 'start' || c.type === 'stop' || c.type === 'kill';

export interface HandledCommand {
  events: BotEvent[];
  // The run's state after this command, for the paper trader (spec 0003).
  state: BotState;
}

const EVENT_FOR = {
  start: 'bot.started',
  stop: 'bot.stopped',
  kill: 'bot.killed',
} as const;

const STATE_FOR = { start: 'running', stop: 'idle', kill: 'killed' } as const;

// The oldest pending command of any type: commands run one at a time, oldest first, across
// every type (spec 0004 AC-5). The worker is the only consumer (advisory lock) and awaits each
// command before reading the next, so no row lock is needed between this read and its handling.
export async function nextPendingCommand(prisma: PrismaClient): Promise<PendingCommand | null> {
  const rows = await prisma.$queryRaw<PendingCommand[]>`
    SELECT id, type::text AS type, "strategyId", "positionId" FROM "BotCommand"
    WHERE status = 'pending'
    ORDER BY "createdAt", id
    LIMIT 1`;
  return rows[0] ?? null;
}

// Applies a start, stop, or kill in ONE statement (one round trip; the database is remote, so
// each round trip costs ~300ms):
//   start → running · stop → idle (no new entries)
//   kill  → killed (the paper trader then runs its kill sweep in its own queue, spec 0003)
// If the statement fails (a database error), nothing is changed and the command stays pending
// for the next drain. Returns null when the command is no longer pending. Events are returned,
// not sent: the caller publishes them only after this statement commits.
export async function handleRunCommand(
  prisma: PrismaClient,
  runId: string,
  command: PendingCommand & { type: RunCommandType },
): Promise<HandledCommand | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH claimed AS (
      SELECT id, type FROM "BotCommand" WHERE id = ${command.id}::uuid AND status = 'pending'
    ),
    run AS (
      UPDATE "BotRun" SET state = CASE claimed.type
          WHEN 'start' THEN 'running'::"BotState"
          WHEN 'stop' THEN 'idle'::"BotState"
          WHEN 'kill' THEN 'killed'::"BotState"
        END
      FROM claimed
      WHERE "BotRun".id = ${runId}::uuid
    )
    UPDATE "BotCommand" SET status = 'done', "handledAt" = now()
    FROM claimed
    WHERE "BotCommand".id = claimed.id
    RETURNING "BotCommand".id`;

  if (!rows[0]) return null;
  return {
    state: STATE_FOR[command.type],
    events: [
      makeEvent(EVENT_FOR[command.type], { runId }),
      makeEvent('command.handled', { commandId: command.id, type: command.type, status: 'done' }),
    ],
  };
}

// The fallback when a command's job throws: it must never stay pending, or it would block
// the commands behind it (spec 0004 AC-5).
export async function failCommand(prisma: PrismaClient, id: string, error: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "BotCommand" SET status = 'failed', error = ${error}, "handledAt" = now()
    WHERE id = ${id}::uuid AND status = 'pending'`;
}

export function handledEvent(command: PendingCommand, result: { status: 'done' } | { status: 'failed'; error: string }): BotEvent {
  return makeEvent('command.handled', {
    commandId: command.id,
    type: command.type,
    status: result.status,
    ...(result.status === 'failed' ? { error: result.error } : {}),
    ...(command.strategyId ? { strategyId: command.strategyId } : {}),
    ...(command.positionId ? { positionId: command.positionId } : {}),
  });
}
