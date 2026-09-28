import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import {
  LayoutGrid, Gamepad2, Search, Loader2, Play, ExternalLink,
  FolderPlus, Settings, MapPin, Trash2, AlertTriangle, RotateCcw,
} from 'lucide-react';
import { Panel, SectionHeading, EmptyState, Toggle } from '../components/ui';
import { getGame } from '../config/games';
import { useLibraryPrefs } from '../stores/useLibraryPrefs';
import toast from 'react-hot-toast';

// The Library is ONE unified list of games detected on this PC —
// deliberately NOT a category-navigation page. There is no per-game
// filter/tab (Steam/FiveM/Minecraft/etc.); every detected game gets exactly
// one real row in DetectedGamesSection below regardless of platform or
// Mercy support status, and Mercy support is shown as a plain badge on that
// same row rather than as a separate section a user has to switch into.
export default function Library() {
  const { showDetectedApps, setShowDetectedApps } = useLibraryPrefs();
  return (
    <div className="p-7 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <SectionHeading icon={LayoutGrid} title="Library" subtitle="Games on this PC." />
        <label className="flex items-center gap-2 text-xs text-surface-400 shrink-0 cursor-pointer select-none" title="Show or hide the 'Games on this PC' section below">
          Show detected apps
          <Toggle checked={showDetectedApps} onChange={setShowDetectedApps} />
        </label>
      </div>

      {showDetectedApps && <DetectedGamesSection />}
    </div>
  );
}

const MERCY_STATUS_META: Record<'supported' | 'planned' | 'unsupported', { label: string; className: string }> = {
  supported: { label: 'Available', className: 'text-success' },
  planned: { label: 'Coming Soon', className: 'text-warning' },
  unsupported: { label: 'Not available yet', className: 'text-surface-500' },
};

