import { useState } from 'react';
import { Bot, HeartPulse, OctagonX, Play, Square } from 'lucide-react';
import { useCommand } from '../../hooks/useCommand.js';
import { fmtUtc } from '../../lib/format.js';
import ConfirmDialog from './ConfirmDialog.jsx';
import { Badge, Button, CommandResult } from './ui.jsx';

const STATE_TONE = { running: 'green', idle: 'slate', killed: 'red' };
const WORKER_TONE = { up: 'green', down: 'red', none: 'amber' };

// Bot state, worker status, heartbeat, and Start / Stop / Kill (spec 0004 AC-2).
// Start: idle, killed · Stop: running · Kill: running, idle (needs the open positions count).
export default function StatusBar({ health, account, disabled, subscribe }) {
  const start = useCommand(subscribe);
  const stop = useCommand(subscribe);
  const kill = useCommand(subscribe);
  const [confirmKill, setConfirmKill] = useState(false);
  const [lastSent, setLastSent] = useState(null);

  const state = health?.bot?.state ?? null;
  const worker = health?.worker;
  const workerDown = worker && worker.status !== 'up';
  const openCount = account.data?.openPositions;
  const last = { start, stop, kill }[lastSent];

  return (
    <section aria-label="Bot status and controls" className="bg-gradient-to-br from-slate-900 to-[#020617] border border-white/5 rounded-[2rem] p-6 shadow-xl">
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-4">
            <div className="bg-gradient-to-tr from-blue-600 to-indigo-600 p-2.5 rounded-2xl shadow-[0_0_20px_rgba(37,99,235,0.3)]">
              <Bot size={22} className="text-white" aria-hidden="true" />
            </div>
            <div>
              <p className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em]">Bot state</p>
              <div className={`flex items-center gap-2 ${workerDown ? 'opacity-50' : ''}`}>
                <span className={`w-2 h-2 rounded-full ${state === 'running' ? 'bg-emerald-500 animate-pulse' : state === 'killed' ? 'bg-rose-500' : 'bg-slate-500'}`} aria-hidden="true" />
                <p className="text-2xl font-black tracking-tighter text-white uppercase">
                  {state ?? 'unknown'}
                  {workerDown && <span className="text-sm text-slate-400 normal-case font-bold ml-2">(worker down)</span>}
                </p>
              </div>
            </div>
          </div>

          <dl className="flex flex-wrap gap-3">
            <div className="bg-white/5 border border-white/5 px-4 py-2 rounded-xl">
              <dt className="text-[9px] font-black text-slate-500 uppercase">Worker</dt>
              <dd className="mt-1">
                {worker ? <Badge tone={WORKER_TONE[worker.status]}>{worker.status}</Badge> : <Badge>unknown</Badge>}
              </dd>
            </div>
            <div className="bg-white/5 border border-white/5 px-4 py-2 rounded-xl">
              <dt className="text-[9px] font-black text-slate-500 uppercase flex items-center gap-1">
                <HeartPulse size={10} aria-hidden="true" /> Last heartbeat
              </dt>
              <dd className="text-xs font-mono font-bold text-blue-300 mt-1">{fmtUtc(worker?.lastHeartbeatAt)}</dd>
            </div>
            <div className="bg-white/5 border border-white/5 px-4 py-2 rounded-xl">
              <dt className="text-[9px] font-black text-slate-500 uppercase">Run started</dt>
              <dd className="text-xs font-mono font-bold text-slate-300 mt-1">{fmtUtc(health?.bot?.startedAt)}</dd>
            </div>
          </dl>
        </div>

        <div className="flex flex-col items-start xl:items-end gap-2">
          <div className="flex flex-wrap gap-3">
            <Button
              variant="success"
              busy={start.busy}
              disabled={disabled || !(state === 'idle' || state === 'killed')}
              onClick={() => {
                setLastSent('start');
                start.send({ type: 'start' });
              }}
            >
              <Play size={14} aria-hidden="true" /> Start
            </Button>
            <Button variant="primary" busy={stop.busy} disabled={disabled || state !== 'running'} onClick={() => {
                setLastSent('stop');
                stop.send({ type: 'stop' });
              }}>
              <Square size={14} aria-hidden="true" /> Stop
            </Button>
            <Button
              variant="danger"
              busy={kill.busy}
              disabled={disabled || !(state === 'running' || state === 'idle') || openCount === undefined}
              onClick={() => setConfirmKill(true)}
            >
              <OctagonX size={14} aria-hidden="true" /> Kill
            </Button>
          </div>
          <div className="min-h-4">{last && <CommandResult command={last} />}</div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmKill}
        title="Kill the bot?"
        message={`${openCount === 1 ? '1 open position' : `${openCount ?? 0} open positions`} will be closed at the next tradeable price, and no new trades will open until you start it again.`}
        confirmLabel="Kill"
        onCancel={() => setConfirmKill(false)}
        onConfirm={() => {
          setConfirmKill(false);
          setLastSent('kill');
          kill.send({ type: 'kill' });
        }}
      />
    </section>
  );
}
