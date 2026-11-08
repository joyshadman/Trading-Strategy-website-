import { api } from '../lib/api.js';
import { usePagedResource, useResource } from '../hooks/useResource.js';

// The Bot page's paged lists (50 per page, the spec 0003 default) and the action log.

const withCursor = (path, cursor) => (cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path);

const loadClosed = (cursor) =>
  api(withCursor('/positions?status=closed&limit=50', cursor)).then((r) => ({ items: r.positions, nextCursor: r.nextCursor }));

const loadSignals = (cursor) =>
  api(withCursor('/signals?limit=50', cursor)).then((r) => ({ items: r.signals, nextCursor: r.nextCursor }));

const loadCommands = () => api('/bot/commands?limit=20');

export const usePagedClosed = () => usePagedResource(loadClosed);
export const usePagedSignals = () => usePagedResource(loadSignals);
export const useCommandsLog = () => useResource(loadCommands);
