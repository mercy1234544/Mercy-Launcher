# Mercy Assetto Corsa Server Catalog — integration contract (v1.0.0)

**Audience:** the Claude session on the Linux host that runs the Assetto Corsa servers. **Status:** PROPOSED by the Windows side; the Windows client in this repo already enforces everything below. Nothing in this file is verified against the live servers — the example at the end is **EXAMPLE ONLY**.

## 0. What we are building
Linux publishes one authoritative, **signed, read-only catalog** describing every server and every piece of content a player needs. Mercy's Launcher fetches it at startup, when the Assetto Corsa section opens, and periodically; detects changes; updates server cards and requirements itself; and installs only verified, authorized content. Nobody edits the Windows app to add a car, track or layout.

Hard rules: the catalog carries **no secrets and no admin controls**; it is **never served from the dashboard (port 8787 — unauthenticated admin)**; the launcher trusts a **signing key pinned on the Windows side**, not anything the catalog says about itself.

## 1. Publishing model (recommended: static files)
Serve a directory over **HTTPS** with any static web server (nginx/Caddy). No application code, no write routes, no auth needed:

| Method | Route (relative to `{base}`, e.g. `https://<your-host>/ac/v1`) | Purpose |
|---|---|---|
| GET | `/catalog.json` | the catalog (UTF-8 JSON, ≤ 2 MiB). Must send `ETag` (any static server does) and `Cache-Control: no-cache` |
| GET | `/catalog.json.sig` | detached signature (JSON, §5) over the **exact bytes** of `/catalog.json` |
| GET | `/health.json` | optional publish-health file (§9) |
| GET | `archives[].url` | content archives; may live anywhere allowed by §6 |

`{base}` is configured on the Windows side (Setup & Diagnostics → Server catalog). Do not invent it; the owner supplies it. Only `GET`/`HEAD`. Support HTTP `Range` on archives.

## 2. Catalog document
Top level (all keys required unless marked optional):
```
schema: "mercy.ac.catalog"            schemaVersion: "1.0.0"   (major must be 1; higher minor/patch accepted, unknown keys ignored with a warning)
catalog: { id, revision, generatedAt, expiresAt?, environment }
notice?: string                        (human note; shown to players)
example?: true                         (only in example files — the client REJECTS any catalog with example:true)
servers: [Server]   content: { cars: [Car], tracks: [Track] }   archives: [Archive]
```
- `catalog.id` — stable id, `[a-z0-9._-]{1,64}`. `revision` — **integer that strictly increases whenever the content changes** (never reset; never bump when nothing changed — keep `generatedAt` unchanged too so the bytes/ETag stay identical). `generatedAt`/`expiresAt` — ISO-8601 UTC. `environment` — `"production"` or `"development"` (§8).

**Server**
```
id (safe id) displayName description? engine:{type:"kunos-stock"|"assettoserver"|"other", version?}
maxPlayers? ai?:{enabled,trafficCars} passwordRequired?
connection: { public: {host, gamePort, httpPort} | null,  ports?: {gamePort, httpPort}  ← used when public is null,  lan?: {host, gamePort, httpPort}  ← lan ONLY in development catalogs }
tracks: [{ trackId, layouts:[config…], required? (default true) }]      layout "" = the track's single default layout
cars:   [{ carId, role:"player"|"traffic", required? (default true), skins?:[pinned skin folder names] }]
requirements: { csp: { required, minimumVersion, testedVersion? } | null }
hud?: { delivery:"none"|"server-csp-online-script", version }   companionApps?: ["srp_board"]  ← closed list; unknown ids are ignored
status?: "active"|"maintenance"|"retired"
```
`connection.public` is `null` until a public endpoint truly exists — never a placeholder, guess or private address. While it is `null`, publish `connection.ports` so a player who is given a host (a LAN test, or an address from you) still gets the right ports; it carries no host and is safe in production.

**Car** (`content.cars[]`): `id` (the `content/cars/<id>` folder name), `name`, `version` (value of `ui_car.json "version"`, or null), `origin`, `identity: { dataAcdSha256|null, uiCarJsonSha256|null }`.
**Track** (`content.tracks[]`): `id`, `name`, `version`, `origin`, `verify: { markerFile, markerSha256 } | null` (a small file in the track folder that identifies the build), `layouts: [{ config, name?, uiTrackJsonSha256|null }]`.

**origin** (how a player legitimately obtains it):
- `{ "kind":"archive", "archiveId", "path"? }` — inside one of `archives[]` (`path` = folder inside the archive, default `content/{cars|tracks}/<id>`).
- `{ "kind":"base-game" }` — ships with Assetto Corsa; the launcher only detects it, never installs it.
- `{ "kind":"dlc", "name" }` — paid DLC; detected locally only, never distributed.
- `{ "kind":"manual", "homepage"?, "instructions" }` — the player must obtain it themselves (e.g. a track with no official direct link).

