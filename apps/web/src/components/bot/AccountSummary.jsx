import { Wallet } from 'lucide-react';
import { fmtPnl, fmtUsd, pnlTone } from '../../lib/format.js';
import { Loading, Section, SectionError } from './ui.jsx';

// Balance, equity, margin, today's realized PnL, open count (spec 0004 AC-8), from /api/account.
export default function AccountSummary({ account, stale }) {
  const a = account.data;
  const tiles = a
    ? [
        { label: 'Balance', value: `$${fmtUsd(a.balance)}` },
        { label: 'Equity', value: `$${fmtUsd(a.equity)}`, accent: 'text-blue-300' },
        { label: 'Margin used', value: `$${fmtUsd(a.marginUsed)}` },
        { label: 'Free margin', value: `$${fmtUsd(a.freeMargin)}` },
        { label: "Today's realized PnL", value: fmtPnl(a.todayRealizedPnl), accent: pnlTone(a.todayRealizedPnl) },
        { label: 'Open positions', value: String(a.openPositions) },
      ]
    : [];

  return (
    <Section title="Account" icon={Wallet} iconClass="text-emerald-500" lastUpdatedAt={account.lastUpdatedAt} stale={stale}>
      <SectionError error={account.error} />
      {account.loading ? (
        <Loading />
      ) : a ? (
        <dl className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          {tiles.map((t) => (
            <div key={t.label} className="bg-white/5 border border-white/5 p-4 rounded-2xl">
              <dt className="text-[9px] font-black text-slate-500 uppercase tracking-wider mb-1">{t.label}</dt>
              <dd className={`text-lg font-mono font-bold ${t.accent ?? 'text-white'}`}>{t.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-slate-500">{account.error?.status === 404 ? 'No paper account yet. Run npm run db:seed.' : 'No account data.'}</p>
      )}
    </Section>
  );
}
