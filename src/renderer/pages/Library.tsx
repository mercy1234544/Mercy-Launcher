import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Car, LayoutGrid, Package, ArrowRight, Gamepad2, Search, Loader2, Play, ExternalLink } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { Panel, SectionHeading, EmptyState } from '../components/ui';
import { GAMES, getGame } from '../config/games';
import toast from 'react-hot-toast';

// Unified Library shell across every game hub. FiveM shows REAL numbers pulled
// from the servers already loaded by ServerManager; the other games show an
// honest "Coming soon" state rather than invented content, per the Mercy
// Launcher rule against faking installed-content data.
type Filter = 'all' | 'fivem' | 'minecraft' | 'assetto' | 'beamng';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'fivem', label: 'FiveM' }, { id: 'minecraft', label: 'Minecraft' },
  { id: 'assetto', label: 'Assetto Corsa' }, { id: 'beamng', label: 'BeamNG.drive' },
];

export default function Library() {
  const navigate = useNavigate();
  const { servers, setServers } = useAppStore();
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.server.getAll().then(setServers).catch(() => {});
  }, []);

  const totalResources = servers.reduce((sum, s) => sum + s.resourceCount, 0);
  const showFivem = filter === 'all' || filter === 'fivem';
  // 'assettocorsa' in the shared game registry vs this page's own short
  // 'assetto' filter id — only place the two need reconciling.
  const filterIdFor = (gameId: string): Filter => (gameId === 'assettocorsa' ? 'assetto' : (gameId as Filter));
  const comingSoonGames = GAMES.filter((g) => !g.hasRealHub && (filter === 'all' || filter === filterIdFor(g.id)));

  return (
    <div className="p-7 max-w-6xl mx-auto space-y-6">
      <SectionHeading icon={LayoutGrid} title="Library" subtitle="All your installed content, across every game." />

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all duration-150 ${filter === f.id ? 'bg-primary-500/15 text-primary-200 border-primary-500/30' : 'bg-overlay-3 text-surface-300 border-overlay-6 hover:bg-overlay-6'}`}>
            {f.label}
          </button>
        ))}
      </div>

      <DetectedGamesSection />

      {showFivem && (
        <Panel>
          <div className="flex items-center gap-2 mb-3">
            <Car size={16} className="text-orange-300" /><p className="text-sm font-bold text-surface-100">FiveM</p>
          </div>
          {servers.length === 0 ? (
            <p className="text-xs text-surface-500 py-4">No servers yet — create or import one to see its resources here.</p>
          ) : (
            <div className="flex items-center justify-between rounded-xl border border-overlay-4 bg-overlay-2 px-4 py-3">
              <div className="flex items-center gap-3">
                <Package size={16} className="text-amber-300" />
                <div><p className="text-sm font-semibold text-surface-100">{totalResources.toLocaleString()} resources</p><p className="text-[11px] text-surface-500">across {servers.length} server{servers.length !== 1 ? 's' : ''}</p></div>
              </div>
              <button onClick={() => navigate('/servers')} className="btn-secondary text-xs py-1.5 flex items-center gap-1.5">Open My Servers <ArrowRight size={12} /></button>
            </div>
          )}
        </Panel>
      )}

      {comingSoonGames.map((g) => (
        <Panel key={g.id}>
          <div className="flex items-center gap-2 mb-2">
            <g.icon size={16} className={g.tint} /><p className="text-sm font-bold text-surface-100">{g.label}</p>
            <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-overlay-6 text-surface-500 border border-overlay-10">Soon</span>
          </div>
          <p className="text-xs text-surface-500">No content yet — this hub isn't built yet.</p>
        </Panel>
      ))}
    </div>
  );
}

// ── Game Library: real, read-only detection of games installed on this PC —
// a DIFFERENT concept from Mercy server-management support (see
// GameScanner.ts's own header comment). A detected game never implies
// Mercy can manage a server for it; that's shown as its own honest badge. ──
function DetectedGamesSection() {
  const navigate = useNavigate();
  const [games, setGames] = useState<DetectedGame[]>([]);
  const [scanning, setScanning] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [launchingId, setLaunchingId] = useState<string | null>(null);

  useEffect(() => {
    if (!window.electronAPI?.games) return;
    window.electronAPI.games.getCached().then((cached) => { setGames(cached); setHasScanned(cached.length > 0); }).catch(() => {});
  }, []);

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
      if (!result.success) toast.error(result.error || `Could not launch ${name}`);
    } finally { setLaunchingId(null); }
  };

  return (
    <Panel>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Gamepad2 size={16} className="text-primary-300" />
          <p className="text-sm font-bold text-surface-100">Game Library</p>
          <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-overlay-6 text-surface-500 border border-overlay-10">Detected on this PC</span>
        </div>
        <button onClick={scan} disabled={scanning} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-60">
          {scanning ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} {scanning ? 'Scanning…' : hasScanned ? 'Scan Again' : 'Scan for Games'}
        </button>
      </div>

      {!hasScanned && !scanning ? (
        <EmptyState icon={Gamepad2} title="No scan yet" description="Scan to detect games actually installed on this computer — this never assumes Mercy can manage a server for what it finds." />
      ) : scanning ? (
        <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-primary-400" /></div>
      ) : games.length === 0 ? (
        <p className="text-xs text-surface-500 py-4">No known games were found on this computer.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {games.map((g) => {
            const mercyGame = g.mercyGameId ? getGame(g.mercyGameId) : undefined;
            return (
              <div key={g.id} className="flex items-center gap-3 rounded-xl border border-overlay-4 bg-overlay-2 px-4 py-3">
                <div className="w-9 h-9 rounded-lg bg-overlay-6 flex items-center justify-center shrink-0">
                  {mercyGame ? <mercyGame.icon size={16} className={mercyGame.tint} /> : <Gamepad2 size={16} className="text-surface-500" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-surface-100 truncate">{g.name}</p>
                  <p className="text-[10px] mt-0.5">
                    {mercyGame ? <span className="text-success">Mercy server tools available</span> : <span className="text-surface-500">Detected — no Mercy server tools yet</span>}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {mercyGame && (
                    <button onClick={() => navigate(mercyGame.path)} className="p-1.5 rounded-lg text-surface-500 hover:text-primary-300 hover:bg-overlay-6 transition-colors" title={`Manage in Mercy`}><ExternalLink size={13} /></button>
                  )}
                  <button onClick={() => launch(g.id, g.name)} disabled={launchingId === g.id} className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1.5">
                    {launchingId === g.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Launch
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
