import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Minus, Square, X, Settings } from 'lucide-react';
import NotificationBell from './NotificationBell';
import { Tooltip } from './ui';

// Slim top bar over the content column (Sidebar owns navigation + window-width
// to its left, including the account card). This bar is just the current
// section's title plus the frameless window's drag region, Settings shortcut,
// and controls — no account UI here, matching the reference (account lives
// bottom-left in the sidebar).
const SECTION_TITLES: { test: (p: string) => boolean; title: string; subtitle: string }[] = [
  { test: (p) => p === '/', title: 'Home', subtitle: 'Your games, in one place' },
  { test: (p) => p === '/fivem', title: 'FiveM', subtitle: 'FiveM Management' },
  { test: (p) => p === '/browse-servers', title: 'FiveM', subtitle: 'Browse Servers' },
  { test: (p) => p.startsWith('/mercy-servers'), title: "Mercy's Servers", subtitle: 'Official Mercy servers' },
  { test: (p) => p.startsWith('/servers') || p.startsWith('/server/'), title: 'FiveM', subtitle: 'My Servers' },
  { test: (p) => p === '/create', title: 'FiveM', subtitle: 'Create Server' },
  { test: (p) => p === '/resources', title: 'FiveM', subtitle: 'Resources' },
  { test: (p) => p === '/organizer', title: 'FiveM', subtitle: 'Resource Organizer' },
  { test: (p) => p === '/startup', title: 'FiveM', subtitle: 'Startup Manager' },
  { test: (p) => p === '/health', title: 'FiveM', subtitle: 'Health Scanner' },
  { test: (p) => p === '/backups', title: 'FiveM', subtitle: 'Backups' },
  { test: (p) => p === '/files', title: 'FiveM', subtitle: 'File Explorer' },
  { test: (p) => p === '/editor', title: 'FiveM', subtitle: 'server.cfg Editor' },
  { test: (p) => p === '/marketplace', title: 'FiveM', subtitle: 'Store' },
  { test: (p) => p === '/import', title: 'FiveM', subtitle: 'Import Resources' },
  { test: (p) => p === '/updater', title: 'FiveM', subtitle: 'Resource Updater' },
  { test: (p) => p === '/vehicles', title: 'FiveM', subtitle: 'Vehicle Packs' },
  { test: (p) => p === '/console', title: 'FiveM', subtitle: 'Console' },
  { test: (p) => p === '/livery', title: 'FiveM', subtitle: 'Livery Editor' },
  { test: (p) => p.startsWith('/vehicle-studio'), title: 'FiveM', subtitle: 'Vehicle Studio' },
  { test: (p) => p === '/minecraft', title: 'Minecraft', subtitle: 'Server Management' },
  { test: (p) => p === '/minecraft/create', title: 'Minecraft', subtitle: 'Create Server' },
  { test: (p) => p.startsWith('/minecraft/server/'), title: 'Minecraft', subtitle: 'Manage Server' },
  { test: (p) => p === '/minecraft/marketplace', title: 'Minecraft', subtitle: 'Marketplace' },
  { test: (p) => p.startsWith('/assetto-corsa'), title: 'Assetto Corsa', subtitle: 'Coming soon' },
  { test: (p) => p.startsWith('/beamng'), title: 'BeamNG.drive', subtitle: 'Coming soon' },
  { test: (p) => p.startsWith('/library'), title: 'Library', subtitle: 'All your installed content' },
  { test: (p) => p.startsWith('/downloads'), title: 'Downloads', subtitle: 'Download manager' },
  { test: (p) => p.startsWith('/settings'), title: 'Settings', subtitle: 'App preferences' },
  { test: (p) => p.startsWith('/admin'), title: 'Admin', subtitle: 'Administration' },
];
function pageInfo(pathname: string) {
  return SECTION_TITLES.find((s) => s.test(pathname)) || { title: 'Mercy Launcher', subtitle: '' };
}

export default function TitleBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { title, subtitle } = pageInfo(location.pathname);

  const handleMinimize = () => window.electronAPI?.minimize();
  const handleMaximize = () => window.electronAPI?.maximize();
  const handleClose = () => window.electronAPI?.close();

  return (
    <div
      className="h-14 shrink-0 flex items-center border-b border-overlay-6 select-none relative z-40"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      <div className="flex-1 min-w-0 pl-6">
        <p className="text-sm font-bold text-surface-100 leading-tight truncate">{title}</p>
        {subtitle && <p className="text-[11px] text-surface-500 leading-tight truncate">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-1 shrink-0 mr-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <NotificationBell />
        <Tooltip content="Settings">
          <button onClick={() => navigate('/settings')} aria-label="Settings"
            className="w-9 h-9 flex items-center justify-center text-surface-500 hover:text-surface-200 hover:bg-overlay-6 rounded-lg transition-colors">
            <Settings size={15} />
          </button>
        </Tooltip>
      </div>

      <div className="w-px h-6 bg-overlay-8 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as any} />

      <div className="flex shrink-0" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <Tooltip content="Minimize">
          <button onClick={handleMinimize} aria-label="Minimize" className="w-12 h-14 flex items-center justify-center text-surface-500 hover:text-surface-200 hover:bg-overlay-6 transition-colors duration-150">
            <Minus size={14} />
          </button>
        </Tooltip>
        <Tooltip content="Maximize">
          <button onClick={handleMaximize} aria-label="Maximize" className="w-12 h-14 flex items-center justify-center text-surface-500 hover:text-surface-200 hover:bg-overlay-6 transition-colors duration-150">
            <Square size={11} />
          </button>
        </Tooltip>
        <Tooltip content="Close">
          <button onClick={handleClose} aria-label="Close" className="w-12 h-14 flex items-center justify-center text-surface-500 hover:text-surface-100 hover:bg-red-600/90 transition-colors duration-150">
            <X size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
