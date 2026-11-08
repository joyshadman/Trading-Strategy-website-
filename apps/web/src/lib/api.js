// Fetch wrapper for our backend (spec 0004). Base /api (the Vite proxy forwards it), JSON in
// and out, 8 second timeout. A thrown or timed out fetch is an OfflineError; any non 2xx
// response is an HttpError carrying its parsed body (a 503 health body still says db: 'down').

export const FETCH_TIMEOUT_MS = 8_000;

export class OfflineError extends Error {
  constructor(cause) {
    super('backend offline');
    this.name = 'OfflineError';
    this.cause = cause;
  }
}

export class HttpError extends Error {
  constructor(status, body) {
    super(body?.error ?? `request failed (${status})`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new OfflineError(err);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // An empty or non JSON body (the dev proxy answers 5xx with no JSON when the API is down).
  }
  if (!res.ok) throw new HttpError(res.status, data);
  return data;
}

// The dev proxy turns "API not running" into a 5xx without our JSON body.
export const isOffline = (err) =>
  err instanceof OfflineError || (err instanceof HttpError && err.status >= 500 && !err.body?.error && !err.body?.db);
