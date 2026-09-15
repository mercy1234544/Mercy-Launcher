// Real Friends/Presence/Join client — talks to the Linux Mercy API
// (services/mercy-backend, deployed on mercy.tryautoscout.com), replacing
// the previous direct-Supabase-RPC + Supabase-Realtime implementation. See
// docs/mercy-api-contract.md (fetched from the linux-backend/mercy-api
// branch — services/mercy-backend/docs/mercy-api-contract.md there) for the
// exact contract this file implements against.
//
// Identity is UNCHANGED: Supabase Auth remains the only login/account
// system (see supabase.ts/useAuth.ts) — this file only adds the caller's
// already-held Supabase access token to every Mercy API call as
// `Authorization: Bearer <token>`, exactly as the contract specifies. No
// new login flow, no new credentials, no new account system.
//
// THE REAL FIX this replacement exists for (a genuine, reported production
// bug): the previous implementation used a Supabase Realtime
// `.channel().subscribe()` for live updates, which could silently die after
// ~20 minutes with no observable client-side signal — nothing then noticed,
// so friends/presence just went stale forever until the user restarted the
// app. The Mercy API's WebSocket protocol (see subscribeToFriendsUpdates
// below) is explicit about connection state (hello-ack / hello-rejected /
// ping-pong / close) specifically so a dead connection is always OBSERVABLE
// and can be reconnected automatically — never a silent, undetectable drop.
//
// The contract also fixes a real client-side bug this file used to have:
// on a transient failure, every getX() below used to return `{ data: [],
// error }`, and the OLD useFriendsPresence.ts's refresh() blindly wrote
// that empty array into state — wiping the visible friends list to nothing
// on a one-off network blip. That store-level behavior is fixed alongside
// this file (see useFriendsPresence.ts's refresh()); this file's own
// contribution is exposing a distinct `errorCode` on every failure so the
// store can tell "genuinely no such user" (USER_NOT_FOUND) apart from
// "transient/auth failure, keep what you already had" (everything else).
//
// Every method below is safe to call whether or not the Mercy API is
// configured: with no VITE_MERCY_API_URL set (or Supabase itself not
// configured — the API needs a real Supabase access token to authenticate),
// calls resolve with `notConfigured: true` rather than throwing.
import { isSupabaseConfigured, supabase } from './supabase';
import type { RealActivity, PresenceSettings } from '../../main/services/FriendsPresenceLogic';

export interface FriendPresenceRow {
  friendId: string;
  username: string;
  status: 'online' | 'offline';
  activityLabel: string | null;
  mercyGameId: string | null;
  serverId: string | null;
  serverName: string | null;
}

export interface IncomingFriendRequest { id: string; fromUserId: string; fromUsername: string; createdAt: string; }
export interface OutgoingFriendRequest { id: string; toUserId: string; toUsername: string; createdAt: string; }

/** errorCode is the contract's exact machine-readable code (AUTH_ERROR,
 *  SERVER_ERROR, USER_NOT_FOUND, ...) — callers use this to decide how to
 *  react (e.g. only USER_NOT_FOUND should ever render "User not found.";
 *  every other code means "transient/auth failure, keep existing data and
 *  show a connection problem instead"), never the free-text `error`
 *  message alone. */
export interface ServiceResult<T> { data: T; error?: string; errorCode?: string; notConfigured?: boolean; }

const UNREACHABLE = 'Unable to connect to Mercy services.';

// VITE_MERCY_API_URL is optional — unset means "not deployed yet" (the same
// honest fallback every other Mercy service in this app uses), never a
// hardcoded production default baked into source. Set it in .env (see
// .env.example) to the real deployed base URL from the contract
// (https://mercy.tryautoscout.com/mercy-api/v1).
const MERCY_API_BASE: string = (import.meta.env.VITE_MERCY_API_URL || '').replace(/\/$/, '');

export function isMercyApiConfigured(): boolean {
  return isSupabaseConfigured() && !!MERCY_API_BASE;
}

/** The WebSocket URL is derived from the same configured REST base — the
 *  contract documents them as the same host/path prefix, just a different
 *  scheme and suffix (`https://…/v1` -> `wss://…/v1/presence/ws`) — never a
 *  second, independently-configured value that could drift out of sync. */
function mercyWsUrl(): string | null {
  if (!MERCY_API_BASE) return null;
  try {
    const u = new URL(MERCY_API_BASE);
    u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    u.pathname = `${u.pathname.replace(/\/$/, '')}/presence/ws`;
    return u.toString();
  } catch { return null; }
}

interface ApiErrorBody { error?: string; message?: string; }