**Archive** (`archives[]`): `id`, `name`, `fileName`, `format:"7z"|"zip"`, `bytes` (exact), `sha256` (64 lowercase hex of the file), `url` (https) or `null`, `allowedHosts:[host…]`, `provider:{name,homepage}`, `redistribution:"provider-official"|"owner-authorized"|"none"`.

## 3. How to compute the values (generate them — do not hand-maintain)
- Car identity: SHA-256 of `content/cars/<id>/data.acd` and of `content/cars/<id>/ui/ui_car.json` (raw bytes). Track marker: SHA-256 of the marker file. Layout: SHA-256 of `ui/<config>/ui_track.json` (`ui/ui_track.json` when `config` is `""`). Archive: SHA-256 and byte size of the archive file.
- Read the server's real configuration (`server_cfg.ini`, `entry_list.ini`, content folders) so the catalog cannot drift from what runs. **Refuse to publish** if a referenced car/track is missing, a hash cannot be computed, or the document fails the JSON Schema (`docs/ac-catalog.schema.json`).
- Use deterministic output (sorted keys, stable ordering, `\n` line ends) and bump `revision`/`generatedAt` **only if the content-bearing bytes changed**.

## 4. Change visibility
Players see a change when `catalog.json` bytes change. The client sends `If-None-Match`; unchanged → `304`. Publish atomically: write both files into a new directory and swap a symlink (or rename) so `catalog.json` and `catalog.json.sig` never mismatch. (If a client sees a mismatch it retries once, then reports an inconsistent publish.)

## 5. Signing (required for production)
Ed25519, detached, over the **raw bytes of `catalog.json`**.
```
openssl genpkey -algorithm ed25519 -out catalog-signing.key     # private: chmod 600, NOT in any web root, never copied to Windows
openssl pkey -in catalog-signing.key -pubout -out catalog-signing.pub   # give this PUBLIC key to the owner → pasted in the launcher
openssl pkeyutl -sign -rawin -inkey catalog-signing.key -in catalog.json -out catalog.sig.bin
```
`catalog.json.sig`:
```json
{ "alg": "ed25519", "keyId": "mercy-ac-2026-10", "signedAt": "<ISO-8601 UTC>", "catalogSha256": "<hex sha256 of catalog.json>", "signature": "<base64 of catalog.sig.bin>" }
```
The launcher pins one or more `{keyId, publicKey}` (PEM or base64 raw 32 bytes). For key rotation, publish with the new `keyId` after the owner has added the new public key. **No pinned key ⇒ the catalog is rejected** (except local-network development catalogs, §8).

## 6. Download rules
- `https` only (production). The URL host **and every redirect host** must be in `allowedHosts`.
- `url` is used for automatic download **only if** `redistribution` is `provider-official` (the content owner publishes it for download) or `owner-authorized` (we have permission to host it). `none`, or `url: null` ⇒ manual: the launcher shows instructions and never fetches.
- `Content-Length` must equal `bytes`; the SHA-256 must match before anything is installed; `bytes` ≤ 16 GiB. Never publish Steam game files or paid DLC (use `base-game`/`dlc` origins).
- Archives are untrusted: the client blocks path traversal and links, installs only into `content\cars`, `content\tracks`, and never runs anything downloaded. **Do not put executables/scripts in archives.** Custom CSP/Lua apps are not installable from a catalog; only the built-in `srp_board` is.

## 7. Required vs optional
`servers[].cars[].required:false` and `servers[].tracks[].required:false` ⇒ missing content is shown as a warning and still offered for install, but never blocks joining. `requirements.csp.required` marks CSP mandatory; the launcher **never installs or updates CSP** — it detects and explains. A server in `maintenance` shows a notice; `retired` is hidden.

## 8. LAN development vs public production
- **Production** (`environment:"production"`): MUST NOT contain any private/loopback/link-local address, `localhost` or `.local` name **in any string** — the client rejects the whole catalog. `connection.lan` is forbidden.
- **Development** (`environment:"development"`): may carry `connection.lan` for local testing; the client accepts it **only when fetched from a private/loopback URL**, labels it DEVELOPMENT, disables automatic installation, and never writes the LAN address to logs or diagnostics.
- A production catalog fetched from a private URL is fine (testing the real catalog on the LAN); a development catalog fetched from the internet is rejected.

## 9. Health and diagnostics
`/health.json` (optional, regenerated at publish): `{ "ok": true, "service":"mercy-ac-catalog", "schemaVersion":"1.0.0", "revision": 12, "generatedAt":"…", "catalogSha256":"…" }`. It proves **only that the catalog was published** — not that a game server is up or joinable. Live player counts, if wanted, come from each game server's own read-only `/INFO` page on its HTTP port (already used by the launcher). Never expose the dashboard, logs, or filesystem listings.

