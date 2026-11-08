import '../utc.js';
import { BOT_COMMANDS_CHANNEL, BOT_EVENTS_CHANNEL } from '@trading/shared';
import { directDatabaseUrl, loadOrExit, parseWorkerConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createPrisma } from '../db/prisma.js';
import { connectPg, notifyAll } from '../db/pg.js';
import { MarketDataFeed } from '../feed/feed.js';
import { PaperBroker } from '../trader/broker.js';
import { previousRunState } from '../trader/store.js';
import { Trader, type CommandResult } from '../trader/trader.js';
import {
  failCommand,
  handledEvent,
  handleRunCommand,
  isRunCommand,
  nextPendingCommand,
  type TraderCommand,
} from './commands.js';
import {
  COMMAND_POLL_MS,
  HEARTBEAT_MS,
  PAPER_ACCOUNT_NAME,
  STALE_COMMAND_SECONDS,
  WORKER_LOCK_KEY,
} from './constants.js';

const config = loadOrExit('worker', parseWorkerConfig());
const log = createLogger('worker', config.LOG_LEVEL, config.NODE_ENV === 'development');
const prisma = createPrisma(config.DATABASE_URL);
const pg = await connectPg(directDatabaseUrl(config));

// Losing this connection means losing the lock, so a second worker could start. Exit and
// let whoever runs us restart; startup recovery handles the rest.
pg.on('error', (err) => {
  log.fatal({ err }, 'lock connection lost, exiting');
  process.exit(1);
});

const lock = await pg.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [WORKER_LOCK_KEY]);
if (!lock.rows[0]?.ok) {
  log.error('another worker is running, exiting');
  await pg.end();
  await prisma.$disconnect();
  process.exit(1);
}

const paper = await prisma.account.findUnique({ where: { name: PAPER_ACCOUNT_NAME } });
if (!paper) {
  log.error(`account "${PAPER_ACCOUNT_NAME}" is missing, run "npm run db:seed" first`);
  process.exit(1);
}

// Startup recovery: close runs left open by a crash, and never replay old commands.
const crashed = await prisma.$executeRaw`
  UPDATE "BotRun" SET "stoppedAt" = now(), "stopReason" = 'crashed' WHERE "stoppedAt" IS NULL`;
const stale = await prisma.$executeRaw`
  UPDATE "BotCommand"
  SET status = 'failed', error = 'stale at startup', "handledAt" = now()
  WHERE status = 'pending' AND "createdAt" < now() - make_interval(secs => ${STALE_COMMAND_SECONDS})`;
const run = await prisma.botRun.create({ data: { state: 'idle' } });
log.info({ runId: run.id, closedCrashedRuns: crashed, staleCommands: stale }, 'worker started');

// Market data feed (spec 0002): runs for the worker's whole life, independent of
// start/stop/kill, and starts in the background so health shows `up` right away.
const feed = new MarketDataFeed({
  prisma,
  log: log.child({ component: 'feed' }),
  publish: (event) => notifyAll(pg, BOT_EVENTS_CHANNEL, [event]),
  oanda:
    config.OANDA_API_TOKEN && config.OANDA_ACCOUNT_ID
      ? { token: config.OANDA_API_TOKEN, accountId: config.OANDA_ACCOUNT_ID, env: config.OANDA_ENV }
      : undefined,
});

// Paper trader (spec 0003): created before the command loop so every command reaches it.
const trader = new Trader({
  prisma,
  log: log.child({ component: 'trader' }),
  marketData: feed.marketData,
  feedState: (id) => feed.getFeedState(id),
  broker: new PaperBroker(prisma),
  publish: (events) => notifyAll(pg, BOT_EVENTS_CHANNEL, events),
  accountId: paper.id,
  previousState: await previousRunState(prisma, run.id),
});

const heartbeat = setInterval(() => {
  prisma.$executeRaw`UPDATE "BotRun" SET "lastHeartbeatAt" = now() WHERE id = ${run.id}::uuid`.catch(
    (err: unknown) => log.error({ err }, 'heartbeat failed'),
  );
}, HEARTBEAT_MS);

let draining = false;
let drainAgain = false;

// Handles every pending command. NOTIFY wakes us at once; the poll is the backup.
async function drainCommands(): Promise<void> {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    do {
      drainAgain = false;
      for (;;) {
        const command = await nextPendingCommand(prisma);
        if (!command) break;
        if (isRunCommand(command)) {
          const handled = await handleRunCommand(prisma, run.id, command);
          if (!handled) continue;
          trader.setBotState(handled.state);
          await notifyAll(pg, BOT_EVENTS_CHANNEL, handled.events);
          log.info({ commandId: command.id, type: command.type, status: 'done' }, 'command handled');
          continue;
        }
        // The panel's commands run inside the trader's serial queue (spec 0004).
        let result: CommandResult;
        try {
          result = await trader.runCommand(command as TraderCommand);
        } catch (err) {
          log.error({ err, commandId: command.id, type: command.type }, 'command job threw');
          result = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
          // If even this fails (database down), the drain stops and the poll retries later.
          await failCommand(prisma, command.id, result.error);
        }
        const status = { commandId: command.id, type: command.type, strategyId: command.strategyId, positionId: command.positionId };
        if (result.status === 'failed') log.warn({ ...status, error: result.error }, 'command failed');
        else log.info({ ...status, status: 'done' }, 'command handled');
        await notifyAll(pg, BOT_EVENTS_CHANNEL, [handledEvent(command, result)]);
      }
    } while (drainAgain);
  } catch (err) {
    log.error({ err }, 'command handling failed');
  } finally {
    draining = false;
  }
}

pg.on('notification', (msg) => {
  if (msg.channel === BOT_COMMANDS_CHANNEL) void drainCommands();
});
await pg.query(`LISTEN ${BOT_COMMANDS_CHANNEL}`);
const poller = setInterval(() => void drainCommands(), COMMAND_POLL_MS);
void drainCommands();

// The trader starts once the feed has refreshed tick sizes; it stays off if the feed can't start.
feed
  .start()
  .then(() => trader.start())
  .catch((err: unknown) => log.error({ err }, 'market data feed failed to start, paper trader not started'));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  clearInterval(poller);
  clearInterval(heartbeat);
  try {
    await trader.stop().catch((err: unknown) => log.error({ err }, 'trader shutdown failed'));
    await feed.stop().catch((err: unknown) => log.error({ err }, 'feed shutdown failed'));
    await prisma.$executeRaw`
      UPDATE "BotRun" SET "stoppedAt" = now(), "stopReason" = 'shutdown' WHERE id = ${run.id}::uuid`;
    await pg.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK_KEY]);
  } finally {
    await pg.end().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
