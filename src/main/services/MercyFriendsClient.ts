// Main-process Mercy API client — Friends/Presence/Servers/Join-requests,
// authenticated using the existing Launcher/Vehicle Studio Discord session
// (VehicleStudioAuth), NOT a separate Mercy username/password account.
//
// WHY THIS LIVES IN THE MAIN PROCESS (the real architectural fix this
// migration makes): the Discord session token has always been kept
// main-process-only, by explicit design (see VehicleStudioAuth.ts's own
// header — "changing localStorage / React state / dev-console values
// cannot unlock the app"). The OLD Friends/Presence implementation lived in
// the renderer and held a Supabase access token there instead — a
// materially different (and looser) trust boundary. Rather than exposing
// the Discord session token to the renderer just to keep the old
// renderer-side networking code, this class moves the networking itself
// into the main process, so the session token never has to leave it at
// all. The renderer only ever sees the resulting DATA (friends lists,
// presence, `changed`/status events) via the narrow `mercyFriends:*` IPC
// surface (see main.ts) — never the credential that produced it.
//
// AUTHENTICATION: every request attaches the Discord session token
// (VehicleStudioAuth.getSessionToken()) as `Authorization: Bearer <token>`.
// The Mercy API is expected to validate it server-to-server against
// `https://auth.tryautoscout.com/session` (exactly how it already
// validates Supabase tokens via `supabase.auth.getUser()` today — see the
// migration plan) and resolve the verified Discord ID to the existing
// Mercy UUID identity via the new `profiles.discord_id` mapping. This
// class never computes, guesses, or trusts a Discord ID itself — it only
// ever forwards an opaque token for the server to verify.
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { VehicleStudioAuth } from './VehicleStudioAuth';
import type { RealActivity, PresenceSettings } from './FriendsPresenceLogic';

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

export interface ServiceResult<T> { data: T; error?: string; errorCode?: string; notConfigured?: boolean; }

export interface EveryonePlayingRow {
  userId: string;
  username: string;
  activityLabel: string | null;
  mercyGameId: string | null;
  isFriend: boolean;
  requestPending: boolean;
}

export interface JoinRequestRow {
  id: string; requesterId: string; requesterUsername: string; hostId: string; serverId: string;
  status: 'pending' | 'authorized' | 'denied' | 'expired';
  endpoint: { strategy: string; address: string; relayId?: string; relayIdUdp?: string; relayIdHttp?: string } | null;
  token: string | null;
  mercyGameId: string | null;
  edition: 'java' | 'bedrock' | null;
  createdAt: string;
}

export type WsConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const UNREACHABLE = 'Unable to connect to Mercy services.';
const WS_HELLO_TIMEOUT_MS = 5000;
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;

interface ApiErrorBody { error?: string; message?: string; }

// The production Mercy API base URL — a public endpoint every client must
// reach regardless of who installed it, not a per-deployment secret (same
// configuration philosophy as the Linux side's VEHICLE_STUDIO_AUTH_URL
// default in services/mercy-backend/api/env.js). This MUST be a hardcoded
// fallback, not solely an env-var read: main.ts is compiled by plain tsc,
// never touched by Vite, so unlike the renderer's `import.meta.env.VITE_*`
// (which Vite substitutes at BUILD time, baking a real value into every
// shipped bundle) a `process.env.VITE_MERCY_API_URL` read in the main
// process only ever has a value if something loads a real .env file at
// RUNTIME — and no .env file has ever shipped with a packaged build (it's
// git-ignored and deliberately excluded from electron-builder's `files`).
// Without this default, every real installed copy of v1.106.0 silently had
// apiBase === '' and isConfigured() === false, so every REST call and the
// presence WebSocket returned before ever making a network request — the
// confirmed root cause of the production Friends & Presence outage (zero
// heartbeats, zero new presence rows, from any real client, ever).
const DEFAULT_MERCY_API_URL = 'https://mercy.tryautoscout.com/mercy-api/v1';

export class MercyFriendsClient extends EventEmitter {
  private apiBase: string;

  private stopped = true;
  private socket: WebSocket | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private hasConnectedOnce = false;

  constructor(private auth: VehicleStudioAuth) {
    super();
    // VITE_MERCY_API_URL still overrides this for local dev/testing (see
    // main.ts's loadMainProcessEnv(), which loads the WHOLE .env file into
    // process.env when one exists) — it just no longer needs to for a real
    // packaged install to work correctly.
    this.apiBase = (process.env.VITE_MERCY_API_URL || DEFAULT_MERCY_API_URL).replace(/\/$/, '');
  }

