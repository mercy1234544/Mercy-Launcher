// Real behavioral tests for src/renderer/lib/friendsPresence.ts — the
// replacement of the previous direct-Supabase-RPC + Supabase-Realtime
// Friends/Presence client with the Linux Mercy API/WebSocket (see
// docs/mercy-api-contract.md, fetched from the linux-backend/mercy-api
// branch at services/mercy-backend/docs/mercy-api-contract.md).
//
// This is a renderer (ESM, Vite) file — it and its own real local import
// (./supabase) both read `import.meta.env` at module scope, which Vite
// statically replaces at build time and which has no meaning outside a
// real Vite build (no CommonJS equivalent). Rather than a weaker
// source-text-only test, this registers a real temporary `require.extensions['.ts']`
// hook (the same real technique test/gamescanner/launch-game-content-manager.test.js
// established for a single self-contained file, extended here to also
// transpile transitive local .ts imports) so every real line of actual
// logic — fetch construction, error-code mapping, the WebSocket
// hello/reconnect state machine — runs completely unmodified, against a
// scripted fake `@supabase/supabase-js` client (mocking a third-party SDK
// at its module boundary is standard practice; nothing of THIS project's
// own code is mocked).
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const FRIENDS_PRESENCE_PATH = path.resolve(__dirname, '../../src/renderer/lib/friendsPresence.ts');
const SUPABASE_PATH = path.resolve(__dirname, '../../src/renderer/lib/supabase.ts');

/** Registers a real (if old-style) require hook so `.ts` files under
 *  src/renderer/lib resolve and transpile like real modules, with
 *  `import.meta.env.X` substituted for real, injectable values per file —
 *  the one thing that's not real Vite behavior, and the only reason this
 *  hook exists instead of just `require()`ing the real .ts files directly. */
function installTsRequireHook(envByFile) {
  const previous = Module._extensions['.ts'];
  Module._extensions['.ts'] = function (mod, filename) {
    let source = fs.readFileSync(filename, 'utf8');
    const env = envByFile[filename] || {};
    source = source.replace(/import\.meta\.env\.(\w+)/g, (_m, key) => JSON.stringify(env[key] ?? ''));
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    });
    mod._compile(outputText, filename);
  };
  return () => { Module._extensions['.ts'] = previous; };
}

/** Mocks @supabase/supabase-js at the module boundary — a real third-party
 *  SDK, not this project's own code — so supabase.ts's real
 *  isSupabaseConfigured()/createClient() logic runs unmodified, but the
 *  resulting client's auth.getSession() returns a scripted, controllable
 *  token instead of requiring a real network session. */
function installSupabaseJsMock(getSessionImpl) {
  const key = require.resolve('@supabase/supabase-js');
  const previous = require.cache[key];
  require.cache[key] = {
    id: key, filename: key, loaded: true, exports: {
      createClient: () => ({ auth: { getSession: getSessionImpl } }),
    },
  };
  return () => { if (previous) require.cache[key] = previous; else delete require.cache[key]; };
}

function freshFriendsPresenceModule({ mercyApiUrl, supabaseUrl, supabaseAnonKey, getSessionImpl }) {
  delete require.cache[FRIENDS_PRESENCE_PATH];
  delete require.cache[SUPABASE_PATH];
  const restoreHook = installTsRequireHook({
    [FRIENDS_PRESENCE_PATH]: { VITE_MERCY_API_URL: mercyApiUrl },
    [SUPABASE_PATH]: { VITE_SUPABASE_URL: supabaseUrl, VITE_SUPABASE_ANON_KEY: supabaseAnonKey },
  });
  const restoreMock = installSupabaseJsMock(getSessionImpl || (async () => ({ data: { session: null } })));
  try {
    return require(FRIENDS_PRESENCE_PATH);
  } finally {
    restoreHook();
    restoreMock();
  }
}

const REAL_SESSION = () => ({ data: { session: { access_token: 'fake-real-token' } } });
const NO_SESSION = () => ({ data: { session: null } });

