import { History } from 'lucide-react';
import { fmtPnl, fmtPrice, fmtQty, fmtUsd, fmtUtc, label, pnlTone } from '../../lib/format.js';
import { Badge, Empty, LoadMore, Loading, Section, SectionError, Table, cell, mono } from './ui.jsx';

const REASON_TONE = { take_profit: 'green', stop_loss: 'red', kill: 'red', manual: 'blue', opposite_signal: 'amber' };

// Newest first, 50 per page, "Load more" (spec 0004 AC-8).
export default function ClosedTrades({ trades, instruments, stale }) {
  const list = trades.items;
  return (
    <Section title="Closed trades" icon={History} iconClass="text-indigo-400" lastUpdatedAt={trades.lastUpdatedAt} stale={stale}>
      <SectionError error={trades.error} />
      {trades.loading ? (
        <Loading />
      ) : !list || list.length === 0 ? (
        <Empty>No closed trades yet</Empty>
      ) : (
        <>
          <Table caption="Closed trades" head={['Symbol', 'Strategy', 'Side', 'Qty', 'Entry', 'Exit', 'Reason', 'Realized PnL', 'Fees', 'Closed']}>
            {list.map((p) => {
              const inst = instruments.get(p.symbol);
              return (
                <tr key={p.id} className="hover:bg-white/[0.02]">
                  <th scope="row" className={`${cell} font-black text-white text-left`}>
                    {p.symbol}
                  </th>
                  <td className={`${cell} text-slate-400`}>{p.strategy.name}</td>
                  <td className={cell}>
                    <Badge tone={p.side === 'buy' ? 'green' : 'red'}>{p.side === 'buy' ? 'long' : 'short'}</Badge>
                  </td>
                  <td className={mono}>{fmtQty(p.qty, inst?.minQty)}</td>
                  <td className={mono}>{fmtPrice(p.entryPrice, inst?.tickSize)}</td>
                  <td className={mono}>{fmtPrice(p.exitPrice, inst?.tickSize)}</td>
                  <td className={cell}>
                    <Badge tone={REASON_TONE[p.closeReason] ?? 'slate'}>{label(p.closeReason)}</Badge>
                  </td>
                  <td className={`${cell} font-mono font-bold ${pnlTone(p.realizedPnl)}`}>{fmtPnl(p.realizedPnl)}</td>
                  <td className={mono}>{fmtUsd(p.fees)}</td>
                  <td className={`${cell} font-mono text-slate-500`}>{fmtUtc(p.closedAt)}</td>
                </tr>
              );
            })}
          </Table>
          <LoadMore resource={trades} />
        </>
      )}
    </Section>
  );
}
