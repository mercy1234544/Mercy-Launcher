import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Car, Blocks, FlagTriangleRight, Truck, LayoutGrid, Package, ArrowRight } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { Panel, SectionHeading } from '../components/ui';

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
  const comingSoonGames = [
    { id: 'minecraft', label: 'Minecraft', icon: Blocks, tint: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/25' },
    { id: 'assetto', label: 'Assetto Corsa', icon: FlagTriangleRight, tint: 'text-rose-300 bg-rose-500/15 border-rose-500/25' },
    { id: 'beamng', label: 'BeamNG.drive', icon: Truck, tint: 'text-sky-300 bg-sky-500/15 border-sky-500/25' },
  ].filter((g) => filter === 'all' || filter === (g.id as Filter));

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
            <g.icon size={16} className={g.tint.split(' ')[0]} /><p className="text-sm font-bold text-surface-100">{g.label}</p>
            <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-overlay-6 text-surface-500 border border-overlay-10">Soon</span>
          </div>
          <p className="text-xs text-surface-500">No content yet — this hub isn't built yet.</p>
        </Panel>
      ))}
    </div>
  );
}
