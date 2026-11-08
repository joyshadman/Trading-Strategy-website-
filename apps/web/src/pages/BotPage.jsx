import { useEffect, useMemo, useRef } from 'react';
import { api } from '../lib/api.js';
import { useCommandsLog, usePagedClosed, usePagedSignals } from './botResources.js';
import { useHealth } from '../hooks/useHealth.js';
import { useResource } from '../hooks/useResource.js';
import { useSocket } from '../hooks/useSocket.js';
import AccountSummary from '../components/bot/AccountSummary.jsx';
import ActionLog from '../components/bot/ActionLog.jsx';
import ClosedTrades from '../components/bot/ClosedTrades.jsx';
import EquityChart from '../components/bot/EquityChart.jsx';
import FeedHealth from '../components/bot/FeedHealth.jsx';
import OfflineBanner from '../components/bot/OfflineBanner.jsx';
import OpenPositions from '../components/bot/OpenPositions.jsx';
import SignalsLog from '../components/bot/SignalsLog.jsx';
import StatusBar from '../components/bot/StatusBar.jsx';
import StrategiesPanel from '../components/bot/StrategiesPanel.jsx';

const loadAccount = () => api('/account');
const loadStrategies = () => api('/strategies');
const loadInstruments = () => api('/instruments');
// Open positions are few (max open trades per strategy), so one page of the max covers them.
const loadOpen = () => api('/positions?status=open&limit=200').then((r) => r.positions);

// The Bot page (spec 0004): the control panel. Every section fetches over REST and refetches
// when a WebSocket event says something changed. All controls are disabled while the backend,
// database, or worker is down, and data then stays on screen dimmed with its last update time.
export default function BotPage() {
  const { connected, subscribe } = useSocket();
  const health = useHealth();
  const account = useResource(loadAccount);
  const strategies = useResource(loadStrategies);
  const instruments = useResource(loadInstruments);
  const open = useResource(loadOpen);
  const closed = usePagedClosed();
  const signals = usePagedSignals();
  const commands = useCommandsLog();

  const outage = health.outage;
  const disabled = outage !== null || health.loading;

  // The live updates map (spec 0004, Live updates). Refetches are coalesced per section.
  const { setData: setInstruments } = instruments;
  useEffect(() => {
    const all = () => [health, account, strategies, instruments, open, closed, signals, commands].forEach((r) => r.refetch());
    const on = (types, fn) => types.map((t) => subscribe(t, fn));
    const subs = [
      ...on(['hello'], all),
      ...on(['bot.started', 'bot.stopped', 'bot.killed'], () => {
        health.refetch();
        open.refetch();
        commands.refetch();
      }),
      ...on(['command.handled'], (e) => {
        commands.refetch();
        if (e.payload.strategyId) strategies.refetch();
        if (e.payload.positionId) open.refetch();
      }),
      ...on(['account.updated'], () => {
        account.refetch();
        open.refetch();
      }),
      ...on(['position.opened'], () => {
        open.refetch();
        account.refetch();
        strategies.refetch();
      }),
      ...on(['position.closed'], () => {
        open.refetch();
        closed.refetch();
        account.refetch();
        strategies.refetch();
      }),
      ...on(['signal.created'], () => signals.refetch()),
      ...on(['risk.halted'], () => strategies.refetch()),
      ...on(['feed.status'], (e) => {
        const { instrumentId, status, lastError } = e.payload;
        setInstruments((list) =>
          list?.map((i) => (i.id === instrumentId ? { ...i, feed: { ...i.feed, status, lastError: lastError ?? null } } : i)),
        );
      }),
    ];
    return () => subs.forEach((unsubscribe) => unsubscribe());
    // Each refetch is stable; listing the resource objects would resubscribe every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, setInstruments]);

  // When an outage clears, every section refetches (a worker outage leaves the socket up,
  // so no hello arrives then).
  const hadOutage = useRef(false);
  useEffect(() => {
    if (outage !== null) {
      hadOutage.current = true;
      return;
    }
    if (!hadOutage.current) return;
    hadOutage.current = false;
    [account, strategies, instruments, open, closed, signals, commands].forEach((r) => r.refetch());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outage]);

  const bySymbol = useMemo(() => new Map((instruments.data ?? []).map((i) => [i.symbol, i])), [instruments.data]);
  const stale = outage !== null;
  const botState = health.health?.bot?.state ?? null;

  return (
    <main className="max-w-[1600px] mx-auto px-4 sm:px-6 pb-16 space-y-6 mt-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-black tracking-tighter text-white uppercase">Control panel</h1>
          <p className="text-[10px] text-blue-400 font-bold uppercase tracking-[0.2em]">Paper trading · localhost only</p>
        </div>
        <p className="text-[10px] font-mono text-slate-500">All times UTC</p>
      </header>
      <OfflineBanner outage={outage} health={health.health} socketConnected={connected} />
      <StatusBar health={health.health} account={account} disabled={disabled} subscribe={subscribe} />
      <AccountSummary account={account} stale={stale} />

      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 space-y-6 min-w-0">
          <EquityChart stale={stale} />
          <OpenPositions positions={open} instruments={bySymbol} disabled={disabled} stale={stale} subscribe={subscribe} />
          <ClosedTrades trades={closed} instruments={bySymbol} stale={stale} />
          <SignalsLog signals={signals} stale={stale} />
        </div>
        <div className="lg:col-span-4 space-y-6 min-w-0">
          <StrategiesPanel strategies={strategies} disabled={disabled} stale={stale} subscribe={subscribe} botState={botState} />
          <FeedHealth instruments={instruments} stale={stale} />
          <ActionLog commands={commands} stale={stale} />
        </div>
      </div>
    </main>
  );
}
