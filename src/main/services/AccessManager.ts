// Exclusive-access verification via Discord OAuth (PKCE, no client secret).
//
// Flow: user clicks "Verify with Discord" → system browser opens Discord's
// authorize page → Discord redirects to a temporary localhost callback → we
// exchange the code for a user token → check membership of the configured
// guild (and optionally a role) → access granted/denied. Result is cached in
// userData/data/access.json and re-checked every 10 minutes.
//
// The "admin panel" is Discord itself: with DISCORD_ACCESS_ROLE_ID set, staff
// grant access by assigning that role to a member (right-click → Roles). With
// it empty, ANY member of the server gets access automatically.

import { shell } from 'electron';
import path from 'path';
import fs from 'fs';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';

// ═══════════════════ OWNER SETUP ═══════════════════
// 1) discord.com/developers/applications → New Application
// 2) OAuth2 → Redirects → add exactly:  http://127.0.0.1:53682/callback
// 3) OAuth2 → toggle "Public Client" ON → copy the Client ID below
// 4) Discord (Settings → Advanced → Developer Mode ON) → right-click your
//    server icon → Copy Server ID → paste below
// 5) OPTIONAL: to gate by role instead of plain membership, create a role
//    (e.g. "Exclusive"), right-click it → Copy Role ID → paste below.
export const DISCORD_CLIENT_ID = 'PASTE_YOUR_CLIENT_ID_HERE';
export const DISCORD_GUILD_ID = 'PASTE_YOUR_SERVER_ID_HERE';
export const DISCORD_ACCESS_ROLE_ID = ''; // empty = every server member has access

const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const OAUTH_SCOPES = 'identify guilds.members.read';
const RECHECK_MS = 10 * 60 * 1000; // membership re-check interval
/** Real inactivity policy (Part 7): a session found less than this old is
 *  restored automatically; five hours or more genuinely idle requires
 *  authenticating again. This is deliberately separate from, and never
 *  weakens, Discord's own real token expiry — a token that's genuinely
 *  expired/revoked before five hours still requires re-auth on its own. */
export const SESSION_INACTIVITY_LIMIT_MS = 5 * 60 * 60 * 1000;

export interface AccessStatus {
  configured: boolean;   // owner has pasted the IDs
  loggedIn: boolean;
  inGuild: boolean;
  hasAccess: boolean;
  username?: string;
  discordId?: string;
  reason?: string;       // human-readable explanation when not granted
}

interface StoredAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  user?: { id: string; username: string };
  lastCheck?: number;
  lastResult?: { inGuild: boolean; hasAccess: boolean };
  /** Updated on every successful login/status confirmation while Mercy
   *  Launcher is actually running — the real "was this session genuinely
   *  active recently" timestamp the 5-hour policy is measured against.
   *  Never reset merely because the app closed (see this file's header on
   *  where session state lives and why closing must not clear it). */
  lastActiveAt: number;
}

const CLOSE_PAGE = `<!doctype html><html><body style="margin:0;background:#0b0e14;color:#dbe2ee;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><div style="font-size:42px">✅</div><h2 style="margin:8px 0 4px">Verified with Discord</h2><p style="color:#8b94a7;margin:0">You can close this tab and return to Mercy Launcher.</p></div></body></html>`;

export class AccessManager {
  private file: string;
  private loginInFlight = false;
  /** Single-flight guard for token refresh — the actual fix for the real
   *  "reopen the app and get logged out" bug this file used to have: two
   *  concurrent status() calls (e.g. two components each checking auth on
   *  mount) both seeing a near-expiry token would previously each POST
   *  their own refresh_token exchange. Discord rotates refresh tokens on
   *  use, so whichever call lost the race would refresh with an
   *  already-invalidated token, fail, and call save(null) — wiping out the
   *  session the WINNING call had just successfully saved a moment earlier.
   *  Concurrent callers now share one real in-flight refresh instead. */
  private refreshInFlight: Promise<StoredAuth | null> | null = null;

  private clientId: string;
  private guildId: string;
  private accessRoleId: string;

  /** apiBase/clientId/guildId/accessRoleId are injectable ONLY for
   *  deterministic tests to point at a real local fake Discord API with
   *  real fake IDs — production always uses the real https://discord.com
   *  and the real owner-configured IDs above, and never talks to anything
   *  else. */
  constructor(
    userDataPath: string,
    private apiBase: string = 'https://discord.com',
    overrides: { clientId?: string; guildId?: string; accessRoleId?: string } = {},
  ) {
    const dataDir = path.join(userDataPath, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'access.json');
    this.clientId = overrides.clientId ?? DISCORD_CLIENT_ID;
    this.guildId = overrides.guildId ?? DISCORD_GUILD_ID;
    this.accessRoleId = overrides.accessRoleId ?? DISCORD_ACCESS_ROLE_ID;
  }

