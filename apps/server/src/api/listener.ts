import type pg from 'pg';
import type { Logger } from 'pino';
import { BOT_EVENTS_CHANNEL, botEventSchema, type BotEvent } from '@trading/shared';
import { connectPg } from '../db/pg.js';

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export interface EventListener {
  // The live connection, also used to NOTIFY the worker. Null while reconnecting.
  client: () => pg.Client | null;
  stop: () => Promise<void>;
}

// LISTENs on bot_events and hands each valid event to onEvent. Reconnects with backoff
// (1s doubling to 30s) and runs LISTEN again on every connect. Events sent while
// disconnected are lost; the frontend reloads state over REST on reconnect.
export function listenForEvents(
  databaseUrl: string,
  log: Logger,
  onEvent: (event: BotEvent) => void,
): EventListener {
  let current: pg.Client | null = null;
  let stopped = false;
  let backoff = MIN_BACKOFF_MS;
  let retryTimer: NodeJS.Timeout | undefined;

  const scheduleReconnect = () => {
    if (stopped) return;
    current = null;
    log.warn({ retryInMs: backoff }, 'event listener disconnected');
    retryTimer = setTimeout(() => void connect(), backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };

  const connect = async () => {
    try {
      const client = await connectPg(databaseUrl);
      // Without an error handler a dropped connection would crash the API.
      client.on('error', (err) => {
        log.error({ err }, 'event listener error');
        client.end().catch(() => undefined);
      });
      client.on('end', scheduleReconnect);
      client.on('notification', (msg) => {
        if (msg.channel !== BOT_EVENTS_CHANNEL || !msg.payload) return;
        try {
          const parsed = botEventSchema.safeParse(JSON.parse(msg.payload));
          if (parsed.success) onEvent(parsed.data);
          else log.warn({ issues: parsed.error.issues }, 'ignored invalid bot event');
        } catch (err) {
          log.warn({ err }, 'ignored unparseable bot event');
        }
      });
      await client.query(`LISTEN ${BOT_EVENTS_CHANNEL}`);
      current = client;
      backoff = MIN_BACKOFF_MS;
      log.info('event listener connected');
    } catch (err) {
      log.error({ err }, 'event listener connect failed');
      scheduleReconnect();
    }
  };

  void connect();

  return {
    client: () => current,
    async stop() {
      stopped = true;
      clearTimeout(retryTimer);
      await current?.end().catch(() => undefined);
    },
  };
}
