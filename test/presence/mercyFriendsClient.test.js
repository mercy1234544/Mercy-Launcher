// MercyFriendsClient tests — the main-process Mercy Friends REST/WS client
// that replaced the renderer's old Supabase-authenticated lib/friendsPresence.ts
// as part of the Discord-identity migration (see MercyFriendsClient.ts's own
// header). This is the ONLY thing that talks to the Mercy API for Friends &
// Presence now; the renderer never sees the Discord session token that
// authenticates it.
//
// REST calls are proven against a mocked global.fetch (matching the
// established convention in the old friendsPresenceApi.test.js this file
// replaces). The WebSocket lifecycle is proven against a REAL local `ws`
// server (the same package the client itself uses), matching the
// established convention in test/connection/relaySignalingClient.test.js —
// not a mock, so the actual hello/hello-ack/reconnect wire protocol is
// exercised for real.
const path = require('path');
const WebSocket = require('ws');
const { MercyFriendsClient } = require(path.resolve(__dirname, '../../dist/main/services/MercyFriendsClient.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

/** A fake VehicleStudioAuth — the real class's own header explains why the
 *  Discord session token never reaches the renderer; here it's just an
 *  in-memory string this fake hands back, exactly like the real class's
 *  getSessionToken() would after a real Discord login. */
function fakeAuth({ enabled = true, token = 'fake-discord-session-token' } = {}) {
  return { isEnabled: () => enabled, getSessionToken: () => token };
}

const PRODUCTION_DEFAULT_API_URL = 'https://mercy.tryautoscout.com/mercy-api/v1';

/** Omitting `apiBaseOverride` entirely leaves VITE_MERCY_API_URL genuinely
 *  UNSET for the constructor call — this is what a real packaged install
 *  looks like (no .env ships, ever — see MercyFriendsClient.ts's own
 *  header), so it's the only way to actually prove the hardcoded
 *  production default is what a real user gets, rather than a test-only
 *  stand-in value. Pass an explicit string to prove the override still
 *  works for local dev/testing. */
function freshClient(opts, apiBaseOverride) {
  const hadPrevious = Object.prototype.hasOwnProperty.call(process.env, 'VITE_MERCY_API_URL');
  const previous = process.env.VITE_MERCY_API_URL;
  if (apiBaseOverride === undefined) delete process.env.VITE_MERCY_API_URL;
  else process.env.VITE_MERCY_API_URL = apiBaseOverride;
  const client = new MercyFriendsClient(fakeAuth(opts));
  if (hadPrevious) process.env.VITE_MERCY_API_URL = previous; else delete process.env.VITE_MERCY_API_URL;
  return client;
}

(async () => {
  try {
    // ── isConfigured() — requires the existing Discord/Vehicle Studio auth
    //    to be enabled. The Mercy API base URL is now ALWAYS present (a
    //    hardcoded production default when VITE_MERCY_API_URL is unset —
    //    see MercyFriendsClient.ts's own header for why a real packaged
    //    install never has that env var), so the only way left to reach
    //    "unconfigured" is auth itself being disabled — never an empty API
    //    URL, which can no longer happen. ──────────────────────────────────
    {
      ok('auth disabled -> isConfigured() === false regardless of any API URL override', freshClient({ enabled: false }).isConfigured() === false);
      ok('auth disabled even with an explicit API URL override -> still false (a real session is required to authenticate)', freshClient({ enabled: false }, 'https://custom.example.com/v1').isConfigured() === false);
      ok('REPRODUCED THE FIX: auth enabled + VITE_MERCY_API_URL genuinely UNSET (the real packaged-install condition) -> isConfigured() === true via the hardcoded production default', freshClient({ enabled: true }).isConfigured() === true);
    }

    // ── The production default itself — proven by actually making a call
    //    and inspecting the real URL fetch() was given, with
    //    VITE_MERCY_API_URL genuinely absent from process.env (never merely
    //    set to ''), which is what every real packaged install looks like. ─
    {
      const client = freshClient({ enabled: true, token: 'tok' });
      const calls = [];
      global.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
      await client.getFriendsPresence();
      ok('REPRODUCED THE FIX: with VITE_MERCY_API_URL unset, a real call hits the hardcoded production Mercy API URL', calls[0].url === `${PRODUCTION_DEFAULT_API_URL}/friends`);
    }

    // ── The env-var override still works for local dev/testing. ─────────
    {
      const client = freshClient({ enabled: true, token: 'tok' }, 'https://custom.example.com/v1');
      const calls = [];
      global.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
      await client.getFriendsPresence();
      ok('VITE_MERCY_API_URL, when explicitly set, still overrides the production default', calls[0].url === 'https://custom.example.com/v1/friends');
    }

    // ── notConfigured short-circuit — never calls fetch at all ──────────
    {
      const client = freshClient({ enabled: false });
      global.fetch = async () => { throw new Error('fetch must never be called when unconfigured'); };
      const r = await client.getFriendsPresence();
      ok('getFriendsPresence() with nothing configured returns notConfigured without ever calling fetch', r.notConfigured === true && r.data.length === 0);
    }

    // ── No Discord session token -> an honest AUTH_ERROR, never an
    //    unauthenticated request. ────────────────────────────────────────
    {
      const client = freshClient({ enabled: true, token: null });
      let fetchCalled = false;
      global.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
      const r = await client.getFriendsPresence();
      ok('with no Discord session token, the call fails honestly with AUTH_ERROR', r.errorCode === 'AUTH_ERROR');
      ok('fetch is never called without a real session token', fetchCalled === false);
    }

    // ── Real REST call construction: URL, method, Authorization header
    //    (carrying the DISCORD session token, never a Supabase one), body. ──
    {
      const client = freshClient({ enabled: true, token: 'real-discord-token' });
      const calls = [];
      global.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ data: { id: 'x' } }) }; };

      await client.getFriendsPresence();
      ok('GET /friends hits the real configured base URL', calls[0].url === 'https://mercy.tryautoscout.com/mercy-api/v1/friends');
      ok('every call carries the DISCORD session token as a Bearer header', calls[0].init.headers.Authorization === 'Bearer real-discord-token');

      calls.length = 0;
      await client.sendFriendRequest('SomeUser');
      ok('POST /friends/requests with the real username body', calls[0].url.endsWith('/friends/requests') && calls[0].init.method === 'POST' && JSON.parse(calls[0].init.body).username === 'SomeUser');

      calls.length = 0;
      await client.respondToFriendRequest('req-1', true);
      ok('POST /friends/requests/:id/respond with the real id in the path and approve in the body', calls[0].url.endsWith('/friends/requests/req-1/respond') && JSON.parse(calls[0].init.body).approve === true);

      calls.length = 0;
      await client.removeFriend('friend-1');
      ok('DELETE /friends/:friendId', calls[0].url.endsWith('/friends/friend-1') && calls[0].init.method === 'DELETE');

      calls.length = 0;
      await client.upsertServer({ id: 'srv-1', mercyGameId: 'minecraft', edition: 'bedrock', displayName: 'My Server', isOnline: true });
      ok('PUT /servers/:id with the real server fields', calls[0].url.endsWith('/servers/srv-1') && calls[0].init.method === 'PUT' && JSON.parse(calls[0].init.body).mercyGameId === 'minecraft');

      calls.length = 0;
      await client.requestJoin('srv-1');
      ok('POST /joins with the real serverId', calls[0].url.endsWith('/joins') && JSON.parse(calls[0].init.body).serverId === 'srv-1');
    }

    // ── Error-code mapping — the exact distinct codes, through the REAL
    //    response-parsing code path. ─────────────────────────────────────
    {
      const client = freshClient({ enabled: true });

      global.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'USER_NOT_FOUND', message: 'User not found.' }) });
      const notFound = await client.sendFriendRequest('nobody');
      ok('a 404 USER_NOT_FOUND surfaces the real, distinct errorCode', notFound.errorCode === 'USER_NOT_FOUND' && notFound.error === 'User not found.');

      global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'AUTH_ERROR', message: 'Invalid session.' }) });
      const authErr = await client.getFriendsPresence();
      ok('a 401 AUTH_ERROR is never confused with USER_NOT_FOUND', authErr.errorCode === 'AUTH_ERROR');

      global.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'SERVER_ERROR', message: 'Backend unreachable.' }) });
      const serverErr = await client.getFriendsPresence();
      ok('a 503 SERVER_ERROR is never confused with AUTH_ERROR or USER_NOT_FOUND', serverErr.errorCode === 'SERVER_ERROR');

      global.fetch = async () => { throw new TypeError('Failed to fetch'); };
      const networkErr = await client.getFriendsPresence();
      ok('a real network/fetch exception maps to SERVER_ERROR, never crashes, never silently succeeds', networkErr.errorCode === 'SERVER_ERROR' && networkErr.data.length === 0);
    }

    // ── WebSocket lifecycle — against a REAL local `ws` server, not a mock.
    //    Proves the hello carries the DISCORD session token, and the
    //    hello-ack/changed/reconnect-on-close protocol is unchanged from the
    //    old renderer implementation, just running in the main process. ────
    {
      function startFakeMercyWsServer() {
        return new Promise((resolve) => {
          const wss = new WebSocket.Server({ port: 0 }, () => resolve({ wss, port: wss.address().port }));
          wss.on('connection', (ws) => {
            ws.on('message', (raw) => {
              const msg = JSON.parse(raw.toString());
              if (msg.type === 'hello') { ws.__lastHello = msg; ws.send(JSON.stringify({ type: 'hello-ack' })); }
            });
          });
          wss.__lastConnection = null;
          wss.on('connection', (ws) => { wss.__lastConnection = ws; });
        });
      }

      const { wss, port } = await startFakeMercyWsServer();
      const client = freshClient({ enabled: true, token: 'ws-discord-token' }, `http://127.0.0.1:${port}`);

      const changedEvents = [];
      const statuses = [];
      client.on('changed', () => changedEvents.push(true));
      client.on('status', (s) => statuses.push(s));

      client.start();
      ok('the very first connection attempt is reported as "connecting"', statuses[0] === 'connecting');

      await new Promise((r) => setTimeout(r, 200));
      ok('a real WebSocket connects to the http->ws derived presence/ws path', wss.__lastConnection != null);
      ok('the hello carries the real Discord session token, never a Supabase one', wss.__lastConnection.__lastHello?.token === 'ws-discord-token');
      ok('hello-ack reports a real, observable "connected" status', statuses[statuses.length - 1] === 'connected');
      ok('hello-ack triggers a "changed" event (a full refresh, since anything missed while disconnected is otherwise lost)', changedEvents.length === 1);

      // The server's own routine disconnect must be recovered automatically.
      wss.__lastConnection.close();
      await new Promise((r) => setTimeout(r, 50));
      ok('closing the socket is immediately reported as "reconnecting" — never silent', statuses[statuses.length - 1] === 'reconnecting');
      await new Promise((r) => setTimeout(r, 1300));
      ok('after the socket closes, a NEW connection is automatically created — no restart required', statuses[statuses.length - 1] === 'connected');

      client.stop();
      wss.close();
    }

    console.log(`\nMERCY FRIENDS CLIENT TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