/** Real fetch wrapper — attaches the caller's own current Supabase access
 *  token (re-read via getSession() on every call, never cached, so a
 *  rotated/refreshed token is always used automatically) and normalizes
 *  the contract's `{ error, message }` failure shape into `{ error,
 *  errorCode }`. Never throws — a network exception becomes an honest
 *  SERVER_ERROR-shaped failure, same as the backend being genuinely down. */
async function mercyFetch<T>(path: string, init?: RequestInit): Promise<{ data?: T; error?: string; errorCode?: string; notConfigured?: boolean }> {
  if (!isMercyApiConfigured() || !supabase) return { notConfigured: true };
  let token: string | undefined;
  try {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token;
  } catch { /* fall through to the honest "not signed in" failure below */ }
  if (!token) return { error: 'Not signed in to Mercy.', errorCode: 'AUTH_ERROR' };
  try {
    const res = await fetch(`${MERCY_API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* a 204/empty body is fine */ }
    if (!res.ok) {
      const err: ApiErrorBody = body || {};
      return { error: err.message || UNREACHABLE, errorCode: err.error || 'SERVER_ERROR' };
    }
    return { data: (body && 'data' in body ? body.data : body) as T };
  } catch {
    // A fetch-level exception (DNS failure, connection refused, CORS, a
    // dropped connection mid-request) is exactly the "backend/network is
    // unreachable" case — SERVER_ERROR, never confused with AUTH_ERROR or
    // USER_NOT_FOUND per the contract's own explicit distinction.
    return { error: UNREACHABLE, errorCode: 'SERVER_ERROR' };
  }
}

export async function sendFriendRequest(username: string): Promise<{ error?: string; errorCode?: string; notConfigured?: boolean }> {
  const r = await mercyFetch('/friends/requests', { method: 'POST', body: JSON.stringify({ username: username.trim() }) });
  if (r.notConfigured) return { notConfigured: true };
  if (r.error) return { error: r.error, errorCode: r.errorCode };
  return {};
}

export async function respondToFriendRequest(requestId: string, approve: boolean): Promise<{ error?: string; errorCode?: string; notConfigured?: boolean }> {
  const r = await mercyFetch(`/friends/requests/${encodeURIComponent(requestId)}/respond`, { method: 'POST', body: JSON.stringify({ approve }) });
  if (r.notConfigured) return { notConfigured: true };
  if (r.error) return { error: r.error, errorCode: r.errorCode };
  return {};
}

export async function removeFriend(friendId: string): Promise<{ error?: string; errorCode?: string; notConfigured?: boolean }> {
  const r = await mercyFetch(`/friends/${encodeURIComponent(friendId)}`, { method: 'DELETE' });
  if (r.notConfigured) return { notConfigured: true };
  if (r.error) return { error: r.error, errorCode: r.errorCode };
  return {};
}

export async function listIncomingRequests(): Promise<ServiceResult<IncomingFriendRequest[]>> {
  const r = await mercyFetch<IncomingFriendRequest[]>('/friends/requests/incoming');
  if (r.notConfigured) return { data: [], notConfigured: true };
  if (r.error) return { data: [], error: r.error, errorCode: r.errorCode };
  return { data: r.data || [] };
}

export async function listOutgoingRequests(): Promise<ServiceResult<OutgoingFriendRequest[]>> {
  const r = await mercyFetch<OutgoingFriendRequest[]>('/friends/requests/outgoing');
  if (r.notConfigured) return { data: [], notConfigured: true };
  if (r.error) return { data: [], error: r.error, errorCode: r.errorCode };
  return { data: r.data || [] };
}

export interface EveryonePlayingRow {
  userId: string;
  username: string;
  activityLabel: string | null;
  mercyGameId: string | null;
  isFriend: boolean;
  requestPending: boolean;
}

/** Real presence discovery across ALL users, not just friends — see
 *  GET /everyone in the contract: never requires friendship, never exposes
 *  server id/name either way (that stays a friends-only, join-relevant
 *  detail), and never includes the caller's own row. */
export async function getEveryonePlaying(): Promise<ServiceResult<EveryonePlayingRow[]>> {
  const r = await mercyFetch<EveryonePlayingRow[]>('/everyone');
  if (r.notConfigured) return { data: [], notConfigured: true };
  if (r.error) return { data: [], error: r.error, errorCode: r.errorCode };
  return { data: r.data || [] };
}

export async function getFriendsPresence(): Promise<ServiceResult<FriendPresenceRow[]>> {
  const r = await mercyFetch<FriendPresenceRow[]>('/friends');
  if (r.notConfigured) return { data: [], notConfigured: true };
  if (r.error) return { data: [], error: r.error, errorCode: r.errorCode };
  return { data: r.data || [] };
}

export async function sendHeartbeat(settings: PresenceSettings, activity: RealActivity | null): Promise<{ error?: string; errorCode?: string; notConfigured?: boolean }> {
  const r = await mercyFetch('/presence/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      appearOnline: settings.appearOnline, showCurrentGame: settings.showCurrentGame,
      showCurrentServer: settings.showCurrentServer, activity,
    }),
  });
  if (r.notConfigured) return { notConfigured: true };
  if (r.error) return { error: r.error, errorCode: r.errorCode };
  return {};
}

export async function upsertServer(server: { id: string; mercyGameId: string; edition?: string | null; displayName: string; isOnline: boolean }): Promise<{ error?: string; errorCode?: string; notConfigured?: boolean }> {
  const r = await mercyFetch(`/servers/${encodeURIComponent(server.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ mercyGameId: server.mercyGameId, edition: server.edition ?? null, displayName: server.displayName, isOnline: server.isOnline }),
  });
  if (r.notConfigured) return { notConfigured: true };
  if (r.error) return { error: r.error, errorCode: r.errorCode };
  return {};
}

