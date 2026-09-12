import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import {
  LayoutGrid, Gamepad2, Search, Loader2, Play, ExternalLink, Users, UserPlus, Check, X, WifiOff, RefreshCw,
  FolderPlus, Settings, MapPin, Trash2, AlertTriangle, Globe2,
} from 'lucide-react';
import { Panel, SectionHeading, EmptyState } from '../components/ui';
import { getGame } from '../config/games';
import { useFriendsPresence } from '../stores/useFriendsPresence';
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

  const locateGame = async (id: string) => {
    const picked = await window.electronAPI.openFile([{ name: 'Executable', extensions: ['exe'] }]);
    if (!picked) return;
    const result = await window.electronAPI.games.relocateManual(id, picked);
    if (!result.success) { toast.error(result.error || 'Could not update that path.'); return; }
    if (result.game) setGames((prev) => prev.map((g) => (g.id === id ? result.game! : g)));
    toast.success('Path updated');
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
                  <p className="text-[10.5px] text-surface-500 truncate">{g.platformLabel}</p>
                </div>
                {g.pathMissing ? (
                  <span className="text-[10px] font-semibold shrink-0 whitespace-nowrap text-danger flex items-center gap-1"><AlertTriangle size={11} /> Path unavailable</span>
                ) : (
                  <span className={`text-[10px] font-semibold shrink-0 whitespace-nowrap ${statusMeta.className}`}>{statusMeta.label}</span>
                )}
                <div className="flex items-center gap-1.5 shrink-0">
                  {mercyGame && (
                    <button onClick={() => navigate(mercyGame.path)} className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1.5" title="Open Mercy Server Tools"><ExternalLink size={12} /> Server Tools</button>
                  )}
                  {g.pathMissing ? (
                    <button onClick={() => locateGame(g.id)} className="btn-primary text-xs py-1.5 px-2.5 flex items-center gap-1.5"><MapPin size={12} /> Locate</button>
                  ) : (
                    <button onClick={() => launch(g.id, g.name)} disabled={launchingId === g.id} className="btn-primary text-xs py-1.5 px-2.5 flex items-center gap-1.5">
                      {launchingId === g.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Launch
                    </button>
                  )}
                  <GameSettingsMenu game={g} onLocate={() => locateGame(g.id)} onRemove={() => removeManualGame(g.id, g.name)} />
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
// detected path, which launcher/platform Mercy will actually use, and (only
// for a manually-added game) Locate/Remove. Nothing here exposes anything a
// normal user wasn't already shown; it's just a compact place to look
// without cluttering the row itself.
function GameSettingsMenu({ game, onLocate, onRemove }: { game: DetectedGame; onLocate: () => void; onRemove: () => void }) {
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
              <p className="text-surface-200 font-medium">{game.platformLabel}</p>
            </div>
            <div>
              <p className="text-surface-500">Executable</p>
              <p className="text-surface-200 font-mono break-all">{game.executablePath}{game.pathMissing ? ' (not found)' : ''}</p>
            </div>
          </div>
          {isManual ? (
            <div className="flex items-center gap-2 pt-1">
              <button onClick={() => { setOpen(false); onLocate(); }} className="btn-secondary text-xs py-1.5 px-2.5 flex-1 flex items-center justify-center gap-1.5">
                <MapPin size={12} /> Locate…
              </button>
              <button onClick={() => { setOpen(false); onRemove(); }} className="btn-secondary text-xs py-1.5 px-2.5 flex items-center justify-center gap-1.5 text-danger hover:bg-danger/10" title="Remove this manually added game">
                <Trash2 size={12} />
              </button>
            </div>
          ) : (
            <p className="text-[10.5px] text-surface-600 pt-1">Detected automatically — rescan if this ever moves.</p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const PRIVACY_TOGGLES: { key: 'appearOnline' | 'showCurrentGame' | 'showCurrentServer'; label: string }[] = [
  { key: 'appearOnline', label: 'Appear Online' },
  { key: 'showCurrentGame', label: 'Show Current Game' },
  { key: 'showCurrentServer', label: 'Show Current Mercy Server' },
];

// ── Friends & Presence — a REAL system: real Supabase-backed accounts,
// friend requests, and privacy-gated presence (see
// src/renderer/lib/friendsPresence.ts and supabase/friends_presence_schema.sql
// for the actual backend). This repo ships with NO Supabase project
// configured (see lib/supabase.ts), so today this always renders the
// honest "not deployed yet" state below — it is not hidden or faked once a
// real project IS configured; the exact same code path handles both. ─────
type PresenceView = 'friends' | 'friendsPlaying' | 'everyone';
const PRESENCE_VIEWS: { key: PresenceView; label: string }[] = [
  { key: 'friends', label: 'Friends' },
  { key: 'friendsPlaying', label: 'Friends Playing' },
  { key: 'everyone', label: 'Everyone Playing' },
];

function FriendsPresenceSection() {
  const {
    connection, friends, everyone, incoming, outgoing, incomingJoinRequests, outgoingJoinRequests, connectionStatus, settings, loading, addFriendError,
    init, teardown, addFriend, addFriendFromEveryone, accept, decline, remove, updateSettings, join, approveJoin, declineJoin, connectToApprovedJoin,
  } = useFriendsPresence();
  const [addUsername, setAddUsername] = useState('');
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [view, setView] = useState<PresenceView>('friends');
  const [addingFromEveryone, setAddingFromEveryone] = useState<string | null>(null);

  useEffect(() => { init(); return () => teardown(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The moment a friend's join request is authorized, actually attempt the
  // connection (direct address, or a real relay tunnel) — never left as a
  // raw address for the user to interpret themselves (Step 9: no NAT/UPnP/
  // relay/WebSocket jargon in the normal UI).
  useEffect(() => {
    for (const r of outgoingJoinRequests) {
      if (r.status === 'authorized' && !connectionStatus[r.id]) connectToApprovedJoin(r);
    }
  }, [outgoingJoinRequests]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitAddFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addUsername.trim()) return;
    await addFriend(addUsername.trim());
    setAddUsername('');
  };

  const handleJoin = async (friend: typeof friends[number]) => {
    if (!friend.serverId) return;
    setJoiningId(friend.serverId);
    try {
      const result = await join(friend.serverId);
      if (result.error) toast.error(result.error);
      else toast('Join request sent — waiting for the host to approve.', { icon: 'ℹ️' });
    } finally { setJoiningId(null); }
  };

  const handleAddFromEveryone = async (username: string) => {
    setAddingFromEveryone(username);
    try {
      await addFriendFromEveryone(username);
      const err = useFriendsPresence.getState().addFriendError;
      if (err) toast.error(err); else toast.success(`Friend request sent to ${username}`);
    } finally { setAddingFromEveryone(null); }
  };

  const handleApproveJoin = async (request: typeof incomingJoinRequests[number]) => {
    setApprovingId(request.id);
    try {
      const result = await approveJoin(request);
      if (result.error) toast.error(result.error);
      else toast('Join approved — a real connection endpoint was negotiated and sent to your friend.', { icon: 'ℹ️' });
    } finally { setApprovingId(null); }
  };

  return (
    <Panel>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-primary-300" />
          <p className="text-sm font-bold text-surface-100 uppercase tracking-wide">Friends & Presence</p>
        </div>
        {connection === 'connected' && (
          <div className="flex gap-3">
            {PRIVACY_TOGGLES.map((t) => (
              <label key={t.key} className="flex items-center gap-1.5 text-[11px] text-surface-400 cursor-pointer select-none">
                <input type="checkbox" checked={settings[t.key]} onChange={(e) => updateSettings({ [t.key]: e.target.checked })} className="accent-primary-500" />
                {t.label}
              </label>
            ))}
          </div>
        )}
      </div>

      {connection === 'unconfigured' ? (
        <EmptyState icon={Users} title="No friend presence yet" description="Friends & Presence requires a Mercy account presence service, which isn't deployed yet. When available, friends' real activity will appear here — never fabricated or hardcoded." />
      ) : loading ? (
        <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-primary-400" /></div>
      ) : connection === 'unreachable' ? (
        <EmptyState icon={WifiOff} title="Unable to connect to Mercy services." description="Your local games and servers are unaffected — only friends/presence needs the connection."
          action={<button onClick={() => useFriendsPresence.getState().refresh()} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"><RefreshCw size={13} /> Retry</button>} />
      ) : (
        <>
          <form onSubmit={submitAddFriend} className="flex items-center gap-2 mb-3">
            <input value={addUsername} onChange={(e) => setAddUsername(e.target.value)} placeholder="Add a friend by username…" className="input-field text-xs py-2 flex-1" />
            <button type="submit" className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><UserPlus size={13} /> Add</button>
          </form>
          {addFriendError && <p className="text-[11px] text-danger mb-3">{addFriendError}</p>}

          {incoming.length > 0 && (
            <div className="space-y-2 mb-3">
              {incoming.map((r) => (
                <div key={r.id} className="flex items-center gap-3 rounded-xl border border-overlay-4 bg-overlay-2 px-4 py-2.5">
                  <p className="flex-1 text-sm text-surface-100"><span className="font-semibold">{r.fromUsername}</span> wants to be friends</p>
                  <button onClick={() => accept(r.id)} className="btn-primary text-xs py-1.5 px-2.5 flex items-center gap-1"><Check size={12} /> Accept</button>
                  <button onClick={() => decline(r.id)} className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1"><X size={12} /> Decline</button>
                </div>
              ))}
            </div>
          )}
          {outgoing.length > 0 && (
            <p className="text-[11px] text-surface-500 mb-3">Pending: {outgoing.map((r) => r.toUsername).join(', ')}</p>
          )}

          {incomingJoinRequests.length > 0 && (
            <div className="space-y-2 mb-3">
              {incomingJoinRequests.map((r) => (
                <div key={r.id} className="flex items-center gap-3 rounded-xl border border-primary-500/30 bg-primary-500/10 px-4 py-2.5">
                  <p className="flex-1 text-sm text-surface-100"><span className="font-semibold">{r.requesterUsername}</span> wants to join <span className="font-semibold">{r.serverId}</span></p>
                  <button onClick={() => handleApproveJoin(r)} disabled={approvingId === r.id} className="btn-primary text-xs py-1.5 px-2.5 flex items-center gap-1">
                    {approvingId === r.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Accept
                  </button>
                  <button onClick={() => declineJoin(r.id)} className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1"><X size={12} /> Decline</button>
                </div>
              ))}
            </div>
          )}
          {outgoingJoinRequests.filter((r) => r.status !== 'denied' && r.status !== 'expired').map((r) => {
            const status = connectionStatus[r.id];
            return (
              <div key={r.id} className="flex items-center gap-3 rounded-xl border border-overlay-4 bg-overlay-2 px-4 py-2.5 mb-3">
                {r.status === 'pending' ? (
                  <p className="flex-1 text-xs text-surface-400"><Loader2 size={12} className="inline animate-spin mr-1.5" /> Waiting for the host to approve your join request for {r.serverId}…</p>
                ) : !status || status.state === 'connecting-direct' ? (
                  <p className="flex-1 text-xs text-surface-400"><Loader2 size={12} className="inline animate-spin mr-1.5" /> Connecting directly…</p>
                ) : status.state === 'connecting-relay' ? (
                  <p className="flex-1 text-xs text-surface-400"><Loader2 size={12} className="inline animate-spin mr-1.5" /> Direct connection unavailable — connecting through Mercy Relay…</p>
                ) : status.state === 'connected-direct' ? (
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-success font-semibold">Connected directly</p>
                    <p className="text-xs font-mono text-primary-300 mt-0.5">{status.localAddress}</p>
                    {status.detail && <p className="text-[11px] text-surface-500 mt-0.5">{status.detail}</p>}
                  </div>
                ) : status.state === 'connected-relay' ? (
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-success font-semibold">Connected through Mercy Relay</p>
                    <p className="text-xs font-mono text-primary-300 mt-0.5">{status.localAddress}</p>
                  </div>
                ) : (
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-danger font-semibold">Unable to establish connection</p>
                    {status.detail && <p className="text-[11px] text-surface-500 mt-0.5">{status.detail}</p>}
                  </div>
                )}
              </div>
            );
          })}

          {/* Friends / Friends Playing / Everyone Playing — one shared list
              surface, switched by a plain tab bar rather than three separate
              panels, so scanning between them stays cheap. */}
          <div className="flex items-center gap-1 mb-3 border-b border-overlay-6">
            {PRESENCE_VIEWS.map((v) => (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                className={`text-xs font-semibold px-3 py-2 border-b-2 -mb-px transition-colors ${view === v.key ? 'border-primary-400 text-primary-300' : 'border-transparent text-surface-500 hover:text-surface-300'}`}
              >
                {v.label}
              </button>
            ))}
          </div>

          {view === 'friends' && (
            friends.length === 0 ? (
              <p className="text-xs text-surface-500 py-4">No friends yet — add one by username above.</p>
            ) : (
              <div className="space-y-2">
                {friends.map((f) => (
                  <div key={f.friendId} className="flex items-center gap-3 rounded-xl border border-overlay-4 bg-overlay-2 px-4 py-3">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${f.status === 'online' ? 'bg-success' : 'bg-surface-600'}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-surface-100 truncate">{f.username}</p>
                      <p className="text-[11px] text-surface-500">{f.activityLabel || (f.status === 'online' ? 'Online' : 'Offline')}{f.serverName ? ` — ${f.serverName}` : ''}</p>
                    </div>
                    <button onClick={() => remove(f.friendId)} className="text-[11px] text-surface-500 hover:text-danger px-1">Remove</button>
                    {f.serverId && (
                      <button onClick={() => handleJoin(f)} disabled={joiningId === f.serverId} className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5">
                        {joiningId === f.serverId ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Join
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )
          )}

          {view === 'friendsPlaying' && (() => {
            const playing = friends.filter((f) => f.status === 'online' && f.activityLabel);
            return playing.length === 0 ? (
              <p className="text-xs text-surface-500 py-4">No friends are playing anything right now.</p>
            ) : (
              <div className="space-y-2">
                {playing.map((f) => (
                  <div key={f.friendId} className="flex items-center gap-3 rounded-xl border border-overlay-4 bg-overlay-2 px-4 py-3">
                    <span className="w-2 h-2 rounded-full shrink-0 bg-success" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-surface-100 truncate">{f.username}</p>
                      <p className="text-[11px] text-surface-500">{f.activityLabel}{f.serverName ? ` — ${f.serverName}` : ''}</p>
                    </div>
                    {f.serverId && (
                      <button onClick={() => handleJoin(f)} disabled={joiningId === f.serverId} className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5">
                        {joiningId === f.serverId ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Join
                      </button>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}

          {view === 'everyone' && (
            everyone.length === 0 ? (
              <EmptyState icon={Globe2} title="Nobody's visible right now" description="Other Mercy Launcher users who choose to appear online and share their current game will show up here — this never includes people who've kept their presence private." />
            ) : (
              <div className="space-y-2">
                {everyone.map((p) => (
                  <div key={p.userId} className="flex items-center gap-3 rounded-xl border border-overlay-4 bg-overlay-2 px-4 py-3">
                    <span className="w-2 h-2 rounded-full shrink-0 bg-success" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-surface-100 truncate">{p.username}</p>
                      <p className="text-[11px] text-surface-500">{p.activityLabel}</p>
                    </div>
                    {p.isFriend ? (
                      <span className="text-[11px] text-surface-500 px-1">Friends</span>
                    ) : p.requestPending ? (
                      <span className="text-[11px] text-surface-500 px-1">Pending</span>
                    ) : (
                      <button
                        onClick={() => handleAddFromEveryone(p.username)}
                        disabled={addingFromEveryone === p.username}
                        className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1.5"
                      >
                        {addingFromEveryone === p.username ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />} Add Friend
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}
    </Panel>
  );
}
