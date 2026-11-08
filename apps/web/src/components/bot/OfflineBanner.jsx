import { CloudOff, DatabaseZap, PlugZap, WifiOff } from 'lucide-react';
import { fmtUtc } from '../../lib/format.js';

// Only the first that applies shows (spec 0004 AC-7): backend, database, worker, and last
// "live updates paused" (socket closed, everything else fine).
export default function OfflineBanner({ outage, health, socketConnected }) {
  let banner = null;
  if (outage === 'backend') {
    banner = { icon: CloudOff, tone: 'red', text: 'Backend offline', detail: 'Controls are off. Retrying every 5 seconds.' };
  } else if (outage === 'db') {
    banner = { icon: DatabaseZap, tone: 'red', text: 'Database down', detail: 'Controls are off until the database is back.' };
  } else if (outage === 'worker') {
    const at = health?.worker.lastHeartbeatAt;
    banner = {
      icon: PlugZap,
      tone: 'red',
      text: at ? `Worker down since ${fmtUtc(at)}` : 'Worker never started',
      detail: 'Restart it from the terminal (npm run dev). Controls are off until it is back.',
    };
  } else if (!socketConnected) {
    banner = { icon: WifiOff, tone: 'amber', text: 'Live updates paused', detail: 'Reconnecting. Numbers may be stale; controls still work.' };
  }
  if (!banner) return null;

  const Icon = banner.icon;
  const tone =
    banner.tone === 'red' ? 'bg-rose-500/10 border-rose-500/25 text-rose-200' : 'bg-amber-500/10 border-amber-500/20 text-amber-200';
  return (
    <div role="alert" className={`border p-4 rounded-2xl flex flex-wrap items-center gap-3 ${tone}`}>
      <Icon size={18} aria-hidden="true" />
      <p className="text-xs font-black uppercase tracking-wide">{banner.text}</p>
      <p className="text-xs opacity-80">{banner.detail}</p>
    </div>
  );
}
