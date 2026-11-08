import { ScrollText } from 'lucide-react';
import { fmtUtc, label } from '../../lib/format.js';
import { Badge, Empty, Loading, Section, SectionError } from './ui.jsx';

const STATUS_TONE = { done: 'green', failed: 'red', pending: 'amber' };

// Your last 20 commands: type, target, status, error (spec 0004 AC-11).
export default function ActionLog({ commands, stale }) {
  const list = commands.data?.commands;
  return (
    <Section title="Action log" icon={ScrollText} iconClass="text-slate-400" lastUpdatedAt={commands.lastUpdatedAt} stale={stale}>
      <SectionError error={commands.error} />
      {commands.loading ? (
        <Loading />
      ) : !list || list.length === 0 ? (
        <Empty>No actions yet</Empty>
      ) : (
        <ol className="space-y-2 max-h-[26rem] overflow-y-auto pr-1" tabIndex={0} aria-label="Your last 20 commands">

          {list.map((c) => (
            <li key={c.id} className="bg-white/5 border border-white/5 rounded-xl px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs">
                  <span className="font-black text-white uppercase tracking-wide">{label(c.type)}</span>{' '}
                  <span className="text-slate-400">{c.strategy?.name ?? c.position?.symbol ?? 'all'}</span>
                </p>
                <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
              </div>
              <p className="text-[10px] font-mono text-slate-500 mt-0.5">{fmtUtc(c.createdAt)}</p>
              {c.error && <p className="text-[11px] text-rose-300 mt-0.5">{c.error}</p>}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
