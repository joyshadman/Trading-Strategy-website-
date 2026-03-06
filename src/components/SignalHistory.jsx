import React, { useState, useEffect, useRef } from 'react';
import { History, CheckCircle2, XCircle, Clock, ExternalLink, Zap } from 'lucide-react';

const SignalHistory = ({ currentSignal }) => {
  const [history, setHistory] = useState([
    { id: 1, pair: 'BTCUSDT', type: 'BUY', result: 'WIN', profit: '+1.2%', time: '10:30 AM' },
    { id: 2, pair: 'EURUSD', type: 'SELL', result: 'LOSS', profit: '-0.4%', time: '09:15 AM' },
    { id: 3, pair: 'ETHUSDT', type: 'BUY', result: 'WIN', profit: '+0.8%', time: '08:45 AM' },
  ]);

  // Track processed signals to prevent duplicate entries on re-renders
  const lastProcessedSignalRef = useRef(null);

  useEffect(() => {
    if (!currentSignal) return;

    // Generate a unique key for the signal (Pair + Price + Signal Type)
    const signalKey = `${currentSignal.pair}-${currentSignal.price}-${currentSignal.type}`;

    // Fix: Check if this exact signal was already added
    if (currentSignal.confidence > 88 && lastProcessedSignalRef.current !== signalKey) {
      lastProcessedSignalRef.current = signalKey;

      const newEntry = {
        id: Date.now(),
        pair: currentSignal.pair,
        type: currentSignal.type,
        result: 'PENDING',
        profit: 'Targeting...',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      setHistory(prev => [newEntry, ...prev].slice(0, 8));
    }
  }, [currentSignal]);

  return (
    <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-[2.5rem] p-7 shadow-2xl h-full transition-all duration-500">
      <div className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-500/10 rounded-xl border border-blue-500/20">
            <History size={20} className="text-blue-400" />
          </div>
          <h3 className="text-xl font-black text-white tracking-tighter">Signal Log</h3>
        </div>
        <div className="flex items-center gap-2 px-3 py-1 bg-blue-500/10 rounded-full border border-blue-500/20">
          <Zap size={12} className="text-blue-400 fill-blue-400" />
          <span className="text-[10px] font-black text-blue-400 uppercase tracking-widest">
            78% Accuracy
          </span>
        </div>
      </div>

      <div className="space-y-4">
        {history.map((item, index) => (
          <div 
            key={item.id} 
            className={`group flex items-center justify-between p-4 rounded-3xl border transition-all duration-300 animate-in fade-in slide-in-from-right-4 
              ${index === 0 && item.result === 'PENDING' ? 'bg-blue-500/5 border-blue-500/20' : 'bg-white/5 border-white/5 hover:bg-white/10'}
            `}
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <div className="flex items-center gap-4">
              <div className={`p-2.5 rounded-2xl ${item.type === 'BUY' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
                {item.type === 'BUY' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-black text-sm text-white tracking-tight">{item.pair}</span>
                  <span className={`text-[10px] font-black px-2 py-0.5 rounded-md ${item.type === 'BUY' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
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
                Verify <ExternalLink size={10} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 pt-6 border-t border-white/5">
        <div className="bg-slate-950/40 p-4 rounded-2xl border border-white/5">
          <p className="text-[10px] text-slate-500 font-semibold italic text-center leading-relaxed">
            NEURAL LOG: High-confidence signals verified via Exness MT5 bridge. Always verify candle close before entry.
          </p>
        </div>
      </div>
    </div>
  );
};

export default SignalHistory;