/** Real join-authorization request — presence only ever tells a friend
 *  "Hunter is running My Survival Server"; this is the separate, actual
 *  authorization step. It stops at authorization: there is no cross-network
 *  game transport implemented here — see PresenceManager.ts's connectivity
 *  audit and useFriendsPresence.ts's own connectToApprovedJoin. */
export async function requestJoin(serverId: string): Promise<{ data?: { id: string }; error?: string; errorCode?: string; notConfigured?: boolean }> {
  const r = await mercyFetch<{ id: string }>('/joins', { method: 'POST', body: JSON.stringify({ serverId }) });
  if (r.notConfigured) return { notConfigured: true };
  if (r.error) return { error: r.error, errorCode: r.errorCode };
  return { data: r.data };
}

export async function respondToJoinRequest(
  requestId: string, approve: boolean, token?: string, endpoint?: { strategy: string; address: string; relayId?: string; relayIdUdp?: string; relayIdHttp?: string } | null,
): Promise<{ error?: string; errorCode?: string; notConfigured?: boolean }> {
  const r = await mercyFetch(`/joins/${encodeURIComponent(requestId)}/respond`, {
    method: 'POST',
    body: JSON.stringify({ approve, token: token ?? null, endpoint: endpoint ?? null }),
  });
  if (r.notConfigured) return { notConfigured: true };
  if (r.error) return { error: r.error, errorCode: r.errorCode };
  return {};
}

export interface JoinRequestRow {
  id: string; requesterId: string; requesterUsername: string; hostId: string; serverId: string;
  status: 'pending' | 'authorized' | 'denied' | 'expired';
  endpoint: { strategy: string; address: string; relayId?: string; relayIdUdp?: string; relayIdHttp?: string } | null;
  /** Only meaningful to the REQUESTER — the opaque HMAC credential the host
   *  minted, needed to authenticate to the relay when endpoint.strategy is
   *  'relay'. Never decoded/inspected client-side (see PresenceManager.ts). */
  token: string | null;
  /** The real server's own registered game/edition — needed so the
   *  requester knows whether a relay connection must use TCP or UDP
   *  (Bedrock) transport, without guessing. */
  mercyGameId: string | null;
  edition: 'java' | 'bedrock' | null;
  createdAt: string;
}

/** Real join requests where I'm the HOST (people asking to join MY server)
 *  and where I'm the REQUESTER (my own outstanding/resolved requests) —
 *  GET /joins already returns both, scoped server-side to exactly these
 *  two roles for the caller. */
export async function listJoinRequests(): Promise<ServiceResult<{ incoming: JoinRequestRow[]; outgoing: JoinRequestRow[] }>> {
  const r = await mercyFetch<{ incoming: JoinRequestRow[]; outgoing: JoinRequestRow[] }>('/joins');
  if (r.notConfigured) return { data: { incoming: [], outgoing: [] }, notConfigured: true };
  if (r.error) return { data: { incoming: [], outgoing: [] }, error: r.error, errorCode: r.errorCode };
  return { data: r.data || { incoming: [], outgoing: [] } };
}

