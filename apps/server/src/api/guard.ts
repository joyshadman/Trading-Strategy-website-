import type { RequestHandler } from 'express';
import type { Logger } from 'pino';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// True only for a loopback Host header (any port, any case). A missing Host fails. This
// blocks DNS rebinding: an outside name pointed at 127.0.0.1 still sends its own Host.
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  return LOOPBACK_HOSTS.has(name ?? '');
}

// The first middleware (spec 0004 AC-10). Every request needs a loopback Host; a non GET
// /api request that carries an Origin needs exactly WEB_ORIGIN. No Origin at all (curl,
// scripts) is allowed: only browsers can be tricked into cross site requests, and they always
// send Origin on a non GET.
export function requestGuard(webOrigin: string, log: Logger): RequestHandler {
  return (req, res, next) => {
    if (!isLoopbackHost(req.headers.host)) {
      log.warn({ host: req.headers.host, path: req.path }, 'rejected request host');
      res.status(403).json({ error: 'forbidden host' });
      return;
    }
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.path.startsWith('/api') && origin !== undefined && origin !== webOrigin) {
      log.warn({ origin, path: req.path }, 'rejected request origin');
      res.status(403).json({ error: 'forbidden origin' });
      return;
    }
    next();
  };
}