## 10. Client policy (what you can rely on)
| Situation | Client behaviour |
|---|---|
| Malformed JSON / schema violation / unsafe path / oversize / unknown major version | **Rejected**; last good catalog kept; reason shown |
| Bad or missing signature (key pinned) / unknown `keyId` | **Rejected** |
| `revision` lower than last accepted, or `catalog.id` changed | **Rejected** (rollback/replay) |
| Same `revision`, different bytes | **Rejected** (conflicting publish) |
| `expiresAt` in the past | **Rejected**; a cached catalog that expires is shown read-only, installs disabled |
| Server unreachable / 5xx / timeout | Last good catalog stays in use, "last synced …" shown, retries with backoff (1 → 30 min) |
| New/removed/updated content | UI refreshes; installed content is **never deleted** because it left the catalog |
Auto-install (opt-in on the Windows side, per server the player marks "keep ready") additionally requires: signed **production** catalog (never `development`), not expired, an `https` source whose host is in `allowedHosts` with `redistribution` ≠ `none` and a known `bytes`/`sha256`, size under the player's limit, game not running, and a non-destructive change (replacing existing content needs a second opt-in and always keeps a backup). It never installs CSP, never moves a player's files aside, and never runs anything it downloaded.

### What the client does that you may rely on
- Fetches at launcher start, when the Assetto Corsa section opens (≥ 60 s apart), every 15 min by default (player-adjustable 5–120 min), and on the Refresh button. Failures back off 1 → 30 min with jitter. At most one request pair is in flight.
- Sends `If-None-Match` with the last `ETag`; on `304` nothing else happens. Reads at most 2 MiB of `catalog.json`, 4 KiB of the signature, follows ≤ 3 redirects **on the same host only**, and never sends cookies or credentials.
- Re-verifies the signature of its cached copy on every start (a tampered cache is discarded).
- Judges a catalog fetched from a new `{base}` on its own (rollback/identity history is per address).

## 11. EXAMPLE ONLY (not verified against live configs)
```json
{
  "schema": "mercy.ac.catalog", "schemaVersion": "1.0.0", "example": true,
  "catalog": { "id": "example", "revision": 1, "generatedAt": "2026-01-01T00:00:00Z", "environment": "production" },
  "servers": [{
    "id": "example-server", "displayName": "Example Server", "engine": { "type": "assettoserver" },
    "connection": { "public": null },
    "tracks": [{ "trackId": "example_track", "layouts": ["main"] }],
    "cars": [{ "carId": "example_car", "role": "player" }, { "carId": "bmw_m3_e92", "role": "player" }],
    "requirements": { "csp": { "required": true, "minimumVersion": "0.1.76" } }
  }],
  "content": {
    "cars": [
      { "id": "example_car", "name": "Example Car", "version": "1.0", "origin": { "kind": "archive", "archiveId": "example-pack" }, "identity": { "dataAcdSha256": "<64 hex>", "uiCarJsonSha256": null } },
      { "id": "bmw_m3_e92", "name": "BMW M3 E92", "version": null, "origin": { "kind": "base-game" }, "identity": { "dataAcdSha256": null, "uiCarJsonSha256": null } }
    ],
    "tracks": [{ "id": "example_track", "name": "Example Track", "version": "1.0", "origin": { "kind": "manual", "homepage": "https://example.invalid", "instructions": "Download it from the author." }, "verify": null, "layouts": [{ "config": "main" }] }]
  },
  "archives": [{ "id": "example-pack", "name": "Example Pack", "fileName": "example.7z", "format": "7z", "bytes": 1000, "sha256": "<64 hex>", "url": null, "allowedHosts": [], "provider": { "name": "Example", "homepage": "https://example.invalid" }, "redistribution": "none" }]
}
```
A fuller example derived from the owner's handoff package (still **unverified** against the live configs, no URLs, no endpoints) is in `docs/examples/ac-catalog.example.json`; its JSON Schema is `docs/ac-catalog.schema.json` (structure only — the cross-reference and security rules above are enforced by the client and must be enforced by your generator too).

## 12. Checklist for Linux Claude
1. Build a **generator** (reads live configs + content dirs → catalog.json), a **signer**, and an **atomic publisher** serving static files over HTTPS — outside the dashboard and without any write route.
2. Validate against `docs/ac-catalog.schema.json` before publishing; fail closed.
3. Keep the signing key private; hand the **public** key + chosen `{base}` URL to the owner.
4. Set `connection.public` only to a real, configured public host/ports; otherwise `null`.
5. Decide per archive: official download (`provider-official`), your own authorized hosting (`owner-authorized`), or manual (`none`). Never host what you may not redistribute.
6. Report back: the `{base}` URL, the key id + public key, the first revision number, and any field you could not fill truthfully.
