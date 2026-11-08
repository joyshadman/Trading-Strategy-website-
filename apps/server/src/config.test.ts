import { describe, expect, it } from 'vitest';
import { directDatabaseUrl, parseApiConfig, parseWorkerConfig } from './config.js';

const DB = 'postgresql://u:p@localhost:5432/db';

describe('config', () => {
  it('rejects a missing DATABASE_URL for the api', () => {
    const result = parseApiConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join()).toContain('DATABASE_URL');
  });

  it('applies api defaults', () => {
    const result = parseApiConfig({ DATABASE_URL: DB });
    expect(result).toMatchObject({
      ok: true,
      config: { API_HOST: '127.0.0.1', API_PORT: 4000, WEB_ORIGIN: 'http://localhost:5173' },
    });
  });

  it('refuses a non loopback host (localhost only)', () => {
    expect(parseApiConfig({ DATABASE_URL: DB, API_HOST: '0.0.0.0' }).ok).toBe(false);
    expect(parseApiConfig({ DATABASE_URL: DB, API_HOST: 'localhost' }).ok).toBe(true);
  });

  it('rejects an invalid port', () => {
    expect(parseApiConfig({ DATABASE_URL: DB, API_PORT: 'abc' }).ok).toBe(false);
  });

  it('lets the worker run without api settings', () => {
    expect(parseWorkerConfig({ DATABASE_URL: DB }).ok).toBe(true);
  });

  it('uses the direct url for session work, falling back to DATABASE_URL', () => {
    const pooled = 'postgresql://u:p@ep-a-pooler.r.aws.neon.tech/db';
    const direct = 'postgresql://u:p@ep-a.r.aws.neon.tech/db';
    expect(directDatabaseUrl({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: direct })).toBe(direct);
    expect(directDatabaseUrl({ DATABASE_URL: DB })).toBe(DB);
  });

  it('refuses a pooled url for session work', () => {
    const pooled = 'postgresql://u:p@ep-a-pooler.r.aws.neon.tech/db';
    expect(() => directDatabaseUrl({ DATABASE_URL: pooled })).toThrow(/-pooler/);
  });
});
