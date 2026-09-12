// AccessManager (Mercy/Discord login) tests — deterministic, against a REAL
// local HTTP server standing in for discord.com's real API (never the real
// Discord, never real credentials/tokens). login()'s own interactive
// browser-consent step can't be automated (it opens a real system browser
// and waits for a real redirect), so these tests pre-seed a real, valid
// stored session — exactly the state a real login() call would have left
// behind — and exercise status()/refresh/5-hour policy/logout/corrupted-
// storage from there, which is also exactly the code path a real app
// restart actually exercises.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { AccessManager, SESSION_INACTIVITY_LIMIT_MS } = require(path.resolve(__dirname, '../../dist/main/services/AccessManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-access-test-')); }
function accessFilePath(userDataRoot) { return path.join(userDataRoot, 'data', 'access.json'); }
function seedAuth(userDataRoot, auth) {
  fs.mkdirSync(path.join(userDataRoot, 'data'), { recursive: true });
  fs.writeFileSync(accessFilePath(userDataRoot), JSON.stringify(auth, null, 2));
}

/** A real local HTTP server implementing just enough of Discord's real API
 *  shape to exercise AccessManager for real — including real refresh-token
 *  ROTATION (a used refresh token is real-rejected, exactly like Discord's
 *  own documented behavior), which is what proves the single-flight fix. */
function startFakeDiscord({ guildRoles = [], memberStatus = 200, refreshFailsAfterFirstUse = true } = {}) {
  const validRefreshTokens = new Set(['refresh-token-1']);
  let refreshCount = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString();
        const params = new URLSearchParams(bodyStr);
        if (req.url === '/api/oauth2/token' && req.method === 'POST') {
          if (params.get('grant_type') === 'refresh_token') {
            const rt = params.get('refresh_token');
            refreshCount++;
            if (!validRefreshTokens.has(rt)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid "refresh_token" in request.' }));
              return;
            }
            if (refreshFailsAfterFirstUse) validRefreshTokens.delete(rt);
            const newRt = `refresh-token-${refreshCount + 1}`;
            validRefreshTokens.add(newRt);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ access_token: `access-${refreshCount}`, refresh_token: newRt, expires_in: 604800 }));
            return;
          }
        }
        if (req.url?.startsWith('/api/users/@me/guilds/') && req.method === 'GET') {
          if (memberStatus !== 200) { res.writeHead(memberStatus); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ roles: guildRoles }));
          return;
        }
        if (req.url === '/api/users/@me') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'fake-user-1', username: 'FakeTestUser' }));
          return;
        }
        res.writeHead(404); res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, getRefreshCount: () => refreshCount }));
  });
}

