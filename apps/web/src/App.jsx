import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { 
  Activity, Zap, Search, ShieldCheck, AlertCircle 
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import PredictorCard from './components/PredictorCard';
import SignalHistory from './components/SignalHistory';
import MarketTimeline from './components/MarketTimeline';

const MotionDiv = motion.div;

// Accurate 2026 Forex Session Times (UTC)
const MARKET_SESSIONS = [
  { name: 'Sydney', open: 21, close: 6, color: 'from-blue-400 to-cyan-400' },
  { name: 'Tokyo', open: 0, close: 9, color: 'from-purple-400 to-pink-400' },
  { name: 'London', open: 8, close: 16, color: 'from-emerald-400 to-teal-400' },
  { name: 'New York', open: 13, close: 21, color: 'from-orange-400 to-red-400' }
];

const ALL_ASSETS = [
  { symbol: 'BTCUSDT', type: 'crypto', name: 'Bitcoin / Tether' },
  { symbol: 'ETHUSDT', type: 'crypto', name: 'Ethereum / Tether' },
  { symbol: 'SOLUSDT', type: 'crypto', name: 'Solana / Tether' },
  { symbol: 'BNBUSDT', type: 'crypto', name: 'Binance Coin' },
  { symbol: 'XRPUSDT', type: 'crypto', name: 'Ripple / Tether' },
  { symbol: 'EURUSD', type: 'forex', name: 'EUR / USD' },
  { symbol: 'GBPUSD', type: 'forex', name: 'GBP / USD' },
  { symbol: 'USDJPY', type: 'forex', name: 'USD / JPY' },
  { symbol: 'AUDUSD', type: 'forex', name: 'AUD / USD' },
  { symbol: 'USDCAD', type: 'forex', name: 'USD / CAD' },
  { symbol: 'EURGBP', type: 'forex', name: 'EUR / GBP' },
  { symbol: 'GBPJPY', type: 'forex', name: 'GBP / JPY' },
];

export default function App() {
  const [lastSignal, setLastSignal] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilter, setActiveFilter] = useState('all');
  const [utcTime, setUtcTime] = useState(new Date());

  // 1. Optimized Internal Clock (Synced to UTC)
  useEffect(() => {
    const timer = setInterval(() => setUtcTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 2. Performance: Memoized Market Status Calculations
  const marketMetrics = useMemo(() => {
    const hour = utcTime.getUTCHours();
    const day = utcTime.getUTCDay();
    
    const activeSessions = MARKET_SESSIONS.filter(s => 
      s.open > s.close ? (hour >= s.open || hour < s.close) : (hour >= s.open && hour < s.close)
    );

    const isWeekend = day === 6 || (day === 5 && hour >= 22) || (day === 0 && hour < 21);
    
    return { activeSessions, isWeekend };
  }, [utcTime]);

  const handleSignal = useCallback((signal) => {
    setLastSignal(signal);
  }, []);

  // 3. Performance: Memoized Filtering
  const filteredAssets = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return ALL_ASSETS.filter(asset => {
      const matchesSearch = asset.symbol.toLowerCase().includes(term) || asset.name.toLowerCase().includes(term);
      const matchesType = activeFilter === 'all' || asset.type === activeFilter;
      return matchesSearch && matchesType;
    });
  }, [searchTerm, activeFilter]);

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 font-sans antialiased selection:bg-blue-500/30 overflow-x-hidden">
      
      {/* --- TOP NAVIGATION BAR --- */}
      <nav className="border-b border-white/5 bg-[#020617]/80 backdrop-blur-xl sticky top-0 z-50 px-6 py-4">
        <div className="max-w-[1600px] mx-auto flex flex-col lg:flex-row justify-between items-center gap-6">
          
          <div className="flex items-center gap-4">
            <div className="bg-gradient-to-tr from-blue-600 to-indigo-600 p-2.5 rounded-2xl shadow-[0_0_20px_rgba(37,99,235,0.3)]">
              <Zap size={22} className="text-white fill-current" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tighter text-white uppercase">Quantum Terminal</h1>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full animate-pulse ${marketMetrics.isWeekend ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
                <p className="text-[10px] text-blue-400 font-bold uppercase tracking-[0.2em]">
                  {marketMetrics.isWeekend ? 'Market Closed' : 'Live Infrastructure'}
                </p>
              </div>
            </div>
          </div>

          {/* MARKET TIME SYNC DISPLAY */}
          <div className="hidden xl:flex items-center gap-6 bg-white/5 border border-white/10 rounded-2xl px-6 py-2 backdrop-blur-md">
            {MARKET_SESSIONS.map(session => {
              const isActive = marketMetrics.activeSessions.some(s => s.name === session.name);
              return (
                <div key={session.name} className="flex flex-col items-center">
                  <span className={`text-[9px] font-black uppercase tracking-tighter ${isActive ? 'text-white' : 'text-slate-600'}`}>
                    {session.name}
                  </span>
                  <div className={`h-1 w-8 rounded-full mt-1 transition-all duration-500 ${isActive ? `bg-gradient-to-r ${session.color}` : 'bg-slate-800'}`} />
                </div>
              );
            })}
            <div className="pl-4 border-l border-white/10 ml-2">
              <p className="text-[10px] text-slate-500 font-bold uppercase">UTC Sync</p>
              <p className="text-sm font-mono font-bold text-blue-400">
                {utcTime.getUTCHours().toString().padStart(2, '0')}:{utcTime.getUTCMinutes().toString().padStart(2, '0')}
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center gap-4 w-full lg:w-auto">
            <div className="relative w-full sm:w-64 group">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
              <input 
                type="text"
                placeholder="Search Pairs..."
                className="w-full bg-white/5 border border-white/10 rounded-xl py-2.5 pl-11 pr-4 text-sm focus:outline-none focus:border-blue-500/50 transition-all text-white"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div className="flex bg-white/5 p-1 rounded-xl border border-white/10">
              {['all', 'crypto', 'forex'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveFilter(tab)}
                  className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                    activeFilter === tab ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>
        </div>
      </nav>

      {/* --- MAIN CONTENT --- */}
      <main className="max-w-[1600px] mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8 mt-4">
        
        {/* LEFT: Assets & Timeline */}
        <div className="lg:col-span-8 space-y-6">
          <AnimatePresence>
            {marketMetrics.isWeekend && (
              <MotionDiv 
                initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
                className="bg-amber-500/10 border border-amber-500/20 p-4 rounded-2xl flex items-center gap-3 text-amber-200"
              >
                <AlertCircle size={18} />
                <p className="text-xs font-bold uppercase tracking-wide">Liquidity Warning: Markets are currently in Weekend Mode.</p>
              </MotionDiv>
            )}
          </AnimatePresence>

          {/* Integrated Market Timeline Overlay */}
          <MarketTimeline 
            utcTime={utcTime} 
            activeSessions={marketMetrics.activeSessions.map(s => s.name)} 
          />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Activity className="text-blue-500" size={20} />
              <h2 className="text-xl font-bold tracking-tight text-white uppercase">Neural Inference Nodes</h2>
            </div>
            <div className="text-[10px] font-mono text-slate-500 border border-white/5 px-3 py-1 rounded-full bg-white/[0.02]">
              LOAD_BALANCER: OK
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {filteredAssets.map((asset) => (
              <PredictorCard 
                key={asset.symbol}
                symbol={asset.symbol} 
                type={asset.type} 
                onSignalDetected={handleSignal} 
                activeSessions={marketMetrics.activeSessions.map(s => s.name)}
              />
            ))}
          </div>
        </div>

        {/* RIGHT: Stats & History */}
        <div className="lg:col-span-4 space-y-6">
          <div className="sticky top-28 space-y-6">
            
            <SignalHistory 
              currentSignal={lastSignal} 
              activeSessions={marketMetrics.activeSessions.map(s => s.name)} 
            />
            
            <div className="bg-gradient-to-br from-slate-900 to-[#020617] border border-white/5 rounded-[2rem] p-6 shadow-xl relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-8 bg-blue-500/5 blur-[50px] rounded-full" />
              <div className="relative z-10">
                <div className="flex items-center gap-3 mb-6">
                  <ShieldCheck className="text-emerald-500" size={20} />
                  <h3 className="font-bold text-lg text-white uppercase tracking-tighter">Safety Protocol</h3>
                </div>
                
                <div className="space-y-4">
                  {[
                    { label: "CONFIRMATION", val: "Power Score > 92%", color: "text-blue-400" },
                    { label: "SPREAD", val: "Exness Zero Account Recommended", color: "text-slate-400" },
                    { label: "LEVERAGE", val: "Max 1:500 for Scalping", color: "text-rose-400" }
                  ].map((item, idx) => (
                    <div key={idx} className="bg-white/5 border border-white/5 p-3 rounded-xl">
                      <p className="text-[9px] font-black text-slate-500 mb-1">{item.label}</p>
                      <p className={`text-xs font-bold ${item.color}`}>{item.val}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* FOOTER */}
      <footer className="mt-20 border-t border-white/5 p-12 text-center bg-slate-950/80">
        <p className="text-[10px] text-slate-600 font-black tracking-[0.8em] mb-4">DECENTRALIZED DATA LAYER</p>
        <div className="flex justify-center gap-8 text-[10px] font-bold text-slate-500">
           <span>LATENCY: 14MS</span>
           <span>UPTIME: 99.99%</span>
           <span>ENGINE: V8.QUANT</span>
        </div>
      </footer>
    </div>
  );
}