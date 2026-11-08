import { Loader2 } from 'lucide-react';
import { fmtUtc } from '../../lib/format.js';

// Small building blocks for the Bot page, in the Market dashboard's look: dark slate glass
// cards, uppercase black headings, lucide icons.

export function Section({ title, icon: Icon, iconClass = 'text-blue-500', lastUpdatedAt, stale, actions, children, className = '' }) {
  const headingId = `section-${title.toLowerCase().replaceAll(' ', '-')}`;
  return (
    <section
      aria-labelledby={headingId}
      className={`bg-gradient-to-br from-slate-900 to-[#020617] border border-white/5 rounded-[2rem] p-6 shadow-xl relative overflow-hidden transition-opacity ${stale ? 'opacity-50' : ''} ${className}`}
    >
      <div className="absolute top-0 right-0 p-10 bg-blue-500/5 blur-[50px] rounded-full pointer-events-none" aria-hidden="true" />
      <div className="relative z-10">
        <header className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div className="flex items-center gap-3">
            {Icon && <Icon className={iconClass} size={20} aria-hidden="true" />}
            <h2 id={headingId} className="font-bold text-lg text-white uppercase tracking-tighter">
              {title}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            {actions}
            {lastUpdatedAt && (
              <span className="text-[10px] font-mono text-slate-500" title="Last successful update">
                {stale ? 'last updated ' : ''}
                {fmtUtc(lastUpdatedAt)}
              </span>
            )}
          </div>
        </header>
        {children}
      </div>
    </section>
  );
}

export function Spinner({ size = 14, className = '' }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} aria-hidden="true" />;
}

const TONES = {
  blue: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  green: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  amber: 'bg-amber-500/10 text-amber-200 border-amber-500/20',
  red: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
  slate: 'bg-white/5 text-slate-300 border-white/10',
};

export function Badge({ tone = 'slate', children, title }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-black uppercase tracking-wider whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  );
}

const BUTTONS = {
  primary: 'bg-blue-600 hover:bg-blue-500 text-white shadow-[0_0_20px_rgba(37,99,235,0.25)]',
  success: 'bg-emerald-600 hover:bg-emerald-500 text-white',
  danger: 'bg-rose-600 hover:bg-rose-500 text-white shadow-[0_0_20px_rgba(225,29,72,0.25)]',
  ghost: 'bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10',
};

export function Button({ variant = 'ghost', busy, disabled, children, className = '', ...rest }) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none ${BUTTONS[variant]} ${className}`}
      {...rest}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Empty({ children }) {
  return <p className="text-sm text-slate-500 bg-white/[0.02] border border-dashed border-white/10 rounded-2xl px-4 py-8 text-center">{children}</p>;
}

export function Loading() {
  return (
    <p className="flex items-center justify-center gap-2 text-sm text-slate-500 py-8" role="status">
      <Spinner /> Loading
    </p>
  );
}

export function SectionError({ error }) {
  if (!error) return null;
  return (
    <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2 mb-3" role="alert">
      Could not refresh: {error.message}
    </p>
  );
}

// The result of the last command a control sent, shown next to it.
export function CommandResult({ command }) {
  if (command.status === 'failed') {
    return (
      <span className="text-[11px] text-rose-300" role="alert">
        Failed: {command.error}
      </span>
    );
  }
  if (command.status === 'done') return <span className="text-[11px] text-emerald-300" role="status">Done</span>;
  if (command.busy) return <span className="text-[11px] text-slate-400" role="status">Working</span>;
  return null;
}

export function LoadMore({ resource }) {
  if (!resource.nextCursor) return null;
  return (
    <div className="flex justify-center mt-4">
      <Button onClick={resource.loadMore} busy={resource.loadingMore}>
        Load more
      </Button>
    </div>
  );
}

// Table chrome shared by the list sections; horizontal scroll stays inside the card.
export function Table({ caption, head, children }) {
  return (
    <div className="overflow-x-auto -mx-2">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-[9px] font-black uppercase tracking-widest text-slate-500">
            {head.map((h) => (
              <th key={h} scope="col" className="px-2 pb-3 whitespace-nowrap font-black">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">{children}</tbody>
      </table>
    </div>
  );
}

export const cell = 'px-2 py-2.5 whitespace-nowrap';
export const mono = `${cell} font-mono text-slate-300`;
