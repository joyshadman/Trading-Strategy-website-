import { useEffect } from 'react';
import { api, HttpError } from '../lib/api.js';
import { useResource } from './useResource.js';

export const HEALTH_POLL_MS = 5_000;

const loadHealth = async () => {
  try {
    return { ok: true, body: await api('/health') };
  } catch (err) {
    // A 503 from our API still carries the health body (db: 'down').
    if (err instanceof HttpError && err.body?.db === 'down') return { ok: true, body: err.body };
    throw err;
  }
};

// Polls /api/health every 5 seconds. `outage` is the first that applies (AC-7):
//   'backend' (no answer) → 'db' (database down) → 'worker' (worker down or never started)
// and null when everything is up.
export function useHealth() {
  const resource = useResource(loadHealth);
  const { refetch } = resource;

  useEffect(() => {
    const timer = setInterval(refetch, HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [refetch]);

  const body = resource.data?.body;
  let outage = null;
  if (resource.error) outage = 'backend';
  else if (body?.db === 'down') outage = 'db';
  else if (body && body.worker.status !== 'up') outage = 'worker';

  return { health: body, outage, lastUpdatedAt: resource.lastUpdatedAt, loading: resource.loading, refetch };
}
