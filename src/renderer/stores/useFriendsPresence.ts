// Real Friends/Presence store — identity is the existing launcher Discord
// session (see useAppAuth.ts / VehicleStudioAuth.ts), never a separate Mercy
// username/password account. All Mercy Friends networking (REST + WebSocket)
// now lives in the main process (MercyFriendsClient.ts) — this store only
// ever talks to it through the narrow `window.electronAPI.mercyFriends.*`
// IPC surface, and reads local activity truth from the main process
// (PresenceManager, via the existing presence:getLocal IPC — never
// re-derived or guessed here). See Library.tsx's FriendsPresenceSection for
// how this is actually rendered.
//
// WHY THE NETWORKING MOVED: the OLD implementation (src/renderer/lib/
// friendsPresence.ts) authenticated with a Supabase access token held in the
// renderer, requiring users to create/remember a separate Mercy account just
// to use Friends & Presence. The Discord/Vehicle Studio session token this
// store's identity now derives from has always been main-process-only, by
// design (see VehicleStudioAuth.ts) — so the REST/WebSocket client moved
// there too, rather than exposing that token to the renderer.
//
// Local activity is polled cheaply and often (every few seconds, in-process
// IPC, no network) purely so a server start/stop is picked up quickly; the
// actual network heartbeat is throttled to ~30s unless the activity
// genuinely changed. The same change also registers/updates the real
// `servers` row (Phase 7) — a Mercy-managed server only ever appears there
// while it's genuinely running, and is marked offline the moment local
// activity stops reflecting it.
//
// Join approval (Minecraft only, this milestone — see ConnectionNegotiator.ts)
// is real: accepting a join request negotiates a real endpoint on THIS
// host's own machine (LAN address / UPnP-mapped address / honestly
// "unavailable, no relay configured"), mints a real single-use HMAC join
// token bound to that endpoint, and only then marks the request authorized.
//
// KNOWN GAP (flagged, not fixed by this migration): approveJoin() below
// still registers the host with the separate Mercy Relay signaling server
// using a Supabase access token (see supabase.auth.getSession() below) —
// that system is explicitly out of scope for the Discord-identity migration
// (Mercy Relay must not be broken/altered here) and is unaudited for a
// Discord-only identity. A user with no Mercy password account will still
// see "Not signed in to Mercy" specifically when APPROVING a join request as
// host, even though Friends & Presence itself no longer requires that
// account. See the migration report for details.
import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import { useNotifications } from './useNotifications';

type FriendPresenceRow = MercyFriendPresenceRow;
type EveryonePlayingRow = MercyEveryonePlayingRow;
type IncomingFriendRequest = MercyIncomingFriendRequest;
type OutgoingFriendRequest = MercyOutgoingFriendRequest;
type JoinRequestRow = MercyJoinRequestRow;
type WsConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const isMercyApiConfigured = () => !!window.electronAPI?.mercyFriends;
const sendFriendRequest = (username: string) => window.electronAPI.mercyFriends.sendFriendRequest(username);
const respondToFriendRequest = (requestId: string, approve: boolean) => window.electronAPI.mercyFriends.respondToFriendRequest(requestId, approve);
const removeFriend = (friendId: string) => window.electronAPI.mercyFriends.removeFriend(friendId);
const listIncomingRequests = () => window.electronAPI.mercyFriends.listIncomingRequests();
const listOutgoingRequests = () => window.electronAPI.mercyFriends.listOutgoingRequests();
const getFriendsPresence = () => window.electronAPI.mercyFriends.getFriends();
const getEveryonePlaying = () => window.electronAPI.mercyFriends.getEveryone();
const sendHeartbeat = (settings: PresenceSettings, activity: any) => window.electronAPI.mercyFriends.sendHeartbeat(settings, activity);
const requestJoin = (serverId: string) => window.electronAPI.mercyFriends.requestJoin(serverId);
const respondToJoinRequest = (requestId: string, approve: boolean, token?: string, endpoint?: any) => window.electronAPI.mercyFriends.respondToJoinRequest(requestId, approve, token, endpoint);
const listJoinRequests = () => window.electronAPI.mercyFriends.listJoinRequests();
const upsertServer = (server: { id: string; mercyGameId: string; edition?: string | null; displayName: string; isOnline: boolean }) => window.electronAPI.mercyFriends.upsertServer(server);

