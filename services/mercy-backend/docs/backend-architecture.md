# Mercy Linux Backend — Architecture & Decisions

Authoritative input: `reference/client/linux-backend-client-contract.md` (Windows client
audit, commit `ff36b34`, client v1.95.0). This document records how the Linux backend
resolves the gaps that audit explicitly flagged as unresolved on the client side. **No
WebSocket message type or field defined in `protocol.ts` is changed, renamed, or
extended anywhere below.** Every decision here is a backend-side implementation choice
for filling a gap the client audit itself says is open — not a new protocol.

## 1. One WebSocket surface, not two

`protocol.ts`'s own type union settles this: `RelayDataFrame` (`relay-data`) is a member
of both `SignalingClientMessage` and `SignalingServerMessage` — the same message set that
carries `hello`/`register-host`/`request-relay`. The client never opens a second
connection for data; everything rides one WebSocket per client process, per the audit's
§1–§3. So there is exactly **one live TCP/WS listener** for this whole system, not a
separate "signaling service" and "relay service" on different ports.

Given that, `mercy-relay` (see Step 10 naming) is the one real network-facing process; it
internally contains a `signaling/` module (handshake, auth, host/join negotiation) and a
`relay/` module (channel pairing, byte forwarding). The originally-sketched `mercy-signaling`
pm2 process is kept as a **thin HTTP health/status sidecar** (`signaling/health.js`) rather
than a second WebSocket listener, since inventing a second live socket the client never
opens would be exactly the kind of protocol invention Step 2 forbids.

## 2. The relay never opens an outbound connection to an arbitrary destination

Per §12 of the audit, `TunnelProxy` on the client side is what turns relay bytes into a
real local TCP connection (to `127.0.0.1:targetPort` on the host, or a local listener on
the joining side) — that logic lives and stays on the Windows client. The Linux relay's
job, per the wire protocol, is only to shuttle `relay-data{channelId, data}` frames
between the two WebSocket sockets paired under that `channelId`. **The relay process
itself never makes any outbound network connection to a game server, host IP, or
client-supplied address.** This satisfies Step 9's "never allow a client to tell the
relay to connect to an arbitrary IP/port" by construction, not by a runtime check —
there is no code path in this service that opens a socket to caller-supplied coordinates.

## 3. Host authentication for `hello` (role: 'host') — resolving audit ambiguity #2

The audit is explicit (§20.2) that the client never transmits the per-install HMAC
secret (`PresenceManager`'s `presence-secret.json`) anywhere, so the relay cannot verify
a join-token signature itself, and a host has no join-token at all before any friend has
been approved to join (join-tokens are minted per-approval, not per-hosting-session).

**Decision:** for `role: 'host'`, the `HelloMessage.token` field is the caller's existing
Supabase Auth access token (JWT) — the one real, live credential a hosting user already
holds (audit §4A). The relay verifies it locally against `SUPABASE_JWT_SECRET` (standard
JWT signature check, no network call) and extracts `sub` as the authenticated user id.
On `register-host`, the relay additionally queries `servers.id = serverId AND
servers.owner_id = sub` before issuing a `relayId`.

**Correction (production-safety task, 2026-09-17):** that ownership query originally
targeted Supabase, on the assumption of §18.2's `servers` table living there. It does
not, and never has since `mercy-api` was built — `servers` (and `join_requests`, §4
below) live ONLY in a dedicated local Postgres database (`mercy_backend`); see
`api/env.js`'s own header comment: "unrelated to Supabase (which remains the identity
provider only, never Friends/Presence data storage after this migration)." Supabase
has no `servers`/`join_requests` table for this app at all, so the original
Supabase-backed query here silently found zero rows for every real server and
rejected every real `register-host` — **the relay's host-registration and
join-authorization paths (§4 below) were completely non-functional against
production data; no friend could ever actually join a hosted server through the
relay.** `verifyServerOwnership`/`verifyClientToken` in `signaling/auth.js` now query
the local `mercy_backend` database directly, through a second, independent
`pg.Pool` (`shared/localDb.js`) — sharing the database `api/db.js` uses but not its
process or pool, consistent with the two-separate-PM2-apps failure-domain split this
doc's own intro describes. `verifyHostToken`'s Supabase identity check is unaffected.

This is unchanged wire format (`token` stays an opaque string) and does not touch
`protocol.ts`. It **does** require future work on the Windows client (main.ts would need
to instantiate `RelaySignalingClient` for the host role with a Supabase access token) —
that wiring is explicitly out of scope for this Linux-only task and is called out below
as a blocker for the next Windows-side session.

## 4. Client authentication for `hello` (role: 'client') — resolving audit ambiguity #2

