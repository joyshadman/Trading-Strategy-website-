import type { HealthResponse, WorkerStatus } from '@trading/shared';
import type { PrismaClient } from '../db/prisma.js';
import { WORKER_DOWN_AFTER_SECONDS } from '../worker/constants.js';

interface RunRow {
  id: string;
  state: 'idle' | 'running' | 'killed';
  startedAt: Date;
  lastHeartbeatAt: Date;
  stoppedAt: Date | null;
  age: number;
}

export function workerStatusFrom(row: RunRow | undefined): WorkerStatus {
  if (!row) return 'none';
  if (row.stoppedAt || row.age > WORKER_DOWN_AFTER_SECONDS) return 'down';
  return 'up';
}

// Age uses the database clock (now()), so API and worker clocks can't disagree.
export async function getHealth(prisma: PrismaClient): Promise<{ status: number; body: HealthResponse }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return {
      status: 503,
      body: { api: 'ok', db: 'down', worker: { status: 'down', lastHeartbeatAt: null, ageSeconds: null }, bot: null },
    };
  }

  const rows = await prisma.$queryRaw<RunRow[]>`
    SELECT id, state::text AS state, "startedAt", "lastHeartbeatAt", "stoppedAt",
           EXTRACT(EPOCH FROM (now() - "lastHeartbeatAt"))::float8 AS age
    FROM "BotRun"
    ORDER BY "startedAt" DESC
    LIMIT 1`;
  const row = rows[0];

  return {
    status: 200,
    body: {
      api: 'ok',
      db: 'ok',
      worker: {
        status: workerStatusFrom(row),
        lastHeartbeatAt: row ? row.lastHeartbeatAt.toISOString() : null,
        ageSeconds: row ? Math.round(row.age * 10) / 10 : null,
      },
      // The newest run's state (spec 0004), so one poll covers offline detection and the state.
      bot: row ? { runId: row.id, state: row.state, startedAt: row.startedAt.toISOString() } : null,
    },
  };
}