(async () => {
  try {
    // ── isMercyApiConfigured() — must require BOTH a real Supabase config
    //    AND a real Mercy API URL, never either alone. ───────────────────
    {
      const unconfigured = freshFriendsPresenceModule({ mercyApiUrl: '', supabaseUrl: '', supabaseAnonKey: '' });
      ok('neither configured -> isMercyApiConfigured() === false', unconfigured.isMercyApiConfigured() === false);

      const onlyMercy = freshFriendsPresenceModule({ mercyApiUrl: 'https://mercy.tryautoscout.com/mercy-api/v1', supabaseUrl: '', supabaseAnonKey: '' });
      ok('Mercy API URL set but Supabase not configured -> still false (a real session is required to authenticate)', onlyMercy.isMercyApiConfigured() === false);

      const onlySupabase = freshFriendsPresenceModule({ mercyApiUrl: '', supabaseUrl: 'https://real.supabase.co', supabaseAnonKey: 'real-anon-key' });
      ok('Supabase configured but no Mercy API URL -> still false', onlySupabase.isMercyApiConfigured() === false);

      const both = freshFriendsPresenceModule({ mercyApiUrl: 'https://mercy.tryautoscout.com/mercy-api/v1', supabaseUrl: 'https://real.supabase.co', supabaseAnonKey: 'real-anon-key' });
      ok('REPRODUCED THE FIX: both configured -> isMercyApiConfigured() === true', both.isMercyApiConfigured() === true);
    }

    // ── notConfigured short-circuit — never calls fetch at all ──────────
    {
      const mod = freshFriendsPresenceModule({ mercyApiUrl: '', supabaseUrl: '', supabaseAnonKey: '' });
      global.fetch = async () => { throw new Error('fetch must never be called when unconfigured'); };
      const r = await mod.getFriendsPresence();
      ok('getFriendsPresence() with nothing configured returns notConfigured without ever calling fetch', r.notConfigured === true && r.data.length === 0);
    }

    // ── No real session -> an honest AUTH_ERROR, never an unauthenticated
    //    request. ──────────────────────────────────────────────────────
    {
      const mod = freshFriendsPresenceModule({
        mercyApiUrl: 'https://mercy.tryautoscout.com/mercy-api/v1', supabaseUrl: 'https://real.supabase.co', supabaseAnonKey: 'real-anon-key',
        getSessionImpl: NO_SESSION,
      });
      let fetchCalled = false;
      global.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
      const r = await mod.getFriendsPresence();
      ok('with no real session, the call fails honestly with AUTH_ERROR', r.errorCode === 'AUTH_ERROR');
      ok('fetch is never called without a real access token', fetchCalled === false);
    }

    // ── Real REST call construction: URL, method, Authorization header,
    //    and body — proven against every mutating endpoint the contract
    //    defines, not just GETs. ──────────────────────────────────────────
    {
      const mod = freshFriendsPresenceModule({
        mercyApiUrl: 'https://mercy.tryautoscout.com/mercy-api/v1', supabaseUrl: 'https://real.supabase.co', supabaseAnonKey: 'real-anon-key',
        getSessionImpl: REAL_SESSION,
      });
      const calls = [];
      global.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ data: { id: 'x' } }) }; };

      await mod.getFriendsPresence();
      ok('GET /friends hits the real contract path with the real base URL', calls[0].url === 'https://mercy.tryautoscout.com/mercy-api/v1/friends');
      ok('every call carries the real Supabase access token as a Bearer header', calls[0].init.headers.Authorization === 'Bearer fake-real-token');

      calls.length = 0;
      await mod.sendFriendRequest('SomeUser');
      ok('POST /friends/requests with the real username body', calls[0].url.endsWith('/friends/requests') && calls[0].init.method === 'POST' && JSON.parse(calls[0].init.body).username === 'SomeUser');

      calls.length = 0;
      await mod.respondToFriendRequest('req-1', true);
      ok('POST /friends/requests/:id/respond with the real id in the path and approve in the body', calls[0].url.endsWith('/friends/requests/req-1/respond') && JSON.parse(calls[0].init.body).approve === true);

      calls.length = 0;
      await mod.removeFriend('friend-1');
      ok('DELETE /friends/:friendId', calls[0].url.endsWith('/friends/friend-1') && calls[0].init.method === 'DELETE');

      calls.length = 0;
      await mod.upsertServer({ id: 'srv-1', mercyGameId: 'minecraft', edition: 'bedrock', displayName: 'My Server', isOnline: true });
      ok('PUT /servers/:id with the real server fields', calls[0].url.endsWith('/servers/srv-1') && calls[0].init.method === 'PUT' && JSON.parse(calls[0].init.body).mercyGameId === 'minecraft');

      calls.length = 0;
      await mod.requestJoin('srv-1');
      ok('POST /joins with the real serverId', calls[0].url.endsWith('/joins') && JSON.parse(calls[0].init.body).serverId === 'srv-1');
    }

    // ── Error-code mapping — the contract's exact distinct codes, through
    //    the REAL response-parsing code path. ───────────────────────────
    {
      const mod = freshFriendsPresenceModule({
        mercyApiUrl: 'https://mercy.tryautoscout.com/mercy-api/v1', supabaseUrl: 'https://real.supabase.co', supabaseAnonKey: 'real-anon-key',
        getSessionImpl: REAL_SESSION,
      });

      global.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'USER_NOT_FOUND', message: 'User not found.' }) });
      const notFound = await mod.sendFriendRequest('nobody');
      ok('REPRODUCED THE FIX: a 404 USER_NOT_FOUND surfaces the real, distinct errorCode', notFound.errorCode === 'USER_NOT_FOUND' && notFound.error === 'User not found.');

      global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'AUTH_ERROR', message: 'Invalid session.' }) });
      const authErr = await mod.getFriendsPresence();
      ok('REPRODUCED THE FIX: a 401 AUTH_ERROR is never confused with USER_NOT_FOUND', authErr.errorCode === 'AUTH_ERROR');

      global.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'SERVER_ERROR', message: 'Backend unreachable.' }) });
      const serverErr = await mod.getFriendsPresence();
      ok('REPRODUCED THE FIX: a 503 SERVER_ERROR is never confused with AUTH_ERROR or USER_NOT_FOUND', serverErr.errorCode === 'SERVER_ERROR');

      global.fetch = async () => { throw new TypeError('Failed to fetch'); };
      const networkErr = await mod.getFriendsPresence();
      ok('a real network/fetch exception maps to SERVER_ERROR, never crashes, never silently succeeds', networkErr.errorCode === 'SERVER_ERROR' && networkErr.data.length === 0);
    }

    // ── WebSocket reconnect protocol — real hello / hello-ack / changed /
    //    reconnect-on-close state machine against a scripted fake socket. ─
    {
      class FakeWebSocket {
        constructor(url) {
          this.url = url; this.sent = [];
          FakeWebSocket.instances.push(this);
          setTimeout(() => { if (this.onopen) this.onopen(); }, 5);
        }
        send(data) { this.sent.push(JSON.parse(data)); }
        close() { if (this.onclose) this.onclose(); }
        emitMessage(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
      }
      FakeWebSocket.instances = [];
      global.WebSocket = FakeWebSocket;

      const mod = freshFriendsPresenceModule({
        mercyApiUrl: 'https://mercy.tryautoscout.com/mercy-api/v1', supabaseUrl: 'https://real.supabase.co', supabaseAnonKey: 'real-anon-key',
        getSessionImpl: REAL_SESSION,
      });
      let changeCount = 0;
      const statuses = [];
      const unsubscribe = mod.subscribeToFriendsUpdates(() => { changeCount++; }, (s) => statuses.push(s));

      ok('the very first connection attempt is reported as "connecting", not "reconnecting"', statuses[0] === 'connecting');

      await new Promise((r) => setTimeout(r, 30));
      ok('a real WebSocket is constructed at the contract\'s exact documented path, derived from the configured REST base', FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].url === 'wss://mercy.tryautoscout.com/mercy-api/v1/presence/ws');

      const first = FakeWebSocket.instances[0];
      ok('a real "hello" is sent with the real access token, per the contract\'s exact message shape', first.sent[0].type === 'hello' && first.sent[0].token === 'fake-real-token');

      first.emitMessage({ type: 'hello-ack', userId: 'u-1' });
      ok('hello-ack triggers one onChange (a full refresh, since anything missed while disconnected is otherwise lost)', changeCount === 1);
      ok('hello-ack reports a real, observable "connected" status', statuses[statuses.length - 1] === 'connected');

      first.emitMessage({ type: 'changed', kind: 'friends', at: Date.now() });
      ok('a "changed" push triggers another onChange', changeCount === 2);

      // Simulate the server's own 45s ping-timeout disconnect (or any other
      // close) — the REAL fix for the original bug: this must reconnect on
      // its own, not require the app to restart.
      first.close();
      ok('REPRODUCED THE FIX: closing the socket is immediately reported as "reconnecting" — never silent', statuses[statuses.length - 1] === 'reconnecting');
      await new Promise((r) => setTimeout(r, 1300));
      ok('REPRODUCED THE FIX: after the socket closes, a NEW WebSocket connection is automatically created — no restart required', FakeWebSocket.instances.length === 2);
      ok('the reconnect sends a fresh, real "hello" again', FakeWebSocket.instances[1].sent[0]?.type === 'hello');

      FakeWebSocket.instances[1].emitMessage({ type: 'hello-ack', userId: 'u-1' });
      ok('once reconnected, the status returns to "connected" (proving recovery, not a permanent "reconnecting" stuck state)', statuses[statuses.length - 1] === 'connected');

      unsubscribe();
      const countAfterUnsubscribe = FakeWebSocket.instances.length;
      FakeWebSocket.instances[1].close();
      await new Promise((r) => setTimeout(r, 1300));
      ok('after unsubscribe(), a close no longer triggers a further reconnect', FakeWebSocket.instances.length === countAfterUnsubscribe);
    }

    // ── WebSocket auth rejection — hello-rejected AUTH_ERROR must be
    //    reported distinctly as 'auth-required', never as a plain
    //    connectivity 'reconnecting' problem, so the UI can correctly ask
    //    the user to sign in again instead of implying a network issue. ─
    {
      class FakeWebSocket {
        constructor(url) {
          this.url = url; this.sent = [];
          FakeWebSocket.instances.push(this);
          setTimeout(() => { if (this.onopen) this.onopen(); }, 5);
        }
        send(data) { this.sent.push(JSON.parse(data)); }
        close() { if (this.onclose) this.onclose(); }
        emitMessage(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
      }
      FakeWebSocket.instances = [];
      global.WebSocket = FakeWebSocket;

      const mod = freshFriendsPresenceModule({
        mercyApiUrl: 'https://mercy.tryautoscout.com/mercy-api/v1', supabaseUrl: 'https://real.supabase.co', supabaseAnonKey: 'real-anon-key',
        getSessionImpl: REAL_SESSION,
      });
      const statuses = [];
      const unsubscribe = mod.subscribeToFriendsUpdates(() => {}, (s) => statuses.push(s));
      await new Promise((r) => setTimeout(r, 30));

      FakeWebSocket.instances[0].emitMessage({ type: 'hello-rejected', code: 'AUTH_ERROR', reason: 'Token expired.' });
      FakeWebSocket.instances[0].close();
      ok('REPRODUCED THE FIX: a hello-rejected AUTH_ERROR is reported as "auth-required", not a generic reconnect', statuses[statuses.length - 1] === 'auth-required');

      await new Promise((r) => setTimeout(r, 1300));
      ok('the client still automatically retries even after an auth rejection (a token that was rotated in the meantime can self-heal)', FakeWebSocket.instances.length === 2);

      // A later successful hello-ack proves recovery back to a healthy state.
      FakeWebSocket.instances[1].emitMessage({ type: 'hello-ack', userId: 'u-1' });
      ok('a subsequent successful hello-ack clears the auth-required state back to "connected"', statuses[statuses.length - 1] === 'connected');

      unsubscribe();
    }

    // ── WebSocket, no session at all (never signed in / signed out) — must
    //    report auth-required, never hang silently retrying forever without
    //    any observable status. ────────────────────────────────────────────
    {
      class FakeWebSocket {
        constructor(url) { this.url = url; this.sent = []; FakeWebSocket.instances.push(this); }
        send() {}
        close() {}
      }
      FakeWebSocket.instances = [];
      global.WebSocket = FakeWebSocket;

      const mod = freshFriendsPresenceModule({
        mercyApiUrl: 'https://mercy.tryautoscout.com/mercy-api/v1', supabaseUrl: 'https://real.supabase.co', supabaseAnonKey: 'real-anon-key',
        getSessionImpl: NO_SESSION,
      });
      const statuses = [];
      const unsubscribe = mod.subscribeToFriendsUpdates(() => {}, (s) => statuses.push(s));
      await new Promise((r) => setTimeout(r, 30));
      ok('with no real session at all, no WebSocket is ever even constructed', FakeWebSocket.instances.length === 0);
      ok('and the status is honestly reported as "auth-required", never a silent hang', statuses.includes('auth-required'));
      unsubscribe();
    }

    // ── Presence heartbeat — real request shape, and recovery after a
    //    transient failure (Step: "Presence heartbeat must continue
    //    automatically"). ──────────────────────────────────────────────────
    {
      const mod = freshFriendsPresenceModule({
        mercyApiUrl: 'https://mercy.tryautoscout.com/mercy-api/v1', supabaseUrl: 'https://real.supabase.co', supabaseAnonKey: 'real-anon-key',
        getSessionImpl: REAL_SESSION,
      });

      let lastRequest = null;
      global.fetch = async (url, init) => { lastRequest = { url, init }; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
      const settings = { appearOnline: true, showCurrentGame: true, showCurrentServer: false };
      const activity = { mercyGameId: 'fivem', kind: 'hosting', serverId: 's1', serverName: 'My Server' };
      const okResult = await mod.sendHeartbeat(settings, activity);
      ok('a successful heartbeat POSTs to /presence/heartbeat with the real settings/activity shape', lastRequest.url.endsWith('/presence/heartbeat') && lastRequest.init.method === 'POST');
      const sentBody = JSON.parse(lastRequest.init.body);
      ok('the heartbeat body matches the contract\'s exact field names', sentBody.appearOnline === true && sentBody.showCurrentGame === true && sentBody.showCurrentServer === false && sentBody.activity.serverId === 's1');
      ok('a successful heartbeat resolves with no error', !okResult.error);

      global.fetch = async () => { throw new TypeError('Failed to fetch'); };
      const failResult = await mod.sendHeartbeat(settings, activity);
      ok('a heartbeat during an outage fails honestly as SERVER_ERROR, never throws', failResult.errorCode === 'SERVER_ERROR');

      global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
      const recoveredResult = await mod.sendHeartbeat(settings, activity);
      ok('REPRODUCED THE FIX: heartbeat automatically succeeds again once the backend recovers, with no special reset needed', !recoveredResult.error);
    }

    // ── Friend request errors — ALREADY_FRIENDS / REQUEST_PENDING must be
    //    surfaced with their real distinct codes, never collapsed into a
    //    generic failure or misreported as USER_NOT_FOUND. ─────────────────
    {
      const mod = freshFriendsPresenceModule({
        mercyApiUrl: 'https://mercy.tryautoscout.com/mercy-api/v1', supabaseUrl: 'https://real.supabase.co', supabaseAnonKey: 'real-anon-key',
        getSessionImpl: REAL_SESSION,
      });

      global.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'ALREADY_FRIENDS', message: 'You are already friends with this user.' }) });
      const alreadyFriends = await mod.sendFriendRequest('existingFriend');
      ok('ALREADY_FRIENDS is surfaced with its own real error code, not USER_NOT_FOUND', alreadyFriends.errorCode === 'ALREADY_FRIENDS');

      global.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'REQUEST_PENDING', message: 'A friend request is already pending.' }) });
      const pending = await mod.sendFriendRequest('pendingUser');
      ok('REQUEST_PENDING is surfaced with its own real error code', pending.errorCode === 'REQUEST_PENDING');

      global.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'USER_NOT_FOUND', message: 'No such Mercy user.' }) });
      const notFound = await mod.sendFriendRequest('nobody');
      ok('a genuinely nonexistent username still reports the real USER_NOT_FOUND code', notFound.errorCode === 'USER_NOT_FOUND');
    }

    console.log(`\nFRIENDS PRESENCE API CLIENT TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
