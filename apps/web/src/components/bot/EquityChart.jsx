import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ColorType, LineSeries, createChart } from 'lightweight-charts';
import { LineChart } from 'lucide-react';
import { api } from '../../lib/api.js';
import { fmtUsd, fmtUtc } from '../../lib/format.js';
import { useResource } from '../../hooks/useResource.js';
import { Empty, Loading, Section, SectionError } from './ui.jsx';

const DAY_MS = 86_400_000;
const RANGES = [
  { key: '1d', label: '1 day', days: 1 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
];
const QUARTER_MS = 15 * 60_000;
// Snapshots are written on the quarter hour from the trader's queue, so a little late.
const SNAPSHOT_GRACE_MS = 10_000;

// Follows nextCursor: 30 days is 2,880 snapshots, over the 1,000 page limit.
async function loadEquity(days) {
  const from = new Date(Date.now() - days * DAY_MS).toISOString();
  const all = [];
  let cursor = null;
  do {
    const q = new URLSearchParams({ from });
    if (cursor) q.set('cursor', cursor);
    const page = await api(`/equity?${q}`);
    all.push(...page.snapshots);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

// The equity line from the 15 minute snapshots (spec 0004 AC-8). The series needs plain
// numbers for drawing (the one exception to AC-9); the hover readout formats the decimal
// string. lightweight-charts shows unix times as UTC, so the axis is UTC too.
export default function EquityChart({ stale }) {
  const [range, setRange] = useState('7d');
  const days = RANGES.find((r) => r.key === range).days;
  const load = useCallback(() => loadEquity(days), [days]);
  const equity = useResource(load);
  const { refetch } = equity;
  const host = useRef(null);
  const chartRef = useRef(null);
  const [hover, setHover] = useState(null);

  // Refetch when the range changes (the first fetch happens on mount).
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) refetch();
    mounted.current = true;
  }, [range, refetch]);

  // And 10 seconds after each quarter hour UTC.
  useEffect(() => {
    let timer;
    const schedule = () => {
      const wait = QUARTER_MS - (Date.now() % QUARTER_MS) + SNAPSHOT_GRACE_MS;
      timer = setTimeout(() => {
        refetch();
        schedule();
      }, wait);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [refetch]);

  const snapshots = equity.data;
  const byTime = useMemo(() => new Map((snapshots ?? []).map((s) => [Math.floor(Date.parse(s.takenAt) / 1000), s])), [snapshots]);
  const hasData = Boolean(snapshots?.length);

  useEffect(() => {
    if (!host.current || !hasData) return undefined;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#64748b', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { labelBackgroundColor: '#1e40af' }, vertLine: { labelBackgroundColor: '#1e40af' } },
    });
    const series = chart.addSeries(LineSeries, { color: '#60a5fa', lineWidth: 2, priceLineVisible: false });
    chartRef.current = { chart, series };
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [hasData]);

  useEffect(() => {
    const c = chartRef.current;
    if (!c || !snapshots) return undefined;
    c.series.setData([...byTime.entries()].map(([time, s]) => ({ time, value: Number(s.equity) })));
    c.chart.timeScale().fitContent();
    const onMove = (param) => setHover(param.time ? (byTime.get(param.time) ?? null) : null);
    c.chart.subscribeCrosshairMove(onMove);
    return () => c.chart.unsubscribeCrosshairMove(onMove);
  }, [snapshots, byTime]);

  const latest = snapshots?.[snapshots.length - 1];
  const shown = hover ?? latest;

  const picker = (
    <div className="flex bg-white/5 p-1 rounded-xl border border-white/10" role="group" aria-label="Chart range">
      {RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          aria-pressed={range === r.key}
          onClick={() => setRange(r.key)}
          className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all focus-visible:outline-2 focus-visible:outline-blue-400 ${
            range === r.key ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );

  return (
    <Section title="Equity" icon={LineChart} lastUpdatedAt={equity.lastUpdatedAt} stale={stale} actions={picker}>
      <SectionError error={equity.error} />
      {equity.loading ? (
        <Loading />
      ) : !hasData ? (
        <Empty>No snapshots yet (first one at the next quarter hour)</Empty>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-3 mb-3" aria-live="polite">
            <span className="text-2xl font-mono font-bold text-white">${fmtUsd(shown.equity)}</span>
            <span className="text-[11px] text-slate-500">
              balance ${fmtUsd(shown.balance)} · {shown.openPositions} open · {fmtUtc(shown.takenAt)}
            </span>
          </p>
          <div ref={host} className="h-64 w-full" role="img" aria-label={`Equity over ${RANGES.find((r) => r.key === range).label}`} />
        </>
      )}
    </Section>
  );
}
