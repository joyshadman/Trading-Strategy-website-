import express, { type ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import type { PrismaClient } from '../db/prisma.js';
import { commandRoutes } from './commands.js';
import { requestGuard } from './guard.js';
import { getHealth } from './health.js';
import { marketRoutes } from './market.js';
import { tradingRoutes } from './trading.js';

export interface AppDeps {
  prisma: PrismaClient;
  log: Logger;
  // The only Origin allowed to write (spec 0004 AC-10).
  webOrigin: string;
  // Wakes the worker right away; the worker's 1s poll is the backup if this fails.
  wakeWorker: () => Promise<void>;
}

export function createApp({ prisma, log, webOrigin, wakeWorker }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // First, before the body parser and every route.
  app.use(requestGuard(webOrigin, log));
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', async (_req, res) => {
    const { status, body } = await getHealth(prisma);
    res.status(status).json(body);
  });

  app.use(commandRoutes(prisma, log, wakeWorker));
  app.use(marketRoutes(prisma));
  app.use(tradingRoutes(prisma, log));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    log.error({ err }, 'request failed');
    res.status(500).json({ error: 'internal error' });
  };
  app.use(onError);

  return app;
}
