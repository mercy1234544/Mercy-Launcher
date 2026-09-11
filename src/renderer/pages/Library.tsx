import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutGrid, Gamepad2, Search, Loader2, Play, ExternalLink, Users, Lock } from 'lucide-react';
import { Panel, SectionHeading, EmptyState } from '../components/ui';
import { getGame } from '../config/games';
import toast from 'react-hot-toast';

// The Library is ONE unified list of games detected on this PC, plus a
// Friends/Now Playing section — deliberately NOT a category-navigation
// page. There is no per-game filter/tab (Steam/FiveM/Minecraft/etc.);
// every detected game gets exactly one real row in DetectedGamesSection
// below regardless of platform or Mercy support status, and Mercy support
// is shown as a plain badge on that same row rather than as a separate
// section a user has to switch into.
export default function Library() {
  return (
    <div className="p-7 max-w-6xl mx-auto space-y-6">
      <SectionHeading icon={LayoutGrid} title="Library" subtitle="Games on this PC, and who's playing." />

      <DetectedGamesSection />

      <FriendsPresenceSection />
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

  const visibleGames = query.trim() ? games.filter((g) => g.name.toLowerCase().includes(query.trim().toLowerCase())) : games;

  return (
    <Panel>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Gamepad2 size={16} className="text-primary-300" />
          <p className="text-sm font-bold text-surface-100 uppercase tracking-wide">Games on this PC</p>
        </div>
        <button onClick={scan} disabled={scanning} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-60">
          {scanning ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} {scanning ? 'Scanning…' : hasScanned ? 'Scan Again' : 'Scan for Games'}
        </button>
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
        <div className="space-y-2">
          {visibleGames.map((g) => {
            const mercyGame = g.mercyGameId ? getGame(g.mercyGameId) : undefined;
            const statusMeta = MERCY_STATUS_META[g.mercyStatus];
            return (
              <div key={g.id} className="flex items-center gap-3 rounded-xl border border-overlay-4 bg-overlay-2 px-4 py-3">
                <div className="w-9 h-9 rounded-lg bg-overlay-6 flex items-center justify-center shrink-0">
                  {mercyGame ? <mercyGame.icon size={16} className={mercyGame.tint} /> : <Gamepad2 size={16} className="text-surface-500" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-surface-100 truncate">{g.name}</p>
                  <p className="text-[11px] text-surface-500 truncate">{g.platformLabel} · {g.installPath}</p>
                  <p className={`text-[10px] mt-0.5 font-semibold ${statusMeta.className}`}>Mercy Server Tools — {statusMeta.label}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {mercyGame && (
                    <button onClick={() => navigate(mercyGame.path)} className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1.5" title="Open Mercy Server Tools"><ExternalLink size={12} /> Server Tools</button>
                  )}
                  <button onClick={() => launch(g.id, g.name)} disabled={launchingId === g.id} className="btn-primary text-xs py-1.5 px-2.5 flex items-center gap-1.5">
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

const VISIBILITY_OPTIONS: { id: PresenceVisibility; label: string }[] = [
  { id: 'private', label: 'Private' }, { id: 'friends-only', label: 'Friends Only' }, { id: 'everyone', label: 'Everyone' },
];

// ── Friends & Presence — a REAL foundation, not a fake social feature.
// Mercy has no deployed presence/signaling service today, so this is
// deliberately a real, empty list (matching the existing MercyServers.tsx
// precedent for "Mercy will eventually operate this, honestly nothing to
// show yet") rather than any hardcoded/fabricated friends or sessions.
// The privacy control and "what am I doing right now" ARE real and local. ─
function FriendsPresenceSection() {
  const [visibility, setVisibility] = useState<PresenceVisibility>('private');
  const [localPresence, setLocalPresence] = useState<LocalPresence | null>(null);
  const [friends, setFriends] = useState<FriendPresence[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!window.electronAPI?.presence) { setLoading(false); return; }
    Promise.all([
      window.electronAPI.presence.getVisibility(),
      window.electronAPI.presence.getLocal(),
      window.electronAPI.presence.getFriends(),
    ]).then(([v, local, f]) => { setVisibility(v); setLocalPresence(local); setFriends(f); }).finally(() => setLoading(false));
  }, []);

  const changeVisibility = async (v: PresenceVisibility) => {
    setVisibility(v);
    await window.electronAPI.presence.setVisibility(v);
  };

  return (
    <Panel>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-primary-300" />
          <p className="text-sm font-bold text-surface-100 uppercase tracking-wide">Friends & Presence</p>
        </div>
        <div className="flex gap-1 p-1 rounded-xl bg-overlay-4 border border-overlay-8">
          {VISIBILITY_OPTIONS.map((o) => (
            <button key={o.id} onClick={() => changeVisibility(o.id)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${visibility === o.id ? 'bg-primary-600/20 text-primary-300' : 'text-surface-400 hover:text-surface-200'}`}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-primary-400" /></div>
      ) : (
        <>
          <Panel padding="sm" className="mb-3 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-overlay-6 flex items-center justify-center shrink-0"><Lock size={15} className="text-surface-500" /></div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-surface-100">
                {localPresence?.activity ? `Currently hosting: ${localPresence.activity.serverName}` : 'Not currently hosting anything'}
              </p>
              <p className="text-[11px] text-surface-500 mt-0.5">
                Visibility: {VISIBILITY_OPTIONS.find((o) => o.id === visibility)?.label} — {visibility === 'private' ? 'your activity is not shared with anyone.' : 'shown to the audience you chose above, once a Mercy presence service is available.'}
              </p>
            </div>
          </Panel>

          {friends.length === 0 ? (
            <EmptyState icon={Users} title="No friend presence yet" description="Friends & Presence requires a Mercy account presence service, which isn't deployed yet. When available, friends' real activity will appear here — never fabricated or hardcoded." />
          ) : (
            <div className="space-y-2">
              {friends.map((f) => (
                <div key={f.displayName} className="flex items-center gap-3 rounded-xl border border-overlay-4 bg-overlay-2 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-surface-100 truncate">{f.displayName}</p>
                    <p className="text-[11px] text-surface-500">{f.activity ? `Playing ${f.activity.serverName}` : f.status}</p>
                  </div>
                  {f.joinable && <button className="btn-primary text-xs py-1.5 px-3">Join</button>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
