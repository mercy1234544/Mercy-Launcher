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
// without hammering the backend on every poll tick.
import { create } from 'zustand';
import { isSupabaseConfigured } from '../lib/supabase';
import {
  sendFriendRequest, respondToFriendRequest, removeFriend, listIncomingRequests, listOutgoingRequests,
  getFriendsPresence, sendHeartbeat, requestJoin, subscribeToFriendsUpdates,
  FriendPresenceRow, IncomingFriendRequest, OutgoingFriendRequest,
} from '../lib/friendsPresence';

type PresenceSettings = { appearOnline: boolean; showCurrentGame: boolean; showCurrentServer: boolean };
const DEFAULT_SETTINGS: PresenceSettings = { appearOnline: false, showCurrentGame: false, showCurrentServer: false };
const LOCAL_POLL_MS = 5000;
const HEARTBEAT_MIN_INTERVAL_MS = 30000;

export type ConnectionState = 'unconfigured' | 'connecting' | 'connected' | 'unreachable';

interface FriendsPresenceState {
  connection: ConnectionState;
  friends: FriendPresenceRow[];
  incoming: IncomingFriendRequest[];
  outgoing: OutgoingFriendRequest[];
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
  join: (serverId: string) => Promise<{ error?: string; authorized?: boolean }>;
}

let localPollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeRealtime: (() => void) | null = null;
let lastHeartbeatAt = 0;
let lastActivityKey = '';

export const useFriendsPresence = create<FriendsPresenceState>((set, get) => ({
  connection: isSupabaseConfigured() ? 'connecting' : 'unconfigured',
  friends: [],
  incoming: [],
  outgoing: [],
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
    const [friendsRes, incomingRes, outgoingRes] = await Promise.all([getFriendsPresence(), listIncomingRequests(), listOutgoingRequests()]);
    const anyError = friendsRes.error || incomingRes.error || outgoingRes.error;
    set({
      friends: friendsRes.data, incoming: incomingRes.data, outgoing: outgoingRes.data,
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
    // Authorization only — see requestJoin()'s own header: there is no
    // cross-network game transport implemented yet, so this never claims
    // the friend can actually connect right now.
    return { authorized: true };
  },
}));