For `role: 'client'`, `HelloMessage.token` is the join-token minted by
`PresenceManager.createJoinToken()` and stored verbatim on the approved `join_requests`
row (`join_requests.token`, audit §18.2). The relay cannot verify its HMAC signature
(no shared secret with the host), so instead it takes the token string as a lookup key:

1. Base64url-decode the body (no signature check possible/needed here) to read
   `serverId`, `mercyGameId`, `expiresAt`, `nonce` — matches `JoinTokenPayload` (§5).
2. Query the local `mercy_backend` Postgres database (NOT Supabase — see the
   correction under §3 above) for a `join_requests` row where `token` equals the
   **exact** presented string and `status = 'authorized'`. An exact-string match
   against the value the backend itself stored at approval time (via `mercy-api`'s
   `api/repo/joins.js`) is the equivalent security property an HMAC check would give
   (a forged/tampered token cannot match any stored row).
3. Reject if `expires_at` (SQL column) has passed, or if the decoded payload's
   `expiresAt` has passed (defense in depth — the two should agree).
4. Enforce **single-use** the same way the client's own (unused) code does it (§5):
   an in-memory `Map<nonce, expiresAt>` per relay process. A second `hello` presenting
   the same nonce is rejected as a replay. This mirrors `consumedNonces` in
   `PresenceManager.ts` rather than inventing a new mechanism.
5. The `join_requests.id` found in step 2 is remembered on the connection/session and
   must match the `joinRequestId` sent later in `request-relay` — this is what actually
   authorizes a `request-relay` call, not a fresh Supabase lookup at that point.

## 5. `request-relay` authorization

`RequestRelayMessage{joinRequestId, relayId}` is only granted when **all** of:
- The calling session already completed `hello` as `role: 'client'` and its remembered
  `join_requests.id` equals `joinRequestId`.
- `relayId` matches a currently-registered, non-expired host registration.
- That host registration's `serverId` equals the `server_id` on the same `join_requests`
  row (prevents a valid token for server A being used to reach server B's relay slot).

Only then is a `channelId` minted and `relay-granted` sent to the client, and a matching
grant is (conceptually) delivered to the host side of that `relayId`'s live connection so
both ends start forwarding `relay-data` under that `channelId`.

## 6. `unregister-host` — never sent by the client (audit §1/§2), still handled

The server accepts it if sent (cheap to support, matches the declared type union) but
does not depend on it: a host registration is also freed on socket close and on TTL
expiry (`RELAY_HOST_REGISTRATION_TTL_MS`), per protocol.ts's own comment that the relay
"must free the allocation on expiry/disconnect even if no explicit `unregister-host` is
ever sent" (audit §17).

## 7. Timeouts/limits — taken directly from `protocol.ts` constants

| Constant | Value | Enforced by relay as |
|---|---|---|
| `RELAY_HELLO_TIMEOUT_MS` | 5000 | close the socket if no `hello` arrives within 5s of connection open |
| `RELAY_IDLE_TIMEOUT_MS` | 90000 | close the socket if no message of any kind (including `ping`) arrives for 90s — this is the audit's documented "relay-side responsibility" (§16.B) |
| `RELAY_HOST_REGISTRATION_TTL_MS` | 600000 (10 min) | a host registration (`relayId`) expires and is freed even if the socket stays open |
| `RELAY_ALLOCATION_RATE_LIMIT` | 5/60s | applied to `register-host` calls per connection |
| `JOIN_REQUEST_RATE_LIMIT` | 10/60s | applied to `request-relay` calls per connection |

Additional relay-side-only limits (not in `protocol.ts`, needed for Step 9's resource
exhaustion protections, configured via `.env`): max concurrent WebSocket connections,
max concurrent relay sessions (paired channels), max message size (`ws` `maxPayload`).

## 8. What is explicitly out of scope / blocked for a future Windows-side session

- `main.ts` never instantiates `RelaySignalingClient` for either role — this backend can
  be fully correct and still see zero real traffic until that wiring exists client-side.
  Not something this Linux task can or should fix.
- `ConnectionNegotiator.planHostEndpoint()` never produces a `'relay'` candidate — the
  negotiation flow that would tell a client "use the relay" doesn't exist yet client-side.
- The `MERCY_RELAY_WS_URL` vs `VITE_MERCY_RELAY_WS_URL` env var mismatch (audit §19/§20.4)
  is a client-side bug; this backend does not attempt to work around it.
- UDP transport: `protocol.ts` declares it, nothing implements it client-side (audit §13).
  This backend implements TCP-shaped byte forwarding only (it forwards opaque
  `relay-data` frames regardless of what game bytes they carry — "UDP support" for a
  game like Bedrock would need a client-side `dgram`-based `DataChannel`/`TunnelProxy`
  that doesn't exist yet; the relay itself is transport-agnostic since it never touches
  raw sockets, only WS frames, so no relay-side change would even be needed once that
  client piece exists).