  /** Corrupted/unreadable storage fails safely to "logged out", never
   *  throws and never crashes the app — matches this file's own existing
   *  honest-failure convention everywhere else. */
  private load(): StoredAuth | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || typeof parsed.accessToken !== 'string' || typeof parsed.expiresAt !== 'number') return null;
      return parsed;
    } catch { return null; }
  }
  private save(a: StoredAuth | null) {
    try {
      if (!a) { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); }
      else fs.writeFileSync(this.file, JSON.stringify(a, null, 2), 'utf-8');
    } catch {}
  }

  isConfigured(): boolean {
    return !this.clientId.startsWith('PASTE') && !this.guildId.startsWith('PASTE');
  }

  private notConfigured(): AccessStatus {
    return {
      configured: false, loggedIn: false, inGuild: false, hasAccess: false,
      reason: 'Discord verification is not set up yet — the store owner needs to finish setup.',
    };
  }

  /** Full OAuth login: browser consent → token → membership check. */
  async login(): Promise<AccessStatus> {
    if (!this.isConfigured()) return this.notConfigured();
    if (this.loginInFlight) return { ...(await this.status()), reason: 'A login window is already open — finish it in your browser.' };
    this.loginInFlight = true;
    try {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const state = crypto.randomBytes(16).toString('hex');

      const code = await new Promise<string>((resolve, reject) => {
        const server = http.createServer((req, res) => {
          try {
            const u = new URL(req.url || '/', REDIRECT_URI);
            if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(CLOSE_PAGE);
            const c = u.searchParams.get('code');
            const st = u.searchParams.get('state');
            setTimeout(() => { try { server.close(); } catch {} }, 100);
            if (!c || st !== state) reject(new Error(u.searchParams.get('error_description') || 'Login was cancelled'));
            else resolve(c);
          } catch (e: any) { reject(e); }
        });
        server.on('error', () => reject(new Error(`Port ${REDIRECT_PORT} is busy — close other apps and try again`)));
        server.listen(REDIRECT_PORT, '127.0.0.1', () => {
          const url =
            // Always the real discord.com — this opens in the user's real
            // system browser for the interactive consent screen, never
            // redirected to a test double even when apiBase is overridden
            // for the token/API calls below.
            `https://discord.com/oauth2/authorize?client_id=${this.clientId}` +
            `&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
            `&scope=${encodeURIComponent(OAUTH_SCOPES)}&state=${state}` +
            `&code_challenge=${challenge}&code_challenge_method=S256`;
          shell.openExternal(url);
        });
        // Give the user 3 minutes to finish in the browser.
        setTimeout(() => { try { server.close(); } catch {}; reject(new Error('Login timed out — try again')); }, 180000);
      });

      // Exchange code → token (PKCE public client: no secret required)
      const body = new URLSearchParams({
        client_id: this.clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      const tok = await axios.post(`${this.apiBase}/api/oauth2/token`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000,
      });

      const auth: StoredAuth = {
        accessToken: tok.data.access_token,
        refreshToken: tok.data.refresh_token,
        expiresAt: Date.now() + (tok.data.expires_in ?? 604800) * 1000,
        lastActiveAt: Date.now(),
      };

      const me = await axios.get(`${this.apiBase}/api/users/@me`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` }, timeout: 15000,
      });
      auth.user = { id: me.data.id, username: me.data.global_name || me.data.username };
      // A fresh login always persists the NEW account's session — if a
      // different account was previously stored, this fully replaces it
      // (never merges), matching Part 8's "restore the CURRENTLY
      // authenticated account, not the previous one" requirement.
      this.save(auth);

      return this.status(true);
    } catch (e: any) {
      const msg = e?.response?.data?.error_description || e?.message || 'Login failed';
      return { configured: true, loggedIn: false, inGuild: false, hasAccess: false, reason: msg };
    } finally {
      this.loginInFlight = false;
    }
  }

  /** The actual network refresh — factored out so concurrent callers can
   *  share one in-flight call (see refreshInFlight's own comment on the
   *  real bug this fixes). Returns the updated, already-saved StoredAuth on
   *  success, or null on any real failure (network, revoked/invalid
   *  refresh token, etc.) — never throws. */
  private async doRefresh(current: StoredAuth): Promise<StoredAuth | null> {
    if (!current.refreshToken) return null;
    try {
      const body = new URLSearchParams({
        client_id: this.clientId, grant_type: 'refresh_token', refresh_token: current.refreshToken,
      });
      const tok = await axios.post(`${this.apiBase}/api/oauth2/token`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000,
      });
      const updated: StoredAuth = {
        ...current,
        accessToken: tok.data.access_token,
        refreshToken: tok.data.refresh_token ?? current.refreshToken,
        expiresAt: Date.now() + (tok.data.expires_in ?? 604800) * 1000,
        lastActiveAt: Date.now(),
      };
      this.save(updated);
      return updated;
    } catch {
      return null;
    }
  }

  private refreshTokenSingleFlight(current: StoredAuth): Promise<StoredAuth | null> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefresh(current).finally(() => { this.refreshInFlight = null; });
    }
    return this.refreshInFlight;
  }

  /** Cached status; re-checks membership with Discord when stale or forced.
   *  Implements the real 5-hour inactivity policy (Part 7): a session found
   *  less than 5 hours since its last confirmed activity is restored
   *  automatically; one found genuinely idle 5+ hours requires
   *  authenticating again — checked BEFORE touching the token at all, so a
   *  merely-idle-but-still-valid token is never even given the chance to
   *  fail differently. A real, server-side expiry/revocation (the refresh
   *  call itself failing) still requires re-auth regardless of the
   *  inactivity clock — this policy only ever adds a stricter local rule,
   *  never a looser one than Discord's own. */
  async status(force = false): Promise<AccessStatus> {
    if (!this.isConfigured()) return this.notConfigured();
    let a = this.load();
    if (!a) return { configured: true, loggedIn: false, inGuild: false, hasAccess: false };

    const inactiveMs = Date.now() - (a.lastActiveAt ?? 0);
    if (inactiveMs >= SESSION_INACTIVITY_LIMIT_MS) {
      this.save(null);
      return { configured: true, loggedIn: false, inGuild: false, hasAccess: false, reason: 'Your session expired after 5 hours of inactivity — verify again.' };
    }

    // Refresh the token if it's about to expire — single-flighted so two
    // concurrent status() calls never race each other's refresh attempt.
    if (Date.now() > a.expiresAt - 60_000) {
      const refreshed = await this.refreshTokenSingleFlight(a);
      if (!refreshed) { this.save(null); return { configured: true, loggedIn: false, inGuild: false, hasAccess: false, reason: 'Session expired — verify again' }; }
      a = refreshed;
    }

    // Serve the cached membership result when fresh.
    if (!force && a.lastCheck && a.lastResult && Date.now() - a.lastCheck < RECHECK_MS) {
      a.lastActiveAt = Date.now();
      this.save(a);
      return {
        configured: true, loggedIn: true,
        inGuild: a.lastResult.inGuild, hasAccess: a.lastResult.hasAccess,
        username: a.user?.username, discordId: a.user?.id,
        reason: a.lastResult.hasAccess ? undefined : this.denyReason(a.lastResult.inGuild),
      };
    }

    // Live membership (+ optional role) check.
    try {
      const m = await axios.get(`${this.apiBase}/api/users/@me/guilds/${this.guildId}/member`, {
        headers: { Authorization: `Bearer ${a.accessToken}` }, timeout: 15000,
      });
      const roles: string[] = m.data.roles || [];
      const hasAccess = this.accessRoleId ? roles.includes(this.accessRoleId) : true;
      a.lastCheck = Date.now(); a.lastResult = { inGuild: true, hasAccess }; a.lastActiveAt = Date.now();
      this.save(a);
      return {
        configured: true, loggedIn: true, inGuild: true, hasAccess,
        username: a.user?.username, discordId: a.user?.id,
        reason: hasAccess ? undefined : this.denyReason(true),
      };
    } catch (e: any) {
      const notMember = e?.response?.status === 404;
      if (notMember) {
        a.lastCheck = Date.now(); a.lastResult = { inGuild: false, hasAccess: false }; a.lastActiveAt = Date.now();
        this.save(a);
        return {
          configured: true, loggedIn: true, inGuild: false, hasAccess: false,
          username: a.user?.username, discordId: a.user?.id,
          reason: this.denyReason(false),
        };
      }
      // Network/API hiccup: fall back to the last known result rather than
      // lock out — and still count this as real activity, since the user
      // IS actively using the app right now, just offline/Discord is down.
      a.lastActiveAt = Date.now();
      this.save(a);
      return {
        configured: true, loggedIn: true,
        inGuild: a.lastResult?.inGuild ?? false,
        hasAccess: a.lastResult?.hasAccess ?? false,
        username: a.user?.username, discordId: a.user?.id,
        reason: 'Could not reach Discord — using last known status',
      };
    }
  }

  private denyReason(inGuild: boolean): string {
    if (!inGuild) return 'You are not in the Discord server yet — join it, then verify again.';
    return 'You are in the server but staff have not granted you the access role yet — open a ticket to request it.';
  }

  logout() { this.save(null); }
}
