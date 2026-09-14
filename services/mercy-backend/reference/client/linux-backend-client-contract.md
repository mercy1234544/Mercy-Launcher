# Mercy Launcher → Linux Backend Client Contract

**Audit-only reference export.** This document reports the exact, current state of the
Windows client source as of the commit below. Nothing in this document is aspirational
or theoretical — every claim is tied to an exact file and line, and every gap is
explicitly labeled `NOT IMPLEMENTED IN WINDOWS CLIENT` or `FUTURE/UNIMPLEMENTED`. No
application code was changed to produce this report.

**Repository commit inspected:** `ff36b345e0f9e8d8b0858612e8198a5e4f751724`
(`git log -1`: `ff36b34 Real cross-computer join infrastructure: NAT traversal, relay
protocol, host approval UI`, working tree clean except this new file and the
pre-existing untracked `.claude/`)
**Client version at this commit:** `package.json` → `"version": "1.95.0"`

---

## 0. Executive summary — what actually runs today

Read this first. The individual sections below go file-by-file, but the single most
important fact for a backend implementer is this:

- **The relay/signaling client code is real, complete, and unit-tested — but it is not
  wired into the running application at all.** `RelaySignalingClient`, `TunnelProxy`,
  and every message type in `protocol.ts` have **zero call sites** outside their own
  files and their test files. `main.ts` never imports `RelaySignalingClient`. No IPC
  handler creates one. No renderer code creates one.
