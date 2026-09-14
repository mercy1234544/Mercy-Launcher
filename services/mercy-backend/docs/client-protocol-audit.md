# Mercy Launcher Client Protocol Audit — STATUS: UNBLOCKED (2026-09-11)

## Source of truth

The full, authoritative audit is at
`reference/client/linux-backend-client-contract.md` (Windows client commit `ff36b34`,
client v1.95.0, 20 sections). This file is a short index into it plus the resulting
architecture decisions — read the full contract before touching `signaling/` or `relay/`.

## Key facts that shaped the implementation

1. **One WebSocket surface.** `relay-data` frames ride the same connection as
   `hello`/`register-host`/`request-relay` (contract §1–§3) — there is no separate
   signaling vs. relay transport to build. See `docs/backend-architecture.md` §1.
2. **The relay/signaling code exists on the client but has zero live call sites**
   (contract §0) — `RelaySignalingClient`, `TunnelProxy`, and the full `protocol.ts`
   message set are real and unit-tested, but nothing in the running Windows app
   instantiates them yet. The Linux backend implements the server side of a protocol
   the client currently only *defines*, not yet *uses*.
3. **Join tokens are HMAC-signed with a secret that never leaves the host machine**
   (contract §5, §20.2) — the relay cannot verify the signature itself. Resolved via
   exact-string lookup against `join_requests.token` in Supabase instead (§4 in
   `backend-architecture.md`).
4. **Hosts have no join-token before hosting starts** — resolved by authenticating
   `role:'host'` hellos with the host's own Supabase Auth JWT (§3 in
   `backend-architecture.md`).
5. **TCP only.** `protocol.ts` declares a `udp` transport option but nothing in the
   client implements it (contract §13). The relay forwards opaque frames regardless,
   so no relay-side change is needed if/when a UDP `DataChannel` is added client-side.
6. **The exact Supabase schema** (`profiles`, `friend_requests`, `friendships`,
   `presence`, `servers`, `join_requests`) is documented in contract §18 — used as-is,
   no new tables. The relay only ever queries `servers` (ownership check) and
   `join_requests` (token/authorization check) with the service-role key.

## Where each requirement from Step 3's checklist is answered

| # | Question | Contract section |
|---|---|---|
| 1–3 | Messages sent/expected, identifiers | §1–§3, §15 |
| 4–6 | Auth, join-token format, expiration | §4–§6 |
| 7 | Relay negotiation flow (as designed) | §7 |
| 8–9 | Direct/relay candidate format | §10–§11 |
| 10 | TCP/UDP requirements | §13 |
| 11–13 | Host registration / join request / host approval (as actually run today) | §8–§9 |
| 14 | Relay selection | §14 (env var, currently disconnected client-side) |
| 15–16 | Relay session auth / termination | §4, §17 |
| 17 | What must never be sent through the backend | §4B (the per-install HMAC secret never leaves the host) |
