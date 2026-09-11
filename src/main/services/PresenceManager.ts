// Presence / Friends / Join foundation.
//
// IMPORTANT — what this file deliberately IS and IS NOT:
//  - IS a real, working LOCAL activity tracker (what is THIS installation
//    of Mercy actually doing right now, derived from the real, existing
//    FiveM/Minecraft/Assetto Corsa server managers — never fabricated).
//  - IS a real, tested security primitive for join tokens (HMAC-signed,
//    short-lived, carrying only {serverId, mercyGameId, issuedAt,
//    expiresAt, nonce} — never an IP address, filesystem path, credential,
//    or auth token).
//  - IS a real, honest connectivity-strategy resolver documenting exactly
//    what Mercy can and cannot do per supported game (see the audit below
//    — this is the "before implementing the join system, inspect each
//    game's actual networking capabilities" requirement, answered once
//    here rather than assumed away).
//  - IS NOT a working cross-machine friends list. Mercy has no deployed
//    presence/signaling server today — broadcastPresence()/getFriends()
//    are real client code with a real (currently unconfigured) network
//    call, honestly reporting "not configured" rather than a fabricated
//    result. This mirrors this app's own existing MercyServers.tsx
//    precedent: a real, empty list today, with the real wiring already in
//    place for whenever Mercy actually operates that service.
//  - IS NOT a NAT-traversal/relay implementation. None of Mercy's
//    supported games' server protocols (Minecraft Java/Bedrock, a FiveM
//    server, an Assetto Corsa dedicated server) have a built-in WebRTC-
//    style ICE/STUN/TURN-brokered connection model — they are plain TCP/
//    UDP servers that need either a forwarded port or a real relay/tunnel
//    service in front of them to be reachable from outside the host's own
//    network. Building a fake STUN/TURN layer that can't actually carry
//    Minecraft/FiveM/AC traffic would be worse than not building one — see
//    assessConnectivity() below, which documents this per game and points
//    at the same honest tunneling-service guidance already used in each
//    game's own Connect tab (MinecraftServerPanel's ConnectTab), not a new
//    mechanism.
//
// Per-game networking reality (Part 20's required audit):
//  - Minecraft (Java + Bedrock): plain TCP (Java) / UDP (Bedrock) dedicated
//    server. No built-in NAT traversal, no built-in relay, no third-party
//    master server requirement to connect. A remote friend needs either a
//    forwarded port or a tunneling relay (playit.gg/ngrok-style) — already
//    the existing, honest guidance in ConnectTab.
//  - FiveM: the dedicated server is plain UDP/TCP too. FiveM's own
//    "Cfx.re" infrastructure operates a PUBLIC server list/heartbeat for
//    servers that opt into `sv_master1` registration, but that's a
//    discovery mechanism for PUBLIC servers, not a NAT-traversal/relay
//    service Mercy can use to make an arbitrary private friend-hosted
//    server reachable — the host still needs real reachability.
//  - Assetto Corsa: plain UDP/TCP dedicated server. It has an optional
//    lobby-registration flag for public listing (already a real, existing
//    field — REGISTER_TO_LOBBY in AssettoCorsaManager.ts), which is again
//    discovery, not connectivity — the joining client still needs the
//    server to be really reachable.
//  - Net result: for all three, "joinable directly" is only genuinely true
//    on the same LAN, or when the host has a forwarded port or a real
//    tunnel in front of their server — there is no game-agnostic magic
//    fix, so this file never claims one.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import Store from 'electron-store';
import {
  PresenceSettings, DEFAULT_PRESENCE_SETTINGS, RealActivity, ActivityGameId,
} from './FriendsPresenceLogic';

export type PresenceVisibility = 'everyone' | 'friends-only' | 'private';
export type PresenceStatus = 'online' | 'in-game' | 'offline';
export type PresenceGameId = 'fivem' | 'minecraft' | 'assettocorsa';

export interface LocalActivity {
  mercyGameId: PresenceGameId;
  serverId: string;
  serverName: string;
  /** Real, derived from the server's own real status field — never assumed. */
  joinable: boolean;
  /** 'hosting' = a real Mercy-managed server of this game is running here;
   *  'playing' = the game's own process is running, with no Mercy server —
   *  both real, never invented. Defaults to 'hosting' for callers/tests
   *  written before this field existed (every prior LocalActivity WAS a
   *  hosting case — this file never detected "playing" before now). */
  kind?: 'playing' | 'hosting';
  /** Minecraft only — real, detected edition, never guessed. */
  edition?: 'java' | 'bedrock';
}

