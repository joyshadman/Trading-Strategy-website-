import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Zap, 
  Activity, 
  Layers, 
  Target,
  ChevronRight,
  TrendingUp,
  Waves,
  AlertCircle,
  BarChart3
} from 'lucide-react';

const MotionDiv = motion.div;

const SESSIONS = [
  { id: 'syd', name: 'Sydney', start: 21, end: 6, color: '#38bdf8', weight: 1, pairs: ['AUD', 'NZD', 'JPY'] },
  { id: 'tok', name: 'Tokyo', start: 0, end: 9, color: '#f472b6', weight: 1.5, pairs: ['JPY', 'AUD', 'SGD'] },
  { id: 'lon', name: 'London', start: 8, end: 16, color: '#34d399', weight: 4, pairs: ['EUR', 'GBP', 'CHF'] },
  { id: 'ny', name: 'New York', start: 13, end: 21, color: '#fb923c', weight: 3.5, pairs: ['USD', 'CAD'] }
];

const MarketVolatilityMonitor = () => {
  const [now, setNow] = useState(new Date());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const utcSecond = now.getUTCSeconds();
  const currentTimeDecimal = utcHour + utcMinute / 60 + utcSecond / 3600;

  const sessionData = useMemo(() => {
    return SESSIONS.map(s => {
      let isActive = false;
      let minutesUntilClose = null;

      if (s.start > s.end) {
        isActive = currentTimeDecimal >= s.start || currentTimeDecimal < s.end;
      } else {
        isActive = currentTimeDecimal >= s.start && currentTimeDecimal < s.end;
      }

      if (isActive) {
        const endDecimal = s.end < s.start ? s.end + 24 : s.end;
        const currentDec = (s.start > currentTimeDecimal && s.end < s.start) 
          ? currentTimeDecimal + 24 
          : currentTimeDecimal;
        minutesUntilClose = (endDecimal - currentDec) * 60;
      }

      return { ...s, isActive, minutesUntilClose };
    });
  }, [currentTimeDecimal]);

  // DERIVED DATA FOR UI
  const activeSessions = sessionData.filter(s => s.isActive);
  const volatilityScore = activeSessions.reduce((acc, curr) => acc + curr.weight, 0);
  
  const isLondonActive = sessionData.find(s => s.id === 'lon')?.isActive;
  const isNYActive = sessionData.find(s => s.id === 'ny')?.isActive;
  const isPowerHour = isLondonActive && isNYActive;
  const nearClosing = sessionData.some(s => s.isActive && s.minutesUntilClose < 30);

  const activePairs = [...new Set(activeSessions.flatMap(s => s.pairs))];

  const getStrategy = () => {
    if (nearClosing) return { label: "Spread Warning", desc: "Session ending. High slippage risk.", color: "text-rose-400" };
    if (isPowerHour) return { label: "Aggressive Scalping", desc: "Max Volume: EURUSD/GBPUSD peak.", color: "text-blue-400" };
    if (isLondonActive) return { label: "Trend Breakouts", desc: "London momentum is high.", color: "text-emerald-400" };
    return { label: "Wait for Setup", desc: "Low liquidity. Watch ranges.", color: "text-slate-500" };
  };

  const strategy = getStrategy();
  const copyStrategy = async () => {
    const text = `${strategy.label} — ${strategy.desc}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Fallback: do nothing (clipboard may be blocked)
    }
  };

  return (
    <div className="w-full bg-[#020617]/40 backdrop-blur-2xl text-slate-200 p-8 rounded-[3rem] border border-white/10 shadow-2xl overflow-hidden relative group/monitor">
      
      {/* GLOW OVERLAY */}
      <div className={`absolute top-0 left-1/2 -translate-x-1/2 w-full h-32 blur-[120px] transition-colors duration-1000 pointer-events-none opacity-30 ${isPowerHour ? 'bg-blue-500' : 'bg-indigo-500/20'}`} />

      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-12 gap-6 relative z-10">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-blue-600/20 rounded-xl border border-blue-500/30">
              <Activity size={20} className="text-blue-400" />
            </div>
            <h2 className="text-2xl font-black tracking-tighter uppercase italic text-white">Quantum Timeline</h2>
          </div>
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.4em]">
            UTC CLOCK: {now.getUTCHours().toString().padStart(2, '0')}:{now.getUTCMinutes().toString().padStart(2, '0')}
          </p>
        </div>

        {/* VOLATILITY HEAT INDICATOR */}
        <div className="flex items-center gap-6 bg-white/[0.03] border border-white/10 p-3 pr-8 rounded-2xl backdrop-blur-xl">
          <div className="flex -space-x-3">
            {activeSessions.map(s => (
              <MotionDiv 
                key={s.id} 
                initial={{ scale: 0 }} animate={{ scale: 1 }}
                className="w-10 h-10 rounded-full border-2 border-[#020617] flex items-center justify-center text-[11px] font-black shadow-lg" 
                style={{ backgroundColor: s.color, color: '#000' }}
              >
                {s.name[0]}
              </MotionDiv>
            ))}
          </div>
          <div className="border-l border-white/10 pl-6">
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-tighter mb-1">Volume Load</p>
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className={`h-4 w-1.5 rounded-full transition-all duration-700 ${volatilityScore >= (i + 1) ? 'bg-blue-500 shadow-[0_0_12px_rgba(59,130,246,0.8)]' : 'bg-slate-800'}`} />
                ))}
              </div>
              <span className="text-xs font-bold text-white uppercase ml-2">{volatilityScore > 5 ? 'Extreme' : 'Nominal'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* TIMELINE VISUALIZER */}
      <div className="relative mb-14 px-2">
        <div className="flex justify-between text-[10px] font-black text-slate-600 mb-6 font-mono">
          {['00', '04', '08', '12', '16', '20', '24'].map(t => <span key={t}>{t}:00</span>)}
        </div>

        <div className="space-y-4 relative">
          {sessionData.map((session) => {
            const startPos = (session.start / 24) * 100;
            const isMidnightCross = session.start > session.end;
            const width = isMidnightCross ? (100 - startPos + (session.end / 24) * 100) : ((session.end / 24) * 100 - startPos);

            return (
              <div key={session.id} className="h-10 w-full bg-white/[0.02] rounded-2xl relative border border-white/5">
                <MotionDiv 
                  animate={{ 
                    opacity: session.isActive ? 1 : 0.1,
                    scaleY: session.isActive ? 1 : 0.85,
                    backgroundColor: session.isActive ? session.color : '#475569'
                  }}
                  className="absolute h-full rounded-xl flex items-center justify-between px-5 shadow-2xl"
                  style={{ 
                    left: `${isMidnightCross && currentTimeDecimal < session.end ? 0 : startPos}%`, 
                    width: `${width}%`,
                  }}
                >
                  <span className="text-[10px] font-black uppercase tracking-tighter text-slate-900">
                    {session.name}
                  </span>
                  {session.isActive && <TrendingUp size={12} className="text-slate-900/40" />}
                </MotionDiv>
              </div>
            );
          })}

          {/* CURRENT TIME NEEDLE */}
          <MotionDiv 
            className="absolute top-[-30px] bottom-[-15px] w-[2px] bg-white z-20 shadow-[0_0_20px_#fff]"
            animate={{ left: `${(currentTimeDecimal / 24) * 100}%` }}
            transition={{ type: "spring", stiffness: 60, damping: 20 }}
          >
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-4 h-4 bg-white rounded-full border-[4px] border-blue-600" />
          </MotionDiv>
        </div>
      </div>

      {/* METRIC GRID */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 pt-8 border-t border-white/5">
        
        {/* Active Currencies */}
        <div className="bg-white/[0.03] border border-white/5 p-6 rounded-[2.5rem]">
          <div className="flex items-center gap-3 mb-4 text-blue-400">
            <BarChart3 size={18} />
            <h4 className="text-[11px] font-black uppercase tracking-widest">Active Assets</h4>
          </div>
          <div className="flex flex-wrap gap-2">
            {activePairs.map(p => (
              <span key={p} className="px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded-md text-[10px] font-bold text-blue-300">
                {p}
              </span>
            ))}
            {activePairs.length === 0 && <span className="text-[10px] text-slate-600 font-bold uppercase tracking-widest">Market Dormant</span>}
          </div>
        </div>

        {/* Tactical Strategy */}
        <div className={`p-6 rounded-[2.5rem] border transition-all duration-700 ${nearClosing ? 'bg-rose-500/10 border-rose-500/20' : 'bg-white/[0.03] border-white/5'}`}>
          <div className="flex items-center gap-3 mb-4">
            {nearClosing ? <AlertCircle size={18} className="text-rose-400 animate-pulse" /> : <Target size={18} className="text-emerald-400" />}
            <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-400">Tactical Node</h4>
          </div>
          <p className={`text-sm font-black uppercase mb-1 ${strategy.color}`}>{strategy.label}</p>
          <p className="text-[10px] text-slate-500 font-medium leading-relaxed">{strategy.desc}</p>
        </div>

        {/* Action Button */}
        <button
          type="button"
          onClick={copyStrategy}
          className={`p-6 rounded-[2.5rem] flex flex-col justify-between group cursor-pointer transition-all text-left ${isPowerHour ? 'bg-blue-600 hover:bg-blue-500 shadow-blue-500/20' : 'bg-white/[0.03] border border-white/5 hover:bg-white/[0.08]'}`}
          aria-label="Copy current tactical strategy"
          title="Copy strategy"
        >
          <div className="flex justify-between items-start">
            <Zap size={20} className={isPowerHour ? "text-white" : "text-slate-500"} />
            <ChevronRight size={18} className={`${isPowerHour ? "text-white" : "text-slate-500"} group-hover:translate-x-1 transition-transform`} />
          </div>
          <div>
            <p className={`text-[10px] font-black uppercase tracking-widest mb-1 ${isPowerHour ? 'text-blue-100' : 'text-slate-500'}`}>
              {copied ? "Copied" : "Copy Strategy"}
            </p>
            <p className={`text-sm font-bold uppercase ${isPowerHour ? 'text-white' : 'text-slate-400'}`}>
              {nearClosing ? "Transitioning" : isPowerHour ? "High Conviction" : "Low Volatility"}
            </p>
          </div>
        </button>

      </div>
    </div>
  );
};

export default MarketVolatilityMonitor;