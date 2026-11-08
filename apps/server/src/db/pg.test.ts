import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { makeEvent } from '@trading/shared';
import { notifyAll } from './pg.js';

function fakeClient() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    },
  } as unknown as pg.Client;
  return { client, calls };
}

describe('notifyAll', () => {
  // The database is remote (~300ms per round trip), so every event of a command must go out
  // in ONE query. Sending them one by one pushed commands past the 2 second limit (AC-7).
  it('sends every event in one query, in order, with bound parameters', async () => {
    const { client, calls } = fakeClient();
    const events = [
      makeEvent('bot.started', { runId: 'r1' }),
      makeEvent('command.handled', { commandId: 'c1', status: 'done' }),
    ];
    await notifyAll(client, 'bot_events', events);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe('SELECT pg_notify($1, $2), pg_notify($1, $3)');
    expect(calls[0]!.values).toEqual(['bot_events', JSON.stringify(events[0]), JSON.stringify(events[1])]);
  });

  it('sends nothing for no events', async () => {
    const { client, calls } = fakeClient();
    await notifyAll(client, 'bot_events', []);
    expect(calls).toHaveLength(0);
  });
});
