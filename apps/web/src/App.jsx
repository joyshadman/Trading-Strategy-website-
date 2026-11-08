import { useEffect, useState } from 'react';
import { Bot, LineChart } from 'lucide-react';
import MarketPage from './pages/MarketPage';
import BotPage from './pages/BotPage';

// The page comes from the URL hash (spec 0004 AC-1): `#/bot` is the Bot page, anything else
// is Market. A refresh keeps the page and the back button works; no router library.
const pageFromHash = () => (location.hash === '#/bot' ? 'bot' : 'market');

const PAGES = [
  { key: 'market', href: '#/', label: 'Market', icon: <LineChart size={13} aria-hidden="true" /> },
  { key: 'bot', href: '#/bot', label: 'Bot', icon: <Bot size={13} aria-hidden="true" /> },
];

export default function App() {
  const [page, setPage] = useState(pageFromHash);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.title = page === 'bot' ? 'Bot · Quantum Terminal' : 'Quantum Terminal';
  }, [page]);

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 font-sans antialiased selection:bg-blue-500/30 overflow-x-hidden">
      <nav aria-label="Pages" className="border-b border-white/5 bg-slate-950 px-4 sm:px-6 py-2">
        <ul className="max-w-[1600px] mx-auto flex items-center gap-1">
          {PAGES.map(({ key, href, label, icon }) => (
            <li key={key}>
              <a
                href={href}
                aria-current={page === key ? 'page' : undefined}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all focus-visible:outline-2 focus-visible:outline-blue-400 ${
                  page === key ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'
                }`}
              >
                {icon}
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {page === 'bot' ? <BotPage /> : <MarketPage />}
    </div>
  );
}