// ── Real-time updates — the Mercy API's WebSocket, replacing the previous
// Supabase Realtime `.channel().subscribe()` (the actual, confirmed cause
// of the ~20-minute silent-death bug: nothing observed that connection
// dying). This implementation is explicit about every connection state the
// contract defines (hello-ack / hello-rejected / close) and reconnects with
// exponential backoff whenever the socket closes or errors for ANY reason
// — including the server's own 45s ping-timeout disconnect, which the
// contract documents as the expected, routine way a stale connection gets
// recycled, not a failure to treat specially. ───────────────────────────────
const WS_HELLO_TIMEOUT_MS = 5000;
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;

/** Observable connection lifecycle for the UI (Step: distinguish Connected /
 *  Reconnecting / Disconnected / Authentication required) — never inferred
 *  from silence. 'connecting' is the very first attempt; every later retry
 *  after a drop is 'reconnecting' so the UI can keep showing last-known-good
 *  data instead of treating a mid-session drop like a fresh cold start.
 *  'auth-required' is reported only when the server itself rejected the
 *  token (hello-rejected AUTH_ERROR) or no token could be read at all —
 *  never for a generic network/server failure, which stays 'reconnecting'. */
export type WsConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'auth-required' | 'disconnected';

export function subscribeToFriendsUpdates(onChange: () => void, onStatusChange?: (status: WsConnectionStatus) => void): () => void {
  if (!isMercyApiConfigured()) { onStatusChange?.('disconnected'); return () => {}; }
  const wsUrl = mercyWsUrl();
  if (!wsUrl) { onStatusChange?.('disconnected'); return () => {}; }

  let stopped = false;
  let socket: WebSocket | null = null;
  let helloTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let hasConnectedOnce = false;
  // Set only by an explicit server-side AUTH_ERROR rejection or a genuinely
  // missing token — a closed socket/network error on its own never implies
  // an auth problem, so it must not flip the UI to "sign in again" for a
  // plain connectivity blip.
  let lastFailureWasAuth = false;

  const clearTimers = () => {
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    onStatusChange?.(lastFailureWasAuth ? 'auth-required' : 'reconnecting');
    const delay = Math.min(WS_RECONNECT_BASE_MS * 2 ** attempt, WS_RECONNECT_MAX_MS);
    attempt++;
    reconnectTimer = setTimeout(connect, delay);
  };

  async function connect() {
    if (stopped) return;
    if (!supabase) { lastFailureWasAuth = true; scheduleReconnect(); return; }
    let token: string | undefined;
    try {
      // Always a FRESH token — never a cached/stale one — so a session that
      // rotated while disconnected still reconnects successfully.
      const { data } = await supabase.auth.getSession();
      token = data.session?.access_token;
    } catch { /* handled below as "no token" */ }
    if (!token) { lastFailureWasAuth = true; scheduleReconnect(); return; }

    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl!); } catch { scheduleReconnect(); return; }
    socket = ws;

    ws.onopen = () => {
      if (stopped) { try { ws.close(); } catch {} return; }
      ws.send(JSON.stringify({ type: 'hello', token }));
      helloTimer = setTimeout(() => { try { ws.close(); } catch {} }, WS_HELLO_TIMEOUT_MS);
    };

    ws.onmessage = (event) => {
      let msg: any;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : ''); } catch { return; }
      if (msg?.type === 'hello-ack') {
        if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
        attempt = 0; // a real, successful connection resets the backoff
        hasConnectedOnce = true;
        lastFailureWasAuth = false;
        onStatusChange?.('connected');
        // Any `changed` events missed while disconnected are lost (this
        // socket is a push HINT, not a queued/replayed log) — one full
        // refresh right after (re)connecting covers that gap honestly.
        onChange();
        return;
      }
      if (msg?.type === 'hello-rejected') {
        // An honest, typed rejection. AUTH_ERROR specifically means the
        // token itself was refused — surfaced distinctly so the UI can ask
        // the user to sign in again instead of implying a network problem.
        // Any other code (e.g. SERVER_ERROR) still just reconnects.
        lastFailureWasAuth = msg?.code === 'AUTH_ERROR';
        return;
      }
      if (msg?.type === 'changed') {
        // The push is a "go refetch" signal, not the data itself (see the
        // contract) — one shared full refresh covers every kind
        // (friends/requests/joins/everyone/servers) rather than adding
        // five separate partial-refetch code paths for a single push
        // mechanism that's explicitly documented as best-effort/lossy
        // anyway.
        onChange();
      }
    };

    ws.onclose = () => {
      if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
      if (socket === ws) socket = null;
      scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  onStatusChange?.(hasConnectedOnce ? 'reconnecting' : 'connecting');
  connect();

  return () => {
    stopped = true;
    clearTimers();
    if (socket) { try { socket.close(); } catch {} socket = null; }
  };
}
