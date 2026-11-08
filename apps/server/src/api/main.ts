import '../utc.js';
import { createServer } from 'node:http';
import { BOT_COMMANDS_CHANNEL } from '@trading/shared';
import { directDatabaseUrl, loadOrExit, parseApiConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createPrisma } from '../db/prisma.js';
import { notify } from '../db/pg.js';
import { createApp } from './app.js';
import { attachWebSocket } from './ws.js';
import { listenForEvents } from './listener.js';

const config = loadOrExit('api', parseApiConfig());
const log = createLogger('api', config.LOG_LEVEL, config.NODE_ENV === 'development');
const prisma = createPrisma(config.DATABASE_URL);

const server = createServer();
const hub = attachWebSocket(server, config.WEB_ORIGIN, log);
const listener = listenForEvents(directDatabaseUrl(config), log, (event) => hub.broadcast(event));

const app = createApp({
  prisma,
  log,
  webOrigin: config.WEB_ORIGIN,
  wakeWorker: async () => {
    const client = listener.client();
    if (client) await notify(client, BOT_COMMANDS_CHANNEL, {});
  },
});
server.on('request', app);

// Open a pool connection now, so the first request doesn't pay the ~2.5s connect to the
// remote database.
await prisma.$queryRaw`SELECT 1`.catch((err: unknown) => log.warn({ err }, 'database not reachable yet'));

server.listen(config.API_PORT, config.API_HOST, () => {
  log.info(`api listening on http://${config.API_HOST}:${config.API_PORT}`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  await hub.close();
  await listener.stop();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