- **The only connection-negotiation code that actually runs in production** is
  `ConnectionNegotiator.planHostEndpoint()`, wired to one IPC handler
  (`connection:negotiateMinecraftEndpoint`), called from one place in the renderer
  (`useFriendsPresence.ts`'s `approveJoin`). It only ever produces **LAN-direct** or
  **UPnP-direct** candidates. It never contacts a relay, never mints a `relayId`, and
  never calls into `RelaySignalingClient` — even when a relay URL is configured, it
  just returns `relayAvailable: true` with an empty candidate list and stops there.
- **Today, without any Linux backend, join negotiation can only ever succeed for
  same-LAN or UPnP-capable-router hosts.** Everything relay-shaped in this repo is
  real code with no live path to it yet.
- **The Supabase schema has never been run against a live database.** Credentials in
  `src/renderer/lib/supabase.ts` are unset placeholders in this repo.

---

## 1. Every protocol message/type/interface used by the relay/signaling system

Exact source: `src/main/services/connection/protocol.ts` (full file, 115 lines).

```ts
export const RELAY_PROTOCOL_VERSION = 1;

export type RelayProtocolGame = 'minecraft' | 'fivem' | 'assettocorsa';
export type RelayTransport = 'tcp' | 'udp';

export interface HelloMessage {
  type: 'hello';
  protocolVersion: number;
  token: string;                 // PresenceManager.createJoinToken() output
  role: 'host' | 'client';
}
export interface HelloAckMessage { type: 'hello-ack'; sessionId: string; }
export interface HelloRejectedMessage { type: 'hello-rejected'; reason: string; }

export interface RegisterHostMessage {
  type: 'register-host';
  serverId: string;
  game: RelayProtocolGame;
  transport: RelayTransport;
  localPort: number;             // real local port on the HOST machine, 127.0.0.1-scoped
  expiresAt: number;             // epoch ms
}
export interface HostRegisteredMessage { type: 'host-registered'; relayId: string; expiresAt: number; }
export interface UnregisterHostMessage { type: 'unregister-host'; relayId: string; }

export interface RequestRelayMessage { type: 'request-relay'; joinRequestId: string; relayId: string; }
export interface RelayGrantedMessage { type: 'relay-granted'; channelId: string; }
export interface RelayDeniedMessage { type: 'relay-denied'; reason: string; }

export interface RelayDataFrame { type: 'relay-data'; channelId: string; data: string; /* base64 */ }
export interface RelayClosedMessage { type: 'relay-closed'; channelId: string; reason: string; }

export interface PingMessage { type: 'ping'; at: number; }
export interface PongMessage { type: 'pong'; at: number; }

export type SignalingClientMessage =
  | HelloMessage | RegisterHostMessage | UnregisterHostMessage | RequestRelayMessage | RelayDataFrame | PingMessage;
export type SignalingServerMessage =
  | HelloAckMessage | HelloRejectedMessage | HostRegisteredMessage | RelayGrantedMessage | RelayDeniedMessage
  | RelayDataFrame | RelayClosedMessage | PongMessage;

export const RELAY_HOST_REGISTRATION_TTL_MS = 10 * 60 * 1000;  // 10 minutes
export const RELAY_IDLE_TIMEOUT_MS = 90 * 1000;                // 90 seconds
export const RELAY_HELLO_TIMEOUT_MS = 5000;                    // 5 seconds
export const RELAY_ALLOCATION_RATE_LIMIT = { maxHits: 5, windowMs: 60_000 };
export const JOIN_REQUEST_RATE_LIMIT = { maxHits: 10, windowMs: 60_000 };
```

**Important:** `UnregisterHostMessage` is a defined type and is included in the
`SignalingClientMessage` union, but **`RelaySignalingClient` has no method that sends
it.** See §2 below. `NOT IMPLEMENTED IN WINDOWS CLIENT.`

Transport note: `RelayTransport` declares `'tcp' | 'udp'`, but **no UDP implementation
exists anywhere in the client** (see §13). `NOT IMPLEMENTED IN WINDOWS CLIENT.`

Framing: messages are JSON-serialized (`JSON.stringify`/`JSON.parse`), one JSON object
per WebSocket text frame. No length-prefixing, no binary framing, no compression
negotiated in code.

---

## 2. Every WebSocket message sent by the Windows client

Exact source: `src/main/services/connection/RelaySignalingClient.ts` (full file, 117
lines). This is the only code capable of sending these; **it is currently
uninstantiated in the running app** (§0).

| Method | Sends | When (as coded) |
|---|---|---|
| `connect(token, role)` | `{type:'hello', protocolVersion: 1, token, role}` | Immediately on WebSocket `'open'` |
| `registerHost(serverId, game, transport, localPort, expiresAt)` | `{type:'register-host', serverId, game, transport, localPort, expiresAt}` | Caller-invoked only; no automatic call site exists |
| `requestRelay(joinRequestId, relayId)` | `{type:'request-relay', joinRequestId, relayId}` | Caller-invoked only |
| `sendData(channelId, data: Buffer)` | `{type:'relay-data', channelId, data: data.toString('base64')}` | Caller-invoked only |
| `ping()` | `{type:'ping', at: Date.now()}` | Caller-invoked only — **no internal interval calls this**; there is no automatic keepalive loop in the client |

`send()` (private) is a no-op if `this.ws.readyState !== WebSocket.OPEN` — messages
sent before `hello-ack` (other than `hello` itself) or after close are silently
dropped, not queued.

**Never sent by this client:** `unregister-host` (no method exists to send it).

**No automatic ping loop.** `RELAY_IDLE_TIMEOUT_MS` (90s) is a constant the *server*
is expected to enforce (per `protocol.ts`'s own comments); the client itself never
calls `ping()` on a timer anywhere in the codebase.

---

## 3. Every WebSocket message expected from the backend

From `RelaySignalingClient.ts`'s `'message'` handler (lines 58–74) and
`handleReady()` (lines 84–93):

- `hello-ack` — before this arrives, only this and `hello-rejected` are recognized;
  everything else received before `hello-ack` is routed into `handleReady()` anyway
  (there is no explicit "reject non-hello-ack messages pre-auth" guard — see §20
  ambiguity #1).
- `hello-rejected` — rejects the `connect()` promise with `new Error(msg.reason)`,
  sets state `'failed'`.
- `host-registered` → `onHostRegistered?.(relayId, expiresAt)`
- `relay-granted` → `onRelayGranted?.(channelId)`
- `relay-denied` → `onRelayDenied?.(reason)`
- `relay-data` → `onRelayData?.(channelId, Buffer.from(data, 'base64'))`
- `relay-closed` → `onRelayClosed?.(channelId, reason)`
- `pong` → no-op (`case 'pong': break;`)

Malformed JSON on any incoming frame is silently dropped (`try { JSON.parse } catch {
return; }`, line 60) — no error surfaced, no disconnect.

**Unknown/future message types:** the `switch` in `handleReady()` has no `default`
case; an unrecognized `type` value is silently ignored by the switch (TypeScript's
exhaustiveness isn't enforced at runtime). Forward-compatible by accident, not by
design.

---

## 4. Authentication requirements

Two **completely separate** auth systems exist; the relay protocol is designed to use
only the second one, and does not use Supabase auth at all.

**A. Supabase Auth (accounts/friends/presence)** — `src/renderer/lib/supabase.ts`:
- Username-based accounts. Supabase Auth requires an email internally, so usernames
  are mapped to a synthetic address: `usernameToAuthEmail(username)` →
  `${slug}@users.fivembuilder.app` where `slug = username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')`.
- Session persistence: `createClient(url, key, { auth: { persistSession: true,
  autoRefreshToken: true } })`.
- `isSupabaseConfigured()` = `!SUPABASE_URL.startsWith('PASTE') &&
  !SUPABASE_ANON_KEY.startsWith('PASTE')`. In this repo, both are still the literal
  placeholder strings (`'PASTE_YOUR_SUPABASE_URL_HERE'` /
  `'PASTE_YOUR_SUPABASE_ANON_KEY_HERE'`), overridable via `.env` → `VITE_SUPABASE_URL`
  / `VITE_SUPABASE_ANON_KEY` (see `src/renderer/lib/supabase.ts` lines 17–18 and
  `.env.example`). No `.env` file exists in this repo; only `.env.example`.
- The anon key is intentionally public; all access control is RLS (§18).

**B. Relay/signaling auth (protocol.ts)** — per `protocol.ts`'s own header comment
(lines 18–22): every signaling WebSocket connection presents a `HelloMessage.token`,
which **must be** the same HMAC-signed token family minted by
`PresenceManager.createJoinToken()` (§5). The relay is explicitly documented to
**never** accept a raw Supabase JWT and **never** see Supabase service-role
credentials. `RelaySignalingClient.connect(token, role)` is the only place this token
is transmitted, and it is sent as the very first frame after the socket opens.

**Backend implication:** the Linux relay authenticates callers by validating this
HMAC token's signature and the caller's role, not by talking to Supabase. **How the
relay would obtain the HMAC signing secret to validate tokens minted by an
arbitrary host's `PresenceManager` is not addressed anywhere in this codebase** — see
§5 and §20 ambiguity #2. This is a real, unresolved architecture gap, not an
oversight in this report.

---

## 5. Join-token format and validation

Exact source: `src/main/services/PresenceManager.ts` lines 104–118, 292–317.

**Payload shape (`JoinTokenPayload`):**
```ts
interface JoinTokenPayload {
  serverId: string;
  mercyGameId: 'fivem' | 'minecraft' | 'assettocorsa';
  issuedAt: number;    // epoch ms
  expiresAt: number;   // epoch ms
  nonce: string;        // crypto.randomBytes(8).toString('hex') — 16 hex chars
  endpoint?: { strategy: string; address: string } | null;  // OMITTED (not null) when no endpoint was negotiated
}
```

**Wire format:** `${base64url(JSON.stringify(payload))}.${base64url(HMAC-SHA256(secret, body))}`
— a single string, body and signature joined by a literal `.`, both base64url
(`Buffer.toString('base64url')`).

**Signing secret:** `crypto.randomBytes(32)`, generated once per installation and
persisted at `<userDataPath>/data/presence-secret.json` (JSON `{secret: hex}`),
loaded/created by `loadOrCreateSecret()` (lines 228–238). **This secret is local to
each host machine and is never transmitted anywhere** — not to Supabase, not to any
relay, not in any IPC call observed in this codebase. It exists solely so that
`verifyJoinToken()` on the **same** PresenceManager instance that minted a token can
verify it later.

**Creation:** `createJoinToken(serverId, mercyGameId, ttlMs = 300000, endpoint?)`
(line 292). Default TTL is 5 minutes (`DEFAULT_JOIN_TOKEN_TTL_MS = 5 * 60 * 1000`,
line 193), but the actual live call site
(`useFriendsPresence.ts` line 33, `JOIN_TOKEN_TTL_MS = 2 * 60 * 1000`) uses **2
minutes**, not the default. `endpoint` is spread into the payload only if truthy
(`...(endpoint ? { endpoint } : {})`) — when omitted, the key is absent from the
payload entirely (not `null`), preserved by `JSON.stringify` dropping `undefined`.

**Validation (`verifyJoinToken`, lines 302–317):**
1. Token must be a string containing `.` → else `{valid:false, reason:'Malformed token.'}`.
2. Split into `body`/`sig` on `.`; both must be non-empty.
3. Recompute HMAC-SHA256 over `body` with the local secret; compare to `sig` via
   `crypto.timingSafeEqual` (length-checked first to avoid a throw on mismatched
   lengths) → mismatch is `{valid:false, reason:'Invalid signature.'}`.
4. `JSON.parse` the base64url-decoded body → parse failure is `'Malformed token.'`.
5. Require `payload.serverId`, `payload.mercyGameId`, and `typeof payload.expiresAt
   === 'number'` → else `'Malformed token.'`.
6. `Date.now() > payload.expiresAt` → `{valid:false, reason:'Token expired.'}`.
7. Otherwise `{valid:true, payload}`.

**Single-use enforcement (`verifyAndConsumeJoinToken`, lines 323–330):** calls
`verifyJoinToken` first; if valid, checks `payload.nonce` against an **in-memory**
`Map<nonce, expiresAt>` (`consumedNonces`, per-`PresenceManager`-instance, i.e.
per-process, i.e. cleared on app restart). If the nonce is already present →
`{valid:false, reason:'Token has already been used.'}`. Otherwise the nonce is
recorded and the result returned. `pruneConsumedNonces()` (lines 332–335) removes
entries whose `expiresAt` has passed, called at the start of every
`verifyAndConsumeJoinToken` call (no separate timer).

**Critical fact: `verifyJoinToken` and `verifyAndConsumeJoinToken` are called from
NOWHERE in the live application** — grep confirms zero call sites outside
`PresenceManager.ts` itself and `test/presence/service.test.js`. `createJoinToken` IS
called live, from `useFriendsPresence.ts`'s `approveJoin` (line 190). **The Windows
client currently only ever mints tokens; nothing in the client verifies one.**
Verification is presumed (by the architecture, not by any code) to happen on the
relay when a `hello`/`request-relay` arrives — this is `FUTURE/UNIMPLEMENTED` on the
client side and entirely undefined on any backend side.

---

## 6. Token expiration behavior

- Expiration is a plain epoch-ms comparison (`Date.now() > payload.expiresAt`), not a
  JWT-standard `exp` claim, not enforced by any signature mechanism beyond that
  comparison.
- No refresh/renewal mechanism exists. A new token requires a brand new
  `createJoinToken()` call (i.e., a brand new join-approval action).
- Expired-but-otherwise-valid tokens are distinguished from tampered ones:
  `verifyJoinToken` returns `reason: 'Token expired.'` (matches `/expired/i` in
  tests) vs `reason: 'Invalid signature.'` for a bad HMAC.
- **No revocation mechanism** exists for a token before its natural expiry (e.g., if
  a host wants to cancel an approval). `NOT IMPLEMENTED IN WINDOWS CLIENT.`

---

## 7. Relay session creation flow (AS DESIGNED, not as implemented)

This entire flow is described by `protocol.ts`'s comments and message shapes; **none
of it currently executes** (§0). As designed:

1. Host's Mercy Launcher opens a WebSocket to the relay's signaling endpoint.
2. Sends `hello {protocolVersion:1, token, role:'host'}`.
3. Relay validates the token, replies `hello-ack {sessionId}` or `hello-rejected
   {reason}`.
4. Host sends `register-host {serverId, game, transport, localPort, expiresAt}` —
   `localPort` is the REAL local port the host's game server is listening on
   (127.0.0.1-scoped; never sent to the joining client directly per the comment on
   line 58–60 of `protocol.ts`).
5. Relay replies `host-registered {relayId, expiresAt}` (`expiresAt` here is
   presumably `now + RELAY_HOST_REGISTRATION_TTL_MS`, though no client code computes
   or checks this value against that constant anywhere).
6. Separately, the joining client's Mercy Launcher also connects and sends
   `hello {token, role:'client'}`.
7. Client sends `request-relay {joinRequestId, relayId}` — `joinRequestId` is
   documented (protocol.ts lines 68–72) to correspond to a `join_requests` row
   already marked `'authorized'` by Supabase's `respond_to_join_request()` (§18); the
   relay is expected to re-verify this against Supabase itself.
8. Relay replies `relay-granted {channelId}` or `relay-denied {reason}`.
9. Both sides exchange `relay-data {channelId, data: base64}` frames; the relay
   forwards bytes between the two `channelId`-scoped ends. Not decoded/interpreted.
10. Either side can end with `relay-closed {channelId, reason}`.
11. Host may `unregister-host {relayId}` — **no client code sends this** (§1, §2).

**None of steps 1–10 are triggered by any user action in the running Windows client
today.** `NOT IMPLEMENTED IN WINDOWS CLIENT` (wiring); the message contract itself
is fully specified.

---

## 8. Host/client pairing flow (what actually runs today)

This is the REAL, live flow, distinct from §7's unimplemented relay flow. Exact
source: `src/renderer/stores/useFriendsPresence.ts`, `src/main/main.ts` lines
420–444, `supabase/friends_presence_schema.sql`.

1. Requester clicks Join in the UI → `useFriendsPresence.join(serverId)` →
   `requestJoin(serverId)` (`src/renderer/lib/friendsPresence.ts` line 138) → Supabase
   RPC `request_join(p_server_id)`.
2. Supabase's `request_join()` function (schema §18) checks: server exists, requester
   is not the owner, requester `is_friend_of` the owner, server `is_online` — then
   inserts a `join_requests` row with `status='pending'`, `expires_at = now() +
   interval '2 minutes'`.
3. Host sees it via `listJoinRequests()` (polled on `refresh()`, and pushed via the
   Realtime subscription on the `join_requests` table — `subscribeToFriendsUpdates`,
   `friendsPresence.ts` line 208).
4. Host clicks Accept → `useFriendsPresence.approveJoin(request)` (lines 183–195):
   a. Calls IPC `connection:negotiateMinecraftEndpoint(request.serverId)` →
      `ConnectionNegotiator.planHostEndpoint()` (§9/§10).
   b. Takes `plan.candidates[0]` (first candidate only — no explicit "prefer
      upnp-direct over lan-direct" or vice versa; whichever `planHostEndpoint` pushed
      first wins, and it always pushes LAN before UPnP — see §10).
   c. Calls IPC `presence:createJoinToken(request.serverId, 'minecraft', 120000,
      endpoint)` — **`'minecraft'` is hardcoded here** regardless of the join
      request's actual game; see §20 ambiguity #3.
   d. Calls `respondToJoinRequest(request.id, true, token, endpoint)` → Supabase RPC
      `respond_to_join_request(request_id, approve, p_token, p_endpoint)`, which
      checks the caller is the real `host_id` and the request is still `pending`,
      then sets `status='authorized'`, stores `token` and `endpoint` on the row.
5. Requester sees the row become `authorized` via the same Realtime subscription/poll
   and reads `endpoint` directly off the `join_requests` row (Library.tsx renders
   `r.endpoint.address` / `r.endpoint.strategy` — not part of the requested file list,
   referenced here only because it consumes `JoinRequestRow.endpoint`).

**This flow never touches `RelaySignalingClient`, `TunnelProxy`, or the relay
protocol at all.** It is a Supabase-only handshake that happens to carry a
Mercy-format HMAC token as an opaque string plus a plaintext `endpoint` JSON object.

---

## 9. Connection negotiation flow (what actually runs today)

Exact source: `src/main/services/connection/ConnectionNegotiator.ts` (full file, 111
lines), invoked only from `main.ts`'s `connection:negotiateMinecraftEndpoint` handler
(lines 429–444).

```
IPC connection:negotiateMinecraftEndpoint(serverId)
  → minecraftManager.getConnectionInfo(serverId)     // real LAN/port/RakNet facts
  → ConnectionNegotiator.planHostEndpoint(facts, relayConfigured)
```

`planHostEndpoint(facts: {lanAddress, port, portListening}, relayConfigured: boolean)`:

1. If `facts.lanAddress` is non-null → push `{strategy:'lan-direct',
   address:'${lanAddress}:${port}', note:'Works only if the joining friend is on this
   same local network.'}`.
2. If `facts.portListening` is truthy → call
   `UpnpIgdPortMapper.mapPort(port, 'TCP', 'Mercy Launcher', 3600)` (3600 = TTL
   seconds passed to the router's `AddPortMapping`, i.e. 1 hour — **not** the
   `RELAY_HOST_REGISTRATION_TTL_MS` constant from `protocol.ts`, which this file does
   not reference at all). If successful and `externalAddress` present → push
   `{strategy:'upnp-direct', address:'${externalAddress}:${externalPort ??
   port}', note:'A port was opened automatically...'}`.
   - **UPnP is never attempted if `portListening` is falsy** — deliberate, per the
     comment (avoids mapping a dead port).
3. If any candidates exist → return them immediately, `unavailableExplanation: null`,
   `relayAvailable` set to whatever the caller passed in (does not gate on whether
   candidates exist).
4. Else if `relayConfigured` → return `{candidates: [], relayAvailable: true,
   unavailableExplanation: null}`. **No relay registration, no `relayId`, no call
   into any relay code happens here** — this branch is purely a flag.
5. Else → call `assessConnectivity({hasLanAddress: false, realtimeReachable:
   upnp?.success ? true : null})` (reused from `PresenceManager.ts`) and return its
   `.explanation` as `unavailableExplanation`.

`relayConfigured` is computed at the IPC call site as `!!process.env.MERCY_RELAY_WS_URL`
(`main.ts` line 443) — **note the env var name mismatch documented in §19/§20.**

`EndpointStrategy` type: `'lan-direct' | 'upnp-direct' | 'relay'` — **`'relay'` is
declared but never actually assigned to any candidate anywhere in this file.**
`NOT IMPLEMENTED IN WINDOWS CLIENT.`

---

## 10. How direct connections are represented

`EndpointCandidate`:
```ts
interface EndpointCandidate {
  strategy: 'lan-direct' | 'upnp-direct' | 'relay';
  address: string;   // "host:port", e.g. "192.168.1.50:25565" or "203.0.113.9:25565"
  note: string;       // human-readable caveat, shown as-is in the UI
}
```
- `lan-direct`: `address = "${facts.lanAddress}:${facts.port}"` — the host's own
  non-internal IPv4 LAN address (from `MinecraftManager.getLanAddress()`, reused via
  `getConnectionInfo()`), concatenated with the real server port.
- `upnp-direct`: `address = "${upnp.externalAddress}:${upnp.externalPort ?? port}"`
  — the router-reported external IP from `GetExternalIPAddress`, and the mapped
  external port (which `UpnpIgdPortMapper.mapPort` always requests equal to the
  internal port — no port-remapping logic exists).

`EndpointPlan` (the IPC return value, and the ambient renderer type in
`src/renderer/types/electron.d.ts` lines 205–207):
```ts
interface EndpointPlan {
  candidates: EndpointCandidate[];
  relayAvailable: boolean;
  unavailableExplanation: string | null;
}
```

There is a separate, **unused-in-production** static helper for verifying an address
actually answers: `ConnectionNegotiator.verifyEndpointReachable(host, port,
timeoutMs=2000)` — a plain TCP `net.Socket().connect()` with a timeout, resolving
`true`/`false`, never throwing. Zero call sites outside its own test file. It is
explicitly documented as intended for the joining side to call before telling the
player to connect, but nothing in the client currently calls it.

---

## 11. How relay connections are represented

**As designed (protocol.ts), not as implemented:** a relay connection is represented
by an opaque `channelId` string (assigned by the relay in `relay-granted`), used as
the correlation key for every subsequent `relay-data`/`relay-closed` frame on that
logical connection. There is no other structured representation — no separate
"relay session" object with its own fields beyond `relayId` (per host-registration)
and `channelId` (per join). Nothing in `ConnectionNegotiator`'s `EndpointCandidate`
or `EndpointPlan` types carries a `channelId` or `relayId` field at all — if/when the
relay path is wired up, these types will need to be extended. `NOT IMPLEMENTED IN
WINDOWS CLIENT.`

---

## 12. What TunnelProxy expects from the relay

Exact source: `src/main/services/connection/TunnelProxy.ts` (full file, 112 lines).

`TunnelProxy` does not talk to a relay directly — it expects to be constructed with
an object satisfying the `DataChannel` interface:
```ts
interface DataChannel {
  send(data: Buffer): void;
  onData(cb: (data: Buffer) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}
```
In production, this would be backed by a `RelaySignalingClient` (per the file's own
header comment) — **but no such adapter class exists in this codebase.** The only
real `DataChannel` implementation present is `createLoopbackChannelPair()`, an
in-memory same-process pair used exclusively by tests. `NOT IMPLEMENTED IN WINDOWS
CLIENT`: there is no `RelaySignalingClient`-backed `DataChannel` implementation
anywhere.

`TunnelProxy` itself, given a real `DataChannel`:
- `mode:'client'`: `net.createServer()` listening on `listenPort` (127.0.0.1 only,
  `this.server.listen(listenPort, '127.0.0.1', ...)`); each inbound TCP connection's
  bytes are forwarded via `channel.send(data)`; `channel.onData` writes back to
  the current socket (only ONE local socket is tracked at a time — `this.socket` is
  overwritten per new connection, meaning **a second concurrent local connection to
  the same listener would silently steal the channel from the first** — no
  multiplexing of multiple local connections over one channel exists).
- `mode:'host'`: `net.createConnection({host:'127.0.0.1', port: targetPort})`
  immediately on `start()` (not lazily on first relay-granted) — forwards bytes both
  ways the same way.
- `channel.onClose` triggers `this.stop()` (destroys the socket, closes the server).
- Each `TunnelProxy` + `DataChannel` pair represents exactly ONE logical connection
  — confirmed by this session's own test file needing two independent
  `createLoopbackChannelPair()`/`TunnelProxy` pairs to prove two sequential
  connections both work (closing one tunnel fully tears it down; it is not reused).

**Backend implication:** a real relay's per-`channelId` data plane should map 1:1 to
one `TunnelProxy` pair, matching how `request-relay` grants one `channelId` per join
attempt.

---

## 13. Whether TCP, UDP, or both are required

- **`protocol.ts`** declares `RelayTransport = 'tcp' | 'udp'` and `RegisterHostMessage.transport`
  accepts either.
- **`TunnelProxy.ts`** imports only `net` (TCP). **There is no `dgram`-based UDP
  tunnel implementation anywhere in this codebase.**
- **`UpnpPortMapper.mapPort()`** takes a `protocol: 'TCP' | 'UDP'` parameter and can
  request either from the router, but every actual call site
  (`ConnectionNegotiator.planHostEndpoint`, line 71) always passes `'TCP'` —
  hardcoded, never `'UDP'`.
- **Bedrock Minecraft is UDP-only (RakNet)** — `MinecraftManager`'s own
  `checkRakNetReachable()` confirms this is understood elsewhere in the codebase (it
  pings via `dgram`), but `ConnectionNegotiator`/`TunnelProxy` do not branch on
  edition to use UDP for Bedrock. A Bedrock server's `portListening` fact
  (`info.raknet?.reachable`) IS correctly fed into `planHostEndpoint` (main.ts line
  441: `info.edition === 'bedrock' ? (info.raknet?.reachable ?? null) :
  info.portListening`), so a Bedrock server CAN produce `lan-direct`/`upnp-direct`
  candidates — but if relay were ever needed for a Bedrock server, **no UDP relay
  path exists to carry it.** `NOT IMPLEMENTED IN WINDOWS CLIENT.`

**Conclusion for the backend: TCP relay data-plane support is what the current
client-side scaffolding (`TunnelProxy`) could support today (if wired up); UDP is
declared in the protocol but has no client implementation at all.**

---

## 14. Required ports/configuration

- **Signaling WebSocket URL:** intended to come from `VITE_MERCY_RELAY_WS_URL` (see
  `.env.example`, `src/renderer/vite-env.d.ts`) — but the only code that actually
  gates on relay availability (`main.ts` line 443) reads `process.env.MERCY_RELAY_WS_URL`
  (no `VITE_` prefix) directly in the **main process**, which Vite's env injection
  does not touch at all (Vite only rewrites `import.meta.env.VITE_*` in code it
  bundles for the **renderer**). **These are two different, disconnected
  configuration paths that currently do not talk to each other** — see §20
  ambiguity #4. Setting `VITE_MERCY_RELAY_WS_URL` in a real `.env` file would have NO
  effect on `main.ts`'s `relayConfigured` check.
- **UPnP:** SSDP multicast `239.255.255.250:1900` (standard SSDP address, hardcoded in
  `UpnpPortMapper.ts`), UDP4 socket bound to an ephemeral local port
  (`socket.bind(0, ...)`). Two IGD search targets tried:
  `urn:schemas-upnp-org:device:InternetGatewayDevice:1` and `:2`. Discovery timeout
  default 2000ms (`UpnpIgdPortMapper`'s second constructor arg,
  `discoveryTimeoutMs = 2000`); SOAP/HTTP fetch timeout 3000ms (hardcoded in
  `RealUpnpTransport`).
- **Local tunnel proxy ports:** `TunnelProxy` client-mode binds wherever the caller
  specifies (`listenPort`, no default, no auto-selection logic) — always
  `127.0.0.1`-scoped, never `0.0.0.0`.
- **Game server ports:** never hardcoded — reused from
  `MinecraftManager.getConnectionInfo()`'s real `server.port` field (§ referenced
  file not in the requested list, but load-bearing for §9).

---

## 15. Session IDs, connection IDs, nonces, or other identifiers

| Identifier | Format | Origin | Scope |
|---|---|---|---|
| `nonce` (join token) | 16 hex chars (`crypto.randomBytes(8).toString('hex')`) | `PresenceManager.createJoinToken` | Single-use per token, tracked in-memory per `PresenceManager` instance |
| `sessionId` (signaling) | Opaque string, **assigned by the relay** in `hello-ack` | Relay (not client) | Not stored/reused by the client anywhere — `RelaySignalingClient` receives it but discards it (no field stores it) |
| `relayId` (host registration) | Opaque string, **assigned by the relay** in `host-registered` | Relay | Passed back to the relay in `request-relay`; no client-side generation logic |
| `channelId` (relay data) | Opaque string, **assigned by the relay** in `relay-granted` | Relay | Correlates `relay-data`/`relay-closed` frames |
| `joinRequestId` | Supabase `uuid` (`gen_random_uuid()`) | Supabase `join_requests.id` | Cross-referenced into `request-relay` per protocol.ts's design |
| `serverId` | Client-supplied string (the host's own local Mercy server id) | `MinecraftManager`'s own server records | Primary key of Supabase `servers` table |

All relay-side identifiers (`sessionId`, `relayId`, `channelId`) are **opaque from
the client's perspective — the client never parses or validates their format**, only
echoes them back where the protocol requires.

---

## 16. Heartbeats/timeouts

Two **entirely separate** heartbeat systems exist:

**A. Presence heartbeat (live, real, Supabase-backed):**
- Interval: `HEARTBEAT_INTERVAL_MS = 30_000` (30s) — defined in
  `FriendsPresenceLogic.ts` but the actual live loop
  (`useFriendsPresence.ts`, `LOCAL_POLL_MS = 5000`) polls LOCAL activity every 5s and
  only pushes a network heartbeat when `now - lastHeartbeatAt >=
  HEARTBEAT_MIN_INTERVAL_MS` (also 30000, redefined locally in
  `useFriendsPresence.ts` rather than importing the constant — same value, separate
  literal) **or** the activity payload changed since the last push.
- Timeout: `HEARTBEAT_TIMEOUT_MS = 90_000` (90s) — a friend is shown `offline` if
  `last_heartbeat` is older than this, enforced **twice, redundantly**: once in
  `FriendsPresenceLogic.isHeartbeatFresh()` (client-side pure function, used only in
  tests — no live call site found outside `friends-logic.test.js`) and once in the
  live SQL function `get_friends_presence()` (`now() - interval '90 seconds'`,
  hardcoded literal, not parameterized from any shared constant). **These two 90s
  values are maintained independently in TypeScript and SQL and could drift.**

**B. Relay protocol heartbeat (unimplemented):**
- `RELAY_HELLO_TIMEOUT_MS = 5000` — enforced client-side: `RelaySignalingClient`
  starts a `setTimeout` on `open` and fails the connection if no `hello-ack`/
  `hello-rejected` arrives within 5s (lines 53–55).
- `RELAY_IDLE_TIMEOUT_MS = 90_000` — documented as a relay-side responsibility
  (protocol.ts comment); **no client-side timer implements this at all.**
- `RELAY_HOST_REGISTRATION_TTL_MS = 10 * 60 * 1000` — passed nowhere; no client code
  reads or applies this constant to anything (not even to the `expiresAt` field it
  sends in `RegisterHostMessage`, which is never actually constructed by any live
  call site).
- No client-side ping loop exists (§2) despite `ping()`/`pong` being defined.

**C. Join-request expiry (Supabase):**
- `request_join()` sets `expires_at = now() + interval '2 minutes'` on every new
  join request.
- `expire_stale_join_requests()` exists in SQL to sweep `status='pending'` rows past
  their `expires_at` into `status='expired'` — **but nothing calls it.** No pg_cron
  schedule, no Edge Function, no client-side call. `NOT IMPLEMENTED` (schema function
  exists; nothing invokes it).

---

## 17. Disconnect/cleanup behavior

- **Relay signaling (as designed, unimplemented):** protocol.ts's comments state the
  relay "must free the allocation on expiry/disconnect even if no explicit
  `unregister-host` is ever sent" — this is a requirement ON THE RELAY, not something
  the client enforces or tests for, since the client never registers a host via this
  path in the first place.
- **`RelaySignalingClient.close()`:** clears the hello timer, calls `ws.close()`
  wrapped in try/catch. Does not send any explicit disconnect/goodbye message.
- **`TunnelProxy.stop()`:** idempotent (`if (this.closed) return`), destroys the
  socket and closes the server, wrapped in try/catch. Triggered either by direct
  caller invocation or automatically when the `DataChannel`'s `onClose` fires.
- **`consumedNonces` cleanup:** pruned lazily on every `verifyAndConsumeJoinToken`
  call (§5) — no timer-based sweep; if that method is never called (which, per §5,
  is always true in the current live app), the map never prunes, though it also
  never grows since nothing populates it in production either.
- **Presence "offline" cleanup:** purely time-based via the 90s heartbeat check in
  `get_friends_presence()` — no explicit disconnect signal, no `beforeunload`/quit
  hook found marking a user offline early. A user who force-quits Mercy Launcher
  will appear "online" for up to 90 seconds after the fact.
- **UPnP mapping cleanup:** `UpnpIgdPortMapper.unmapPort()` exists and is
  best-effort (swallows all errors) but **has zero call sites in production** —
  mappings created via `planHostEndpoint` (3600s / 1-hour lease) are never
  explicitly torn down by the client; they rely entirely on the router's own lease
  expiry.

---

## 18. Exact Supabase tables, columns, indexes, RLS policies, and RPC/functions

Two files, found by searching the repository (`find -iname "*.sql"` under
`supabase/` — no other `.sql` or migration files exist anywhere in the repo):
`supabase/schema.sql` and `supabase/friends_presence_schema.sql`. Both are plain SQL
files meant to be pasted into the Supabase SQL Editor — **there is no migration
tooling** (no `supabase/migrations/` directory, no CLI-managed migration history).
`friends_presence_schema.sql` is explicitly additive and requires `schema.sql` to
have been run first (it references `public.profiles`).

### 18.1 `schema.sql` — accounts (unrelated to relay/presence, included per the request)

**`public.profiles`**
| Column | Type | Constraint |
|---|---|---|
| `id` | `uuid` | PK, `references auth.users(id) on delete cascade` |
| `username` | `text` | `unique not null` |
| `email` | `text` | nullable |
| `role` | `text` | `not null default 'user'`, `check (role in ('user','admin','owner'))` |
| `created_at` | `timestamptz` | `not null default now()` |

**`public.entitlements`**
| Column | Type | Constraint |
|---|---|---|
| `id` | `uuid` | PK `default gen_random_uuid()` |
| `user_id` | `uuid` | `not null references public.profiles(id) on delete cascade` |
| `script_id` | `text` | `not null` |
| `granted_by` | `uuid` | `references public.profiles(id)`, nullable |
| `granted_at` | `timestamptz` | `not null default now()` |
| | | `unique (user_id, script_id)` |

Trigger: `on_auth_user_created` (after insert on `auth.users`) →
`handle_new_user()` (security definer) auto-inserts a `profiles` row, taking
`username`/`email` from `raw_user_meta_data`, defaulting username to `'user_' ||
left(id::text, 8)` if absent.

Functions: `is_admin()`, `is_owner()` — both `security definer`, `stable`, check
`profiles.role` for `auth.uid()`.

RLS: `profiles` — select if `id = auth.uid() or is_admin()`; update only if
`is_owner()`. `entitlements` — select if `user_id = auth.uid() or is_admin()`;
insert/delete only if `is_admin()`.

No indexes beyond the PKs and the one `unique` constraint above.

### 18.2 `friends_presence_schema.sql` — friends/presence/servers/join

**`public.friend_requests`**
| Column | Type | Constraint |
|---|---|---|
| `id` | `uuid` | PK `default gen_random_uuid()` |
| `requester_id` | `uuid` | `not null references public.profiles(id) on delete cascade` |
| `addressee_id` | `uuid` | `not null references public.profiles(id) on delete cascade` |
| `status` | `text` | `not null default 'pending'`, `check (status in ('pending','accepted','declined'))` |
| `created_at` | `timestamptz` | `not null default now()` |
| `responded_at` | `timestamptz` | nullable |
| | | `constraint no_self_request check (requester_id <> addressee_id)` |

Index: `one_pending_request_per_pair` — **unique**, on
`(least(requester_id,addressee_id), greatest(requester_id,addressee_id))`, **partial**
(`where status = 'pending'`). This is the only non-PK index in either schema file.

**`public.friendships`**
| Column | Type | Constraint |
|---|---|---|
| `user_id` | `uuid` | `not null references public.profiles(id) on delete cascade` |
| `friend_id` | `uuid` | `not null references public.profiles(id) on delete cascade` |
| `created_at` | `timestamptz` | `not null default now()` |
| | | PK `(user_id, friend_id)`; `constraint no_self_friendship check (user_id <> friend_id)` |

Symmetric: one row per direction (both `(A,B)` and `(B,A)` inserted on accept).

**`public.presence`**
| Column | Type | Constraint |
|---|---|---|
| `user_id` | `uuid` | PK `references public.profiles(id) on delete cascade` |
| `appear_online` | `boolean` | `not null default false` |
| `show_current_game` | `boolean` | `not null default false` |
| `show_current_server` | `boolean` | `not null default false` |
| `activity` | `jsonb` | nullable — shape `{mercyGameId, kind:'playing'|'hosting', serverId?, serverName?, edition?}` |
| `last_heartbeat` | `timestamptz` | nullable |

**`public.servers`**
| Column | Type | Constraint |
|---|---|---|
| `id` | `text` | PK — the host's own local server id (client-supplied, not a UUID) |
| `owner_id` | `uuid` | `not null references public.profiles(id) on delete cascade` |
| `mercy_game_id` | `text` | `not null`, `check (mercy_game_id in ('fivem','minecraft','assettocorsa'))` |
| `edition` | `text` | `check (edition in ('java','bedrock') or edition is null)` |
| `display_name` | `text` | `not null` |
| `is_online` | `boolean` | `not null default false` |
| `updated_at` | `timestamptz` | `not null default now()` |

No index on `owner_id` beyond what the FK implies (Postgres does not auto-index FK
columns).

**`public.join_requests`**
| Column | Type | Constraint |
|---|---|---|
| `id` | `uuid` | PK `default gen_random_uuid()` |
| `requester_id` | `uuid` | `not null references public.profiles(id) on delete cascade` |
| `host_id` | `uuid` | `not null references public.profiles(id) on delete cascade` |
| `server_id` | `text` | `not null references public.servers(id) on delete cascade` |
| `status` | `text` | `not null default 'pending'`, `check (status in ('pending','authorized','denied','expired'))` |
| `token` | `text` | nullable — opaque HMAC credential (§5), set only on approval |
| `endpoint` | `jsonb` | nullable — `{strategy, address}`, set only on approval |
| `created_at` | `timestamptz` | `not null default now()` |
| `expires_at` | `timestamptz` | nullable, set by `request_join()` to `now() + interval '2 minutes'` |
| | | `constraint no_self_join check (requester_id <> host_id)` |

No secondary indexes on `host_id`/`requester_id`/`server_id` beyond FK-implied
lookups.

### 18.3 RLS policies (exact, verbatim intent)

| Table | Policy name | Operation | Using / With Check |
|---|---|---|---|
| `friend_requests` | `parties read requests` | select | `requester_id = auth.uid() or addressee_id = auth.uid()` |
| `friend_requests` | `requester creates request` | insert | `with check (requester_id = auth.uid())` |
| `friendships` | `see own friendships` | select | `user_id = auth.uid()` |
| `presence` | `own presence` | **all** | `user_id = auth.uid()` both using and with check |
| `servers` | `owner manages own servers` | **all** | `owner_id = auth.uid()` both |
| `servers` | `friends see online servers` | select | `is_online = true and is_friend_of(owner_id)` |
| `join_requests` | `parties read join requests` | select | `requester_id = auth.uid() or host_id = auth.uid()` |

**No `update`/`delete` policies exist on `friend_requests`, `friendships`, or
`join_requests` at all** — direct client mutation of these tables (outside the
listed insert/select policies) is denied by default under RLS. All actual writes to
`status`, `token`, `endpoint`, friendship rows, etc. happen exclusively through the
`security definer` functions below, which run with the function owner's privileges
and bypass RLS internally (standard Postgres `security definer` semantics) while
re-checking `auth.uid()` manually inside each function body.

### 18.4 Functions (RPCs callable from the client via `supabase.rpc(...)`)

All `security definer`, all `set search_path = public` (consistent hardening against
search-path hijacking across every function in both files).

| Function | Signature | Behavior (exact) |
|---|---|---|
| `is_friend_of(other uuid)` | returns `boolean`, `stable` | `exists(select 1 from friendships where user_id=auth.uid() and friend_id=other)` |
| `send_friend_request(addressee_username text)` | returns `friend_requests` row | Looks up target by username → error if not found / self / already friends / already-pending-either-direction → inserts, returns the row |
| `respond_to_friend_request(request_id uuid, approve boolean)` | returns `void` | Locks the row (`for update`) → error if missing / not pending / caller isn't the addressee → updates `status`+`responded_at` → on approve, inserts both directions into `friendships` (`on conflict do nothing`) |
| `remove_friend(friend_id uuid)` | returns `void` | Error if `friend_id = auth.uid()` → deletes both friendship directions |
| `heartbeat(p_appear_online boolean, p_show_current_game boolean, p_show_current_server boolean, p_activity jsonb)` | returns `void` | Upserts the caller's `presence` row (`on conflict (user_id) do update`), always sets `last_heartbeat = now()` |
| `get_friends_presence()` | returns `table(friend_id uuid, username text, status text, activity_label text, mercy_game_id text, server_id text, server_name text)`, `stable` | Joins `friendships → profiles → presence` for `auth.uid()`'s friends; every column is individually gated by `appear_online AND last_heartbeat > now()-90s` (plus `show_current_game`/`show_current_server` as appropriate) — see exact `case when` logic in §18.5 |
| `upsert_server(p_id text, p_mercy_game_id text, p_edition text, p_display_name text, p_is_online boolean)` | returns `void` | Upserts a `servers` row; the `on conflict` clause has a `where public.servers.owner_id = auth.uid()` guard, so an upsert attempt against a server owned by someone else silently no-ops rather than erroring |
| `request_join(p_server_id text)` | returns `join_requests` row | Looks up server → error if missing / caller is owner / not a friend of owner / server offline → inserts row with 2-minute expiry, returns it |
| `respond_to_join_request(request_id uuid, approve boolean, p_token text default null, p_endpoint jsonb default null)` | returns `void` | Locks the row → error if missing / caller isn't `host_id` / not pending → sets `status`, and `token`/`endpoint` only if `approve` (both forced `null` on decline) |
| `expire_stale_join_requests()` | returns `void` | `update join_requests set status='expired' where status='pending' and expires_at < now()` — **never invoked by anything** (§16.C) |

### 18.5 `get_friends_presence()` exact gating logic (verbatim from source)

```sql
case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds'
     then 'online' else 'offline' end                                          -- status
case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds'
       and pr.show_current_game and pr.activity is not null
     then case when (pr.activity->>'kind') = 'hosting'
            then 'Playing/Hosting ' || initcap(pr.activity->>'mercyGameId')
            else 'Playing ' || initcap(pr.activity->>'mercyGameId') end
     else null end                                                             -- activity_label
case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds'
       and pr.show_current_game
     then pr.activity->>'mercyGameId' else null end                            -- mercy_game_id
case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds'
       and pr.show_current_game and pr.show_current_server
       and (pr.activity->>'kind') = 'hosting'
     then pr.activity->>'serverId' else null end                               -- server_id
-- server_name: identical gating to server_id
```

This is the SQL-side mirror of `buildPresenceForViewer()` in `FriendsPresenceLogic.ts`
(§ referenced above) — the two are maintained as separate, hand-written
implementations of the same rules (SQL is authoritative for real cross-user
enforcement; the TypeScript version is used only in that file's own unit tests to
verify the intended rule set matches).

### 18.6 Deployment status

Per both files' own header comments and `src/renderer/lib/supabase.ts`: **neither
schema file has ever been run against a live Supabase project.** No `.env` exists in
this repo; `SUPABASE_URL`/`SUPABASE_ANON_KEY` fall back to literal placeholder
strings. Realtime replication (required for live friend/presence/join-request
updates per `subscribeToFriendsUpdates`) is documented as something the owner must
manually enable per-table in the Supabase dashboard — no code or migration enables
it programmatically.

---

## 19. Environment variables required by the client

Exact source: `.env.example` (full file, 31 lines) + `src/renderer/vite-env.d.ts` +
`src/main/main.ts` line 443.

| Variable | Read by | Purpose | Status |
|---|---|---|---|
| `VITE_SUPABASE_URL` | `src/renderer/lib/supabase.ts` (renderer, via `import.meta.env`) | Supabase project URL | Unset in this repo (placeholder fallback) |
| `VITE_SUPABASE_ANON_KEY` | `src/renderer/lib/supabase.ts` (renderer) | Supabase anon public key | Unset in this repo (placeholder fallback) |
| `VITE_MERCY_RELAY_WS_URL` | **Documented** in `.env.example` and typed in `vite-env.d.ts`, but **read by no code anywhere in the repository** (`grep` confirms zero `import.meta.env.VITE_MERCY_RELAY_WS_URL` reads) | Intended relay WebSocket URL | Effectively dead configuration today |
| `MERCY_RELAY_WS_URL` (no `VITE_` prefix) | `src/main/main.ts` line 443, `process.env.MERCY_RELAY_WS_URL` (main process, plain Node env, NOT Vite-injected) | Actually gates `relayConfigured` in `ConnectionNegotiator` | This is the variable that actually matters at runtime, and it is **undocumented** — absent from `.env.example` entirely |

**This is a confirmed, exact mismatch, not an inference:** setting
`VITE_MERCY_RELAY_WS_URL` in a real `.env` file (as `.env.example` instructs) has
**zero effect** on the only code path that checks for relay availability, because
that code path is in the main process reading a differently-named, undocumented
`process.env` variable that nothing sets. See §20 ambiguity #4 for the exact lines.

No other environment variables are read anywhere in `src/main/services/connection/`,
`PresenceManager.ts`, `FriendsPresenceLogic.ts`, or `friendsPresence.ts`.

---

## 20. Assumptions the Windows client currently makes about the Linux backend, and exact ambiguities

1. **Pre-auth message handling.** `RelaySignalingClient`'s `'message'` handler
   (lines 58–74) checks for `hello-ack`/`hello-rejected` explicitly, then falls
   through to `handleReady(msg)` for anything else — **including messages received
   before authentication succeeds.** There is no client-side state guard preventing
   `handleReady` from processing a spoofed `relay-granted` etc. sent before
   `hello-ack`. This means the client currently trusts message ordering entirely to
   the server; a backend implementer should not assume the client enforces a
   pre-auth message filter, because it does not.
   *Source: `src/main/services/connection/RelaySignalingClient.ts` lines 58–93.*

2. **Where does the relay get the HMAC secret to validate a join token?**
   `PresenceManager`'s signing secret (§5) is generated locally and stored only at
   `<userDataPath>/data/presence-secret.json` on the HOST machine. Nothing in this
   codebase transmits this secret to Supabase or to any relay. If the relay is
   expected to validate `HelloMessage.token`'s signature itself (as protocol.ts's
   header comment implies — "every signaling connection presents a...token"), **the
   backend needs either (a) a mechanism to fetch/derive the host's per-install secret
   it does not currently have any way to obtain, or (b) the relay should instead
   verify tokens by asking the HOST's own already-connected signaling session to
   verify them (since the host still holds the secret), or (c) tokens should be
   validated by having Supabase (not raw HMAC) issue/co-sign them.** This is not
   resolved anywhere in the current source — it is a genuine open design question,
   not an implementation detail this report can supply an answer for.
   *Source: `PresenceManager.ts` lines 218–226 (secret is instance/file-local);
   `protocol.ts` lines 18–22 (comment asserting relay-side token validation without
   specifying how).*

3. **`approveJoin` hardcodes `'minecraft'` as the token's `mercyGameId`,** regardless
   of the join request's actual game. Since `servers.mercy_game_id` can be
   `'fivem'`/`'assettocorsa'` too (per the schema check constraint), and
   `useFriendsPresence.ts` only implements the negotiation IPC for Minecraft
   (`negotiateMinecraftEndpoint`), approving a join for a non-Minecraft server would
   still call this Minecraft-specific endpoint and mint a token falsely labeled
   `mercyGameId: 'minecraft'`. This is consistent with the milestone's own
   "Minecraft first" scope, but a backend author should not assume `mercyGameId` in
   an incoming token is verified against the server's actual registered game
   anywhere client-side — it is not.
   *Source: `src/renderer/stores/useFriendsPresence.ts` line 190.*

4. **Relay env var name mismatch.** `.env.example` and `vite-env.d.ts` define
   `VITE_MERCY_RELAY_WS_URL` (renderer-scoped, Vite-injected). `main.ts` line 443
   reads `process.env.MERCY_RELAY_WS_URL` (main-process-scoped, plain Node,
   no `VITE_` prefix, and Vite's env replacement never touches main-process code
   since main is compiled by plain `tsc`, not bundled by Vite at all). These two
   variables are unrelated at runtime today. Whoever wires up the relay for real
   will need to either rename one to match the other, or introduce an explicit
   main-process env-loading step (none exists currently — no `dotenv` or equivalent
   package is a dependency; `.env` is never read by the main process at all today,
   confirmed by `grep -rn "process.env" src/main` finding only this one
   `MERCY_RELAY_WS_URL` reference and none reading a `.env` file directly).
   *Source: `.env.example` line 30; `src/renderer/vite-env.d.ts` line 8;
   `src/main/main.ts` line 443.*

5. **`RegisterHostMessage.expiresAt` is a required field the protocol defines, but no
   live code ever constructs a `RegisterHostMessage` at all** (§0), so there is no
   real example of what value would be passed. `RELAY_HOST_REGISTRATION_TTL_MS`
   (10 minutes) exists as a constant but nothing computes `Date.now() +
   RELAY_HOST_REGISTRATION_TTL_MS` anywhere in the source. A backend implementer
   should treat this TTL as a documented *intent*, not a verified client behavior.

6. **UPnP lease duration (3600s / 1 hour) vs. `RELAY_HOST_REGISTRATION_TTL_MS` (600s /
   10 minutes)** are two unrelated numbers serving conceptually similar
   "how long is this reachable" purposes, defined in two different files
   (`ConnectionNegotiator.ts` line 71 hardcodes `3600`; `protocol.ts` line 103
   defines the other), with no cross-reference or shared constant between them.

7. **No protocol version negotiation beyond a bare integer.** `HelloMessage.protocolVersion`
   is sent as `RELAY_PROTOCOL_VERSION` (currently `1`), but the client never checks
   any version-related field in `hello-ack`/`hello-rejected` — a version mismatch
   would have to be communicated via `hello-rejected`'s free-text `reason` string
   and handled as an ordinary auth failure, not a distinct "upgrade required" case.

---

## Appendix A — full file inventory referenced in this report

| File | Lines | Role |
|---|---|---|
| `src/main/services/connection/protocol.ts` | 115 | Wire protocol types/constants (spec only — see §0) |
| `src/main/services/connection/RelaySignalingClient.ts` | 117 | Real WS client for the protocol above; unwired |
| `src/main/services/connection/TunnelProxy.ts` | 112 | Real local TCP forwarder; unwired to any real `DataChannel` |
| `src/main/services/connection/UpnpPortMapper.ts` | 189 | Real, live-wired UPnP IGD client |
| `src/main/services/connection/ConnectionNegotiator.ts` | 111 | Real, live-wired LAN/UPnP-only negotiator |
| `src/main/services/PresenceManager.ts` | 353 | Local activity, join tokens, connectivity assessment |
| `src/main/services/FriendsPresenceLogic.ts` | 209 | Pure rule mirror of the SQL (tests only — §0 note on zero live call sites for most exports) |
| `src/renderer/lib/friendsPresence.ts` | 211 | Real Supabase RPC/query client, live-wired |
| `src/renderer/stores/useFriendsPresence.ts` | 198 | Live orchestration: heartbeat, server registration, join approve/decline |
| `src/main/main.ts` (lines 420–444 inspected) | — | IPC wiring for presence/connection |
| `src/main/preload.ts` (lines 173–186 inspected) | — | Renderer-exposed IPC surface |
| `supabase/schema.sql` | 105 | Accounts/entitlements (base) |
| `supabase/friends_presence_schema.sql` | 292 | Friends/presence/servers/join_requests |
| `.env.example` | 31 | Documented (but partially disconnected — §19/§20.4) config surface |

No other `.sql`, migration, or backend-related config files exist in this
repository (confirmed via repository-wide `find`).

---

*End of audit. No application code, test code, or configuration was modified to
produce this document. No commits were made.*
