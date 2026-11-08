import { useCallback, useEffect, useState } from 'react';
import { api, HttpError, isOffline } from '../lib/api.js';

// If no command.handled arrives within 5 seconds, poll the command every 2 seconds (spec 0004).
const FALLBACK_AFTER_MS = 5_000;
const FALLBACK_POLL_MS = 2_000;

// Sends one command and tracks it until it is done or failed. status:
//   idle → sending → pending → done | failed
// A 409 "already pending" with details.id adopts that command and tracks it like our own.
// Nothing is retried on its own, and a pending command is not remembered across a reload.
export function useCommand(subscribe) {
  const [state, setState] = useState({ status: 'idle', id: null, error: null });
  const { id, status } = state;

  const settle = useCallback((commandId, result) => {
    setState((s) => (s.id === commandId && s.status === 'pending' ? { ...s, status: result.status, error: result.error ?? null } : s));
  }, []);

  // Live result: command.handled for our id.
  useEffect(() => {
    if (status !== 'pending') return undefined;
    return subscribe('command.handled', (event) => {
      if (event.payload.commandId === id) settle(id, event.payload);
    });
  }, [id, status, subscribe, settle]);

  // Fallback when the socket is quiet.
  useEffect(() => {
    if (status !== 'pending') return undefined;
    let poller;
    const poll = async () => {
      try {
        const c = await api(`/bot/commands/${id}`);
        if (c.status !== 'pending') settle(id, c);
      } catch {
        // Offline: the banner covers it; keep polling.
      }
    };
    const start = setTimeout(() => {
      poll();
      poller = setInterval(poll, FALLBACK_POLL_MS);
    }, FALLBACK_AFTER_MS);
    return () => {
      clearTimeout(start);
      clearInterval(poller);
    };
  }, [id, status, settle]);

  const send = useCallback(async (body) => {
    setState({ status: 'sending', id: null, error: null });
    try {
      const created = await api('/bot/commands', { method: 'POST', body });
      setState({ status: created.status, id: created.id, error: created.error });
    } catch (err) {
      if (err instanceof HttpError && err.status === 409 && err.body?.details?.id) {
        setState({ status: 'pending', id: err.body.details.id, error: null });
        return;
      }
      const error = isOffline(err) ? 'backend offline' : err.message;
      setState({ status: 'failed', id: null, error });
    }
  }, []);

  return { send, status, error: state.error, busy: status === 'sending' || status === 'pending' };
}
