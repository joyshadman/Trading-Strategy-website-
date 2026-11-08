import { useCallback, useEffect, useRef, useState } from 'react';

// Reconnect backoff: 1s, 2s, 4s, 8s, then every 10s (spec 0004).
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 10_000;

// One /ws connection for the page. subscribe(type, fn) returns an unsubscribe function.
// Every connect (and reconnect) starts with a `hello` event, which the page uses to refetch.
export function useSocket() {
  const listeners = useRef(new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws;
    let timer;
    let backoff = BACKOFF_START_MS;
    let closed = false;

    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${protocol}://${location.host}/ws`);
      ws.onopen = () => {
        backoff = BACKOFF_START_MS;
        setConnected(true);
      };
      ws.onmessage = (msg) => {
        let event;
        try {
          event = JSON.parse(msg.data);
        } catch {
          return;
        }
        for (const fn of listeners.current.get(event.type) ?? []) fn(event);
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  const subscribe = useCallback((type, fn) => {
    const set = listeners.current.get(type) ?? new Set();
    set.add(fn);
    listeners.current.set(type, set);
    return () => set.delete(fn);
  }, []);

  return { connected, subscribe };
}
