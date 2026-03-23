import React, { useState, useCallback, useMemo } from 'react';
import { Activity, LayoutDashboard, Globe, ShieldCheck, Zap, Search, TrendingUp, BarChart3 } from 'lucide-react';
import PredictorCard from './components/PredictorCard';
import SignalHistory from './components/SignalHistory';

// Expanded Asset List matching Exness Terminal offerings
const ALL_ASSETS = [
  // CRYPTO PAIRS
  { symbol: 'BTCUSDT', type: 'crypto', name: 'Bitcoin / Tether' },
  { symbol: 'ETHUSDT', type: 'crypto', name: 'Ethereum / Tether' },
  { symbol: 'SOLUSDT', type: 'crypto', name: 'Solana / Tether' },
  { symbol: 'BNBUSDT', type: 'crypto', name: 'Binance Coin' },
  { symbol: 'XRPUSDT', type: 'crypto', name: 'Ripple / Tether' },
  { symbol: 'ADAUSDT', type: 'crypto', name: 'Cardano / Tether' },
  { symbol: 'DOGEUSDT', type: 'crypto', name: 'Dogecoin / Tether' },
  { symbol: 'AVAXUSDT', type: 'crypto', name: 'Avalanche / Tether' },

  // FOREX MAJORS & MINORS (Frankfurter compatible)
  { symbol: 'EURUSD', type: 'forex', name: 'EUR / USD' },
  { symbol: 'GBPUSD', type: 'forex', name: 'GBP / USD' },
  { symbol: 'USDJPY', type: 'forex', name: 'USD / JPY' },
  { symbol: 'AUDUSD', type: 'forex', name: 'AUD / USD' },
  { symbol: 'USDCAD', type: 'forex', name: 'USD / CAD' },
  { symbol: 'USDCHF', type: 'forex', name: 'USD / CHF' },
  { symbol: 'NZDUSD', type: 'forex', name: 'NZD / USD' },
  { symbol: 'EURGBP', type: 'forex', name: 'EUR / GBP' },
  { symbol: 'EURJPY', type: 'forex', name: 'EUR / JPY' },
  { symbol: 'GBPJPY', type: 'forex', name: 'GBP / JPY' },
];

