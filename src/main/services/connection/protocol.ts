// Mercy Relay/Signaling protocol — REAL, precise contract for the Linux
// backend this repo does not yet contain (see ConnectionNegotiator.ts's own
// header for what IS implemented vs what genuinely requires that backend to
// be deployed). This file is the actual spec: a future Linux service and
// this launcher's RelaySignalingClient both implement these exact message
// shapes, not a prose description of them.
//
// ARCHITECTURE THIS PROTOCOL SERVES:
//   HOST PC (Mercy Launcher)              MERCY RELAY/SIGNALING (Linux)              FRIEND PC (Mercy Launcher)
//   real game server runs here  <—auth—>  connection coordination only   <—auth—>   real game client runs here
//                                          + relay data-plane fallback
//
// The relay/signaling service NEVER runs anyone's Minecraft/FiveM/Assetto
// Corsa server — it only ever coordinates who may connect to whom, and
// optionally forwards already-authorized game traffic byte-for-byte when a
// direct/NAT-mapped connection isn't possible (see RelayDataFrame below).
//
// AUTH BETWEEN LAUNCHER AND BACKEND: every signaling connection presents a
// short-lived Mercy join/session credential (the SAME HMAC-signed token
// family already minted by PresenceManager.createJoinToken() — never a
// separate, second credential system). The relay never accepts a raw
// Supabase JWT and never sees Supabase service-role credentials at all.

export const RELAY_PROTOCOL_VERSION = 1;

export type RelayProtocolGame = 'minecraft' | 'fivem' | 'assettocorsa';
export type RelayTransport = 'tcp' | 'udp';

// ── 1) Connecting to signaling ──────────────────────────────────────────────
// A client opens exactly one WebSocket to the relay's signaling endpoint and
// authenticates before sending anything else. The relay closes the socket
// (code 4401) if `hello` isn't the first frame, or if the token doesn't
// verify — see "Auth" above.
export interface HelloMessage {
  type: 'hello';
  protocolVersion: number;
  /** The Mercy join/session token — see PresenceManager.createJoinToken(). */
  token: string;
  /** 'host' registers a real local server as reachable-via-relay; 'client'
   *  is a friend about to consume an already-authorized join. */
  role: 'host' | 'client';
}

export interface HelloAckMessage { type: 'hello-ack'; sessionId: string; }
export interface HelloRejectedMessage { type: 'hello-rejected'; reason: string; }

// ── 2) Host registers a temporary relay endpoint for one real local server ──
// Sent only after hello-ack, only by role:'host'. `expiresAt` bounds how
// long the relay keeps this registration — the relay must reject any join
// attempt against it after that, and must free the allocation on
// expiry/disconnect even if no explicit `unregister-host` is ever sent
// (Phase 4 point 9: cleanup must not depend solely on a well-behaved client).
export interface RegisterHostMessage {
  type: 'register-host';
  serverId: string;
  game: RelayProtocolGame;
  transport: RelayTransport;
  /** The REAL local port Mercy will forward relay traffic to on 127.0.0.1
   *  on the host machine — never sent anywhere except this authenticated
   *  channel, and never exposed to the joining client directly. */
  localPort: number;
  expiresAt: number;
}
export interface HostRegisteredMessage { type: 'host-registered'; relayId: string; expiresAt: number; }
export interface UnregisterHostMessage { type: 'unregister-host'; relayId: string; }

// ── 3) Client requests to actually use an already-authorized join ──────────
// `joinRequestId` must correspond to a join_requests row the backend
// (Supabase, via respond_to_join_request()) already marked 'authorized' for
// THIS caller — the relay re-verifies this against the same database rather
// than trusting the client's claim (Phase 13: never trust a renderer-
// supplied ownership/authorization claim).
export interface RequestRelayMessage { type: 'request-relay'; joinRequestId: string; relayId: string; }
export interface RelayGrantedMessage {
  type: 'relay-granted';
  /** An opaque data-channel id the client now uses to exchange
   *  RelayDataFrame messages with the relay for this one connection. */
  channelId: string;
}
export interface RelayDeniedMessage { type: 'relay-denied'; reason: string; }

// ── 4) Relay data-plane — only ever carries already-authorized game bytes,
//      never anything Mercy itself interprets. ─────────────────────────────
export interface RelayDataFrame { type: 'relay-data'; channelId: string; /** base64 */ data: string; }
export interface RelayClosedMessage { type: 'relay-closed'; channelId: string; reason: string; }

// ── 5) Keepalive — the relay must drop a session with no traffic (including
//      pings) for longer than RELAY_IDLE_TIMEOUT_MS, so a crashed client
//      never leaves a permanent open relay allocation. ─────────────────────
export interface PingMessage { type: 'ping'; at: number; }
export interface PongMessage { type: 'pong'; at: number; }

export type SignalingClientMessage =
  | HelloMessage | RegisterHostMessage | UnregisterHostMessage | RequestRelayMessage | RelayDataFrame | PingMessage;
export type SignalingServerMessage =
  | HelloAckMessage | HelloRejectedMessage | HostRegisteredMessage | RelayGrantedMessage | RelayDeniedMessage
  | RelayDataFrame | RelayClosedMessage | PongMessage;

// ── Lifecycle / limits (Phase 4 points 7-10) ────────────────────────────────
/** A host registration is only ever valid this long without renewal — long
 *  enough to cover one play session's worth of idle time between joins,
 *  short enough that a crashed launcher's allocation dies on its own. */
export const RELAY_HOST_REGISTRATION_TTL_MS = 10 * 60 * 1000;
/** A granted relay data channel with no traffic for this long is closed —
 *  mirrors the same honest "don't stay online forever" principle as the
 *  presence heartbeat timeout (see FriendsPresenceLogic.HEARTBEAT_TIMEOUT_MS). */
export const RELAY_IDLE_TIMEOUT_MS = 90 * 1000;
/** A signaling connection must hello within this long or the relay drops it. */
export const RELAY_HELLO_TIMEOUT_MS = 5000;
/** Real, deliberately small ceilings — see FriendsPresenceLogic.SlidingWindowRateLimiter,
 *  reused (not duplicated) as the actual limiter implementation on both the
 *  client's own pre-check and the relay's authoritative server-side check. */
export const RELAY_ALLOCATION_RATE_LIMIT = { maxHits: 5, windowMs: 60_000 };
export const JOIN_REQUEST_RATE_LIMIT = { maxHits: 10, windowMs: 60_000 };
