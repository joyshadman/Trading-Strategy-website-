import { Fragment, useState } from 'react';
import { ChevronDown, Radar } from 'lucide-react';
import { fmtUtc, label } from '../../lib/format.js';
import { Badge, Empty, LoadMore, Loading, Section, SectionError, Table, cell } from './ui.jsx';

const INDICATORS = ['ema9', 'ema21', 'ema50', 'rsi', 'macdHist', 'z', 'trend'];

// Indicators are plain numbers (not money), shown to 4 decimals.
const indicatorValue = (v) => (typeof v === 'number' ? v.toFixed(4) : String(v ?? 'n/a'));

// Newest first, outcome and skip reason, indicators on expand, "Load more" (spec 0004 AC-8).
export default function SignalsLog({ signals, stale }) {
  const [open, setOpen] = useState(() => new Set());
  const list = signals.items;
  const toggle = (id) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Section title="Signals" icon={Radar} iconClass="text-cyan-400" lastUpdatedAt={signals.lastUpdatedAt} stale={stale}>
      <SectionError error={signals.error} />
      {signals.loading ? (
        <Loading />
      ) : !list || list.length === 0 ? (
        <Empty>No signals yet</Empty>
      ) : (
        <>
          <Table caption="Signals" head={['', 'Symbol', 'Strategy', 'Side', 'Outcome', 'Skip reason', 'Candle', 'Created']}>
            {list.map((s) => {
              const expanded = open.has(s.id);
              return (
                <Fragment key={s.id}>
                  <tr className="hover:bg-white/[0.02]">
                    <td className={cell}>
                      <button
                        type="button"
                        onClick={() => toggle(s.id)}
                        aria-expanded={expanded}
                        aria-controls={`ind-${s.id}`}
                        aria-label={`${expanded ? 'Hide' : 'Show'} indicators for ${s.symbol}`}
                        className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-blue-400"
                      >
                        <ChevronDown size={14} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
                      </button>
                    </td>
                    <th scope="row" className={`${cell} font-black text-white text-left`}>
                      {s.symbol}
                    </th>
                    <td className={`${cell} text-slate-400`}>{s.strategy.name}</td>
                    <td className={cell}>
                      <Badge tone={s.side === 'buy' ? 'green' : 'red'}>{s.side}</Badge>
                    </td>
                    <td className={cell}>
                      <Badge tone={s.outcome === 'ordered' ? 'blue' : 'slate'}>{s.outcome}</Badge>
                    </td>
                    <td className={`${cell} text-slate-400`}>{s.skipReason ? label(s.skipReason) : ''}</td>
                    <td className={`${cell} font-mono text-slate-500`}>{fmtUtc(s.candleTime)}</td>
                    <td className={`${cell} font-mono text-slate-500`}>{fmtUtc(s.createdAt)}</td>
                  </tr>
                  {expanded && (
                    <tr id={`ind-${s.id}`}>
                      <td colSpan={8} className="px-2 pb-3">
                        <dl className="grid grid-cols-3 sm:grid-cols-7 gap-2 bg-black/20 rounded-xl p-3">
                          {INDICATORS.map((k) => (
                            <div key={k}>
                              <dt className="text-[8px] font-black uppercase text-slate-500 tracking-wider">{k}</dt>
                              <dd className="font-mono text-[11px] text-slate-300">{indicatorValue(s.indicators?.[k])}</dd>
                            </div>
                          ))}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </Table>
          <LoadMore resource={signals} />
        </>
      )}
    </Section>
  );
}
