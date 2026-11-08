import { Radio } from 'lucide-react';
import { fmtUtc } from '../../lib/format.js';
import { Badge, Empty, Loading, Section, SectionError } from './ui.jsx';

const FEED_TONE = { live: 'green', backfilling: 'blue', stale: 'amber', closed: 'slate', error: 'red' };

// Each pair's feed state, last tick, and last error (spec 0004 AC-8). feed.status events
// update the state in place; the tick time refreshes on the next instruments fetch.
export default function FeedHealth({ instruments, stale }) {
  const list = instruments.data;
  return (
    <Section title="Feed health" icon={Radio} iconClass="text-emerald-400" lastUpdatedAt={instruments.lastUpdatedAt} stale={stale}>
      <SectionError error={instruments.error} />
      {instruments.loading ? (
        <Loading />
      ) : !list || list.length === 0 ? (
        <Empty>No instruments yet</Empty>
      ) : (
        <ul className="divide-y divide-white/5">
          {list.map((i) => (
            <li key={i.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-black text-white">
                  {i.symbol} <span className="text-[10px] font-bold text-slate-500 uppercase ml-1">{i.venue}</span>
                </p>
                <p className="text-[10px] font-mono text-slate-500">tick {fmtUtc(i.feed?.lastTickAt)}</p>
                {i.feed?.lastError && (
                  <p className="text-[10px] text-rose-300 break-words max-w-[22rem]" title={i.feed.lastError}>
                    {i.feed.lastError.length > 120 ? `${i.feed.lastError.slice(0, 120)}…` : i.feed.lastError}
                  </p>
                )}
              </div>
              <Badge tone={FEED_TONE[i.feed?.status] ?? 'slate'}>{i.feed?.status ?? 'unknown'}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
