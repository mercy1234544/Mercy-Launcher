# Linux Host Port & Service Audit — harperlinux

Captured 2026-09-11, before any Mercy Launcher Linux infrastructure was deployed.
Purpose: pick dedicated Mercy signaling/relay ports that do not collide with anything
already running on this host, per task Step 11.

## Ports currently bound (from `ss -tulpn`)

| Port | Proto | Owner | Notes |
|------|-------|-------|-------|
| 22 | tcp | sshd | |
| 53 | tcp/udp | systemd-resolved | local resolver only |
| 80 | tcp | nginx | HTTP, vhosts below |
| 443 | tcp | nginx | HTTPS, vhosts below |
| 3000 | tcp | next-server | autoscout-frontend (pm2) |
| 3306 | tcp | mysql/mariadb | |
| 4000 | tcp | PM2 God daemon | PM2 internal RPC, not a project port |
| 4001 | tcp | node (pm2 id 5) | vehicle-studio-auth |
| 5432 | tcp | postgres | local |
| 6379 | tcp | redis | local |
| 8081, 9600 (tcp+udp) | tcp/udp | acServer (pid 1111) | Assetto Corsa server |
| 8100, 25565 | tcp | java (pid 2313) | Minecraft (SMP) server, incl. Bedrock 19132/udp, voice 24454/udp |
| 8787 | tcp | node (pid 1377) | ac-dashboard (pm2) |
| 20241 | tcp | cloudflared | local metrics/control, loopback only |
| 33714, 36249, 38900, 48678 (udp) | udp | cloudflared | ephemeral QUIC/tunnel ports |
| 41641 | udp | (tailscale-style) | present on both v4/v6, not part of this project |

## PM2 processes

`ac-dashboard`, `autoscout-api` (x2, cluster), `autoscout-frontend`, `autoscout-tunnel`,
`autoscout-worker`, `vehicle-studio-auth`. No `mercy-*` processes exist yet.

## nginx sites-enabled

`autoscout`, `vehicle-studio-auth`. No Mercy vhost exists yet. Nothing will be modified
here until the signaling/relay services exist and need a public hostname — and then only
an isolated new server block, per Step 11 ("smallest isolated configuration possible,
do not modify unrelated domains").

## systemd

No `mercy*`, and no `fivem`/`minecraft`/`vehicle`/`autoscout` systemd units exist —
everything above is managed by pm2 or ad-hoc processes. Consistent with prior memory
notes (no systemd units on this host for the app-level services).

## Proposed dedicated Mercy ports

Not yet finalized — depends on what `RelaySignalingClient.ts` / `TunnelProxy.ts`
actually expect (single combined port vs. separate signaling/relay ports, WS vs TCP
relay transport). Candidates that avoid every port above:

- `mercy-signaling`: **4100** (tcp, WebSocket)
- `mercy-relay`: **4200** (tcp, relay data plane) — exact transport TBD from protocol audit

These are placeholders for planning only; they will be confirmed/adjusted once the
client protocol audit (Step 3) is done and are not yet wired into nginx, firewall, or
any running service.
