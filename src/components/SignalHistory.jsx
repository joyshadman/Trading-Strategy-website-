import React, { useState, useEffect, useRef } from 'react';
import { 
  History, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  ExternalLink, 
  Zap, 
  TrendingUp, 
  TrendingDown 
} from 'lucide-react';

const SignalHistory = ({ currentSignal }) => {
  const [history, setHistory] = useState([
    { id: 1, pair: 'BTCUSDT', type: 'BUY', result: 'WIN', profit: '+1.2%', time: '10:30 AM' },
    { id: 2, pair: 'EURUSD', type: 'SELL', result: 'LOSS', profit: '-0.4%', time: '09:15 AM' },
  ]);

  const lastProcessedSignalRef = useRef(null);

  useEffect(() => {
    // Guard: Ensure signal exists and meets the confidence threshold
    if (!currentSignal || currentSignal.confidence < 90) return;

    // Create a unique hash for this signal to prevent duplicate entries
    const signalKey = `${currentSignal.pair}-${currentSignal.type}-${Math.floor(currentSignal.price)}`;

    if (lastProcessedSignalRef.current !== signalKey) {
      lastProcessedSignalRef.current = signalKey;

      const newEntry = {
        id: Date.now(),
        pair: currentSignal.pair,
        type: currentSignal.type,
        result: 'PENDING',
        profit: 'Targeting...',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      // Keep only the last 8 entries for performance and layout
      setHistory(prev => [newEntry, ...prev].slice(0, 8));
    }
  }, [currentSignal]);

  return (
    <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-[2.5rem] p-7 shadow-2xl h-full transition-all duration-500 flex flex-col">
      <div className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-500/10 rounded-xl border border-blue-500/20">
            <History size={20} className="text-blue-400" />
          </div>
          <h3 className="text-xl font-black text-white tracking-tighter">Signal Log</h3>
        </div>
        <div className="flex items-center gap-2 px-3 py-1 bg-emerald-500/10 rounded-full border border-emerald-500/20">
          <Zap size={12} className="text-emerald-400 fill-emerald-400" />
          <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">
            Live Feed Active
          </span>
        </div>
      </div>

      <div className="space-y-4 flex-1">
        {history.map((item, index) => (
          <div 
            key={item.id} 
            className={`group flex items-center justify-between p-4 rounded-3xl border transition-all duration-300 animate-in fade-in slide-in-from-right-4 
              ${item.result === 'PENDING' ? 'bg-blue-500/10 border-blue-500/30 ring-1 ring-blue-500/20' : 'bg-white/5 border-white/5 hover:bg-white/10'}
            `}
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <div className="flex items-center gap-4">
              <div className={`p-2.5 rounded-2xl ${item.type === 'BUY' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
                {item.type === 'BUY' ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-black text-sm text-white tracking-tight">{item.pair}</span>
                  <span className={`text-[9px] font-black px-2 py-0.5 rounded-md ${item.type === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                    {item.type}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold mt-1">
                  <Clock size={10} className="text-blue-500" /> {item.time}
                </div>
              </div>
            </div>

            <div className="text-right">
              <div className={`text-sm font-black tracking-tighter ${item.result === 'WIN' ? 'text-emerald-400' : item.result === 'LOSS' ? 'text-rose-400' : 'text-blue-400 animate-pulse'}`}>
                {item.profit}
              </div>
              <button className="opacity-0 group-hover:opacity-100 transition-all flex items-center gap-1 text-[9px] text-slate-500 ml-auto uppercase font-black tracking-tighter mt-1 hover:text-blue-400">
                View Chart <ExternalLink size={10} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 pt-6 border-t border-white/5">
        <div className="bg-slate-950/40 p-4 rounded-2xl border border-white/5">
          <p className="text-[10px] text-slate-500 font-semibold italic text-center leading-relaxed">
            NEURAL LOG: Only High-Confidence (90%+) signals are recorded. Signals update automatically via WebSocket Convergence.
          </p>
        </div>
      </div>
    </div>
  );
};

export default SignalHistory;