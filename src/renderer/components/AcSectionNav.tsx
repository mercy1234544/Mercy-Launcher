import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Server, Globe2, Wrench } from 'lucide-react';

// The one navigation strip shared by every Assetto Corsa page, so the three halves of the game's area
// read as ONE section instead of unrelated pages:
//   My Servers          — dedicated servers YOU host and manage (create, import, start/stop, content library)
//   Mercy's Servers     — OFFICIAL servers run by Mercy that you join (requirements check, install, join)
//   Setup & Diagnostics — your game install, CSP, companion app, connection endpoints, troubleshooting
export const AC_NAV_TABS = [
  { id: 'my', label: 'My Servers', hint: 'Servers you host', path: '/assetto-corsa', icon: Server, match: (p: string) => p.startsWith('/assetto-corsa') && !p.startsWith('/assetto-corsa/setup') },
  { id: 'mercy', label: "Mercy's Servers", hint: 'Official servers you join', path: '/mercy-servers/assettocorsa', icon: Globe2, match: (p: string) => p.startsWith('/mercy-servers/assettocorsa') },
  { id: 'setup', label: 'Setup & Diagnostics', hint: 'Your game install & troubleshooting', path: '/assetto-corsa/setup', icon: Wrench, match: (p: string) => p.startsWith('/assetto-corsa/setup') },
] as const;

export default function AcSectionNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <nav aria-label="Assetto Corsa sections" className="flex items-center gap-1 p-1 rounded-xl border border-overlay-6 bg-surface-900/50 w-fit max-w-full overflow-x-auto">
      {AC_NAV_TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <button key={t.id} onClick={() => navigate(t.path)} aria-current={active ? 'page' : undefined} title={t.hint}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${active ? 'bg-primary-600/25 text-primary-100 shadow-glow-sm' : 'text-surface-400 hover:text-surface-100 hover:bg-overlay-6'}`}>
            <t.icon size={14} /> {t.label}
          </button>
        );
      })}
    </nav>
  );
}
