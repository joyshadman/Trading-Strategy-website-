import { describe, expect, it } from 'vitest';
import { workerStatusFrom } from './health.js';

const now = new Date();
const run = { id: 'run-1', state: 'idle' as const, startedAt: now };

describe('workerStatusFrom', () => {
  it('is none with no run', () => {
    expect(workerStatusFrom(undefined)).toBe('none');
  });

  it('is up with a fresh heartbeat', () => {
    expect(workerStatusFrom({ ...run, lastHeartbeatAt: now, stoppedAt: null, age: 4 })).toBe('up');
  });

  it('is down after 15 seconds without a heartbeat', () => {
    expect(workerStatusFrom({ ...run, lastHeartbeatAt: now, stoppedAt: null, age: 16 })).toBe('down');
  });

  it('is down once the run is stopped', () => {
    expect(workerStatusFrom({ ...run, lastHeartbeatAt: now, stoppedAt: now, age: 1 })).toBe('down');
  });
});
