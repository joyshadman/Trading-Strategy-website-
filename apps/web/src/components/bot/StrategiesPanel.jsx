import { useEffect } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useCommand } from '../../hooks/useCommand.js';
import { fmtPnl, fmtUsd, pnlTone } from '../../lib/format.js';
import { Badge, CommandResult, Empty, Loading, Section, SectionError, Spinner } from './ui.jsx';

// The switch is pending, not optimistic: it holds its old value with a spinner until the
// worker answers; on done the list refetches, on failed it stays put and shows the error.
function StrategySwitch({ strategy, disabled, subscribe, onDone, botState }) {
  const command = useCommand(subscribe);
  const { status } = command;

  useEffect(() => {
    if (status === 'done') onDone();
  }, [status, onDone]);

  const toggle = () =>
    command.send({ type: strategy.enabled ? 'disable_strategy' : 'enable_strategy', strategyId: strategy.id });

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={strategy.enabled}
        aria-label={`${strategy.name} ${strategy.enabled ? 'on' : 'off'}`}
        aria-busy={command.busy || undefined}
        disabled={disabled || command.busy}
        onClick={toggle}
        className={`relative w-12 h-7 rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-40 disabled:cursor-not-allowed ${
          strategy.enabled ? 'bg-emerald-500/80 border-emerald-400/50' : 'bg-slate-800 border-white/10'
        }`}
      >
        <span
          className={`absolute top-0.5 w-5.5 h-5.5 rounded-full bg-white shadow flex items-center justify-center transition-all ${
            strategy.enabled ? 'left-[calc(100%-1.5rem)]' : 'left-0.5'
          }`}
        >
          {command.busy && <Spinner size={12} className="text-slate-700" />}
        </span>
      </button>
      {status === 'failed' && <CommandResult command={command} />}
      {botState === 'killed' && !strategy.enabled && <span className="text-[10px] text-slate-500">applies on next start</span>}
    </div>
  );
}

const pct = (v) => `${fmtUsd(v).replace(/\.?0+$/, '')}%`;

// Strategies with their switch, pairs and risk limits read only (AC-3, AC-8, AC-12).
export default function StrategiesPanel({ strategies, disabled, stale, subscribe, botState }) {
  const list = strategies.data;
  return (
    <Section title="Strategies" icon={SlidersHorizontal} lastUpdatedAt={strategies.lastUpdatedAt} stale={stale}>
      <SectionError error={strategies.error} />
      {strategies.loading ? (
        <Loading />
      ) : !list || list.length === 0 ? (
        <Empty>No strategies yet. Run npm run db:seed.</Empty>
      ) : (
        <ul className="space-y-4">
          {list.map((s) => (
            <li key={s.id} className="bg-white/5 border border-white/5 rounded-2xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-black text-white tracking-tight">{s.name}</h3>
                    <Badge tone="blue">{s.timeframe}</Badge>
                    {s.halted && (
                      <Badge tone="red" title="The daily loss limit tripped; no new entries until 00:00 UTC">
                        halted
                      </Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    {s.openPositions} open · today <span className={`font-mono ${pnlTone(s.todayRealizedPnl)}`}>{fmtPnl(s.todayRealizedPnl)}</span>
                  </p>
                </div>
                <StrategySwitch strategy={s} disabled={disabled} subscribe={subscribe} onDone={strategies.refetch} botState={botState} />
              </div>

              <div className="flex flex-wrap gap-1.5 mt-3" aria-label="Pairs">
                {s.symbols.map((sym) => (
                  <span key={sym} className="text-[10px] font-mono text-slate-300 bg-white/5 border border-white/5 rounded-md px-1.5 py-0.5">
                    {sym}
                  </span>
                ))}
              </div>

              {s.risk && (
                <dl className="grid grid-cols-3 gap-2 mt-3 text-[10px]" aria-label="Risk limits (read only)">
                  {[
                    ['Stop loss', pct(s.risk.stopLossPct)],
                    ['Take profit', pct(s.risk.takeProfitPct)],
                    ['Risk per trade', pct(s.risk.riskPerTradePct)],
                    ['Max size', `$${fmtUsd(s.risk.maxPositionSize)}`],
                    ['Max open', String(s.risk.maxOpenTrades)],
                    ['Daily loss limit', `$${fmtUsd(s.risk.dailyLossLimit)}`],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-black/20 rounded-lg px-2 py-1.5">
                      <dt className="font-black uppercase text-slate-500 tracking-wider text-[8px]">{k}</dt>
                      <dd className="font-mono text-slate-300">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
