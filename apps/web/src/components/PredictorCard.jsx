import React, { useState, useEffect, useRef } from 'react';
import { 
  Zap, 
  ShieldAlert, 
  Activity, 
  Target,
  BrainCircuit,
  Loader2,
  TrendingUp,
  TrendingDown,
  Gauge,
  BarChart3,
  Bell,
  BellOff
} from 'lucide-react';
import { calculateEMA, calculateRSI, calculateMACD } from '@trading/shared';

const STRONG_SIGNAL_MIN_SCORE = 94;
const CRYPTO_CONFIRM_INTERVALS = ["1m", "5m", "15m"];

const FX_API_BASE_URL = "https://api.frankfurter.dev/v1";

const fetchFxRate = async ({ base, target }) => {
  const url = `${FX_API_BASE_URL}/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(target)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`FX HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const json = await res.json();
  const rate = json?.rates?.[target];
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    throw new Error(`FX rate missing for ${base}/${target}`);
  }
  return rate;
};

const PredictorCard = ({ symbol = "BTCUSDT", type = 'crypto', onSignalDetected }) => {
  const [data, setData] = useState({ price: 0, change: 0, high: 0, low: 0, volume: 0 });
  const [isScanning, setIsScanning] = useState(true);
  const [alarmEnabled, setAlarmEnabled] = useState(false);
  const [prediction, setPrediction] = useState({ 
    signal: 'Analyzing...', score: 0, tp: 0, sl: 0, holdTime: '...', timeframe: '...', entryWindow: '...', confirmations: '' 
  });

  const socketRef = useRef(null);
  const priceHistory = useRef([]);
  const forexInterval = useRef(null);
  const cryptoConfirmInterval = useRef(null);
  const lastEmittedKey = useRef(null);
  const signalGate = useRef({
    confirmed: "Hold",
    candidate: null,
    streak: 0,
    lastFlipAt: 0,
    lastUiUpdateAt: 0,
  });
  const confirmState = useRef({
    timeframes: {
      "1m": { bias: "neutral", strength: 0 },
      "5m": { bias: "neutral", strength: 0 },
      "15m": { bias: "neutral", strength: 0 },
    },
    updatedAt: 0,
  });

  const playAlarm = React.useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      const now = ctx.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      osc.stop(now + 0.38);
      setTimeout(() => ctx.close().catch((e) => console.debug(e)), 650);
    } catch (e) {
      console.debug(e);
    }
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(`alarm:${symbol}`);
      if (stored === "1") queueMicrotask(() => setAlarmEnabled(true));
    } catch (e) {
      console.debug(e);
    }
  }, [symbol]);

  const setAlarm = React.useCallback(async (next) => {
    setAlarmEnabled(next);
    try {
      localStorage.setItem(`alarm:${symbol}`, next ? "1" : "0");
    } catch (e) {
      console.debug(e);
    }
    if (next && "Notification" in window && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch (e) {
        console.debug(e);
      }
    }
  }, [symbol]);

  /**
   * QUANT ENGINE V9.2 - TRIPLE CONFLUENCE LOGIC
   */
  const runQuantEngine = React.useCallback((current) => {
    priceHistory.current.push(current);
    if (priceHistory.current.length > 200) priceHistory.current.shift();
    
    const history = priceHistory.current;
    if (history.length < 60) return;

    // 1. TREND HIERARCHY (EMA RIBBON)
    const ema9 = calculateEMA(history, 9);   // Entry trigger
    const ema21 = calculateEMA(history, 21); // Trend confirmation
    const ema50 = calculateEMA(history, 50); // Major baseline

    // 2. MOMENTUM & EXHAUSTION
    const rsi = calculateRSI(history, 14);
    const macd = calculateMACD(history);
    
    // 3. STATISTICAL VOLATILITY (MEAN REVERSION)
    const avg = history.reduce((a, b) => a + b, 0) / history.length;
    const stdDev = Math.sqrt(history.map(x => Math.pow(x - avg, 2)).reduce((a, b) => a + b) / history.length);
    const zScore = (current - avg) / (stdDev || 1);

    let score = 50;
    let signal = "Hold";

    // --- DECISION MATRIX ---
    const isBullishStack = ema9 > ema21 && ema21 > ema50;
    const isBearishStack = ema9 < ema21 && ema21 < ema50;
    
    // STRONG BUY: Trend is up + Momentum is positive + Not Overbought
    if (isBullishStack && macd.hist > 0 && rsi < 65 && zScore < 1.5) {
      signal = "Strong Buy";
      score = 94 + Math.min(5, Math.max(0, (macd.hist * 20))) + Math.min(2, Math.max(0, (65 - rsi) / 10));
    } 
    // STRONG SELL: Trend is down + Momentum is negative + Not Oversold
    else if (isBearishStack && macd.hist < 0 && rsi > 35 && zScore > -1.5) {
      signal = "Strong Sell";
      score = 94 + Math.min(5, Math.max(0, (-macd.hist * 20))) + Math.min(2, Math.max(0, (rsi - 35) / 10));
    }
    // MEAN REVERSION BUY (Dip Buying)
    else if (zScore < -2.2 && rsi < 30) {
      signal = "Buy (Extreme Dip)";
      score = 85;
    }
    // TAKE PROFIT WARNING
    else if (isBullishStack && (rsi > 80 || zScore > 2.5)) {
      signal = "Take Profit / Hold";
      score = 60;
    }
    else if (isBullishStack) {
      signal = "Buy";
      score = 70 + (rsi * 0.1);
    }
    else if (isBearishStack) {
      signal = "Sell";
      score = 70 + ((100 - rsi) * 0.1);
    }

    // --- CONFIRMATION CHECKLIST (strong signals require multiple agrees) ---
    const confirmations = [];
    if (isBullishStack) confirmations.push("EMA stack bullish");
    if (isBearishStack) confirmations.push("EMA stack bearish");
    if (macd.hist > 0) confirmations.push("MACD momentum up");
    if (macd.hist < 0) confirmations.push("MACD momentum down");
    if (rsi < 65) confirmations.push("RSI not overbought");
    if (rsi > 35) confirmations.push("RSI not oversold");
    if (Math.abs(zScore) < 1.5) confirmations.push("Volatility normal");

    // --- MULTI-TIMEFRAME CONFIRMATION (CRYPTO) + EXECUTION TF (FOREX) ---
    let tfBoost = 0;
    let tfLabel = type === "crypto" ? "1m/5m/15m" : "10s";
    let entryWindow =
      type === "crypto"
        ? "Wait 1-3 candles; enter on pullback to EMA9/EMA21 with momentum holding"
        : "Wait for retest of EMA9/EMA21 zone; enter only if MACD momentum agrees";

    if (type === "crypto") {
      const st = confirmState.current?.timeframes || {};
      const bias1 = st["1m"]?.bias;
      const bias5 = st["5m"]?.bias;
      const bias15 = st["15m"]?.bias;

      const allBull = bias1 === "bull" && bias5 === "bull" && bias15 === "bull";
      const allBear = bias1 === "bear" && bias5 === "bear" && bias15 === "bear";
      if (allBull) confirmations.push("MTF aligned bull (1m/5m/15m)");
      if (allBear) confirmations.push("MTF aligned bear (1m/5m/15m)");
      const strongWord = signal.startsWith("Strong");
      const buyWord = signal.includes("Buy");
      const sellWord = signal.includes("Sell");

      if (strongWord && buyWord && allBull) {
        tfBoost = 4;
        entryWindow = "Enter on 1m pullback to EMA9/EMA21; require 5m momentum to hold";
      } else if (strongWord && sellWord && allBear) {
        tfBoost = 4;
        entryWindow = "Enter on 1m breakdown below EMA21; require 5m momentum to hold";
      } else if (strongWord && (buyWord || sellWord)) {
        // strong signal without full alignment should be downgraded
        score = Math.min(score, 90);
      }
    } else {
      // Forex: stricter trigger — require at least 4 confirmations before allowing "Strong"
      const hasStrongWord = signal.startsWith("Strong");
      if (hasStrongWord && confirmations.length < 4) {
        score = Math.min(score, 90);
        signal = signal.includes("Buy") ? "Buy" : signal.includes("Sell") ? "Sell" : signal;
      }
    }

    const finalScore = Math.floor(Math.min(score + tfBoost, 99));
    
    // Dynamic Risk/Reward (2:1 Ratio)
    const volFactor = type === 'crypto' ? 0.028 : 0.0018; 

    // --- SIGNAL STABILIZATION (prevents rapid flipping) ---
    const now = Date.now();
    const minStreak = type === "crypto" ? 8 : 2; // crypto ticks are frequent
    const minFlipCooldownMs = type === "crypto" ? 60_000 : 30_000;

    const gate = signalGate.current;
    if (signal !== gate.confirmed) {
      if (gate.candidate === signal) gate.streak += 1;
      else {
        gate.candidate = signal;
        gate.streak = 1;
      }
      const cooldownOk = (now - gate.lastFlipAt) >= minFlipCooldownMs;
      if (gate.streak >= minStreak && cooldownOk) {
        gate.confirmed = signal;
        gate.lastFlipAt = now;
      }
    } else {
      gate.candidate = null;
      gate.streak = 0;
    }

    const confirmedSignal = gate.confirmed;
    const confirmedIsBuy = confirmedSignal.includes("Buy");
    const confirmedIsSell = confirmedSignal.includes("Sell");

    // Update UI at most ~4x/sec for crypto (prevents flicker).
    const uiInterval = type === "crypto" ? 250 : 0;
    if (uiInterval === 0 || (now - gate.lastUiUpdateAt) >= uiInterval) {
      gate.lastUiUpdateAt = now;
      setPrediction({
        signal: confirmedSignal,
        score: finalScore,
        tp: (confirmedIsBuy ? current * (1 + volFactor) : confirmedIsSell ? current * (1 - volFactor) : current).toFixed(type === 'crypto' ? 2 : 5),
        sl: (confirmedIsBuy ? current * (1 - volFactor * 0.5) : confirmedIsSell ? current * (1 + volFactor * 0.5) : current).toFixed(type === 'crypto' ? 2 : 5),
        holdTime: type === 'crypto' ? "45-120 Mins" : "15-45 Mins",
        timeframe: tfLabel,
        entryWindow,
        confirmations: confirmations.slice(0, 6).join(" • "),
      });
    }

    const isStrongConfirmed = confirmedSignal === "Strong Buy" || confirmedSignal === "Strong Sell";
    if (isStrongConfirmed && finalScore >= STRONG_SIGNAL_MIN_SCORE && onSignalDetected) {
      const side = confirmedIsBuy ? 'BUY' : 'SELL';
      const dedupeKey = `${symbol}:${side}:${tfLabel}:${Math.floor(Date.now() / 60000)}`; // 1-min window
      if (lastEmittedKey.current !== dedupeKey) {
        lastEmittedKey.current = dedupeKey;
        const payload = {
          pair: symbol,
          type: side,
          price: current,
          confidence: finalScore,
          strength: confirmedSignal,
          timeframe: tfLabel,
          entryWindow,
          confirmations,
          tp: (confirmedIsBuy ? current * (1 + volFactor) : current * (1 - volFactor)).toFixed(type === 'crypto' ? 2 : 5),
          sl: (confirmedIsBuy ? current * (1 - volFactor * 0.5) : current * (1 + volFactor * 0.5)).toFixed(type === 'crypto' ? 2 : 5),
        };

        onSignalDetected(payload);

        if (alarmEnabled) {
          playAlarm();
          if ("Notification" in window && Notification.permission === "granted") {
            try {
              new Notification(`${payload.strength}: ${payload.pair}`, {
                body: `${payload.type} • ${payload.timeframe} • ${payload.confidence}%\nTP ${payload.tp} | SL ${payload.sl}`,
              });
            } catch (e) {
              console.debug(e);
            }
          }
        }
      }
    }
    setIsScanning(false);
  }, [alarmEnabled, onSignalDetected, playAlarm, symbol, type]);

  const computeBiasFromCloses = React.useCallback((closes) => {
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);
    const rsi = calculateRSI(closes, 14);
    const macd = calculateMACD(closes);
    const bull = ema9 > ema21 && ema21 > ema50 && macd.hist > 0 && rsi < 72;
    const bear = ema9 < ema21 && ema21 < ema50 && macd.hist < 0 && rsi > 28;
    return { bias: bull ? "bull" : bear ? "bear" : "neutral", strength: bull || bear ? 1 : 0 };
  }, []);

  useEffect(() => {
    let isMounted = true; 
    const cleanStr = symbol.replace(/[^A-Z]/gi, "").toUpperCase();
    const base = cleanStr.substring(0, 3);
    const target = cleanStr.substring(3, 6) || "USD";

    const fetchSeedData = async () => {
      try {
        if (type === 'crypto') {
          const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${cleanStr}&interval=1m&limit=150`);
          const candles = await res.json();
          if (isMounted) priceHistory.current = candles.map(c => parseFloat(c[4]));
        } else {
          const p = await fetchFxRate({ base, target });
          if (isMounted) priceHistory.current = Array(100).fill(p).map(v => v * (1 + (Math.random() - 0.5) * 0.001));
        }
      } catch (err) {
        console.warn("FX seeding error:", err);
      }
    };

    const refreshCryptoConfirm = async () => {
      try {
        const tfResults = {};
        for (const interval of CRYPTO_CONFIRM_INTERVALS) {
          const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${cleanStr}&interval=${interval}&limit=200`);
          const candles = await res.json();
          const closes = Array.isArray(candles) ? candles.map(c => parseFloat(c[4])) : [];
          if (closes.length >= 60) tfResults[interval] = computeBiasFromCloses(closes);
        }
        confirmState.current = {
          timeframes: {
            "1m": tfResults["1m"] || confirmState.current.timeframes["1m"],
            "5m": tfResults["5m"] || confirmState.current.timeframes["5m"],
            "15m": tfResults["15m"] || confirmState.current.timeframes["15m"],
          },
          updatedAt: Date.now(),
        };
      } catch (e) {
        console.warn("TF confirm refresh failed:", e);
      }
    };

    const initStream = () => {
      if (!isMounted) return;
      if (type === 'crypto') {
        refreshCryptoConfirm();
        cryptoConfirmInterval.current = setInterval(refreshCryptoConfirm, 60_000);
        const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${cleanStr.toLowerCase()}@ticker`);
        ws.onmessage = (e) => {
          if (!isMounted) return;
          const m = JSON.parse(e.data);
          const p = parseFloat(m.c);
          setData({ price: p, change: m.P, high: parseFloat(m.h), low: parseFloat(m.l), volume: m.v });
          runQuantEngine(p);
        };
        socketRef.current = ws;
      } else {
        const fetchFx = async () => {
          try {
            const p = await fetchFxRate({ base, target });
            if (isMounted) {
              setData({ price: p, change: "0.02", high: p * 1.002, low: p * 0.998, volume: 1000 });
              runQuantEngine(p);
            }
          } catch (e) {
            console.warn(`FX update failed for ${base}/${target}:`, e);
          }
        };
        fetchFx();
        forexInterval.current = setInterval(fetchFx, 10000);
      }
    };

    fetchSeedData().then(() => isMounted && initStream());

    return () => {
      isMounted = false;
      if (socketRef.current) socketRef.current.close();
      if (forexInterval.current) clearInterval(forexInterval.current);
      if (cryptoConfirmInterval.current) clearInterval(cryptoConfirmInterval.current);
    };
  }, [computeBiasFromCloses, runQuantEngine, symbol, type]);

  return (
    <div className="bg-slate-950/40 backdrop-blur-3xl border border-white/5 rounded-[2.5rem] p-7 group relative overflow-hidden shadow-2xl min-h-[500px] flex flex-col justify-between transition-all duration-700">
      
      {/* Visual Indicator Aura */}
      <div className={`absolute -top-32 -left-32 h-96 w-96 rounded-full blur-[120px] transition-all duration-1000 ${
        prediction.signal.includes('Buy') ? 'bg-emerald-500/20' : prediction.signal.includes('Sell') ? 'bg-rose-500/20' : 'bg-blue-600/10'
      }`} />

      <div className="relative z-10">
        <div className="flex justify-between items-start mb-10">
          <div>
            <div className="flex items-center gap-3">
              <h3 className="text-4xl font-black text-white tracking-tighter uppercase">{symbol}</h3>
              <div className="px-2 py-1 bg-blue-600/20 border border-blue-500/30 rounded-lg flex items-center gap-1.5">
                 <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                 <span className="text-[9px] font-black text-blue-400 tracking-widest uppercase text-white/90">Quant V9.2</span>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-2">
               <Activity size={14} className="text-slate-500" />
               <span className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.2em]">Neural Signal Convergence</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAlarm(!alarmEnabled)}
              className={`p-2 rounded-2xl border backdrop-blur-xl transition-colors duration-500 ${
                alarmEnabled ? 'bg-blue-500/15 border-blue-500/25 text-blue-300' : 'bg-white/5 border-white/10 text-slate-500 hover:text-slate-300'
              }`}
              aria-label={alarmEnabled ? "Disable alarm" : "Enable alarm"}
              title={alarmEnabled ? "Alarm enabled" : "Enable alarm"}
            >
              {alarmEnabled ? <Bell size={16} /> : <BellOff size={16} />}
            </button>
            <div className={`px-4 py-2 rounded-2xl text-xs font-black border backdrop-blur-xl transition-colors duration-500 ${
              parseFloat(data.change) >= 0 ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
            }`}>
              {parseFloat(data.change) >= 0 ? '+' : ''}{data.change}%
            </div>
          </div>
        </div>

        <div className="mb-12">
           <div className="text-7xl font-black text-white tracking-tighter tabular-nums flex items-baseline">
            <span className="text-blue-500 text-3xl mr-2 font-black">$</span>
            {data.price === 0 ? "0.00" : data.price.toLocaleString(undefined, { minimumFractionDigits: type === 'crypto' ? 2 : 5 })}
          </div>
          <div className="flex items-center gap-4 mt-2 px-1">
             <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold uppercase tracking-tighter">
               <BarChart3 size={12} className="text-blue-400" /> Vol: {parseFloat(data.volume).toFixed(2)}
             </div>
          </div>
        </div>

        {isScanning ? (
          <div className="flex flex-col items-center justify-center py-16 bg-white/5 rounded-[2.5rem] border border-white/5">
            <Loader2 className="text-blue-500 animate-spin mb-4" size={32} />
            <p className="text-[10px] font-black text-blue-400 uppercase tracking-[0.4em] animate-pulse">Syncing Blockchain Data</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <StatBox label="Signal Analysis" value={prediction.signal} color={prediction.signal.includes('Buy') ? 'text-emerald-400' : prediction.signal.includes('Sell') ? 'text-rose-400' : 'text-blue-400'} icon={<Gauge size={16}/>} />
            <StatBox label="Confidence" value={`${prediction.score}%`} color="text-white" icon={<BrainCircuit size={16}/>} />
            <StatBox label="Target (TP)" value={prediction.tp} color="text-emerald-400" icon={<Target size={16}/>} />
            <StatBox label="Defense (SL)" value={prediction.sl} color="text-rose-400" icon={<ShieldAlert size={16}/>} />
            {type === "crypto" && (
              <>
                <StatBox label="Timeframe" value={prediction.timeframe} color="text-slate-200" icon={<Activity size={16}/>} />
                <StatBox label="Entry Window" value={prediction.entryWindow} color="text-slate-200" icon={<Zap size={16}/>} />
                <StatBox label="Confirmations" value={prediction.confirmations || "…"} color="text-slate-400" icon={<BrainCircuit size={16}/>} />
              </>
            )}
          </div>
        )}
      </div>

      {!isScanning && prediction.score > 90 && (
        <div className="mt-8 p-5 bg-emerald-500/10 border border-emerald-400/20 rounded-[2rem] flex items-center justify-between relative z-10 overflow-hidden">
          <div className="flex items-center gap-4">
            <div className="p-2 bg-emerald-500/20 rounded-xl">
              <Zap size={20} className="text-emerald-400 fill-emerald-400" />
            </div>
            <div>
              <p className="text-[11px] font-black text-white uppercase tracking-tighter">High Probability Detected</p>
              <p className="text-[9px] text-emerald-400/80 font-bold uppercase tracking-widest">Entry Efficiency: Optimized</p>
            </div>
          </div>
          <div className="text-[10px] font-black text-white/40 italic">
            {prediction.holdTime}
          </div>
        </div>
      )}
    </div>
  );
};

const StatBox = ({ label, value, color, icon }) => (
  <div className="bg-white/5 p-4 rounded-3xl border border-white/5 backdrop-blur-md hover:bg-white/10 transition-colors cursor-default group/stat">
    <div className="flex items-center gap-2 mb-1.5">
      <span className="text-blue-400/60 group-hover/stat:text-blue-400 transition-colors">{icon}</span>
      <p className="text-[9px] text-slate-500 uppercase font-black tracking-tighter">{label}</p>
    </div>
    <div className={`font-black text-base truncate ${color}`}>{value}</div>
  </div>
);

export default PredictorCard;