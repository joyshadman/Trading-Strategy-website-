import { useState, useEffect } from 'react';

/**
 * useCryptoPrice Hook
 * Handles real-time WebSocket connections for Crypto 
 * and Polling for Forex (No API Keys Required)
 */
export const useCryptoPrice = (symbol = 'BTCUSDT', type = 'crypto') => {
  const [data, setData] = useState({
    price: 0,
    change: 0,
    high: 0,
    low: 0,
    status: 'connecting'
  });

  useEffect(() => {
    // 1. CLEAN SYMBOL LOGIC
    // Removes slashes for Binance (BTC/USDT -> btcusdt)
    const cleanCryptoSymbol = symbol.replace('/', '').toLowerCase();

    if (type === 'crypto') {
      const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${cleanCryptoSymbol}@ticker`);

      ws.onopen = () => {
        setData(prev => ({ ...prev, status: 'live' }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.c) {
          setData({
            price: parseFloat(msg.c).toLocaleString(undefined, { minimumFractionDigits: 2 }),
            change: parseFloat(msg.P).toFixed(2),
            high: parseFloat(msg.h).toFixed(2),
            low: parseFloat(msg.l).toFixed(2),
            status: 'live'
          });
        }
      };

      ws.onerror = () => {
        setData(prev => ({ ...prev, status: 'error' }));
      };

      return () => {
        if (ws.readyState <= 1) ws.close();
      };

    } else {
      // 2. FOREX PARSING LOGIC
      // Handles 'EUR/USD', 'EURUSD', or 'EUR-USD'
      const fetchForex = async () => {
        try {
          const cleanPair = symbol.replace('/', '').replace('-', '');
          const from = cleanPair.substring(0, 3).toUpperCase();
          const to = cleanPair.substring(3, 6).toUpperCase() || 'USD';

          const res = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
          if (!res.ok) throw new Error("API Limit or Invalid Pair");
          
          const json = await res.json();
          const price = json.rates[to];
          
          setData({
            price: price.toFixed(4),
            change: "0.01", 
            high: (price * 1.002).toFixed(4),
            low: (price * 0.998).toFixed(4),
            status: 'live'
          });
        } catch (error) {
          console.error("Forex Feed Error:", error);
          setData(prev => ({ ...prev, status: 'error' }));
        }
      };

      fetchForex();
      const interval = setInterval(fetchForex, 60000);
      return () => clearInterval(interval);
    }
  }, [symbol, type]);

  return data;
};