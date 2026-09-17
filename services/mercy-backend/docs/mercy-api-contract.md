# Mercy API — client integration contract

For whoever implements the Windows-side changes in a later phase. This
service is deployed and tested independently of the Windows client — nothing
here has been wired into the Windows client, and nothing in the Windows
source was modified to produce this document.

## Identity — unchanged

Authentication stays exactly as it is today: **Supabase Auth**, the same
username/password account system already used for Mercy accounts. The
client already holds a Supabase access token via
`supabase.auth.getSession()`. Every Mercy API call below just needs that
same token in an `Authorization: Bearer <token>` header — no new login, no
new credential collection anywhere on the client.

The server resolves that token to `auth.users.id` server-side via
`supabase.auth.getUser(token)` (identical to `mercy-relay`'s existing
`verifyHostToken`). That UUID is what every response below calls a user id.

## Base URL

```
https://mercy.tryautoscout.com/mercy-api/v1
```

WebSocket:

```
wss://mercy.tryautoscout.com/mercy-api/v1/presence/ws
```

(Path-prefixed on the existing `mercy.tryautoscout.com` host — no new
subdomain, no new certificate, no Cloudflare change beyond nginx already
proxying this path.)

## Error shape (every non-2xx response)

```json
{ "error": "USER_NOT_FOUND", "message": "User not found." }
```

Distinct codes — this is the direct fix for weakness #4 in the original
audit (everything collapsing into "Unable to connect to Mercy services."):

| code | HTTP status | meaning |
|---|---|---|
| `AUTH_ERROR` | 401 | missing/invalid/expired Supabase token |
| `SERVER_ERROR` | 503 | the backend or its auth check is unreachable — **never** confused with AUTH_ERROR or USER_NOT_FOUND |
| `USER_NOT_FOUND` | 404 | the target username genuinely does not exist |
| `SELF_REQUEST` / `SELF_REMOVE` / `SELF_JOIN` | 400 | acting on yourself |
| `ALREADY_FRIENDS` | 409 | |
| `REQUEST_PENDING` | 409 | a pending friend request already exists between the pair |
| `REQUEST_NOT_FOUND` / `REQUEST_NOT_PENDING` | 404 / 409 | friend or join request state conflict |
| `FORBIDDEN` | 403 | not the right party for this action (not the addressee/host/owner) |
| `NOT_FRIENDS` | 403 | join request from a non-friend |
| `SERVER_NOT_FOUND` / `SERVER_OFFLINE` | 404 / 409 | |
| `BAD_REQUEST` | 400 | malformed request |
| `NOT_FOUND` | 404 | no such route |

**Client-side implication**: only `USER_NOT_FOUND` should ever render "User
not found." `AUTH_ERROR`/`SERVER_ERROR`/a network exception must render a
distinct, honest message and trigger the WebSocket reconnect described
below — never overwrite the friends list with an empty result on a
transient failure the way `friendsPresence.ts` does today.

## REST endpoints

All require `Authorization: Bearer <supabase-access-token>` unless noted.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/friends` | — | `{ data: FriendPresenceRow[] }` |
| GET | `/everyone` | — | `{ data: EveryonePlayingRow[] }` |
| POST | `/friends/requests` | `{ username }` | `{ data: { id, requester_id, addressee_id, status, created_at } }` |
| GET | `/friends/requests/incoming` | — | `{ data: IncomingFriendRequest[] }` |
| GET | `/friends/requests/outgoing` | — | `{ data: OutgoingFriendRequest[] }` |
| POST | `/friends/requests/:id/respond` | `{ approve: boolean }` | `{ ok: true }` |
| DELETE | `/friends/:friendId` | — | `{ ok: true }` |
| POST | `/presence/heartbeat` | `{ appearOnline, showCurrentGame, showCurrentServer, activity }` | `{ ok: true }` |
| PUT | `/servers/:id` | `{ mercyGameId, edition?, displayName, isOnline }` | `{ ok: true }` |
| POST | `/joins` | `{ serverId }` | `{ data: { id } }` |
| POST | `/joins/:id/respond` | `{ approve, token?, endpoint? }` | `{ ok: true }` |
| GET | `/joins` | — | `{ data: { incoming: JoinRequestRow[], outgoing: JoinRequestRow[] } }` |
| GET | `/health` | (no auth) | `{ status, uptimeSeconds, db, activeConnections }` |

Row shapes are the same fields the Windows client's existing
`friendsPresence.ts` types already use (`FriendPresenceRow`,
`EveryonePlayingRow`, `IncomingFriendRequest`, `OutgoingFriendRequest`,
`JoinRequestRow`) — a 1:1 drop-in replacement for the current
`supabase.rpc(...)` calls of the same name, field names unchanged (`friendId`
stays `friendId`, not `friend_id`, etc. — this doc's response shapes are the
already-camelCased ones the repo layer returns).

`activity` shape (heartbeat body and presence rows), unchanged from today:
`{ mercyGameId, kind: 'playing'|'hosting', serverId?, serverName?, edition? }`.

**`endpoint` safety (join approval):** `POST /joins/:id/respond`'s `endpoint.address`
is rejected with `BAD_REQUEST` if its host component is `127.0.0.1`/any other
`127.0.0.0/8` address, `0.0.0.0`, `::1`, or `localhost` — those can only ever mean
"the host's own machine" and are never reachable by a remote friend's client. A
private LAN address (`192.168.x.x`, etc., the `lan-direct` strategy) is still
accepted — it's a legitimate candidate for a friend on the same network, with its
own client-surfaced caveat; only the loopback/unspecified case is rejected here.

## WebSocket — replaces the dead Supabase Realtime subscription

This is the actual fix for the ~20-minute failure. Explicit, observable
states end to end instead of an unobserved `.subscribe()`:

1. Connect to `wss://mercy.tryautoscout.com/mercy-api/v1/presence/ws`.
2. Within 5s, send `{"type":"hello","token":"<supabase-access-token>"}`.
3. Server replies either:
   - `{"type":"hello-ack","userId":"<uuid>"}` — subscribed, connection live.
   - `{"type":"hello-rejected","code":"AUTH_ERROR"|"SERVER_ERROR","reason":"..."}` followed by a close (code 1008) — an honest, typed failure, never a silent drop.
