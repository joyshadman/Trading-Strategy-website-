import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  History, 
  Clock, 
  ExternalLink, 
  TrendingUp, 
  TrendingDown,
  Flame,
  Layers,
  BarChart3
} from 'lucide-react';

const MotionDiv = motion.div;

const getTradingViewSymbol = (pair) => {
  const clean = String(pair || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (!clean) return null;
  // Crypto (common format in this app)
  if (clean.endsWith("USDT")) return `BINANCE:${clean}`;
  // Forex (e.g. EURUSD, GBPJPY, EURGBP)
  if (clean.length === 6) return `FX:${clean}`;
  return clean;
};

const SignalHistory = ({ currentSignal, activeSessions = [] }) => {
  const [history, setHistory] = useState([
    { id: 1, pair: 'BTCUSDT', type: 'BUY', result: 'WIN', profit: '+1.2%', time: '10:30 AM', overlap: true },
    { id: 2, pair: 'EURUSD', type: 'SELL', result: 'LOSS', profit: '-0.4%', time: '09:15 AM', overlap: false },
  ]);

  // Anti-Spam: Store a set of unique signal keys to prevent duplicates
  const processedSignals = useRef(new Set());

  const isOverlap = activeSessions.includes('London') && activeSessions.includes('New York');
  const sessionCount = activeSessions.length;

  const openProof = (pair) => {
    const tvSymbol = getTradingViewSymbol(pair);
    if (!tvSymbol) return;
    const url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  useEffect(() => {
    // Strong signals only
    if (!currentSignal) return;
    const isStrong = currentSignal.strength === "Strong Buy" || currentSignal.strength === "Strong Sell";
    if (!isStrong) return;
    if (typeof currentSignal.confidence === "number" && currentSignal.confidence < 90) return;

    // Dedupe (Pair + Type + TF + 2-min window)
    const timeWindow = Math.floor(Date.now() / 120000);
    const signalKey = `${currentSignal.pair}-${currentSignal.type}-${currentSignal.timeframe || "na"}-${timeWindow}`;

    if (!processedSignals.current.has(signalKey)) {
      processedSignals.current.add(signalKey);

      const newEntry = {
        id: Date.now(),
        pair: currentSignal.pair,
        type: currentSignal.type,
        result: 'PENDING',
        profit: `${currentSignal.confidence ?? "--"}%`,
        strength: currentSignal.strength,
        timeframe: currentSignal.timeframe,
        entryWindow: currentSignal.entryWindow,
        tp: currentSignal.tp,
        sl: currentSignal.sl,
        price: currentSignal.price,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        overlap: isOverlap 
      };

      // Lint rule in this repo discourages direct setState inside effects.
      queueMicrotask(() => {
        setHistory(prev => [newEntry, ...prev].slice(0, 20)); // Keep log strong-only
      });
    }
  }, [currentSignal, isOverlap]);

  return (
    <div className={`relative bg-slate-950/40 backdrop-blur-2xl border rounded-[3rem] p-8 shadow-2xl h-full transition-all duration-1000 flex flex-col overflow-hidden ${isOverlap ? 'border-blue-500/30 ring-1 ring-blue-500/10' : 'border-white/5'}`}>
      
      {/* Background Pulse during Overlap */}
      <AnimatePresence>
        {isOverlap && (
          <MotionDiv 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute -top-10 -right-10 w-64 h-64 bg-blue-600/5 blur-[100px] pointer-events-none"
          />
        )}
      </AnimatePresence>

      <div className="flex justify-between items-center mb-10 relative z-10">
        <div className="flex items-center gap-4">
          <div className="p-2.5 bg-blue-500/10 rounded-2xl border border-blue-500/20">
            <History size={22} className="text-blue-400" />
          </div>
          <div>
            <h3 className="text-xl font-black text-white tracking-tighter uppercase italic">Neural Log</h3>
            <p className="text-[9px] font-black text-slate-500 tracking-[0.3em] uppercase">High Conviction Only</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <div className={`px-4 py-1.5 rounded-full border text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all duration-500 ${isOverlap ? 'bg-blue-500/20 border-blue-500/40 text-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.2)]' : 'bg-white/5 border-white/10 text-slate-500'}`}>
            <Layers size={12} className={isOverlap ? 'animate-pulse' : ''} />
            {isOverlap ? 'Overlap Peak' : 'Standard'}
          </div>
        </div>
      </div>

      <div className="space-y-3 flex-1 relative z-10 overflow-y-auto no-scrollbar pr-2">
        <AnimatePresence initial={false}>
          {history.map((item) => (
            <MotionDiv 
              key={item.id} 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className={`group flex items-center justify-between p-5 rounded-[2rem] border transition-all duration-500 ${item.result === 'PENDING' ? 'bg-blue-500/5 border-blue-500/20' : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05]'}`}
            >
              <div className="flex items-center gap-5">
                <div className="relative">
                  <div className={`p-3 rounded-2xl ${item.type === 'BUY' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                    {item.type === 'BUY' ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
                  </div>
                  {item.overlap && (
                    <div className="absolute -top-1 -right-1 bg-blue-500 rounded-full p-1 border-2 border-slate-950">
                      <Flame size={8} className="text-white fill-white" />
                    </div>
                  )}
                </div>
                
                <div>
                  <div className="flex items-center gap-2.5">
                    <span className="font-black text-base text-white tracking-tight">{item.pair}</span>
                    <span className={`text-[8px] font-black px-2 py-0.5 rounded-md border ${item.type === 'BUY' ? 'border-emerald-500/30 text-emerald-400' : 'border-rose-500/30 text-rose-400'}`}>
                      {item.type}
                    </span>
                    {item.timeframe && (
                      <span className="text-[8px] font-black px-2 py-0.5 rounded-md border border-white/10 text-slate-400 uppercase">
                        {item.timeframe}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold mt-1 uppercase tracking-tighter">
                    <Clock size={10} className="text-blue-500/50" /> {item.time}
                  </div>
                  {item.entryWindow && (
                    <div className="text-[9px] text-slate-500 font-bold mt-1 uppercase tracking-tight">
                      {item.entryWindow}
                    </div>
                  )}
                </div>
              </div>

              <div className="text-right">
                <div className="text-[9px] text-slate-500 font-black uppercase tracking-widest mb-1">
                  {item.strength || "Strong Signal"}
                </div>
                <div className={`text-sm font-black tracking-tighter ${item.type === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {item.profit}
                </div>
                {(item.tp || item.sl) && (
                  <div className="text-[10px] text-slate-500 font-bold mt-1">
                    {item.tp ? `TP ${item.tp}` : ""}{item.tp && item.sl ? " • " : ""}{item.sl ? `SL ${item.sl}` : ""}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => openProof(item.pair)}
                  className="opacity-0 group-hover:opacity-100 transition-all flex items-center gap-1 text-[9px] text-blue-500/60 ml-auto uppercase font-black tracking-tighter mt-1 hover:text-blue-400"
                  aria-label={`Open chart proof for ${item.pair}`}
                  title="Open TradingView chart"
                >
                  Proof <ExternalLink size={10} />
                </button>
              </div>
            </MotionDiv>
          ))}
        </AnimatePresence>
      </div>

      {/* Volume Intensity Bar */}
      <div className="mt-8 pt-8 border-t border-white/5 relative z-10">
        <div className="flex justify-between items-end mb-3">
          <div className="flex items-center gap-2">
            <BarChart3 size={14} className="text-slate-500" />
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Global Intensity</span>
          </div>
          <span className={`text-[10px] font-black uppercase ${isOverlap ? 'text-blue-400 animate-pulse' : 'text-slate-600'}`}>
            {isOverlap ? 'Overlap High' : 'Nominal'}
          </span>
        </div>
        
        <div className="h-2 w-full bg-white/5 rounded-full overflow-hidden flex gap-1 p-0.5">
          {[...Array(12)].map((_, i) => (
            <MotionDiv
              key={i}
              className="h-full flex-1 rounded-sm"
              animate={{ 
                backgroundColor: i < (sessionCount * 3) ? (isOverlap ? '#3b82f6' : '#94a3b8') : '#1e293b',
                opacity: i < (sessionCount * 3) ? 1 : 0.3
              }}
              transition={{ delay: i * 0.05 }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default SignalHistory;