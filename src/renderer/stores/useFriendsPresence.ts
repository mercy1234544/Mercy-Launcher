// Real Friends/Presence store — wires the Supabase-backed client
// (lib/friendsPresence.ts) to the LOCAL activity truth that already lives
// in the main process (PresenceManager, via the existing presence:getLocal
// IPC — never re-derived or guessed here). See Library.tsx's
// FriendsPresenceSection for how this is actually rendered.
//
// Local activity is polled cheaply and often (every few seconds, in-process
// IPC, no network) purely so a server start/stop is picked up quickly; the
// actual network heartbeat to Supabase is throttled to ~30s unless the
// activity genuinely changed, matching Phase 2's real heartbeat cadence
// without hammering the backend on every poll tick. The same change also
// registers/updates the real `servers` row (Phase 7) — a Mercy-managed
// server only ever appears there while it's genuinely running, and is
// marked offline the moment local activity stops reflecting it.
//
// Join approval (Minecraft only, this milestone — see ConnectionNegotiator.ts)
// is real: accepting a join request negotiates a real endpoint on THIS
// host's own machine (LAN address / UPnP-mapped address / honestly
// "unavailable, no relay configured"), mints a real single-use HMAC join
// token bound to that endpoint, and only then marks the request authorized.
import { create } from 'zustand';
import { isSupabaseConfigured } from '../lib/supabase';
import {
  sendFriendRequest, respondToFriendRequest, removeFriend, listIncomingRequests, listOutgoingRequests,
  getFriendsPresence, sendHeartbeat, requestJoin, respondToJoinRequest, listJoinRequests, upsertServer, subscribeToFriendsUpdates,
  FriendPresenceRow, IncomingFriendRequest, OutgoingFriendRequest, JoinRequestRow,
} from '../lib/friendsPresence';

type PresenceSettings = { appearOnline: boolean; showCurrentGame: boolean; showCurrentServer: boolean };
const DEFAULT_SETTINGS: PresenceSettings = { appearOnline: false, showCurrentGame: false, showCurrentServer: false };
const LOCAL_POLL_MS = 5000;
const HEARTBEAT_MIN_INTERVAL_MS = 30000;
const JOIN_TOKEN_TTL_MS = 2 * 60 * 1000;

export type ConnectionState = 'unconfigured' | 'connecting' | 'connected' | 'unreachable';

interface FriendsPresenceState {
  connection: ConnectionState;
  friends: FriendPresenceRow[];
  incoming: IncomingFriendRequest[];
  outgoing: OutgoingFriendRequest[];
  incomingJoinRequests: JoinRequestRow[];
  outgoingJoinRequests: JoinRequestRow[];
  settings: PresenceSettings;
  loading: boolean;
  addFriendError: string | null;

  init: () => Promise<void>;
  teardown: () => void;
  refresh: () => Promise<void>;
  addFriend: (username: string) => Promise<void>;
  accept: (id: string) => Promise<void>;
  decline: (id: string) => Promise<void>;
  remove: (friendId: string) => Promise<void>;
  updateSettings: (s: Partial<PresenceSettings>) => Promise<void>;
  join: (serverId: string) => Promise<{ error?: string; requested?: boolean }>;
  approveJoin: (request: JoinRequestRow) => Promise<{ error?: string }>;
  declineJoin: (requestId: string) => Promise<void>;
}

let localPollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeRealtime: (() => void) | null = null;
let lastHeartbeatAt = 0;
let lastActivityKey = '';
/** The real server local activity last reported as hosting — kept only so
 *  a transition to "no longer hosting" can mark that SAME real row offline
 *  with its own real name/game, never a guess or a blanked-out value. */
let lastHosted: { serverId: string; mercyGameId: 'fivem' | 'minecraft' | 'assettocorsa'; serverName: string; edition?: string } | null = null;