export default function App() {
  const [lastSignal, setLastSignal] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilter, setActiveFilter] = useState('all'); // 'all', 'crypto', 'forex'

  const handleSignal = useCallback((signal) => {
    setLastSignal(signal);
  }, []);

  // Professional Filter Logic
  const filteredAssets = useMemo(() => {
    return ALL_ASSETS.filter(asset => {
      const matchesSearch = asset.symbol.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            asset.name.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesType = activeFilter === 'all' || asset.type === activeFilter;
      return matchesSearch && matchesType;
    });
  }, [searchTerm, activeFilter]);

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 font-sans antialiased selection:bg-blue-500/30 overflow-x-hidden">
      {/* 1. TOP NAVIGATION BAR */}
      <nav className="border-b border-white/5 bg-[#020617]/80 backdrop-blur-xl sticky top-0 z-50 px-6 py-4">
        <div className="max-w-[1600px] mx-auto flex flex-col md:row justify-between items-center gap-6">
          <div className="flex items-center gap-4 mt-20">
            <div className="bg-gradient-to-tr from-blue-600 to-indigo-600 p-2.5 rounded-2xl shadow-[0_0_20px_rgba(37,99,235,0.3)] animate-pulse">
              <Zap size={22} className="text-white fill-current" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tighter text-white bg-clip-text">TRADE PREDECTION</h1>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-emerald-500 rounded-full animate-ping"></span>
                <p className="text-[10px] text-blue-400 font-bold uppercase tracking-[0.2em]">Quant v2026.03</p>
              </div>
            </div>
          </div>

          {/* SEARCH & FILTER CONTROLS */}
          <div className="flex flex-col sm:flex-row items-center gap-4 w-full md:w-auto">
            <div className="relative w-full sm:w-80 group">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-blue-400 transition-colors" size={18} />
              <input 
                type="text"
                placeholder="Search Pairs..."
                className="w-full bg-white/5 border border-white/10 rounded-2xl py-3 pl-12 pr-4 text-sm focus:outline-none focus:border-blue-500/50 focus:ring-4 ring-blue-500/10 transition-all backdrop-blur-md text-white placeholder:text-slate-600"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            
            <div className="flex bg-white/5 p-1 rounded-2xl border border-white/10 backdrop-blur-md">
              {['all', 'crypto', 'forex'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveFilter(tab)}
                  className={`px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                    activeFilter === tab ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>
        </div>
      </nav>

      {/* 2. MAIN CONTENT GRID */}
      <main className="max-w-[1600px] mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* LEFT COLUMN: Predictor Grid */}
        <div className="lg:col-span-8 space-y-8">
          <section>
            <div className="flex items-center justify-between mb-8 px-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-500/10 rounded-lg text-blue-500">
                   <BarChart3 size={20} />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white tracking-tight">Market Intelligence</h2>
                  <p className="text-xs text-slate-500">Real-time neural inference for Exness terminals</p>
                </div>
              </div>
              <div className="px-4 py-1.5 bg-slate-900 border border-slate-800 rounded-full text-[10px] font-mono text-slate-400 tracking-tighter">
                ACTIVE_NODES: {filteredAssets.length}
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
              {filteredAssets.length > 0 ? (
                filteredAssets.map((asset) => (
                  <PredictorCard 
                    key={asset.symbol}
                    symbol={asset.symbol} 
                    type={asset.type} 
                    onSignalDetected={handleSignal} 
                  />
                ))
              ) : (
                <div className="col-span-full py-32 text-center border-2 border-dashed border-white/5 rounded-[3rem] bg-white/[0.02]">
                  <TrendingDown size={48} className="mx-auto text-slate-700 mb-4" />
                  <p className="text-slate-500 font-bold text-lg">No active signals for "{searchTerm}"</p>
                  <p className="text-slate-600 text-sm">Try searching for Major pairs like BTC or EUR</p>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN: Signal Log & Guide */}
        <div className="lg:col-span-4 space-y-8">
          <div className="sticky top-28 space-y-8">
            <SignalHistory currentSignal={lastSignal} />
            
            <div className="relative group">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-500 to-indigo-500 rounded-[2.5rem] blur opacity-10 group-hover:opacity-20 transition duration-1000"></div>
              <div className="relative bg-slate-900/60 backdrop-blur-xl border border-white/5 rounded-[2.5rem] p-8 shadow-2xl">
                <div className="flex items-center gap-3 mb-8">
                  <div className="p-2.5 bg-emerald-500/10 rounded-2xl border border-emerald-500/20">
                    <ShieldCheck size={20} className="text-emerald-500" />
                  </div>
                  <h3 className="font-bold text-xl text-white tracking-tight">Execution Protocol</h3>
                </div>
                
                <div className="space-y-6">
                  {[
                    { id: "01", title: "Confirmation", desc: "Wait for Power Score > 90%", color: "text-blue-400" },
                    { id: "02", title: "Volatility", desc: "Verify 24h change is > 0.5%", color: "text-indigo-400" },
                    { id: "03", title: "Execution", desc: "Use Exness MT5 One-Click Trading", color: "text-emerald-400" },
                    { id: "04", title: "Safety", desc: "Always input TP/SL before entry", color: "text-rose-400" },
                  ].map((item) => (
                    <div key={item.id} className="flex items-start gap-5">
                      <span className={`text-xs font-black px-2.5 py-1 rounded-lg bg-white/5 ${item.color}`}>{item.id}</span>
                      <div>
                        <p className="text-white font-bold text-sm leading-none mb-1">{item.title}</p>
                        <p className="text-slate-500 text-xs font-medium leading-relaxed">{item.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* FOOTER */}
      <footer className="border-t border-white/5 mt-32 p-12 text-center bg-slate-950/50 backdrop-blur-md">
        <div className="max-w-2xl mx-auto space-y-4">
           <p className="text-[10px] uppercase tracking-[0.6em] text-slate-600 font-black">Quantum Data Infrastructure</p>
           <div className="h-[1px] w-full bg-gradient-to-r from-transparent via-blue-500/20 to-transparent"></div>
           <p className="text-xs text-slate-500 leading-relaxed font-medium">
             Algorithm synced with Frankfurt Mid-Market and Binance Spot feeds. <br/>
             Inference Engine v2.0.4 • Optimized for Exness High-Leverage Terminals.
           </p>
        </div>
      </footer>
    </div>
  );
}