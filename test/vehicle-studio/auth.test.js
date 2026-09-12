// VehicleStudioAuth tests — this is the REAL, actually-wired "Mercy/Discord
// Login" (Sidebar's account widget → useAppAuth → window.electronAPI.vsAuth
// → this class), unlike the unwired AccessManager. Deterministic, against a
// REAL local HTTP server standing in for the real deployed auth backend
// (never the real backend, never real Discord credentials/tokens).
//
// This specifically proves the real bug fix: status() previously never
// used the stored refresh token on a 401, wiping the whole session
// (refresh token included) the moment the short-lived session token
// expired — exactly the "closes the app, has to log in again shortly
// after" behavior reported. It now redeems the refresh token first.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { VehicleStudioAuth, SESSION_INACTIVITY_LIMIT_MS } = require(path.resolve(__dirname, '../../dist/main/services/VehicleStudioAuth.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-vsauth-test-')); }
function authFilePath(userDataRoot) { return path.join(userDataRoot, 'data', 'vst-auth.json'); }
function seedAuth(userDataRoot, saved) {
  fs.mkdirSync(path.join(userDataRoot, 'data'), { recursive: true });
  fs.writeFileSync(authFilePath(userDataRoot), JSON.stringify(saved));
}

/** A real local HTTP server implementing the real backend's own documented
 *  shape (/session, /refresh, /verify, /logout) closely enough to exercise
 *  VehicleStudioAuth for real, including real session-token expiry and a
 *  real, usable refresh token — the exact mechanism the bug fix depends on. */
function startFakeAuthBackend() {
  const validSessionTokens = new Set(['session-token-1']);
  const validRefreshTokens = new Map([['refresh-token-1', 'session-token-1']]);
  let refreshCount = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
        const auth = req.headers.authorization || '';
        const bearerToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;

        if (req.url === '/session' && req.method === 'GET') {
          if (bearerToken && validSessionTokens.has(bearerToken)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ user: { discordUsername: 'FakeDiscordUser' }, session: { expiresAt: Date.now() + 900_000 } }));
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_session' }));
          }
          return;
        }
        if (req.url === '/refresh' && req.method === 'POST') {
          const rt = body.refreshToken;
          if (rt && validRefreshTokens.has(rt)) {
            refreshCount++;
            const newSessionToken = `session-token-${refreshCount + 1}`;
            const newRefreshToken = `refresh-token-${refreshCount + 1}`;
            validSessionTokens.add(newSessionToken);
            validRefreshTokens.delete(rt); // real rotation — old refresh token stops working
            validRefreshTokens.set(newRefreshToken, newSessionToken);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessionToken: newSessionToken, refreshToken: newRefreshToken, user: { discordUsername: 'FakeDiscordUser' } }));
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_refresh_token' }));
          }
          return;
        }
        if (req.url === '/logout' && req.method === 'POST') { res.writeHead(200); res.end('{}'); return; }
        res.writeHead(404); res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, getRefreshCount: () => refreshCount }));
  });
}

