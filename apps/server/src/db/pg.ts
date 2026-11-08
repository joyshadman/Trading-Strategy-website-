import pg from 'pg';
import type { BotEvent } from '@trading/shared';

// A dedicated raw connection. Prisma's pool can't hold a session advisory lock or LISTEN.
export async function connectPg(databaseUrl: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

// Bound parameter, never string concatenation. Send only after the related write commits.
export async function notify(
  client: pg.Client,
  channel: string,
  payload: BotEvent | Record<string, unknown>,
): Promise<void> {
  await notifyAll(client, channel, [payload]);
}

// All payloads in one query (one round trip), delivered in order.
export async function notifyAll(
  client: pg.Client,
  channel: string,
  payloads: Array<BotEvent | Record<string, unknown>>,
): Promise<void> {
  if (payloads.length === 0) return;
  const calls = payloads.map((_, i) => `pg_notify($1, $${i + 2})`).join(', ');
  await client.query(`SELECT ${calls}`, [channel, ...payloads.map((p) => JSON.stringify(p))]);
}