  /** Configured whenever a Mercy API base URL is set AND the existing
   *  Discord/Vehicle Studio auth system is enabled — Friends & Presence's
   *  identity now comes entirely from there, never a separate check. */
  isConfigured(): boolean {
    return this.auth.isEnabled() && !!this.apiBase;
  }

  private wsUrl(): string | null {
    if (!this.apiBase) return null;
    try {
      const u = new URL(this.apiBase);
      u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
      u.pathname = `${u.pathname.replace(/\/$/, '')}/presence/ws`;
      return u.toString();
    } catch { return null; }
  }

  private async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<{ data?: T; error?: string; errorCode?: string; notConfigured?: boolean }> {
    if (!this.isConfigured()) return { notConfigured: true };
    const token = this.auth.getSessionToken();
    if (!token) return { error: 'Not signed in with Discord.', errorCode: 'AUTH_ERROR' };
    try {
      const res = await fetch(`${this.apiBase}${path}`, {
        method: init?.method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      let body: any = null;
      try { body = await res.json(); } catch { /* a 204/empty body is fine */ }
      if (!res.ok) {
        const err: ApiErrorBody = body || {};
        return { error: err.message || UNREACHABLE, errorCode: err.error || 'SERVER_ERROR' };
      }
      return { data: (body && 'data' in body ? body.data : body) as T };
    } catch {
      return { error: UNREACHABLE, errorCode: 'SERVER_ERROR' };
    }
  }

  async sendFriendRequest(username: string) {
    const r = await this.request('/friends/requests', { method: 'POST', body: { username: username.trim() } });
    if (r.notConfigured) return { notConfigured: true };
    if (r.error) return { error: r.error, errorCode: r.errorCode };
    return {};
  }

  async respondToFriendRequest(requestId: string, approve: boolean) {
    const r = await this.request(`/friends/requests/${encodeURIComponent(requestId)}/respond`, { method: 'POST', body: { approve } });
    if (r.notConfigured) return { notConfigured: true };
    if (r.error) return { error: r.error, errorCode: r.errorCode };
    return {};
  }

  async removeFriend(friendId: string) {
    const r = await this.request(`/friends/${encodeURIComponent(friendId)}`, { method: 'DELETE' });
    if (r.notConfigured) return { notConfigured: true };
    if (r.error) return { error: r.error, errorCode: r.errorCode };
    return {};
  }

  async listIncomingRequests(): Promise<ServiceResult<IncomingFriendRequest[]>> {
    const r = await this.request<IncomingFriendRequest[]>('/friends/requests/incoming');
    if (r.notConfigured) return { data: [], notConfigured: true };
    if (r.error) return { data: [], error: r.error, errorCode: r.errorCode };
    return { data: r.data || [] };
  }

  async listOutgoingRequests(): Promise<ServiceResult<OutgoingFriendRequest[]>> {
    const r = await this.request<OutgoingFriendRequest[]>('/friends/requests/outgoing');
    if (r.notConfigured) return { data: [], notConfigured: true };
    if (r.error) return { data: [], error: r.error, errorCode: r.errorCode };
    return { data: r.data || [] };
  }

  async getEveryonePlaying(): Promise<ServiceResult<EveryonePlayingRow[]>> {
    const r = await this.request<EveryonePlayingRow[]>('/everyone');
    if (r.notConfigured) return { data: [], notConfigured: true };
    if (r.error) return { data: [], error: r.error, errorCode: r.errorCode };
    return { data: r.data || [] };
  }

  async getFriendsPresence(): Promise<ServiceResult<FriendPresenceRow[]>> {
    const r = await this.request<FriendPresenceRow[]>('/friends');
    if (r.notConfigured) return { data: [], notConfigured: true };
    if (r.error) return { data: [], error: r.error, errorCode: r.errorCode };
    return { data: r.data || [] };
  }

  async sendHeartbeat(settings: PresenceSettings, activity: RealActivity | null) {
    const r = await this.request('/presence/heartbeat', {
      method: 'POST',
      body: { appearOnline: settings.appearOnline, showCurrentGame: settings.showCurrentGame, showCurrentServer: settings.showCurrentServer, activity },
    });
    if (r.notConfigured) return { notConfigured: true };
    if (r.error) return { error: r.error, errorCode: r.errorCode };
    return {};
  }

  async upsertServer(server: { id: string; mercyGameId: string; edition?: string | null; displayName: string; isOnline: boolean }) {
    const r = await this.request(`/servers/${encodeURIComponent(server.id)}`, {
      method: 'PUT',
      body: { mercyGameId: server.mercyGameId, edition: server.edition ?? null, displayName: server.displayName, isOnline: server.isOnline },
    });
    if (r.notConfigured) return { notConfigured: true };
    if (r.error) return { error: r.error, errorCode: r.errorCode };
    return {};
  }

  async requestJoin(serverId: string) {
    const r = await this.request<{ id: string }>('/joins', { method: 'POST', body: { serverId } });
    if (r.notConfigured) return { notConfigured: true };
    if (r.error) return { error: r.error, errorCode: r.errorCode };
    return { data: r.data };
  }

  async respondToJoinRequest(
    requestId: string, approve: boolean, token?: string, endpoint?: { strategy: string; address: string; relayId?: string; relayIdUdp?: string; relayIdHttp?: string } | null,
  ) {
    const r = await this.request(`/joins/${encodeURIComponent(requestId)}/respond`, { method: 'POST', body: { approve, token: token ?? null, endpoint: endpoint ?? null } });
    if (r.notConfigured) return { notConfigured: true };
    if (r.error) return { error: r.error, errorCode: r.errorCode };
    return {};
  }

  async listJoinRequests(): Promise<ServiceResult<{ incoming: JoinRequestRow[]; outgoing: JoinRequestRow[] }>> {
    const r = await this.request<{ incoming: JoinRequestRow[]; outgoing: JoinRequestRow[] }>('/joins');
    if (r.notConfigured) return { data: { incoming: [], outgoing: [] }, notConfigured: true };
    if (r.error) return { data: { incoming: [], outgoing: [] }, error: r.error, errorCode: r.errorCode };
    return { data: r.data || { incoming: [], outgoing: [] } };
  }

  // ── Real-time updates — identical protocol/reconnect semantics to the
  // previous renderer implementation (hello/hello-ack/changed, exponential
  // backoff, WS lifecycle never reports an auth-specific state — see
  // WsConnectionStatus's own header in the old friendsPresence.ts for why),
  // just running in the main process and authenticated with the Discord
  // session token instead of a Supabase one. ─────────────────────────────
  start(): void {
    if (!this.stopped) return; // already running
    this.stopped = false;
    if (!this.isConfigured()) { this.emitStatus('disconnected'); return; }
    const wsUrl = this.wsUrl();
    if (!wsUrl) { this.emitStatus('disconnected'); return; }
    this.emitStatus(this.hasConnectedOnce ? 'reconnecting' : 'connecting');
    this.connect(wsUrl);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.socket) { try { this.socket.close(); } catch {} this.socket = null; }
  }

  private clearTimers() {
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private emitStatus(status: WsConnectionStatus) { this.emit('status', status); }

  private scheduleReconnect(wsUrl: string) {
    if (this.stopped) return;
    this.emitStatus('reconnecting');
    const delay = Math.min(WS_RECONNECT_BASE_MS * 2 ** this.attempt, WS_RECONNECT_MAX_MS);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(wsUrl), delay);
  }

  private connect(wsUrl: string) {
    if (this.stopped) return;
    const token = this.auth.getSessionToken();
    if (!token) { this.scheduleReconnect(wsUrl); return; }

    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl); } catch { this.scheduleReconnect(wsUrl); return; }
    this.socket = ws;

    ws.on('open', () => {
      if (this.stopped) { try { ws.close(); } catch {} return; }
      ws.send(JSON.stringify({ type: 'hello', token }));
      this.helloTimer = setTimeout(() => { try { ws.close(); } catch {} }, WS_HELLO_TIMEOUT_MS);
    });

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type === 'hello-ack') {
        if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
        this.attempt = 0;
        this.hasConnectedOnce = true;
        this.emitStatus('connected');
        this.emit('changed');
        return;
      }
      if (msg?.type === 'hello-rejected') return; // honest rejection; onclose below reconnects
      if (msg?.type === 'changed') this.emit('changed');
    });

    ws.on('close', () => {
      if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
      if (this.socket === ws) this.socket = null;
      this.scheduleReconnect(wsUrl);
    });
    ws.on('error', () => { try { ws.close(); } catch {} });
  }
}
