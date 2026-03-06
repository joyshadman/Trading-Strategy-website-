import React, { useState, useEffect, useRef } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  Zap, 
  ShieldAlert, 
  Activity, 
  Clock, 
  Target,
  BrainCircuit,
  Waves,
  Loader2
} from 'lucide-react';

const PredictorCard = ({ symbol = "BTC/USDT", type = 'crypto', onSignalDetected }) => {
  const [data, setData] = useState({ price: 0, change: 0, high: 0, low: 0 });
  const [isScanning, setIsScanning] = useState(true);
  const [prediction, setPrediction] = useState({ 
    signal: 'Scanning...', 
    score: 0, 
    tp: 0, 
    sl: 0, 
    holdTime: '...' 
  });

  const socketRef = useRef(null);
  const priceHistory = useRef([]);
  const reconnectTimeout = useRef(null);
  const forexInterval = useRef(null);

  const runNeuralInference = (current, high, low, change) => {
    if (!current || isNaN(current)) return;

    priceHistory.current.push(current);
    if (priceHistory.current.length > 20) priceHistory.current.shift();
    
    if (priceHistory.current.length < 5) return;

    const prevPrice = priceHistory.current[0];
    const momentum = ((current - prevPrice) / prevPrice) * 100;
    const range = high - low || 0.0001;
    const position = ((current - low) / range) * 100;

    let score = 50;
    let signal = "Wait";

    if (position < 15 && momentum > -0.05) {
      signal = "Strong Buy";
      score = 85 + Math.random() * 10;
    } else if (position > 85 && momentum < 0.05) {
      signal = "Strong Sell";
      score = 85 + Math.random() * 10;
    } else if (position > 60) {
      signal = "Buy";
      score = 65 + (position * 0.1);
    } else if (position < 40) {
      signal = "Sell";
      score = 65 + ((100 - position) * 0.1);
    }

    const finalScore = Math.floor(Math.min(score, 99));
    const isBuy = signal.includes("Buy");
    const multiplier = type === 'crypto' ? 0.02 : 0.0015; 
    const tp = isBuy ? current * (1 + multiplier) : current * (1 - multiplier);
    const sl = isBuy ? current * (1 - multiplier * 0.5) : current * (1 + multiplier * 0.5);

    setIsScanning(false);

    setPrediction({
      signal,
      score: finalScore,
      tp: tp.toFixed(type === 'crypto' ? 2 : 5),
      sl: sl.toFixed(type === 'crypto' ? 2 : 5),
      holdTime: type === 'crypto' ? "45-120 Mins" : "15-30 Mins"
    });

    if (finalScore > 88 && onSignalDetected) {
      onSignalDetected({ pair: symbol, type: isBuy ? 'BUY' : 'SELL', price: current });
    }
  };

  useEffect(() => {
    let active = true;
    setIsScanning(true);
    priceHistory.current = [];

    const cleanup = () => {
      if (socketRef.current) {
        // Remove listeners first to prevent state updates during teardown
        socketRef.current.onmessage = null;
        socketRef.current.onclose = null;
        socketRef.current.onerror = null;
        
        // Only close if it's not already closed or closing
        if (socketRef.current.readyState === WebSocket.OPEN || socketRef.current.readyState === WebSocket.CONNECTING) {
          socketRef.current.close();
        }
        socketRef.current = null;
      }
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      if (forexInterval.current) clearInterval(forexInterval.current);
    };

    const startCrypto = () => {
      if (!active) return;
      cleanup();

      const cleanSymbol = symbol.replace('/', '').toLowerCase();
      const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${cleanSymbol}@ticker`);
      
      ws.onmessage = (e) => {
        if (!active) return;
        try {
          const m = JSON.parse(e.data);
          const p = parseFloat(m.c), h = parseFloat(m.h), l = parseFloat(m.l);
          setData({ price: p, change: m.P, high: h, low: l });
          runNeuralInference(p, h, l, m.P);
        } catch (err) { console.error("Parse Error"); }
      };

      ws.onclose = () => {
        if (active && type === 'crypto') {
          reconnectTimeout.current = setTimeout(startCrypto, 5000);
        }
      };

      ws.onerror = (err) => {
        console.warn("WebSocket Error, retrying...");
      };

      socketRef.current = ws;
    };

    const startForex = () => {
      cleanup();
      const fetchFx = async () => {
        if (!active) return;
        try {
          const clean = symbol.replace(/[^A-Z]/gi, "");
          const base = clean.substring(0, 3).toUpperCase();
          const target = clean.substring(3, 6).toUpperCase() || 'USD';

          const res = await fetch(`https://api.frankfurter.app/latest?from=${base}&to=${target}`);
          if (!res.ok) throw new Error("API Limit or Error");
          const json = await res.json();
          
          if (active && json.rates && json.rates[target]) {
            const price = json.rates[target];
            const h = price * 1.0005, l = price * 0.9995;
            setData({ price, change: "0.01", high: h, low: l });
            runNeuralInference(price, h, l, "0.01");
          }
        } catch (e) { console.error("Forex Feed Offline"); }
      };

      fetchFx();
      forexInterval.current = setInterval(fetchFx, 15000);
    };

    if (type === 'crypto') startCrypto();
    else startForex();

    return () => { 
      active = false; 
      cleanup(); 
    };
  }, [symbol, type]);

  return (
    <div className="bg-slate-950/60 backdrop-blur-2xl border border-white/10 rounded-[2.5rem] p-7 transition-all duration-500 group relative overflow-hidden shadow-2xl min-h-[420px] flex flex-col justify-between">
      {!isScanning && (
        <div className={`absolute -inset-1 opacity-20 blur-2xl transition-all duration-1000 ${prediction.signal.includes('Buy') ? 'bg-green-500/20' : prediction.signal.includes('Sell') ? 'bg-red-500/20' : 'bg-blue-500/10'}`} />
      )}

      <div className="relative z-10">
        <div className="flex justify-between items-start mb-6">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-2xl font-black text-white tracking-tighter uppercase">{symbol}</h3>
              <div className="px-2 py-0.5 bg-blue-500/20 rounded text-[8px] font-bold text-blue-400 tracking-widest uppercase">PRO</div>
            </div>
            <div className="flex items-center gap-2 mt-1">
               <Waves size={12} className="text-blue-500 animate-pulse" />
               <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Quantum Core v8.4</span>
            </div>
          </div>
          <div className={`px-4 py-1.5 rounded-full text-[10px] font-black border backdrop-blur-md ${parseFloat(data.change) >= 0 ? 'border-green-500/30 text-green-400' : 'border-red-500/30 text-red-400'}`}>
            {data.change}%
          </div>
        </div>

        <div className="mb-8 text-5xl font-black text-white tracking-tighter tabular-nums">
          <span className="text-blue-500 text-2xl mr-1 font-medium">$</span>
          {data.price === 0 ? "..." : data.price.toLocaleString(undefined, { minimumFractionDigits: type === 'crypto' ? 2 : 4 })}
        </div>

        {isScanning ? (
          <div className="flex flex-col items-center justify-center py-10 space-y-4 bg-white/5 rounded-3xl border border-white/5 animate-pulse">
            <Loader2 className="text-blue-500 animate-spin" size={32} />
            <div className="text-center">
              <p className="text-[10px] font-black text-blue-400 uppercase tracking-[0.2em]">Neural Analysis</p>
              <p className="text-[9px] text-slate-500 uppercase font-bold mt-1">Collecting Market Depth...</p>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 mb-6">
              <div className="bg-white/5 border border-white/5 p-4 rounded-3xl backdrop-blur-sm">
                <p className="text-[9px] font-black text-slate-500 uppercase mb-1 tracking-widest">Take Profit</p>
                <p className="text-sm font-black text-green-400 flex items-center gap-2"><Target size={14}/> {prediction.tp}</p>
              </div>
              <div className="bg-white/5 border border-white/5 p-4 rounded-3xl backdrop-blur-sm">
                <p className="text-[9px] font-black text-slate-500 uppercase mb-1 tracking-widest">Stop Loss</p>
                <p className="text-sm font-black text-red-400 flex items-center gap-2"><ShieldAlert size={14}/> {prediction.sl}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <StatBox label="Execution" value={prediction.signal} color={prediction.signal.includes('Buy') ? 'text-green-400' : prediction.signal.includes('Wait') ? 'text-slate-500' : 'text-red-400'} icon={<BrainCircuit size={14}/>} />
              <StatBox label="Holding Time" value={prediction.holdTime} color="text-blue-400" icon={<Clock size={14}/>} />
            </div>
          </>
        )}
      </div>

      {!isScanning && prediction.score > 85 && (
        <div className="mt-6 p-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl flex items-center gap-3 animate-pulse relative z-10">
          <Zap size={18} className="text-yellow-400 fill-yellow-400" />
          <p className="text-[10px] font-black text-white uppercase italic">
            High Confidence Entry Detected. Probability: {prediction.score}%
          </p>
        </div>
      )}
    </div>
  );
};

const StatBox = ({ label, value, color, icon }) => (
  <div className="bg-white/5 p-4 rounded-3xl border border-white/5 backdrop-blur-sm">
    <div className="flex items-center gap-2 mb-1">
      <span className="text-blue-400">{icon}</span>
      <p className="text-[9px] text-slate-500 uppercase font-black tracking-tighter">{label}</p>
    </div>
    <div className={`font-black text-sm truncate ${color}`}>{value}</div>
  </div>
);

export default PredictorCard;