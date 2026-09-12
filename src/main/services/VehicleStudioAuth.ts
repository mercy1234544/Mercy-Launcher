// Desktop-side client for the app auth backend (shared by the whole app).
//
// IMPORTANT: this file contains NO Discord secrets. It only talks to the backend
// API over HTTPS. The session token lives in the MAIN process (userData), never
// in the renderer — so changing localStorage / React state / dev-console values
// cannot unlock the app. Authorization is decided by the backend's /session
// check, not by the client. The main-process IPC guard (main.ts) also calls
// ensureAuthorized() before running protected operations, so a bypassed renderer
// still cannot invoke protected functionality.
import { shell } from 'electron';
import fs from 'fs';
import path from 'path';

// Production backend. VST_AUTH_BACKEND_URL is an optional dev override.
const AUTH_BACKEND_URL = (process.env.VST_AUTH_BACKEND_URL || 'https://auth.tryautoscout.com').replace(/\/$/, '');

// Offline grace: if the backend is briefly unreachable, a recently-validated
// session keeps working for this long (revocation still applies once online).
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
// The main-process guard caches the last authorization decision this long to
// avoid a network round-trip on every protected IPC call.
const GUARD_CACHE_MS = 60 * 1000;
// Real inactivity policy: a session last confirmed less than this long ago
// is restored automatically; one idle 6+ hours requires signing in again.
// This is a LOCAL, additional rule — it never overrides or weakens a real
// server-side revocation/expiry, which still applies regardless (see
// status()'s own 401 handling below).
export const SESSION_INACTIVITY_LIMIT_MS = 6 * 60 * 60 * 1000;

interface Saved { token?: string; refreshToken?: string; username?: string; lastAuthorizedAt?: number; }
export interface VSAuthStatus { enabled: boolean; authorized: boolean; username?: string; reason?: string; stale?: boolean; expiresAt?: number; entitlements?: string[]; }

export class VehicleStudioAuth {
  private file: string;
  // Last authorization decision, cached for the main-process IPC guard.
  private guardCache: { authorized: boolean; at: number } | null = null;
  /** Single-flight guard for the real fix below: without this, two
   *  concurrent status() calls (the Sidebar's account widget mounting at
   *  the same time as another component's own auth check, say) both seeing
   *  a 401 would each independently try to redeem the SAME refresh token.
   *  If the backend rotates/invalidates it on use (a normal, expected
   *  refresh-token behavior), the losing call's attempt fails and could
   *  wipe the session the winning call just successfully restored. */
  private refreshInFlight: Promise<Saved | null> | null = null;

  constructor(userDataPath: string, private authBackendUrl: string = AUTH_BACKEND_URL) {
    const dir = path.join(userDataPath, 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'vst-auth.json');
  }

