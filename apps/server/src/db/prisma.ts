import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export { Prisma } from '../generated/prisma/client.js';
export type { PrismaClient };

// Opening a connection to the remote database costs ~2.5s (TLS + auth), so keep idle pool
// connections for 5 minutes instead of pg's 10 second default.
const IDLE_TIMEOUT_MS = 300_000;

// One client per process: each instance owns a connection pool.
export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, idleTimeoutMillis: IDLE_TIMEOUT_MS }),
  });
}
