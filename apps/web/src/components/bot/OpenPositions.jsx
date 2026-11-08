import { useEffect, useState } from 'react';
import { Crosshair, X } from 'lucide-react';
import { useCommand } from '../../hooks/useCommand.js';
import { fmtPnl, fmtPrice, fmtQty, fmtUtc, pnlTone } from '../../lib/format.js';
import ConfirmDialog from './ConfirmDialog.jsx';
import { Badge, Button, CommandResult, Empty, Loading, Section, SectionError, Table, cell, mono } from './ui.jsx';

// Close follows the position, not the bot state: any open position with no pending exit.
// `done` means the exit order exists, not that the position closed, so the row refetches
// and shows "closing" until position.closed arrives (spec 0004 AC-4).
function CloseCell({ position, disabled, subscribe, onDone }) {
  const command = useCommand(subscribe);
  const [confirm, setConfirm] = useState(false);
  const { status } = command;

  useEffect(() => {
    if (status === 'done') onDone();
  }, [status, onDone]);

  if (position.pendingClose) {
    return (
      <Badge tone="amber" title="A pending exit order fills at the first live, tradeable price">
        closing, waiting for a tradeable price
      </Badge>
    );
  }
  const sideWord = position.side === 'buy' ? 'long' : 'short';
  return (
    <div className="flex items-center gap-2">
      <Button
        className="!px-3 !py-1.5"
        busy={command.busy}
        disabled={disabled}
        onClick={() => setConfirm(true)}
        aria-label={`Close ${position.symbol} ${sideWord}`}
      >
        <X size={12} aria-hidden="true" /> Close
      </Button>
      {status === 'failed' && <CommandResult command={command} />}
      <ConfirmDialog
        open={confirm}
        title="Close position?"
        message={`Close ${position.symbol} ${sideWord} at market?`}
        confirmLabel="Close"
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          command.send({ type: 'close_position', positionId: position.id });
        }}
      />
    </div>
  );
}

export default function OpenPositions({ positions, instruments, disabled, stale, subscribe }) {
  const list = positions.data;
  return (
    <Section title="Open positions" icon={Crosshair} iconClass="text-amber-400" lastUpdatedAt={positions.lastUpdatedAt} stale={stale}>
      <SectionError error={positions.error} />
      {positions.loading ? (
        <Loading />
      ) : !list || list.length === 0 ? (
        <Empty>No open positions</Empty>
      ) : (
        <Table caption="Open positions" head={['Symbol', 'Strategy', 'Side', 'Qty', 'Entry', 'SL', 'TP', 'Mark', 'Unrealized PnL', 'Opened', '']}>
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
                <td className={mono}>{fmtPrice(p.stopLoss, inst?.tickSize)}</td>
                <td className={mono}>{fmtPrice(p.takeProfit, inst?.tickSize)}</td>
                <td className={mono} title={p.markedAt ? `Marked ${fmtUtc(p.markedAt)}` : 'Not marked yet'}>
                  {fmtPrice(p.markPrice, inst?.tickSize)}
                </td>
                <td className={`${cell} font-mono font-bold ${pnlTone(p.unrealizedPnl)}`}>{fmtPnl(p.unrealizedPnl)}</td>
                <td className={`${cell} font-mono text-slate-500`}>{fmtUtc(p.openedAt)}</td>
                <td className={cell}>
                  <CloseCell position={p} disabled={disabled} subscribe={subscribe} onDone={positions.refetch} />
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </Section>
  );
}