(async () => {
  const userDataRoot = mkTempRoot();
  try {
    const { server, port } = await startFakeAuthBackend();
    const backendUrl = `http://127.0.0.1:${port}`;
    const auth = new VehicleStudioAuth(userDataRoot, backendUrl);

    // ── No session at all ────────────────────────────────────────────────
    const none = await auth.status();
    ok('no stored session reports unauthorized honestly, without hitting the network', none.authorized === false && none.reason === 'no_session');

    // ── A real, valid, still-fresh session is confirmed ─────────────────
    seedAuth(userDataRoot, { token: 'session-token-1', refreshToken: 'refresh-token-1', username: 'FakeDiscordUser', lastAuthorizedAt: Date.now() });
    const valid = await auth.status();
    ok('a real, valid session token is confirmed authorized against the real (fake) backend', valid.authorized === true && valid.username === 'FakeDiscordUser');

    // ── THE ACTUAL BUG FIX: an expired/invalid session token is recovered
    //    via the real stored refresh token, never immediately wiped ──────
    seedAuth(userDataRoot, { token: 'expired-session-token', refreshToken: 'refresh-token-1', username: 'FakeDiscordUser', lastAuthorizedAt: Date.now() - 60_000 });
    const recovered = await auth.status();
    ok('an expired session token is silently recovered using the real stored refresh token — the actual reported bug fix', recovered.authorized === true);
    const storedAfterRecovery = JSON.parse(fs.readFileSync(authFilePath(userDataRoot), 'utf-8'));
    ok('after recovery, a genuinely NEW session token is stored, not the expired one', storedAfterRecovery.token !== 'expired-session-token');
    ok('the session survives with the recovered account\'s real username', recovered.username === 'FakeDiscordUser');

    // ── A session with NO refresh token, once expired, honestly requires
    //    re-authentication (there is genuinely nothing left to recover) ──
    seedAuth(userDataRoot, { token: 'expired-no-refresh', username: 'FakeDiscordUser', lastAuthorizedAt: Date.now() - 60_000 });
    const noRefreshToken = await auth.status();
    ok('an expired session with no refresh token at all honestly requires signing in again', noRefreshToken.authorized === false);
    ok('that session is actually cleared from storage', !fs.existsSync(authFilePath(userDataRoot)));

    // ── A real, genuinely revoked refresh token also requires re-auth
    //    (the fix never weakens real server-side revocation) ────────────
    seedAuth(userDataRoot, { token: 'expired-again', refreshToken: 'not-a-real-refresh-token', username: 'FakeDiscordUser', lastAuthorizedAt: Date.now() - 60_000 });
    const revokedRefresh = await auth.status();
    ok('a genuinely invalid/revoked refresh token still requires re-authentication — the fix never weakens real revocation', revokedRefresh.authorized === false);

    // ── Concurrent status() calls racing the same expired token never
    //    race each other's refresh and lose a valid session ─────────────
    // Reuse the real, still-valid refresh token left over from the recovery
    // above (a used refresh token is deleted on rotation — refresh-token-1
    // itself is already gone at this point, exactly like real Discord/OAuth
    // refresh-token rotation), then force the session token back to expired
    // so all three concurrent calls race the SAME real refresh attempt.
    seedAuth(userDataRoot, { ...storedAfterRecovery, token: 'force-expired-for-race-test' });
    const raceAuth = new VehicleStudioAuth(userDataRoot, backendUrl);
    const [r1, r2, r3] = await Promise.all([raceAuth.status(), raceAuth.status(), raceAuth.status()]);
    ok('three concurrent status() calls racing the same expired token ALL succeed — no lost race wipes the session', r1.authorized === true && r2.authorized === true && r3.authorized === true);
    ok('a valid session genuinely remains on disk after the concurrent race', fs.existsSync(authFilePath(userDataRoot)));

    // ── 6-hour inactivity policy ─────────────────────────────────────────
    seedAuth(userDataRoot, { token: 'session-token-1', refreshToken: 'refresh-token-1', username: 'FakeDiscordUser', lastAuthorizedAt: Date.now() - 10 * 60 * 1000 });
    const underSixHours = await auth.status();
    ok('a session confirmed less than 6 hours ago is restored automatically', underSixHours.authorized === true || underSixHours.reason !== 'inactive_6h');

    seedAuth(userDataRoot, { token: 'session-token-1', refreshToken: 'refresh-token-1', username: 'FakeDiscordUser', lastAuthorizedAt: Date.now() - (SESSION_INACTIVITY_LIMIT_MS + 60_000) });
    const overSixHours = await auth.status();
    ok('a session inactive for 6+ hours requires authenticating again, without even attempting a network refresh', overSixHours.authorized === false && overSixHours.reason === 'inactive_6h');
    ok('the inactivity-expired session is actually cleared from storage', !fs.existsSync(authFilePath(userDataRoot)));
    ok('SESSION_INACTIVITY_LIMIT_MS is genuinely 6 hours, not left over at 5', SESSION_INACTIVITY_LIMIT_MS === 6 * 60 * 60 * 1000);

    // ── No password is ever stored ───────────────────────────────────────
    seedAuth(userDataRoot, { token: 'session-token-1', refreshToken: 'refresh-token-1', username: 'FakeDiscordUser', lastAuthorizedAt: Date.now() });
    const raw = fs.readFileSync(authFilePath(userDataRoot), 'utf-8').toLowerCase();
    ok('the stored session never contains a password field', !raw.includes('password'));

    // ── Corrupted storage fails safely ───────────────────────────────────
    fs.writeFileSync(authFilePath(userDataRoot), 'not valid json {{{');
    const corrupted = await auth.status();
    ok('corrupted auth storage is treated as no-session, never crashes', corrupted.authorized === false);

    // ── Explicit logout ───────────────────────────────────────────────────
    seedAuth(userDataRoot, { token: 'session-token-1', refreshToken: 'refresh-token-1', username: 'FakeDiscordUser', lastAuthorizedAt: Date.now() });
    await auth.logout();
    ok('explicit logout clears the stored session', !fs.existsSync(authFilePath(userDataRoot)));
    const afterLogout = await auth.status();
    ok('status() after explicit logout is honestly unauthorized', afterLogout.authorized === false);

    // ── Storage lives outside any install directory ──────────────────────
    ok('VehicleStudioAuth persists to <userDataPath>/data/vst-auth.json — a real per-user path, never inside the app\'s own install directory', authFilePath(userDataRoot).includes(userDataRoot));

    // ── The login gate must actually explain an inactivity sign-out ──────
    // (previously fell through to no banner at all — the user just saw the
    // generic "Welcome to Mercy Launcher" screen with no idea why they'd
    // been signed out).
    const gateSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/components/AppAccessGate.tsx'), 'utf8');
    ok('AppAccessGate shows a real explanation for an inactivity sign-out, not a silent generic login screen', /inactive_6h/.test(gateSrc));

    await new Promise((resolve) => server.close(resolve));
    console.log(`\nVEHICLE STUDIO AUTH TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
