import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Globe2, ArrowLeft, Users, Gauge, Package, LogIn } from 'lucide-react';
import type { MercyServer } from '../types/mercyServer';
import { Panel } from '../components/ui';
import { GAMES, getGame } from '../config/games';

// Mercy's Servers — official/public servers Mercy will eventually operate,
// separate from a user's own servers (managed via each game's hub). This is
// intentionally a real, empty list today: `SERVERS` stays [] until Mercy
// actually has a server online, so the honest Coming Soon state below is
// what renders — never invented listings, player counts, or Join buttons.
//
// When a real server exists, add it to SERVERS (or wire this up to fetch
// from wherever Mercy ends up publishing server status) and the render
// branch further down — already built against the MercyServer shape — takes
// over automatically; nothing about the page structure needs to change.
const SERVERS: MercyServer[] = [];

const PLANNED = [
  'Server name & description', 'Live status & player count', 'Connect / address info',
  'Required content, checked automatically', 'Join Server', 'Download & Join, when content is missing',
];

export default function MercyServers() {
  const { game } = useParams<{ game: string }>();
  const navigate = useNavigate();
  const meta = getGame(game) || GAMES[0];
  const servers = SERVERS.filter((s) => s.game === game);

  return (
    <div className="h-full overflow-y-auto p-7">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-2 mb-6">
          <div className={`w-8 h-8 rounded-lg border flex items-center justify-center ${meta.tintBadge}`}><meta.icon size={15} /></div>
          <p className="text-xs font-semibold text-surface-400">{meta.label}</p>
        </div>

        {servers.length === 0 ? (
          <div className="text-center">
            <div className="relative w-16 h-16 mx-auto mb-5">
              <div className="absolute inset-0 rounded-2xl bg-primary-500/20 blur-xl" />
              <div className="relative w-16 h-16 rounded-2xl bg-primary-500/15 border border-primary-500/25 flex items-center justify-center">
                <Globe2 size={28} className="text-primary-300" />
              </div>
            </div>
            <span className="inline-block text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-overlay-6 text-surface-400 border border-overlay-10 mb-3">Coming Soon</span>
            <h1 className="text-2xl font-extrabold text-surface-100 tracking-tight">Mercy's Servers</h1>
            <p className="text-sm text-surface-400 mt-2">Official servers from Mercy.</p>
            <p className="text-sm text-surface-500 mt-3 leading-relaxed">
              Our official playable {meta.label} servers are currently being prepared. Once they're online, you'll be able to see them here — status, players, and everything you need to join — right from Mercy Launcher.
            </p>

            <Panel className="mt-6 text-left">
              <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-2.5 font-semibold">Planned for this page</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                {PLANNED.map((p) => (
                  <div key={p} className="flex items-center gap-2 text-xs text-surface-300">
                    <span className="w-1 h-1 rounded-full bg-surface-600 shrink-0" /> {p}
                  </div>
                ))}
              </div>
            </Panel>

            <button onClick={() => navigate('/')} className="btn-secondary text-xs py-2 mt-6 mx-auto flex items-center gap-1.5">
              <ArrowLeft size={13} /> Back to Home
            </button>
          </div>
        ) : (
          // Real servers exist — render them. Untested by definition (SERVERS
          // is empty today) but built against the same MercyServer shape so
          // this activates the moment real data is added, with no rework.
          <div className="space-y-4">
            <h1 className="text-xl font-extrabold text-surface-100">Mercy's {meta.label} Servers</h1>
            {servers.map((s) => (
              <Panel key={s.id}>
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold text-surface-100">{s.name}</p>
                  <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${s.status === 'online' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-overlay-6 text-surface-400'}`}>{s.status}</span>
                </div>
                <p className="text-xs text-surface-500 mt-1">{s.description}</p>
                <div className="flex items-center gap-4 mt-3 text-xs text-surface-400">
                  <span className="flex items-center gap-1"><Users size={12} /> {s.players}/{s.maxPlayers}</span>
                  {s.version && <span className="flex items-center gap-1"><Gauge size={12} /> {s.version}</span>}
                  {s.requiredContent.length > 0 && <span className="flex items-center gap-1"><Package size={12} /> {s.requiredContent.length} content items</span>}
                </div>
                <button className="btn-primary text-xs py-1.5 mt-3 flex items-center gap-1.5"><LogIn size={13} /> Join Server</button>
              </Panel>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