  private load(): Saved { try { return JSON.parse(fs.readFileSync(this.file, 'utf-8')); } catch { return {}; } }
  private save(s: Saved) { try { fs.writeFileSync(this.file, JSON.stringify(s), 'utf-8'); } catch {} }
  private clear() { try { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); } catch {} }

  isEnabled() { return !!this.authBackendUrl; }

  private async api(pathname: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 8000);
    try { return await fetch(`${this.authBackendUrl}${pathname}`, { ...init, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  }

  private grace(s: Saved): VSAuthStatus {
    if (s.token && s.lastAuthorizedAt && Date.now() - s.lastAuthorizedAt < OFFLINE_GRACE_MS)
      return { enabled: true, authorized: true, username: s.username, stale: true };
    return { enabled: true, authorized: false, reason: 'offline' };
  }

  /** The real fix for the "closes the app, has to log back in shortly
   *  after" bug: the session token this class talks to /session with is
   *  short-lived by design (that's exactly WHY a refreshToken is issued and
   *  stored alongside it) — but nothing here ever actually used it before.
   *  A 401 immediately wiped the whole session, refreshToken included,
   *  even though the real, intended recovery path (redeem the refresh
   *  token for a new session token, exactly like the initial /verify flow)
   *  was sitting right there unused. This calls the backend's own /refresh
   *  endpoint — matching this file's other established endpoints
   *  (/auth/discord, /verify, /session, /logout) and its own established
   *  response-shape fallbacks — before ever giving up on a session that
   *  still has a real, usable refresh token. Single-flighted so concurrent
   *  callers never race each other's refresh attempt (see refreshInFlight's
   *  own comment). Returns the updated Saved state on success, or null if
   *  the refresh token itself is missing/rejected — a genuine, real
   *  expiry/revocation this policy never overrides. */
  private async doRefresh(s: Saved): Promise<Saved | null> {
    if (!s.refreshToken) return null;
    try {
      const res = await this.api('/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: s.refreshToken }),
      });
      if (res.status !== 200) return null;
      const j: any = await res.json().catch(() => ({}));
      const token = j.sessionToken ?? j.session ?? j.token;
      if (!token) return null;
      const updated: Saved = {
        token, refreshToken: j.refreshToken ?? s.refreshToken,
        username: j.user?.discordUsername ?? j.username ?? s.username,
        lastAuthorizedAt: Date.now(),
      };
      this.save(updated);
      return updated;
    } catch { return null; }
  }

  private refreshTokenSingleFlight(s: Saved): Promise<Saved | null> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefresh(s).finally(() => { this.refreshInFlight = null; });
    }
    return this.refreshInFlight;
  }

  /** The check the gate depends on — always confirmed against the backend,
   *  subject to the real 6-hour inactivity policy checked first:
   *  a session confirmed less than 6 hours ago is restored automatically;
   *  one genuinely idle 6+ hours requires signing in again, checked before
   *  any network call so a clearly-idle session never even gets the chance
   *  to succeed a stale refresh. A real server-side revocation/expiry (the
   *  refresh call itself failing) still requires re-auth regardless of the
   *  inactivity clock — this only ever adds a stricter local rule, never a
   *  looser one than the backend's own. */
  async status(): Promise<VSAuthStatus> {
    if (!this.isEnabled()) return { enabled: false, authorized: true };
    const s = this.load();
    if (!s.token) return { enabled: true, authorized: false, reason: 'no_session' };

    if (s.lastAuthorizedAt && Date.now() - s.lastAuthorizedAt >= SESSION_INACTIVITY_LIMIT_MS) {
      this.clear();
      this.setGuard(false);
      return { enabled: true, authorized: false, reason: 'inactive_6h' };
    }

    return this.checkSession(s);
  }

  private async checkSession(s: Saved, alreadyRefreshed = false): Promise<VSAuthStatus> {
    try {
      const res = await this.api('/session', { headers: { Authorization: `Bearer ${s.token}` } });
      if (res.status === 200) {
        const j: any = await res.json();
        // Deployed backend shape: { user: { discordUsername, ... }, session: { expiresAt } }.
        // 200 always means a valid session (the backend returns 401 otherwise).
        // Fallbacks (?? j.username / j.expiresAt) keep the local reference backend working too.
        const username = j.user?.discordUsername ?? j.username;
        const expiresAt = j.session?.expiresAt ?? j.expiresAt;
        this.save({ ...s, username, lastAuthorizedAt: Date.now() });
        // entitlements is optional/future — passed through if the backend sends it.
        const st: VSAuthStatus = { enabled: true, authorized: true, username, expiresAt, entitlements: Array.isArray(j.entitlements) ? j.entitlements : undefined };
        this.setGuard(true);
        return st;
      }
      if (res.status === 401) {
        // The real recovery path: try the stored refresh token BEFORE
        // giving up — never wipe a session that still has a usable one.
        if (!alreadyRefreshed) {
          const refreshed = await this.refreshTokenSingleFlight(s);
          if (refreshed) return this.checkSession(refreshed, true);
        }
        const j: any = await res.json().catch(() => ({}));
        this.clear();
        this.setGuard(false);
        return { enabled: true, authorized: false, reason: j.error || 'invalid_session' };
      }
      const g = this.grace(s); this.setGuard(g.authorized); return g; // 5xx etc. — temporary
    } catch { const g = this.grace(s); this.setGuard(g.authorized); return g; }
  }

  private setGuard(authorized: boolean) { this.guardCache = { authorized, at: Date.now() }; }

  /**
   * Server-side-backed authorization check for the main-process IPC guard.
   * Cached briefly to avoid hammering the backend. Returns true when
   * verification is disabled (dev override) or the backend confirms the session.
   */
  async ensureAuthorized(): Promise<boolean> {
    if (!this.isEnabled()) return true;
    const now = Date.now();
    if (this.guardCache && now - this.guardCache.at < GUARD_CACHE_MS) return this.guardCache.authorized;
    const st = await this.status(); // validates with backend + refreshes guardCache
    return st.authorized;
  }

  /** Open the official Discord authorization flow in the system browser. */
  async startLogin(): Promise<{ ok: boolean; error?: string }> {
    if (!this.isEnabled()) return { ok: false, error: 'not_configured' };
    await shell.openExternal(`${this.authBackendUrl}/auth/discord`);
    return { ok: true };
  }

  /** Redeem a one-time code for a secure session (stored main-side). */
  async redeem(code: string): Promise<{ ok: boolean; username?: string; error?: string; message?: string }> {
    if (!this.isEnabled()) return { ok: false, error: 'not_configured' };
    try {
      const res = await this.api('/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      const j: any = await res.json().catch(() => ({}));
      // Deployed backend shape: { sessionToken, refreshToken, expiresAt, user: { discordUsername, ... } }.
      // Fallbacks (?? j.session / j.username) keep the local reference backend working too.
      const token = j.sessionToken ?? j.session;
      if (res.status === 200 && token) {
        const username = j.user?.discordUsername ?? j.username;
        this.save({ token, refreshToken: j.refreshToken, username, lastAuthorizedAt: Date.now() });
        this.setGuard(true);
        return { ok: true, username };
      }
      return { ok: false, error: j.error || 'invalid_code', message: j.message || 'Verification failed.' };
    } catch { return { ok: false, error: 'offline', message: 'Could not reach the verification server.' }; }
  }

  async logout(): Promise<void> {
    const s = this.load();
    if (this.isEnabled() && s.token) { try { await this.api('/logout', { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } }); } catch {} }
    this.clear();
    this.setGuard(false);
  }
}