type PresenceSettings = { appearOnline: boolean; showCurrentGame: boolean; showCurrentServer: boolean };
const DEFAULT_SETTINGS: PresenceSettings = { appearOnline: false, showCurrentGame: false, showCurrentServer: false };
const LOCAL_POLL_MS = 5000;
const HEARTBEAT_MIN_INTERVAL_MS = 30000;
const JOIN_TOKEN_TTL_MS = 2 * 60 * 1000;
// Independent of the WebSocket push entirely — a real safety net so
// friends/presence staleness is always bounded even in some edge case
// where the reconnect logic itself misbehaves. This is deliberately a
// SEPARATE, unconditional timer rather than "only refresh if the socket
// looks unhealthy" — the whole point of the original bug was that nothing
// could reliably observe the socket's health, so this never trusts that
// signal as the sole source of truth.
const FALLBACK_REFRESH_INTERVAL_MS = 60000;

// 'reconnecting' and 'auth-required' are the two states the ~20-minute
// silent-death bug actually needed: previously nothing distinguished "the
// WebSocket dropped and is retrying" (data is still last-known-good, no
// action needed) from "the token itself was rejected" (the user genuinely
// needs to sign in again) from "the whole backend is unreachable" — every
// one of those collapsed into the same generic 'unreachable' with no way
// for the UI to react correctly to each.
export type ConnectionState = 'unconfigured' | 'connecting' | 'connected' | 'reconnecting' | 'auth-required' | 'unreachable';

// Honest, user-facing connection states (Step 9) — never "Connected" unless
// a real local tunnel/direct address was actually established.
export type GameConnectionState =
  | 'idle' | 'connecting-direct' | 'connected-direct'
  | 'connecting-relay' | 'connected-relay' | 'failed';
export interface GameConnectionStatus {
  state: GameConnectionState; detail?: string; localAddress?: string;
  /** Assetto Corsa's relay path only — the separate local HTTP tunnel a
   *  real AC client (Content Manager especially) queries for server/car/
   *  track info as part of a normal connection. Absent for every other
   *  game/strategy, which only ever needs the one localAddress. */
  httpAddress?: string;
}

interface FriendsPresenceState {
  connection: ConnectionState;
  /** Feeds the WebSocket's own observable lifecycle (connecting/connected/
   *  reconnecting/auth-required/disconnected — see subscribeToFriendsUpdates)
   *  into `connection`, without letting a transient 'connecting' blip
   *  downgrade an already-'connected' state right after a REST refresh
   *  succeeds. */
  applyWsStatus: (status: WsConnectionStatus) => void;
  friends: FriendPresenceRow[];
  /** Real, non-friend-gated presence discovery — see get_everyone_playing()
   *  and this store's own refresh() for how it's fetched/gated. */
  everyone: EveryonePlayingRow[];
  incoming: IncomingFriendRequest[];
  outgoing: OutgoingFriendRequest[];
  incomingJoinRequests: JoinRequestRow[];
  outgoingJoinRequests: JoinRequestRow[];
  /** Keyed by join_requests.id — the requester's own real connection
   *  attempt state for one approved join, never shared across requests. */
  connectionStatus: Record<string, GameConnectionStatus>;
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
  /** REQUESTER side: once a join request is authorized, actually attempt
   *  the connection — direct address verification, or a real relay tunnel
   *  when the host's endpoint says strategy:'relay'. Drives
   *  connectionStatus[request.id] through the honest states above; never
   *  reports connected-* without a real, successful check. */
  connectToApprovedJoin: (request: JoinRequestRow) => Promise<void>;
  /** Everyone Playing's own Add Friend action — reuses the exact same
   *  addFriend() rules/backend as the Friends section's form; never a
   *  separate, looser path. */
  addFriendFromEveryone: (username: string) => Promise<void>;
}

let localPollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeRealtime: (() => void) | null = null;
let lastHeartbeatAt = 0;
let lastRefreshAt = 0;
let lastActivityKey = '';
/** The real server local activity last reported as hosting — kept only so
 *  a transition to "no longer hosting" can mark that SAME real row offline
 *  with its own real name/game, never a guess or a blanked-out value. */
let lastHosted: { serverId: string; mercyGameId: 'fivem' | 'minecraft' | 'assettocorsa'; serverName: string; edition?: string } | null = null;
/** Incoming friend-request ids already seen, so a genuinely NEW request
 *  (arriving while the app is open) can raise an in-app notification
 *  without re-notifying on every refresh, and without notifying about
 *  requests that already existed before this session started. `null`
 *  means "not seeded yet" — the very first refresh() of a session records
 *  every currently-pending id silently, since none of them are new. */
let knownIncomingRequestIds: Set<string> | null = null;

export const useFriendsPresence = create<FriendsPresenceState>((set, get) => ({
  connection: isMercyApiConfigured() ? 'connecting' : 'unconfigured',
  friends: [],
  everyone: [],
  incoming: [],
  outgoing: [],
  incomingJoinRequests: [],
  outgoingJoinRequests: [],
  connectionStatus: {},
  settings: DEFAULT_SETTINGS,
  loading: true,
  addFriendError: null,

  init: async () => {
    if (!isMercyApiConfigured()) { set({ connection: 'unconfigured', loading: false }); return; }
    const configured = await window.electronAPI.mercyFriends.isConfigured().catch(() => false);
    if (!configured) { set({ connection: 'unconfigured', loading: false }); return; }
    const settings = (await window.electronAPI?.presence?.getSettings?.().catch(() => DEFAULT_SETTINGS)) || DEFAULT_SETTINGS;
    set({ settings });
    await get().refresh();
    lastRefreshAt = Date.now();

    if (!unsubscribeRealtime) {
      const offChanged = window.electronAPI.mercyFriends.onChanged(() => { get().refresh(); lastRefreshAt = Date.now(); });
      const offStatus = window.electronAPI.mercyFriends.onStatus((status) => get().applyWsStatus(status as WsConnectionStatus));
      window.electronAPI.mercyFriends.subscribe();
      unsubscribeRealtime = () => {
        offChanged();
        offStatus();
        window.electronAPI.mercyFriends.unsubscribe();
      };
    }

    if (!localPollTimer) {
      localPollTimer = setInterval(async () => {
        if (!window.electronAPI?.presence) return;
        const local = await window.electronAPI.presence.getLocal().catch(() => null);
        const current = get().settings;
        const activityKey = JSON.stringify(local?.activity ?? null);
        const now = Date.now();
        const dueForHeartbeat = now - lastHeartbeatAt >= HEARTBEAT_MIN_INTERVAL_MS;
        const activityChanged = activityKey !== lastActivityKey;
        // Independent fallback refresh (see FALLBACK_REFRESH_INTERVAL_MS's
        // own comment) — never gated on the WebSocket's perceived health,
        // since that was exactly the thing the original ~20-minute bug
        // proved couldn't be trusted to self-report failure.
        if (now - lastRefreshAt >= FALLBACK_REFRESH_INTERVAL_MS) {
          lastRefreshAt = now;
          get().refresh();
        }
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
              // Real cleanup: stop forwarding relay traffic for a server
              // that has actually stopped, rather than waiting for the
              // relay's own idle timeout to notice.
              await window.electronAPI?.connection?.teardownRelayHost?.(lastHosted.serverId).catch(() => {});
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
    knownIncomingRequestIds = null;
  },

  refresh: async () => {
    if (!isMercyApiConfigured()) { set({ connection: 'unconfigured', loading: false }); return; }
    set({ loading: true });
    const [friendsRes, everyoneRes, incomingRes, outgoingRes, joinRes] = await Promise.all([
      getFriendsPresence(), getEveryonePlaying(), listIncomingRequests(), listOutgoingRequests(), listJoinRequests(),
    ]);
    const results = [friendsRes, everyoneRes, incomingRes, outgoingRes, joinRes];
    const anyError = results.some((r) => r.error);
    if (anyError) {
      // The contract's own required client behavior: a transient/auth
      // failure must never overwrite the visible friends list with an
      // empty result — only flip the connection indicator and keep
      // whatever was last successfully known. The real bug this fixes:
      // every getX() below resolves `{ data: [], error }` on failure, and
      // blindly writing that into state used to wipe Friends/Everyone
      // Playing to nothing on a one-off network blip.
      //
      // AUTH_ERROR is reported as its own distinct 'auth-required' state —
      // never folded into the generic 'unreachable' — because the fix is
      // different: a rejected/expired token needs the user to sign in
      // again, not a "retry the connection" affordance that can never
      // succeed on its own.
      const authFailure = results.some((r) => r.errorCode === 'AUTH_ERROR');
      set({ connection: authFailure ? 'auth-required' : 'unreachable', loading: false });
      return;
    }
    const newIncomingIds = new Set(incomingRes.data.map((r) => r.id));
    if (knownIncomingRequestIds !== null) {
      for (const req of incomingRes.data) {
        if (!knownIncomingRequestIds.has(req.id)) {
          useNotifications.getState().push({
            title: 'New friend request',
            message: `${req.fromUsername} wants to be friends.`,
            category: 'friend',
          });
        }
      }
    }
    knownIncomingRequestIds = newIncomingIds;

    set({
      friends: friendsRes.data, everyone: everyoneRes.data, incoming: incomingRes.data, outgoing: outgoingRes.data,
      incomingJoinRequests: joinRes.data.incoming, outgoingJoinRequests: joinRes.data.outgoing,
      connection: 'connected', loading: false,
    });
  },

  applyWsStatus: (status) => {
    set((s) => {
      // REST refresh() (above) is the SOLE authority for 'auth-required' —
      // it re-derives that verdict fresh from the real, current errorCode on
      // every call, so it can never get permanently stuck the way the old
      // WS-lifetime `lastFailureWasAuth` flag could (the actual v1.105.0
      // regression: one stale WS auth rejection kept overriding an otherwise
      // healthy, REST-verified session on every later reconnect attempt).
      // The WebSocket layer no longer reports an auth state at all (see
      // WsConnectionStatus in friendsPresence.ts) — it only ever signals its
      // own connect/reconnect lifecycle here. A 'reconnecting'/'connecting'
      // blip must never downgrade a genuine 'auth-required' verdict (that
      // would hide a real "please sign in again" behind a misleading
      // "still trying" state); only a real WS 'connected' (a successful,
      // freshly-verified hello-ack) proves the session is good again.
      if (s.connection === 'auth-required' && status !== 'connected') return {};
      if (status === 'connected') return { connection: 'connected' };
      if (status === 'reconnecting') return { connection: 'reconnecting' };
      // A bare 'connecting' callback fires once synchronously right as the
      // socket starts — including immediately after a REST refresh has
      // already proven the connection healthy. Never let that downgrade an
      // already-'connected' state; only apply it while still establishing
      // the very first connection.
      if (status === 'connecting' && s.connection !== 'connected') return { connection: 'connecting' };
      return {};
    });
  },

  addFriend: async (username) => {
    set({ addFriendError: null });
    const result = await sendFriendRequest(username);
    if (result.error) {
      // Only a genuine USER_NOT_FOUND should ever say "no such user" — any
      // other code (AUTH_ERROR/SERVER_ERROR/a network exception) is a real
      // connection problem, not a claim about whether the username exists.
      const message = result.errorCode === 'USER_NOT_FOUND' ? result.error : `Could not reach Mercy services — ${result.error}`;
      set({ addFriendError: message });
      return;
    }
    await get().refresh();
  },

  addFriendFromEveryone: async (username) => { await get().addFriend(username); },

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
    // Negotiate a real endpoint on THIS machine (LAN, then UPnP, then the
    // real Mercy relay — see ConnectionNegotiator's own direct-first
    // priority), then mint a real, single-use, short-lived token bound to
    // it. A relay candidate is only ever produced after a real, successful
    // registration round trip — never assumed available. Minecraft and
    // Assetto Corsa each source their own real connectivity facts (see
    // main.ts's two negotiate* IPC handlers) but share the exact same
    // negotiator/relay/tunnel code underneath — never a second, parallel
    // connection system per game.
    // Registering this server with the Mercy relay authenticates the HOST
    // role, which the relay now verifies against a real Supabase session
    // (see signaling/auth.js's verifyHostToken on the Linux backend) — never
    // the HMAC join token minted below by createJoinToken(), which is a
    // separate credential for the CLIENT role on this one approved
    // join_requests row. A missing/expired session must fail honestly here,
    // not silently substitute that HMAC token.
    const { data: sessionData, error: sessionError } = supabase
      ? await supabase.auth.getSession()
      : { data: { session: null }, error: null };
    const supabaseAccessToken = sessionData?.session?.access_token;
    if (sessionError || !supabaseAccessToken) {
      return { error: 'Not signed in to Mercy — cannot register this server with the relay. Please sign in and try again.' };
    }

    const mercyGameId = request.mercyGameId === 'assettocorsa' ? 'assettocorsa' as const : 'minecraft' as const;
    const plan = mercyGameId === 'assettocorsa'
      ? await window.electronAPI?.connection?.negotiateAssettoCorsaEndpoint?.(request.serverId, supabaseAccessToken).catch(() => null)
      : await window.electronAPI?.connection?.negotiateMinecraftEndpoint?.(request.serverId, supabaseAccessToken).catch(() => null);
    const best = plan?.candidates?.[0] ?? null;
    // relayIdUdp is set only for Assetto Corsa's dual TCP+UDP relay case
    // (see main.ts's negotiateAssettoCorsaEndpoint and
    // RelayConnectionManager's ::transport-scoped keying) — absent/undefined
    // for every other game, which only ever needs one relay channel.
    const endpoint = best ? { strategy: best.strategy, address: best.address, relayId: best.relayId, relayIdUdp: best.relayIdUdp, relayIdHttp: best.relayIdHttp } : null;
    const token = await window.electronAPI?.presence?.createJoinToken?.(request.serverId, mercyGameId, JOIN_TOKEN_TTL_MS, endpoint).catch(() => null);
    const result = await respondToJoinRequest(request.id, true, token || undefined, endpoint);
    if (result.error) return { error: result.error };
    await get().refresh();
    return {};
  },

  declineJoin: async (requestId) => { await respondToJoinRequest(requestId, false); await get().refresh(); },

  connectToApprovedJoin: async (request) => {
    const key = request.id;
    const setStatus = (status: GameConnectionStatus) => set((s) => ({ connectionStatus: { ...s.connectionStatus, [key]: status } }));
    if (!request.endpoint) { setStatus({ state: 'failed', detail: 'The host did not provide a connection endpoint.' }); return; }
    // Bedrock (RakNet) and Assetto Corsa's own game port are both real UDP
    // protocols — see TunnelProxy.ts's own header on why a TCP proxy is
    // structurally incapable of carrying either.
    const transport: 'tcp' | 'udp' = request.edition === 'bedrock' || request.mercyGameId === 'assettocorsa' ? 'udp' : 'tcp';

    if (request.endpoint.strategy === 'lan-direct' || request.endpoint.strategy === 'upnp-direct') {
      // Reported as the real, negotiated address — not independently
      // re-verified from the renderer (ConnectionNegotiator.verifyEndpointReachable
      // is a main-process-only helper with no IPC exposure yet, since
      // nothing calls it live — see docs/linux-backend-client-contract.md
      // §10). The game client's own connection attempt is the real proof,
      // exactly like MinecraftServerPanel's existing ConnectTab already
      // treats a LAN address today.
      setStatus({
        state: 'connected-direct', localAddress: request.endpoint.address,
        detail: 'Use this address in your game client to connect.',
      });
      return;
    }

    if (request.endpoint.strategy === 'relay') {
      if (!request.endpoint.relayId || !request.token) { setStatus({ state: 'failed', detail: 'Missing relay authorization.' }); return; }
      setStatus({ state: 'connecting-relay' });
      const listenPort = 40000 + Math.floor(Math.random() * 5000);

      // Assetto Corsa needs BOTH a TCP and a UDP relay channel to the same
      // local port (see main.ts's negotiateAssettoCorsaEndpoint) — connect
      // both, sharing the SAME listenPort (a TCP listener and a UDP socket
      // can coexist on one port number; they're independent namespaces) —
      // PLUS a separate TCP relay channel for the real, distinct HTTP query
      // port a real AC client (Content Manager especially) uses as part of
      // a normal connection. That third tunnel needs its OWN local port
      // (it's also TCP, and two TCP listeners can't share one port number).
      // Every other game only ever has relayIdUdp unset and takes the
      // original single-channel path unchanged.
      if (request.endpoint.relayIdUdp) {
        const httpListenPort = request.endpoint.relayIdHttp ? 45000 + Math.floor(Math.random() * 5000) : null;
        const [tcpResult, udpResult, httpResult]: { success: boolean; localAddress?: string; reason?: string }[] = await Promise.all([
          window.electronAPI?.connection?.connectViaRelay?.({
            joinRequestId: request.id, relayId: request.endpoint.relayId, token: request.token!, transport: 'tcp', listenPort,
          }).catch((e) => ({ success: false, reason: e?.message })) as Promise<any>,
          window.electronAPI?.connection?.connectViaRelay?.({
            joinRequestId: request.id, relayId: request.endpoint.relayIdUdp, token: request.token!, transport: 'udp', listenPort,
          }).catch((e) => ({ success: false, reason: e?.message })) as Promise<any>,
          httpListenPort && request.endpoint.relayIdHttp
            ? window.electronAPI?.connection?.connectViaRelay?.({
                joinRequestId: request.id, relayId: request.endpoint.relayIdHttp, token: request.token!, transport: 'tcp', listenPort: httpListenPort,
              }).catch((e) => ({ success: false, reason: e?.message })) as Promise<any>
            : Promise.resolve({ success: true }),
        ]);
        if (tcpResult?.success && udpResult?.success && httpResult?.success) {
          setStatus({ state: 'connected-relay', localAddress: tcpResult.localAddress, httpAddress: httpResult.localAddress });
        } else {
          setStatus({ state: 'failed', detail: tcpResult?.reason || udpResult?.reason || httpResult?.reason || 'Could not connect through the Mercy relay (TCP+UDP+HTTP).' });
        }
        return;
      }

      const result: { success: boolean; localAddress?: string; reason?: string } | undefined = await window.electronAPI?.connection?.connectViaRelay?.({
        joinRequestId: request.id, relayId: request.endpoint.relayId, token: request.token, transport, listenPort,
      }).catch((e) => ({ success: false, reason: e?.message }));
      if (result?.success) setStatus({ state: 'connected-relay', localAddress: result.localAddress });
      else setStatus({ state: 'failed', detail: result?.reason || 'Could not connect through the Mercy relay.' });
      return;
    }

    setStatus({ state: 'failed', detail: 'Unknown connection strategy.' });
  },
}));