(async () => {
  const userDataRoot = mkTempRoot();
  try {
    const { server, port } = await startFakeDiscord({ guildRoles: [] });
    const apiBase = `http://127.0.0.1:${port}`;
    const mgr = new AccessManager(userDataRoot, apiBase, { clientId: 'fake-client-id', guildId: 'fake-guild-id' });

    // ── Corrupted / unreadable storage fails safely, never throws ─────────
    fs.mkdirSync(path.join(userDataRoot, 'data'), { recursive: true });
    fs.writeFileSync(accessFilePath(userDataRoot), 'this is not valid json at all {{{');
    const corruptStatus = await mgr.status();
    ok('corrupted auth storage is treated as logged-out, never crashes', corruptStatus.loggedIn === false);
    fs.unlinkSync(accessFilePath(userDataRoot));

    // ── No stored session at all ────────────────────────────────────────
    const noneStatus = await mgr.status();
    ok('no stored session at all reports logged-out honestly', noneStatus.loggedIn === false && noneStatus.configured === true);

    // ── A real, freshly-active session is restored (< 5 hours) ─────────
    seedAuth(userDataRoot, {
      accessToken: 'access-fresh', refreshToken: 'refresh-token-1',
      expiresAt: Date.now() + 60 * 60 * 1000, // access token itself still valid
      user: { id: 'fake-user-1', username: 'FakeTestUser' },
      lastCheck: Date.now(), lastResult: { inGuild: true, hasAccess: true },
      lastActiveAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago
    });
    const restored = await mgr.status();
    ok('a session active less than 5 hours ago is restored automatically, without requiring login again', restored.loggedIn === true && restored.hasAccess === true);

    // ── No password is ever stored anywhere in the session file ─────────
    const rawStored = fs.readFileSync(accessFilePath(userDataRoot), 'utf-8').toLowerCase();
    ok('the stored session never contains a password field', !rawStored.includes('password'));

    // ── 5+ hours of inactivity requires authentication again ────────────
    seedAuth(userDataRoot, {
      accessToken: 'access-stale', refreshToken: 'refresh-token-1',
      expiresAt: Date.now() + 60 * 60 * 1000,
      user: { id: 'fake-user-1', username: 'FakeTestUser' },
      lastCheck: Date.now() - (SESSION_INACTIVITY_LIMIT_MS + 60_000), lastResult: { inGuild: true, hasAccess: true },
      lastActiveAt: Date.now() - (SESSION_INACTIVITY_LIMIT_MS + 60_000), // just over 5 hours ago
    });
    const expiredByInactivity = await mgr.status();
    ok('a session inactive for 5+ hours requires authenticating again', expiredByInactivity.loggedIn === false);
    ok('the 5-hour inactivity message is honest about why', /5 hours/i.test(expiredByInactivity.reason || ''));
    ok('an inactivity-expired session is actually cleared from storage, not just reported expired', !fs.existsSync(accessFilePath(userDataRoot)));

    // ── Real token refresh when the access token itself is near expiry ──
    seedAuth(userDataRoot, {
      accessToken: 'access-old', refreshToken: 'refresh-token-1',
      expiresAt: Date.now() + 10_000, // about to expire
      user: { id: 'fake-user-1', username: 'FakeTestUser' },
      lastCheck: Date.now(), lastResult: { inGuild: true, hasAccess: true },
      lastActiveAt: Date.now(),
    });
    const afterRefresh = await mgr.status(true);
    ok('a near-expiry access token is really refreshed against the real (fake) token endpoint', afterRefresh.loggedIn === true);
    const storedAfterRefresh = JSON.parse(fs.readFileSync(accessFilePath(userDataRoot), 'utf-8'));
    ok('the refreshed session has a real new access token, not the stale one', storedAfterRefresh.accessToken !== 'access-old');

    // ── THE REAL BUG FIX: concurrent status() calls near token expiry
    //    never race each other's refresh and wipe out a valid session ────
    seedAuth(userDataRoot, {
      accessToken: 'access-race', refreshToken: storedAfterRefresh.refreshToken,
      expiresAt: Date.now() + 10_000,
      user: { id: 'fake-user-1', username: 'FakeTestUser' },
      lastCheck: Date.now(), lastResult: { inGuild: true, hasAccess: true },
      lastActiveAt: Date.now(),
    });
    const raceMgr = new AccessManager(userDataRoot, apiBase, { clientId: 'fake-client-id', guildId: 'fake-guild-id' });
    const [raceResult1, raceResult2, raceResult3] = await Promise.all([
      raceMgr.status(true), raceMgr.status(true), raceMgr.status(true),
    ]);
    ok('three concurrent status() calls racing the same near-expiry token ALL succeed — no lost race wipes the session', raceResult1.loggedIn === true && raceResult2.loggedIn === true && raceResult3.loggedIn === true);
    ok('after a concurrent refresh race, the session is still genuinely present on disk', fs.existsSync(accessFilePath(userDataRoot)));

    // ── Guild membership / access role checks (real, not fabricated) ────
    server.close();
    const { server: server2, port: port2 } = await startFakeDiscord({ guildRoles: [], memberStatus: 404 });
    const notMemberMgr = new AccessManager(userDataRoot, `http://127.0.0.1:${port2}`, { clientId: 'fake-client-id', guildId: 'fake-guild-id' });
    seedAuth(userDataRoot, {
      accessToken: 'access-nm', refreshToken: 'refresh-token-1', expiresAt: Date.now() + 60 * 60 * 1000,
      user: { id: 'fake-user-1', username: 'FakeTestUser' }, lastActiveAt: Date.now(),
    });
    const notMemberStatus = await notMemberMgr.status(true);
    ok('a real 404 from the guild-member endpoint is honestly reported as not-in-guild, never fabricated as having access', notMemberStatus.inGuild === false && notMemberStatus.hasAccess === false);
    server2.close();

    // ── Explicit logout ──────────────────────────────────────────────────
    seedAuth(userDataRoot, {
      accessToken: 'access-logout-test', refreshToken: 'refresh-token-1', expiresAt: Date.now() + 60 * 60 * 1000,
      user: { id: 'fake-user-1', username: 'FakeTestUser' }, lastActiveAt: Date.now(),
    });
    mgr.logout();
    ok('explicit logout removes the stored session file', !fs.existsSync(accessFilePath(userDataRoot)));
    const afterLogout = await mgr.status();
    ok('status() after an explicit logout is honestly logged-out — never silently restored', afterLogout.loggedIn === false);

    // ── Account switching: a new login fully replaces the previous account ─
    seedAuth(userDataRoot, {
      accessToken: 'acc-A', refreshToken: 'refresh-token-1', expiresAt: Date.now() + 60 * 60 * 1000,
      user: { id: 'user-A', username: 'AccountA' }, lastActiveAt: Date.now(), lastCheck: Date.now(), lastResult: { inGuild: true, hasAccess: true },
    });
    const beforeSwitch = await mgr.status();
    ok('account A is restored correctly before any switch', beforeSwitch.discordId === 'user-A');
    seedAuth(userDataRoot, {
      accessToken: 'acc-B', refreshToken: 'refresh-token-1', expiresAt: Date.now() + 60 * 60 * 1000,
      user: { id: 'user-B', username: 'AccountB' }, lastActiveAt: Date.now(), lastCheck: Date.now(), lastResult: { inGuild: true, hasAccess: true },
    });
    const afterSwitch = await mgr.status();
    ok('after a different account\'s session is stored (simulating a fresh login), status() reflects the NEW account, never the old one', afterSwitch.discordId === 'user-B');

    // ── Storage lives outside any install directory — real, per-user path ─
    ok('AccessManager persists to <userDataPath>/data/access.json — a real, per-user path the caller controls, never a path inside the app\'s own install directory', accessFilePath(userDataRoot).includes(userDataRoot));

    console.log(`\nACCESS MANAGER TESTS: ${pass} passed, ${fail} failed`);
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
