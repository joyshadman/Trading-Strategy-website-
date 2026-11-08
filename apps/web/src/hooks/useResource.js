import { useCallback, useEffect, useRef, useState } from 'react';

// Runs `run` at most once at a time: a call while one is in flight queues ONE trailing run,
// however many calls arrive meanwhile (spec 0004: refetches are coalesced per section).
function useCoalesced(run) {
  const runRef = useRef(run);
  const state = useRef({ inFlight: false, again: false });

  useEffect(() => {
    runRef.current = run;
  });

  return useCallback(async () => {
    const s = state.current;
    if (s.inFlight) {
      s.again = true;
      return;
    }
    s.inFlight = true;
    try {
      do {
        s.again = false;
        await runRef.current();
      } while (s.again);
    } finally {
      s.inFlight = false;
    }
  }, []);
}

// One section's data: fetched on mount, refetched on demand. `lastUpdatedAt` is the browser
// clock at the last successful fetch; data stays on screen after a failed refetch.
export function useResource(load) {
  const [data, setData] = useState(undefined);
  const [error, setError] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const refetch = useCoalesced(async () => {
    try {
      setData(await load());
      setError(null);
      setLastUpdatedAt(new Date());
    } catch (err) {
      setError(err);
    }
  });

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, setData, error, lastUpdatedAt, loading: data === undefined && !error, refetch };
}

// A cursor paged, newest first list. `load(cursor)` resolves to { items, nextCursor }.
// "Load more" keeps what is loaded; a refetch replaces only the first page and drops
// duplicates by id from the pages after it.
export function usePagedResource(load) {
  const [items, setItems] = useState(undefined);
  const [nextCursor, setNextCursor] = useState(null);
  const [error, setError] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const pages = useRef({ firstLen: 0, extra: false, cursor: null });

  const refetch = useCoalesced(async () => {
    try {
      const page = await load(undefined);
      const ids = new Set(page.items.map((i) => i.id));
      setItems((prev) => {
        const rest = pages.current.extra && prev ? prev.slice(pages.current.firstLen).filter((i) => !ids.has(i.id)) : [];
        return [...page.items, ...rest];
      });
      pages.current.firstLen = page.items.length;
      if (!pages.current.extra) {
        pages.current.cursor = page.nextCursor;
        setNextCursor(page.nextCursor);
      }
      setError(null);
      setLastUpdatedAt(new Date());
    } catch (err) {
      setError(err);
    }
  });

  useEffect(() => {
    refetch();
  }, [refetch]);

  const loadMore = useCallback(async () => {
    const cursor = pages.current.cursor;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await load(cursor);
      setItems((prev) => {
        const have = new Set((prev ?? []).map((i) => i.id));
        return [...(prev ?? []), ...page.items.filter((i) => !have.has(i.id))];
      });
      pages.current.extra = true;
      pages.current.cursor = page.nextCursor;
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }, [load]);

  return { items, error, lastUpdatedAt, loading: items === undefined && !error, nextCursor, loadingMore, loadMore, refetch };
}
