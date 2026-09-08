import React from 'react';
import { motion } from 'framer-motion';
import { useNavigate, useLocation } from 'react-router-dom';
import { Home, LayoutGrid, Download, Settings, Shield, UserCircle2, ChevronRight } from 'lucide-react';
import MercyLogo from './MercyLogo';
import { useAuth } from '../stores/useAuth';
import { useAppAuth } from '../stores/useAppAuth';
import { useLocalAccess } from '../stores/useLocalAccess';
import { useTheme } from '../stores/useTheme';
import { isSupabaseConfigured } from '../lib/supabase';

// Global launcher navigation ONLY — Home, Library, Downloads, Settings. Games
// are NOT sidebar items: FiveM/Minecraft/Assetto Corsa/BeamNG.drive live as
// the large cards on Home and are opened from there, matching the reference
// launcher's structure (sidebar = app-level nav, game cards = game nav).
// `navId` matches config/themes.ts's NAV_COLOR_TARGETS so the Theme
// Customizer can recolor each item's active state independently.
interface NavItem { path: string; label: string; icon: any; navId: string; match: (p: string) => boolean; }
const NAV: NavItem[] = [
  { path: '/', label: 'Home', icon: Home, navId: 'home', match: (p) => p === '/' },
  { path: '/library', label: 'Library', icon: LayoutGrid, navId: 'library', match: (p) => p.startsWith('/library') },
  { path: '/downloads', label: 'Downloads', icon: Download, navId: 'downloads', match: (p) => p.startsWith('/downloads') },
  { path: '/settings', label: 'Settings', icon: Settings, navId: 'settings', match: (p) => p.startsWith('/settings') },
];

// Active-state background: the item's own custom color if the user set one
// (falls back to the shared accent), blended to a subtle 15%/30% tint via
// color-mix rather than needing per-color opacity variants precomputed.
function activeStyle(navId: string): React.CSSProperties {
  const color = `var(--nav-${navId}, var(--primary-500))`;
  return {
    background: `color-mix(in srgb, ${color} 15%, transparent)`,
    borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
  };
}
function activeIconStyle(navId: string): React.CSSProperties {
  return { color: `var(--nav-${navId}, var(--primary-300))` };
}

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const role = useAuth((s) => s.profile?.role);
  const isAdmin = role === 'admin' || role === 'owner';
  const localUnlocked = useLocalAccess((s) => s.unlocked);
  const showAdmin = isSupabaseConfigured() ? isAdmin : localUnlocked;

  const authStatus = useAppAuth((s) => s.status);
  const showAccount = !!authStatus?.enabled && !!authStatus?.authorized;
  const avatarDataUrl = useTheme((s) => s.avatarDataUrl);

  return (
    <aside className="w-60 shrink-0 h-full flex flex-col bg-surface-925/70 border-r border-overlay-6 backdrop-blur-xl">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-5 h-16 shrink-0">
        <MercyLogo size={32} glow />
        <div className="leading-none">
          <p className="text-sm font-extrabold text-surface-100 tracking-[0.14em]">MERCY</p>
          <p className="text-[9px] font-bold text-primary-400 tracking-[0.22em]">LAUNCHER</p>
        </div>
      </div>

      {/* Global nav */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-2 space-y-0.5">
        {NAV.map((item) => {
          const active = item.match(location.pathname);
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`relative w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-colors ${
                active ? 'text-white' : 'text-surface-400 hover:text-surface-100 hover:bg-overlay-4'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-active"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  className="absolute inset-0 rounded-xl border shadow-glow-sm"
                  style={activeStyle(item.navId)}
                />
              )}
              <item.icon size={16} className="relative text-surface-500" style={active ? activeIconStyle(item.navId) : undefined} />
              <span className="relative flex-1 text-left">{item.label}</span>
            </button>
          );
        })}

        {showAdmin && (() => {
          const active = location.pathname.startsWith('/admin');
          return (
            <button
              onClick={() => navigate('/admin')}
              className={`relative w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-colors ${
                active ? 'text-white' : 'text-surface-400 hover:text-surface-100'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-active"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  className="absolute inset-0 rounded-xl border shadow-glow-sm"
                  style={activeStyle('admin')}
                />
              )}
              <Shield size={16} className="relative text-surface-500" style={active ? activeIconStyle('admin') : undefined} />
              <span className="relative flex-1 text-left">Admin</span>
            </button>
          );
        })()}
      </nav>

      {/* Account — bottom-left, real Discord session, click opens Settings
          (where Sign Out already lives) rather than a new menu system. */}
      {showAccount && (
        <button onClick={() => navigate('/settings')}
          className="group shrink-0 m-3 flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-overlay-4 hover:bg-overlay-6 border border-overlay-6 hover:border-overlay-10 transition-all text-left">
          <div className="w-8 h-8 rounded-full bg-primary-500/20 border border-primary-500/25 flex items-center justify-center shrink-0 overflow-hidden">
            {avatarDataUrl ? <img src={avatarDataUrl} alt="" className="w-full h-full object-cover" /> : <UserCircle2 size={16} className="text-primary-300" />}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-xs font-bold text-surface-100 truncate">{authStatus?.username || 'Verified'}</p>
            <p className="text-[10px] text-emerald-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> {authStatus?.stale ? 'Offline' : 'Online'}</p>
          </div>
          <ChevronRight size={14} className="text-surface-500 shrink-0 transition-transform group-hover:translate-x-0.5" />
        </button>
      )}
    </aside>
  );
}