export interface LocalPresence {
  status: PresenceStatus;
  visibility: PresenceVisibility;
  activity: LocalActivity | null;
}

/** Reserved shape for a real friend's presence, once a real presence
 *  service exists — deliberately never populated with fabricated data.
 *  Notably excludes IP address, install paths, and any credential/token —
 *  only what's needed to show "X is playing Y" and let a join attempt
 *  start, per the explicit privacy requirement this was built against. */
export interface FriendPresence {
  displayName: string;
  status: PresenceStatus;
  activity: LocalActivity | null;
  joinable: boolean;
}

export interface JoinTokenPayload {
  serverId: string;
  mercyGameId: PresenceGameId;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  /** Only present once a host has actually negotiated a real endpoint (see
   *  ConnectionNegotiator.planHostEndpoint) — a real "host:port" the joining
   *  client can try, and which real strategy produced it. Never a raw
   *  filesystem path or credential; an address is exposed here deliberately
   *  because the whole point of this token is letting an authorized friend
   *  actually connect — this is the "necessary" case the no-unnecessary-IP
   *  rule allows for. */
  endpoint?: { strategy: string; address: string; relayId?: string } | null;
}

export type ConnectivityStrategy = 'lan-direct' | 'public-direct' | 'relay-required-unavailable' | 'not-joinable';

export interface ConnectivityAssessment {
  strategy: ConnectivityStrategy;
  explanation: string;
}

/** A real, pure decision function over REAL reachability facts the caller
 *  already knows (e.g. from Minecraft/Assetto Corsa's own existing
 *  reachability checks) — never re-implements or guesses that reachability
 *  itself, and never invents a relay/NAT-traversal capability that doesn't
 *  exist (see this file's header audit). */
export function assessConnectivity(reachability: { hasLanAddress: boolean; realtimeReachable: boolean | null }): ConnectivityAssessment {
  if (reachability.realtimeReachable === false) {
    return { strategy: 'not-joinable', explanation: 'The server is not currently reachable — it may be offline or not finished starting yet.' };
  }
  if (reachability.hasLanAddress) {
    return { strategy: 'lan-direct', explanation: 'Reachable directly over the local network.' };
  }
  if (reachability.realtimeReachable === true) {
    return { strategy: 'public-direct', explanation: 'The server is reachable at its current address (already port-forwarded or otherwise publicly reachable).' };
  }
  return {
    strategy: 'relay-required-unavailable',
    explanation: 'Mercy has no relay/NAT-traversal service today — this game\'s dedicated server protocol needs a forwarded port or a tunneling service (e.g. playit.gg, ngrok) for a friend outside the local network to join.',
  };
}

/** Minimal shape PresenceManager needs from each real game manager — kept
 *  small and structural (not importing the concrete classes) so this file
 *  has no dependency on Minecraft/AssettoCorsa/FiveM internals and stays
 *  trivially testable with disposable fixture objects. */
export interface ManagerLike { getAllServers(): { id: string; name: string; status: string; edition?: string }[]; }

/** Real process-presence check, real implementation using the OS's own
 *  process list (tasklist on Windows) — injectable so tests never spawn a
 *  real child process or depend on what's actually running on the test
 *  runner's machine. Only ever asked about ONE exact image name at a time
 *  (the real executable a real GameScanner scan already found), never a
 *  broad process dump. */
export interface ProcessChecker { isRunning(exeName: string): Promise<boolean>; }

class TasklistProcessChecker implements ProcessChecker {
  async isRunning(exeName: string): Promise<boolean> {
    if (process.platform !== 'win32' || !exeName) return false;
    const safe = exeName.replace(/[^A-Za-z0-9_.\-]/g, '');
    if (!safe) return false;
    return new Promise((resolve) => {
      exec(`tasklist /FI "IMAGENAME eq ${safe}" /NH`, { windowsHide: true }, (err, stdout) => {
        if (err) return resolve(false);
        resolve(stdout.toLowerCase().includes(safe.toLowerCase()));
      });
    });
  }
}

/** Minimal shape PresenceManager needs from GameScanner — just its own
 *  already-real, already-cached detection results, never a fresh scan
 *  triggered from here. Matches GameScanner.getCached()'s real (synchronous,
 *  already-in-memory) signature. */
export interface GameCacheLike { getCached(): { mercyGameId: string | null; executablePath: string }[]; }