export const useFriendsPresence = create<FriendsPresenceState>((set, get) => ({
  connection: isSupabaseConfigured() ? 'connecting' : 'unconfigured',
  friends: [],
  incoming: [],
  outgoing: [],
  incomingJoinRequests: [],
  outgoingJoinRequests: [],
  settings: DEFAULT_SETTINGS,
  loading: true,
  addFriendError: null,

  init: async () => {
    if (!isSupabaseConfigured()) { set({ connection: 'unconfigured', loading: false }); return; }
    const settings = (await window.electronAPI?.presence?.getSettings?.().catch(() => DEFAULT_SETTINGS)) || DEFAULT_SETTINGS;
    set({ settings });
    await get().refresh();

    if (!unsubscribeRealtime) unsubscribeRealtime = subscribeToFriendsUpdates(() => { get().refresh(); });

    if (!localPollTimer) {
      localPollTimer = setInterval(async () => {
        if (!window.electronAPI?.presence) return;
        const local = await window.electronAPI.presence.getLocal().catch(() => null);
        const current = get().settings;
        const activityKey = JSON.stringify(local?.activity ?? null);
        const now = Date.now();
        const dueForHeartbeat = now - lastHeartbeatAt >= HEARTBEAT_MIN_INTERVAL_MS;
        const activityChanged = activityKey !== lastActivityKey;
        if (dueForHeartbeat || activityChanged) {
          lastHeartbeatAt = now;
          lastActivityKey = activityKey;
          const a = local?.activity ?? null;
          const realActivity = a ? {
            mercyGameId: a.mercyGameId, kind: a.kind ?? ('hosting' as const),
            serverId: a.serverId, serverName: a.serverName, edition: a.edition,
          } : null;
          const result = await sendHeartbeat(current, realActivity);
          set({ connection: result.error ? 'unreachable' : 'connected' });

          // Server registration (Phase 7/8) — only ever reflects what local
          // activity, itself derived from the real manager state, actually
          // reports. Mark the PREVIOUS real server offline the moment
          // hosting activity moves away from it (stops, or switches game).
          if (activityChanged) {
            const nowHosting = realActivity?.kind === 'hosting' && realActivity.serverId ? realActivity : null;
            if (lastHosted && lastHosted.serverId !== nowHosting?.serverId) {
              await upsertServer({
                id: lastHosted.serverId, mercyGameId: lastHosted.mercyGameId, edition: lastHosted.edition ?? null,
                displayName: lastHosted.serverName, isOnline: false,
              }).catch(() => {});
            }
            if (nowHosting) {
              await upsertServer({
                id: nowHosting.serverId!, mercyGameId: nowHosting.mercyGameId, edition: nowHosting.edition ?? null,
                displayName: nowHosting.serverName || nowHosting.serverId!, isOnline: true,
              }).catch(() => {});
              lastHosted = { serverId: nowHosting.serverId!, mercyGameId: nowHosting.mercyGameId, serverName: nowHosting.serverName || nowHosting.serverId!, edition: nowHosting.edition };
            } else {
              lastHosted = null;
            }
          }
        }
      }, LOCAL_POLL_MS);
    }
  },

  teardown: () => {
    if (localPollTimer) { clearInterval(localPollTimer); localPollTimer = null; }
    if (unsubscribeRealtime) { unsubscribeRealtime(); unsubscribeRealtime = null; }
  },

  refresh: async () => {
    if (!isSupabaseConfigured()) { set({ connection: 'unconfigured', loading: false }); return; }
    set({ loading: true });
    const [friendsRes, incomingRes, outgoingRes, joinRes] = await Promise.all([
      getFriendsPresence(), listIncomingRequests(), listOutgoingRequests(), listJoinRequests(),
    ]);
    const anyError = friendsRes.error || incomingRes.error || outgoingRes.error || joinRes.error;
    set({
      friends: friendsRes.data, incoming: incomingRes.data, outgoing: outgoingRes.data,
      incomingJoinRequests: joinRes.data.incoming, outgoingJoinRequests: joinRes.data.outgoing,
      connection: anyError ? 'unreachable' : 'connected', loading: false,
    });
  },

  addFriend: async (username) => {
    set({ addFriendError: null });
    const result = await sendFriendRequest(username);
    if (result.error) { set({ addFriendError: result.error }); return; }
    await get().refresh();
  },

  accept: async (id) => { await respondToFriendRequest(id, true); await get().refresh(); },
  decline: async (id) => { await respondToFriendRequest(id, false); await get().refresh(); },
  remove: async (friendId) => { await removeFriend(friendId); await get().refresh(); },

  updateSettings: async (partial) => {
    const next = { ...get().settings, ...partial };
    set({ settings: next });
    await window.electronAPI?.presence?.setSettings?.(next);
    lastHeartbeatAt = 0; // force an immediate heartbeat with the new settings
  },

  join: async (serverId) => {
    const result = await requestJoin(serverId);
    if (result.error) return { error: result.error };
    // A request only — see requestJoin()'s own header. The host must still
    // approve, and even then this stops at authorization: there is no
    // cross-network game transport implemented yet.
    await get().refresh();
    return { requested: true };
  },

  approveJoin: async (request) => {
    // Minecraft only this milestone (Phase 5) — negotiate a real endpoint
    // on THIS machine using the server's own real connection info, then
    // mint a real, single-use, short-lived token bound to it.
    const plan = await window.electronAPI?.connection?.negotiateMinecraftEndpoint?.(request.serverId).catch(() => null);
    const best = plan?.candidates?.[0] ?? null;
    const endpoint = best ? { strategy: best.strategy, address: best.address } : null;
    const token = await window.electronAPI?.presence?.createJoinToken?.(request.serverId, 'minecraft', JOIN_TOKEN_TTL_MS, endpoint).catch(() => null);
    const result = await respondToJoinRequest(request.id, true, token || undefined, endpoint);
    if (result.error) return { error: result.error };
    await get().refresh();
    return {};
  },

  declineJoin: async (requestId) => { await respondToJoinRequest(requestId, false); await get().refresh(); },
}));
