import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Compass, Server, PlusCircle, MessageCircle, LifeBuoy, ArrowRight, ChevronRight, Rss } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { useAppAuth } from '../stores/useAppAuth';
import { FiveMArt, MinecraftArt, AssettoCorsaArt, BeamNGArt } from '../components/GameArt';
import GameCard from '../components/GameCard';
import { Panel } from '../components/ui';
import toast from 'react-hot-toast';

const containerVariants = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const itemVariants = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.4, 0, 0.2, 1] } } };

// Every card offers two distinct actions (see GameCard.tsx): "Manage /
// Create Servers" opens the game's own hub for a server the USER runs
// (real today for FiveM; an honest Coming Soon page for the others), and
// "Mercy's Servers" opens a Coming Soon page for official servers MERCY
// will eventually operate — a completely separate concept, never faked.
// `id` matches the folder name under src/renderer/assets/games/ for the
// drop-in asset system, and the game segment in /mercy-servers/:game.
const GAMES = [
  { id: 'fivem', label: 'FiveM', path: '/fivem', Art: FiveMArt, tagline: 'Manage your FiveM servers.' },
  { id: 'minecraft', label: 'Minecraft', path: '/minecraft', Art: MinecraftArt, tagline: 'Manage your Minecraft servers.' },
  { id: 'assettocorsa', label: 'Assetto Corsa', path: '/assetto-corsa', Art: AssettoCorsaArt, tagline: 'Manage your Assetto Corsa servers.' },
  { id: 'beamng', label: 'BeamNG.drive', path: '/beamng', Art: BeamNGArt, tagline: 'Manage your BeamNG.drive servers.' },
];

export default function Home() {
  const navigate = useNavigate();
  const { setServers } = useAppStore();
  const username = useAppAuth((s) => s.status?.username);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.server.getAll().then(setServers).catch(() => {});
  }, []);

  // Real data — the app's own GitHub releases, same source that powers the updater.
  const [news, setNews] = useState<{ tag: string; name: string; date: string; body: string; url: string }[]>([]);
  const RELEASES_URL = 'https://github.com/mercy1234544/fivem-server-builder/releases';
  useEffect(() => {
    fetch('https://api.github.com/repos/mercy1234544/fivem-server-builder/releases?per_page=5')
      .then((r) => (r.ok ? r.json() : []))
      .then((rels: any[]) => {
        if (!Array.isArray(rels)) return;
        setNews(rels.map((r) => ({
          tag: r.tag_name || '', name: r.name || r.tag_name || 'Update',
          date: r.published_at ? new Date(r.published_at).toLocaleDateString() : '',
          body: (r.body || '').replace(/[#*`>-]/g, '').replace(/\r?\n+/g, ' ').slice(0, 90),
          url: r.html_url || '',
        })));
      }).catch(() => {});
  }, []);

  const notConfigured = (what: string) => toast(`${what} isn't configured yet.`, { icon: '🔗' });
  const DISCORD_INVITE_URL = 'https://discord.gg/FkwnmdZx6m';

  const quickActions = [
    { icon: Compass, label: 'Browse Servers', sub: 'Find and join FiveM servers.', onClick: () => navigate('/fivem') },
    { icon: Server, label: 'My Servers', sub: 'Manage your configured servers.', onClick: () => navigate('/servers') },
    { icon: PlusCircle, label: 'Create Server', sub: 'Set up a new FiveM server.', onClick: () => navigate('/create') },
    { icon: MessageCircle, label: 'Join Discord', sub: 'Join the Mercy community.', onClick: () => window.electronAPI?.openExternal(DISCORD_INVITE_URL) },
    { icon: LifeBuoy, label: 'Support', sub: 'Get help and view documentation.', onClick: () => notConfigured('Support') },
  ];

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show" className="p-7 space-y-6 max-w-6xl mx-auto">
      <motion.div variants={itemVariants}>
        <h1 className="text-2xl font-extrabold text-surface-100 leading-tight">
          Welcome back{username ? <>, <span className="text-primary-400">{username}</span></> : null} <span className="inline-block">👋</span>
        </h1>
        <p className="text-sm text-surface-500 mt-1">Launch your favorite games and jump in.</p>
      </motion.div>

      {/* Game hero cards */}
      <motion.div variants={itemVariants} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {GAMES.map((g) => <GameCard key={g.id} {...g} />)}
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Latest News */}
        <motion.div variants={itemVariants}>
        <Panel className="flex flex-col h-full">
          <p className="text-sm font-bold text-surface-100 mb-3 flex items-center gap-2"><Rss size={15} className="text-primary-300" /> Latest News</p>
          {news.length === 0 ? (
            <p className="text-xs text-surface-500 py-6 text-center flex-1">No release notes available right now.</p>
          ) : (
            <div className="space-y-1 flex-1">
              {news.map((n) => (
                <button key={n.tag} onClick={() => window.electronAPI?.openExternal(n.url)}
                  className="w-full flex items-start gap-3 px-2.5 py-2 rounded-xl hover:bg-overlay-4 transition-all text-left">
                  <div className="w-7 h-7 rounded-lg bg-primary-500/15 border border-primary-500/20 flex items-center justify-center shrink-0 mt-0.5">
                    <Rss size={12} className="text-primary-300" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-surface-100 truncate">{n.name}</p>
                      <span className="text-[10px] text-surface-600 shrink-0">{n.date}</span>
                    </div>
                    <p className="text-[11px] text-surface-500 line-clamp-1">{n.body}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
          <button onClick={() => window.electronAPI?.openExternal(RELEASES_URL)}
            className="mt-3 w-full text-center text-xs font-semibold text-surface-400 hover:text-primary-300 py-2 rounded-lg hover:bg-overlay-4 transition-all flex items-center justify-center gap-1.5">
            View All News <ArrowRight size={12} />
          </button>
        </Panel>
        </motion.div>

        {/* Quick Actions */}
        <motion.div variants={itemVariants}>
        <Panel>
          <p className="text-sm font-bold text-surface-100 mb-3 flex items-center gap-2"><Compass size={15} className="text-primary-300" /> Quick Actions</p>
          <div className="space-y-1">
            {quickActions.map((a) => (
              <button key={a.label} onClick={a.onClick} className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl hover:bg-overlay-4 transition-all text-left group">
                <div className="w-9 h-9 rounded-lg bg-overlay-6 border border-overlay-10 flex items-center justify-center shrink-0">
                  <a.icon size={15} className="text-primary-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-surface-100">{a.label}</p>
                  <p className="text-[11px] text-surface-500 truncate">{a.sub}</p>
                </div>
                <ChevronRight size={14} className="text-surface-600 group-hover:text-primary-300 group-hover:translate-x-0.5 transition-all shrink-0" />
              </button>
            ))}
          </div>
        </Panel>
        </motion.div>
      </div>
    </motion.div>
  );
}