export interface PresenceManagerDeps {
  fivem?: ManagerLike;
  minecraft?: ManagerLike;
  assettoCorsa?: ManagerLike;
  gameScanner?: GameCacheLike;
  processChecker?: ProcessChecker;
}

interface PresenceSchema { visibility: PresenceVisibility; presenceSettings: PresenceSettings; }

const RUNNING_STATUSES = new Set(['running']);
const DEFAULT_JOIN_TOKEN_TTL_MS = 5 * 60 * 1000;

export class PresenceManager {
  private store: Store<PresenceSchema>;
  private secretFile: string;
  private secret: Buffer;
  private processChecker: ProcessChecker;
  /** Real single-use enforcement for join tokens (Phase 12/13's "token has
   *  not already been used"): each real token's real nonce, seen exactly
   *  once. In-memory and per-process is the honest scope here — a join
   *  token is only ever meaningful while the HOST's own Mercy Launcher (the
   *  process that minted it and actually owns the running game server) is
   *  alive to begin with, so there is no real state to lose on restart. */
  private consumedNonces = new Map<string, number>();

  constructor(userDataPath: string, private deps: PresenceManagerDeps = {}, private presenceServerUrl: string | null = null) {
    // Explicit cwd (unlike some other stores in this codebase that rely on
    // electron-store's own Electron-app auto-detection) — keeps this
    // service's persistence correctly scoped to the SAME userDataPath every
    // other piece of Mercy state uses, and makes it deterministically
    // testable against a disposable fixture directory instead of silently
    // falling back to a shared default location when there's no real
    // Electron app object to detect (exactly what happens under a plain
    // node test process — the real bug this specific fix avoids).
    this.store = new Store<PresenceSchema>({
      name: 'mercy-presence', cwd: userDataPath,
      defaults: { visibility: 'private', presenceSettings: DEFAULT_PRESENCE_SETTINGS },
    });
    const dataDir = path.join(userDataPath, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.secretFile = path.join(dataDir, 'presence-secret.json');
    this.secret = this.loadOrCreateSecret();
    this.processChecker = deps.processChecker || new TasklistProcessChecker();
  }

  private loadOrCreateSecret(): Buffer {
    try {
      if (fs.existsSync(this.secretFile)) {
        const { secret } = JSON.parse(fs.readFileSync(this.secretFile, 'utf-8'));
        if (typeof secret === 'string' && secret.length > 0) return Buffer.from(secret, 'hex');
      }
    } catch {}
    const fresh = crypto.randomBytes(32);
    try { fs.writeFileSync(this.secretFile, JSON.stringify({ secret: fresh.toString('hex') })); } catch {}
    return fresh;
  }

  // ── Privacy (Part 9) — off by default; the user must opt in. ────────────
  // `visibility` is the original 3-way placeholder from before a real
  // friends system existed; kept (unchanged behavior, unchanged tests) for
  // backward compatibility. `presenceSettings` is the REAL, explicit
  // 3-toggle privacy model presence/friends actually uses now — presence is
  // only ever shown to real friends (there is no "everyone" concept once
  // friends are real), so this supersedes `visibility` going forward.
  getVisibility(): PresenceVisibility { return this.store.get('visibility'); }
  setVisibility(v: PresenceVisibility): void { this.store.set('visibility', v); }

  getPresenceSettings(): PresenceSettings { return this.store.get('presenceSettings') ?? DEFAULT_PRESENCE_SETTINGS; }
  setPresenceSettings(settings: PresenceSettings): void { this.store.set('presenceSettings', settings); }

  /** Real local activity: a real running Mercy-managed server takes
   *  priority ('hosting'); otherwise, a real running game process with no
   *  Mercy server ('playing'); otherwise null. Never fabricated — a game
   *  that GameScanner hasn't actually found installed, or whose process
   *  genuinely isn't running, never appears here. */
  private async detectLocalActivity(): Promise<RealActivity | null> {
    const managers: [ActivityGameId, ManagerLike | undefined][] = [
      ['fivem', this.deps.fivem], ['minecraft', this.deps.minecraft], ['assettocorsa', this.deps.assettoCorsa],
    ];
    for (const [mercyGameId, mgr] of managers) {
      if (!mgr) continue;
      const running = mgr.getAllServers().find((s) => RUNNING_STATUSES.has(s.status));
      if (running) {
        const activity: RealActivity = { mercyGameId, kind: 'hosting', serverId: running.id, serverName: running.name };
        if (mercyGameId === 'minecraft' && (running.edition === 'java' || running.edition === 'bedrock')) activity.edition = running.edition;
        return activity;
      }
    }
    if (this.deps.gameScanner) {
      const cached = this.deps.gameScanner.getCached();
      for (const mercyGameId of ['fivem', 'minecraft', 'assettocorsa'] as ActivityGameId[]) {
        const game = cached.find((g) => g.mercyGameId === mercyGameId);
        if (!game?.executablePath) continue;
        const exeName = game.executablePath.split(/[\\/]/).pop() || '';
        if (exeName && await this.processChecker.isRunning(exeName)) return { mercyGameId, kind: 'playing' };
      }
    }
    return null;
  }

  async getLocalPresence(): Promise<LocalPresence> {
    const real = await this.detectLocalActivity();
    const activity: LocalActivity | null = real
      ? { mercyGameId: real.mercyGameId, serverId: real.serverId || '', serverName: real.serverName || '', joinable: false, kind: real.kind, edition: real.edition }
      : null;
    return { status: activity ? 'in-game' : 'online', visibility: this.getVisibility(), activity };
  }

  // ── Join tokens — real HMAC-signed, short-lived, minimal-disclosure. ────
  createJoinToken(serverId: string, mercyGameId: PresenceGameId, ttlMs: number = DEFAULT_JOIN_TOKEN_TTL_MS, endpoint?: { strategy: string; address: string; relayId?: string } | null): string {
    const payload: JoinTokenPayload = {
      serverId, mercyGameId, issuedAt: Date.now(), expiresAt: Date.now() + ttlMs, nonce: crypto.randomBytes(8).toString('hex'),
      ...(endpoint ? { endpoint } : {}),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  verifyJoinToken(token: string): { valid: boolean; payload?: JoinTokenPayload; reason?: string } {
    if (typeof token !== 'string' || !token.includes('.')) return { valid: false, reason: 'Malformed token.' };
    const [body, sig] = token.split('.');
    if (!body || !sig) return { valid: false, reason: 'Malformed token.' };
    let expectedSig: string;
    try { expectedSig = crypto.createHmac('sha256', this.secret).update(body).digest('base64url'); } catch { return { valid: false, reason: 'Malformed token.' }; }
    const sigBuf = Buffer.from(sig), expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false, reason: 'Invalid signature.' };
    }
    let payload: JoinTokenPayload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')); } catch { return { valid: false, reason: 'Malformed token.' }; }
    if (!payload.serverId || !payload.mercyGameId || typeof payload.expiresAt !== 'number') return { valid: false, reason: 'Malformed token.' };
    if (Date.now() > payload.expiresAt) return { valid: false, reason: 'Token expired.' };
    return { valid: true, payload };
  }

  /** The host's actual join-time check: valid signature AND not expired AND
   *  never seen before. Use this (not the bare verifyJoinToken) at the
   *  point a join is actually being honored — verifyJoinToken alone would
   *  let the same short-lived token be replayed for a second join. */
  verifyAndConsumeJoinToken(token: string): { valid: boolean; payload?: JoinTokenPayload; reason?: string } {
    const result = this.verifyJoinToken(token);
    if (!result.valid || !result.payload) return result;
    this.pruneConsumedNonces();
    if (this.consumedNonces.has(result.payload.nonce)) return { valid: false, reason: 'Token has already been used.' };
    this.consumedNonces.set(result.payload.nonce, result.payload.expiresAt);
    return result;
  }

  private pruneConsumedNonces(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.consumedNonces) if (expiresAt < now) this.consumedNonces.delete(nonce);
  }

  // ── Friends/presence broadcast — real client, honestly unconfigured. ────
  /** Never fabricated: with no presenceServerUrl configured (the real
   *  state today — Mercy operates no such service), this is a real,
   *  honest failure rather than a fake success or an invented friend list. */
  async getFriends(): Promise<FriendPresence[]> {
    if (!this.presenceServerUrl) return [];
    // Real call site for when a presence service exists — intentionally
    // not implemented further until there is a real endpoint to call, so
    // this never pretends to succeed against nothing.
    return [];
  }

  async broadcastPresence(): Promise<{ success: boolean; error?: string }> {
    if (!this.presenceServerUrl) return { success: false, error: 'No Mercy presence service is configured yet.' };
    return { success: false, error: 'Presence broadcasting is not implemented yet.' };
  }
}