4. Server pushes `{"type":"changed","kind":"friends"|"requests"|"joins"|"everyone"|"servers","at":<ms>}` whenever something this user should care about changed. The client should re-fetch the matching REST endpoint (`kind:"friends"` → `GET /friends`, `kind:"requests"` → the incoming/outgoing endpoints, `kind:"joins"` → `GET /joins`) — the push is a "go refetch" signal, not the data itself, so a client that fetched via a slightly-behind REST call never has to trust an unverified payload.
5. Server ping-frames the connection every 20s; if no pong arrives within 45s the server calls `ws.terminate()` — the client's socket then gets a real, observable `close` event (not a hang), which is the client's signal to reconnect immediately with a fresh `hello`.
6. Multiple simultaneous connections for the same user are explicitly supported (e.g. a reconnect racing the old socket's teardown) — never rejected as a duplicate.

**Required client-side reconnect logic** (this is the piece that was
missing before, now that the server side gives it something real to react
to): on `close` or `error`, reconnect with exponential backoff and re-send
`hello`; on `hello-ack`, immediately do one REST refresh of everything
(`/friends`, `/everyone`, `/friends/requests/incoming`, `/joins`) since any
`changed` events missed while disconnected are otherwise lost (this
WebSocket is a push *hint*, not a queued/replayed event log).

## Presence timeout / heartbeat semantics

- A friend/everyone-playing row is "online" only while `appear_online` is
  true **and** the last heartbeat is within `MERCY_API_PRESENCE_STALE_MS`
  (default 90000ms) — computed live on every read, so there's no lag between
  a client going quiet and friends seeing it go offline.
- A background sweep (`MERCY_API_STALE_SWEEP_INTERVAL_MS`, default 30000ms)
  also flips `appear_online` false in storage once a row passes that same
  threshold, and pushes a final `changed:"friends"` to that user's friends —
  so a client that vanished mid-session (crash, force-quit, network death)
  doesn't just silently age out; its friends get one more explicit update.
- Join requests expire the same way: `expires_at` (2 minutes from creation)
  is swept to `status:'expired'` on the same interval.

## Authorization boundaries (server-enforced, not client-trusted)

- A user can only ever read/modify **their own** presence row, friend
  requests addressed to/from them, friendships they're party to, servers
  they own, and join requests where they're the host or requester — every
  query in `api/repo/*.js` is scoped by the token-derived user id, mirroring
  the original Supabase RLS policies as application-level checks (see
  `api/schema.sql`'s header comment).
- `getEveryonePlaying`/`getFriendsPresence` never return the caller's own row.
- `upsertServer` rejects (403 `FORBIDDEN`) overwriting a server id owned by
  someone else.
- `respondToFriendRequest`/`respondToJoinRequest` reject (403 `FORBIDDEN`) a
  responder who isn't the actual addressee/host.

## What this document is not

It is not a Windows-side implementation — no Windows source file has been
read for the purpose of editing it, and none was changed. It's the exact,
already-tested contract the next phase should implement against.
