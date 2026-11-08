import { Router, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  COMMAND_LIST_LIMIT_DEFAULT,
  COMMAND_LIST_LIMIT_MAX,
  createCommandBody,
  type CommandListResponse,
  type CommandResponse,
  type CreateCommandBody,
} from '@trading/shared';
import type { PrismaClient } from '../db/prisma.js';
import { UUID_RE, before, cursorParam, encodeCursor, limitParam } from './trading.js';

interface CommandRow {
  id: string;
  type: CommandResponse['type'];
  status: CommandResponse['status'];
  error: string | null;
  handledAt: Date | null;
  strategyId: string | null;
  positionId: string | null;
}

function toCommandResponse(row: CommandRow): CommandResponse {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    error: row.error,
    handledAt: row.handledAt ? row.handledAt.toISOString() : null,
    strategyId: row.strategyId,
    positionId: row.positionId,
  };
}

const listQuery = z.object({
  limit: limitParam(COMMAND_LIST_LIMIT_DEFAULT, COMMAND_LIST_LIMIT_MAX),
  cursor: cursorParam,
});

const targetOf = (body: CreateCommandBody) => ({
  strategyId: 'strategyId' in body ? body.strategyId : null,
  positionId: 'positionId' in body ? body.positionId : null,
});

// Bot commands (specs 0001 and 0004). The API only queues them; the worker carries them out,
// so the worker stays the only writer of trading tables.
export function commandRoutes(prisma: PrismaClient, log: Logger, wakeWorker: () => Promise<void>): Router {
  const router = Router();

  // A database failure in a handler means the database is down (503), as in the trading reads.
  const db = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try {
      await handler(req, res);
    } catch (err) {
      log.error({ err, path: req.path }, 'command request failed');
      res.status(503).json({ error: 'database unavailable' });
    }
  };

  // The target must exist (404); a position must be open with no exit order yet (409).
  // The worker checks again in its own statement, since the state can change meanwhile.
  async function targetError(body: CreateCommandBody): Promise<{ status: number; error: string } | null> {
    if (body.type === 'enable_strategy' || body.type === 'disable_strategy') {
      const strategy = await prisma.strategy.findUnique({ where: { id: body.strategyId }, select: { id: true } });
      return strategy ? null : { status: 404, error: 'strategy not found' };
    }
    if (body.type === 'close_position') {
      const position = await prisma.position.findUnique({
        where: { id: body.positionId },
        select: { status: true, orders: { where: { clientOrderId: `x:${body.positionId}` }, select: { id: true } } },
      });
      if (!position) return { status: 404, error: 'position not found' };
      if (position.status !== 'open') return { status: 409, error: 'position not open' };
      if (position.orders.length > 0) return { status: 409, error: 'position already closing' };
    }
    return null;
  }

  router.post(
    '/api/bot/commands',
    db(async (req, res) => {
      const parsed = createCommandBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ error: 'invalid command', details: parsed.error.issues });
        return;
      }
      const body = parsed.data;
      const { strategyId, positionId } = targetOf(body);
      log.info({ type: body.type, strategyId, positionId }, 'command received');

      const invalid = await targetError(body);
      if (invalid) {
        res.status(invalid.status).json({ error: invalid.error });
        return;
      }

      // Check and insert in one statement: at most one pending command per (type, target).
      const created = await prisma.$queryRaw<CommandRow[]>`
        INSERT INTO "BotCommand" (id, type, "strategyId", "positionId")
        SELECT gen_random_uuid(), ${body.type}::"CommandType", ${strategyId}::uuid, ${positionId}::uuid
        WHERE NOT EXISTS (
          SELECT 1 FROM "BotCommand"
          WHERE type = ${body.type}::"CommandType" AND status = 'pending'
            AND "strategyId" IS NOT DISTINCT FROM ${strategyId}::uuid
            AND "positionId" IS NOT DISTINCT FROM ${positionId}::uuid
        )
        RETURNING id, type::text AS type, status::text AS status, error, "handledAt", "strategyId", "positionId"`;
      const command = created[0];
      if (!command) {
        const pending = await prisma.botCommand.findFirst({ where: { type: body.type, status: 'pending', strategyId, positionId } });
        res.status(409).json({ error: `a ${body.type} command is already pending`, details: { id: pending?.id } });
        return;
      }
      wakeWorker().catch((err: unknown) => log.warn({ err }, 'could not wake worker, it will poll'));
      res.status(201).json(toCommandResponse(command));
    }),
  );

  // The action log (AC-11): newest first, cursor paged.
  router.get(
    '/api/bot/commands',
    db(async (req, res) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({ error: 'invalid query', details: parsed.error.issues });
        return;
      }
      const q = parsed.data;
      const rows = await prisma.botCommand.findMany({
        where: before('createdAt', q.cursor),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        include: {
          strategy: { select: { id: true, name: true } },
          position: { select: { id: true, instrument: { select: { symbol: true } } } },
        },
      });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const body: CommandListResponse = {
        commands: page.map((c) => ({
          id: c.id,
          type: c.type,
          status: c.status,
          error: c.error,
          createdAt: c.createdAt.toISOString(),
          handledAt: c.handledAt ? c.handledAt.toISOString() : null,
          strategy: c.strategy,
          position: c.position ? { id: c.position.id, symbol: c.position.instrument.symbol } : null,
        })),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
      res.json(body);
    }),
  );

  router.get(
    '/api/bot/commands/:id',
    db(async (req, res) => {
      const id = String(req.params.id);
      const command = UUID_RE.test(id) ? await prisma.botCommand.findUnique({ where: { id } }) : null;
      if (!command) {
        res.status(404).json({ error: 'command not found' });
        return;
      }
      res.json(toCommandResponse(command));
    }),
  );

  return router;
}
