import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Server as ServerIcon, ArrowRight, ArrowLeft, Car, Blocks } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { useMinecraftStore } from '../stores/useMinecraftStore';
import { Panel, SectionHeading, EmptyState } from '../components/ui';

// Unified server list across every game with a real hub — FiveM's useAppStore
// and Minecraft's useMinecraftStore stay separate stores (see their own
// header comments), this page just reads both and merges the rows for
// display. Clicking a row hands off to that game's own real server panel.
const STATUS_DOT: Record<string, string> = {
  running: 'bg-emerald-400', starting: 'bg-amber-400', stopping: 'bg-amber-400', stopped: 'bg-surface-600', error: 'bg-red-400',
};

interface Row { id: string; name: string; game: 'fivem' | 'minecraft'; status: string; sub: string; path: string; }

export default function AllServers() {
  const navigate = useNavigate();
  const fivemServers = useAppStore((s) => s.servers);
  const setFivemServers = useAppStore((s) => s.setServers);
  const mcServers = useMinecraftStore((s) => s.servers);
  const setMcServers = useMinecraftStore((s) => s.setServers);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.server.getAll().then(setFivemServers).catch(() => {});
    window.electronAPI.minecraft?.getAll().then(setMcServers).catch(() => {});
  }, []);

  const rows: Row[] = [
    ...fivemServers.map((s) => ({ id: s.id, name: s.name, game: 'fivem' as const, status: s.status, sub: `FiveM · ${s.framework}`, path: `/server/${s.id}` })),
    ...mcServers.map((s) => ({ id: s.id, name: s.name, game: 'minecraft' as const, status: s.status, sub: `Minecraft · ${s.serverType === 'paper' ? 'Paper' : 'Vanilla'}`, path: `/minecraft/server/${s.id}` })),
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>
        <SectionHeading icon={ServerIcon} title="My Servers" subtitle={`${rows.length} server${rows.length !== 1 ? 's' : ''} across all games`} />
      </div>

      {rows.length === 0 ? (
        <Panel padding="lg">
          <EmptyState
            icon={ServerIcon}
            title="No servers yet"
            description="Create a FiveM or Minecraft server to see it here."
            action={
              <div className="flex items-center gap-2">
                <button onClick={() => navigate('/create')} className="btn-secondary text-xs py-2 flex items-center gap-1.5"><Car size={13} /> New FiveM Server</button>
                <button onClick={() => navigate('/minecraft/create')} className="btn-primary text-xs py-2 flex items-center gap-1.5"><Blocks size={13} /> New Minecraft Server</button>
              </div>
            }
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <Panel as="button" interactive key={`${r.game}-${r.id}`} onClick={() => navigate(r.path)} className="group w-full flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-overlay-6 border border-overlay-10 flex items-center justify-center shrink-0">
                {r.game === 'fivem' ? <Car size={17} className="text-orange-300" /> : <Blocks size={17} className="text-emerald-300" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-surface-100">{r.name}</p>
                  <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[r.status] || 'bg-surface-600'}`} />
                </div>
                <p className="text-xs text-surface-500 mt-0.5">{r.sub}</p>
              </div>
              <ArrowRight size={14} className="text-surface-600 shrink-0 transition-transform group-hover:translate-x-0.5" />
            </Panel>
          ))}
        </div>
      )}
    </motion.div>
  );
}