// ── Game Library: "Games on this PC" — ONE unified list, real read-only
// detection across every major PC game platform (see GameScanner.ts's own
// header comment). Detected and Mercy-supported are deliberately different
// concepts here: every game gets exactly one row, never split into
// per-game categories, and support status is shown as a plain badge, never
// implied by which row it's in. ─────────────────────────────────────────
function DetectedGamesSection() {
  const navigate = useNavigate();
  const [games, setGames] = useState<DetectedGame[]>([]);
  const [scanning, setScanning] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!window.electronAPI?.games) return;
    (async () => {
      const cached = await window.electronAPI.games.getCached().catch(() => []);
      setGames(cached);
      setHasScanned(cached.length > 0);
      // Auto-rescan on app start only when the cache is empty or genuinely
      // stale (see GameScanner.AUTO_RESCAN_INTERVAL_MS) — never on every render.
      const stale = await window.electronAPI.games.isStale().catch(() => true);
      if (stale) scan();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    setScanning(true);
    try {
      const found = await window.electronAPI.games.scan();
      setGames(found);
      setHasScanned(true);
    } catch { toast.error('Scan failed'); } finally { setScanning(false); }
  };

  const launch = async (id: string, name: string) => {
    setLaunchingId(id);
    try {
      const result = await window.electronAPI.games.launch(id);
      if (result.success && result.note) toast(result.note, { icon: 'ℹ️' });
      else if (!result.success) toast.error(result.error || `Could not launch ${name}`);
    } finally { setLaunchingId(null); }
  };

  // Manual game paths become part of this SAME unified list — never a
  // separate "Manual Games" category (see GameScanner.addManualGame(), which
  // already validates existence/is-a-file/normalization before this ever
  // resolves). The picker only ever lets the user pick a real executable
  // they explicitly select — never a path Mercy guesses or constructs.
  const addGame = async () => {
    const picked = await window.electronAPI.openFile([{ name: 'Executable', extensions: ['exe'] }]);
    if (!picked) return;
    const result = await window.electronAPI.games.addManual(picked);
    if (!result.success) { toast.error(result.error || 'Could not add that game.'); return; }
    if (result.game) setGames((prev) => [...prev, result.game!].sort((a, b) => a.name.localeCompare(b.name)));
    setHasScanned(true);
    toast.success(`Added ${result.game?.name ?? 'game'}`);
  };

  // A manually-ADDED game's own path is relocated in place (relocateManual);
  // any OTHER detected game (Steam/Epic/Microsoft Store/etc.) gets a path
  // OVERRIDE layered on top of its normal detection instead — this is what
  // lets a user correct a bad automatic detection (e.g. an unresolved
  // Microsoft Store app id) without duplicating it into a second, separate
  // "Manual Games" entry.
  const changePath = async (id: string) => {
    const game = games.find((g) => g.id === id);
    const picked = await window.electronAPI.openFile([{ name: 'Executable', extensions: ['exe'] }]);
    if (!picked) return;
    const result = game?.platform === 'manual'
      ? await window.electronAPI.games.relocateManual(id, picked)
      : await window.electronAPI.games.setPathOverride(id, picked);
    if (!result.success) { toast.error(result.error || 'Could not update that path.'); return; }
    if (result.game) setGames((prev) => prev.map((g) => (g.id === id ? result.game! : g)));
    toast.success('Path updated');
  };

  const resetPath = async (id: string) => {
    const result = await window.electronAPI.games.clearPathOverride(id);
    if (!result.success) return;
    if (result.game) setGames((prev) => prev.map((g) => (g.id === id ? result.game! : g)));
    toast.success('Restored automatic detection');
  };

  const removeManualGame = async (id: string, name: string) => {
    const ok = await window.electronAPI.games.removeManual(id);
    if (!ok) { toast.error(`Could not remove ${name}`); return; }
    setGames((prev) => prev.filter((g) => g.id !== id));
  };

  const visibleGames = query.trim() ? games.filter((g) => g.name.toLowerCase().includes(query.trim().toLowerCase())) : games;

  return (
    <Panel>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Gamepad2 size={16} className="text-primary-300" />
          <p className="text-sm font-bold text-surface-100 uppercase tracking-wide">Games on this PC</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={addGame} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5" title="Manually add a game by selecting its executable">
            <FolderPlus size={13} /> Add Game
          </button>
          <button onClick={scan} disabled={scanning} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-60">
            {scanning ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} {scanning ? 'Scanning…' : hasScanned ? 'Scan Again' : 'Scan for Games'}
          </button>
        </div>
      </div>

      {hasScanned && games.length > 0 && (
        <div className="relative mb-3">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search games…" className="input-field pl-8 text-xs py-2" />
        </div>
      )}

      {!hasScanned && !scanning ? (
        <EmptyState icon={Gamepad2} title="No scan yet" description="Scan to detect games actually installed on this computer — across Steam, Epic, GOG, Ubisoft, Rockstar, EA, and Xbox/Microsoft Store where reasonably detectable. This never assumes Mercy can manage a server for what it finds." />
      ) : scanning ? (
        <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-primary-400" /></div>
      ) : games.length === 0 ? (
        <p className="text-xs text-surface-500 py-4">No known games were found on this computer.</p>
      ) : visibleGames.length === 0 ? (
        <p className="text-xs text-surface-500 py-4">No games match "{query}".</p>
      ) : (
        <div className="space-y-1.5">
          {visibleGames.map((g) => {
            const mercyGame = g.mercyGameId ? getGame(g.mercyGameId) : undefined;
            const statusMeta = MERCY_STATUS_META[g.mercyStatus];
            return (
              <div key={g.id} className="flex items-center gap-2.5 rounded-lg border border-overlay-4 bg-overlay-2 px-3 py-2">
                <div className="w-8 h-8 rounded-lg bg-overlay-6 flex items-center justify-center shrink-0">
                  {mercyGame ? <mercyGame.icon size={14} className={mercyGame.tint} /> : <Gamepad2 size={14} className="text-surface-500" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-surface-100 truncate">{g.name}</p>
                  <p className="text-[10.5px] text-surface-500 truncate">
                    {g.platformLabel}{g.category === 'launcher' ? ' · Launcher' : ''}
                  </p>
                </div>
                {g.pathMissing ? (
                  <span className="text-[10px] font-semibold shrink-0 whitespace-nowrap text-danger flex items-center gap-1"><AlertTriangle size={11} /> Path unavailable</span>
                ) : (
                  <span className={`text-[10px] font-semibold shrink-0 whitespace-nowrap ${statusMeta.className}`}>{statusMeta.label}</span>
                )}
                <div className="flex items-center gap-1.5 shrink-0">
                  {mercyGame && (
                    <button onClick={() => navigate(mercyGame.path)} className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1.5" title={mercyGame.id === 'assettocorsa' ? 'Open Mercy Server Tools — Assetto Corsa servers are built and launched through Content Manager' : 'Open Mercy Server Tools'}><ExternalLink size={12} /> Server Tools</button>
                  )}
                  {g.pathMissing ? (
                    <button onClick={() => changePath(g.id)} className="btn-primary text-xs py-1.5 px-2.5 flex items-center gap-1.5"><MapPin size={12} /> Locate</button>
                  ) : (
                    <button onClick={() => launch(g.id, g.name)} disabled={launchingId === g.id} className="btn-primary text-xs py-1.5 px-2.5 flex items-center gap-1.5">
                      {launchingId === g.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Launch
                    </button>
                  )}
                  <GameSettingsMenu game={g} onChangePath={() => changePath(g.id)} onResetPath={() => resetPath(g.id)} onRemove={() => removeManualGame(g.id, g.name)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// Small per-row gear — never more than a normal user needs: the real
// detected path/launch mechanism, and a way to correct it when automatic
// detection is wrong (e.g. a Microsoft Store/Xbox-app game whose activation
// id couldn't be resolved) — never limited to manually-added games only.
function GameSettingsMenu({ game, onChangePath, onResetPath, onRemove }: {
  game: DetectedGame; onChangePath: () => void; onResetPath: () => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isManual = game.platform === 'manual';
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="w-7 h-7 flex items-center justify-center rounded-lg text-surface-500 hover:text-surface-200 hover:bg-overlay-6 transition-colors shrink-0" title="Game settings">
          <Settings size={13} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={12} className="z-50 w-72 rounded-xl border border-overlay-10 bg-surface-900/95 backdrop-blur-xl shadow-2xl p-3.5 space-y-2.5 mercy-pop">
          <p className="text-sm font-bold text-surface-100 truncate">{game.name}</p>
          <div className="space-y-1.5 text-[11px]">
            <div>
              <p className="text-surface-500">Launches via</p>
              <p className="text-surface-200 font-medium">{game.platformLabel}{game.pathOverridden ? ' (path overridden)' : ''}</p>
            </div>
            <div>
              <p className="text-surface-500">Executable</p>
              <p className="text-surface-200 font-mono break-all">{game.executablePath || '(resolved automatically at launch)'}{game.pathMissing ? ' (not found)' : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={() => { setOpen(false); onChangePath(); }} className="btn-secondary text-xs py-1.5 px-2.5 flex-1 flex items-center justify-center gap-1.5">
              <MapPin size={12} /> {isManual ? 'Locate…' : 'Change Path…'}
            </button>
            {isManual ? (
              <button onClick={() => { setOpen(false); onRemove(); }} className="btn-secondary text-xs py-1.5 px-2.5 flex items-center justify-center gap-1.5 text-danger hover:bg-danger/10" title="Remove this manually added game">
                <Trash2 size={12} />
              </button>
            ) : game.pathOverridden && (
              <button onClick={() => { setOpen(false); onResetPath(); }} className="btn-secondary text-xs py-1.5 px-2.5 flex items-center justify-center gap-1.5" title="Restore automatic detection">
                <RotateCcw size={12} />
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
