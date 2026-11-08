import type { Server } from 'node:http';
import type { Logger } from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';
import { makeEvent, type BotEvent } from '@trading/shared';
import { isLoopbackHost } from './guard.js';

const PING_MS = 30_000;

export interface EventHub {
  broadcast: (event: BotEvent) => void;
  close: () => Promise<void>;
}

// One WebSocket endpoint at /ws. Host must be loopback and Origin must match the frontend,
// and clients that miss a pong are dropped on the next ping.
export function attachWebSocket(server: Server, webOrigin: string, log: Logger): EventHub {
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req, socket, head) => {
    const path = req.url?.split('?')[0];
    if (path !== '/ws') {
      socket.destroy();
      return;
    }
    if (!isLoopbackHost(req.headers.host)) {
      log.warn({ host: req.headers.host }, 'rejected websocket host');
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (req.headers.origin !== webOrigin) {
      log.warn({ origin: req.headers.origin }, 'rejected websocket origin');
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('error', (err) => log.warn({ err }, 'websocket client error'));
    ws.send(JSON.stringify(makeEvent('hello', { serverTime: new Date().toISOString() })));
  });

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, PING_MS);

  return {
    broadcast(event) {
      const data = JSON.stringify(event);
      for (const ws of wss.clients) {
        if (ws.readyState === ws.OPEN) ws.send(data);
      }
    },
    close() {
      clearInterval(pinger);
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
