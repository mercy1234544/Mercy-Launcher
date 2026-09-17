// Real behavioral test for the store-level fix in
// src/renderer/stores/useFriendsPresence.ts: a transient/auth failure from
// the Mercy API must NEVER overwrite the visible friends list with an empty
// result — only flip the connection indicator and keep whatever was last
// successfully known.
//
// As of the Discord-identity migration, the store no longer talks to
// src/renderer/lib/friendsPresence.ts (removed — its REST/WebSocket logic
// moved into the main process, see MercyFriendsClient.ts) or to a Supabase
// access token for its own identity. It now calls
// `window.electronAPI.mercyFriends.*` IPC methods instead, so this test
// mocks THAT surface at the window boundary (a scripted fake, not this
// project's own real network code) so the REAL useFriendsPresence.ts store
// logic runs unmodified against controllable success/failure responses —
// real zustand, real store methods, only the IPC layer beneath it is faked.
// approveJoin()'s still-Supabase-authenticated Mercy Relay host
// registration (a known, flagged gap — see the store's own header) is
// untouched by this test; supabase.ts is stubbed out exactly as before so
// requiring it doesn't need a real Vite/env context.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const STORE_PATH = path.resolve(__dirname, '../../src/renderer/stores/useFriendsPresence.ts');
const SUPABASE_PATH = path.resolve(__dirname, '../../src/renderer/lib/supabase.ts');

function installTsRequireHook() {
  const previous = Module._extensions['.ts'];
  Module._extensions['.ts'] = function (mod, filename) {
    const source = fs.readFileSync(filename, 'utf8').replace(/import\.meta\.env\.(\w+)/g, () => '""');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    });
    mod._compile(outputText, filename);
  };
  return () => { Module._extensions['.ts'] = previous; };
}

function stubModule(resolvedPath, exportsObj) {
  const previous = require.cache[resolvedPath];
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports: exportsObj };
  return () => { if (previous) require.cache[resolvedPath] = previous; else delete require.cache[resolvedPath]; };
}

(async () => {
  try {
    delete require.cache[STORE_PATH];

    // A scripted fake of the ENTIRE window.electronAPI.mercyFriends surface
    // — every call configurable per-test via `state`, matching the real
    // preload's exact exported shape so the real store code calling it is
    // none the wiser.
    const state = {
      friends: [{ friendId: 'f1', username: 'Alice', status: 'online', activityLabel: null, mercyGameId: null, serverId: null, serverName: null }],
      everyone: [{ userId: 'u1', username: 'Bob', activityLabel: null, mercyGameId: null, isFriend: false, requestPending: false }],
      incoming: [], outgoing: [],
      joins: { incoming: [], outgoing: [] },
      shouldFail: false,
      failureErrorCode: 'SERVER_ERROR',
    };
    const maybeFail = (data) => state.shouldFail ? { data, error: 'Unable to connect to Mercy services.', errorCode: state.failureErrorCode } : { data };

    const mercyFriends = {
      isConfigured: async () => true,
      getFriends: async () => maybeFail(state.friends),
      getEveryone: async () => maybeFail(state.everyone),
      listIncomingRequests: async () => maybeFail(state.incoming),
      listOutgoingRequests: async () => maybeFail(state.outgoing),
      listJoinRequests: async () => maybeFail(state.joins),
      sendFriendRequest: async () => ({}),
      respondToFriendRequest: async () => ({}),
      removeFriend: async () => ({}),
      sendHeartbeat: async () => ({}),
      upsertServer: async () => ({}),
      requestJoin: async () => ({ data: { id: 'j1' } }),
      respondToJoinRequest: async () => ({}),
      subscribe: async () => {},
      unsubscribe: async () => {},
      onChanged: () => () => {},
      onStatus: () => () => {},
    };
    const restoreSupabaseMock = stubModule(SUPABASE_PATH, {
      supabase: null,
      isSupabaseConfigured: () => false,
    });
    global.window = { electronAPI: { mercyFriends } };

    const restoreHook = installTsRequireHook();
    let useFriendsPresence;
    try {
      ({ useFriendsPresence } = require(STORE_PATH));
    } finally {
      restoreHook();
    }

    // ── A successful refresh populates real data. ───────────────────────
    await useFriendsPresence.getState().refresh();
    let s = useFriendsPresence.getState();
    ok('a successful refresh populates the real friends list', s.friends.length === 1 && s.friends[0].username === 'Alice');
    ok('a successful refresh populates the real everyone-playing list', s.everyone.length === 1 && s.everyone[0].username === 'Bob');
    ok('connection is "connected" after a real success', s.connection === 'connected');

    // ── A failing refresh must NOT wipe the previously-known data. ──────
    state.shouldFail = true;
    await useFriendsPresence.getState().refresh();
    s = useFriendsPresence.getState();
    ok('REPRODUCED THE FIX: a failed refresh keeps the previously-known friends list intact, never wiped to empty', s.friends.length === 1 && s.friends[0].username === 'Alice');
    ok('REPRODUCED THE FIX: a failed refresh keeps the previously-known everyone-playing list intact', s.everyone.length === 1 && s.everyone[0].username === 'Bob');
    ok('connection correctly flips to "unreachable" on a real failure', s.connection === 'unreachable');

    // ── Recovery: a subsequent successful refresh updates data again. ───
    state.shouldFail = false;
    state.friends = [...state.friends, { friendId: 'f2', username: 'Carol', status: 'offline', activityLabel: null, mercyGameId: null, serverId: null, serverName: null }];
    await useFriendsPresence.getState().refresh();
    s = useFriendsPresence.getState();
    ok('once the connection recovers, a real successful refresh updates state again (not permanently stuck on stale data)', s.friends.length === 2 && s.connection === 'connected');

    // ── An AUTH_ERROR failure must be reported as 'auth-required' — now
    //    meaning "the launcher's Discord session was rejected", never a
    //    Mercy password concept. ─────────────────────────────────────────
    state.shouldFail = true;
    state.failureErrorCode = 'AUTH_ERROR';
    await useFriendsPresence.getState().refresh();
    s = useFriendsPresence.getState();
    ok('REPRODUCED THE FIX: an AUTH_ERROR failure sets connection to "auth-required", never the generic "unreachable"', s.connection === 'auth-required');
    ok('an auth failure still keeps the previously-known friends list intact', s.friends.length === 2);

    state.shouldFail = false;
    state.failureErrorCode = 'SERVER_ERROR';
    await useFriendsPresence.getState().refresh();
    ok('recovering from an auth-required state with a real successful refresh returns to "connected"', useFriendsPresence.getState().connection === 'connected');

    // ── applyWsStatus() — the WebSocket's own observable lifecycle must
    //    drive the same `connection` field the UI reads, without a stray
    //    'connecting' callback (which fires once synchronously at socket
    //    construction time) ever downgrading an already-'connected' state. ─
    useFriendsPresence.getState().applyWsStatus('reconnecting');
    s = useFriendsPresence.getState();
    ok('REPRODUCED THE FIX: a WebSocket drop reported via applyWsStatus flips connection to "reconnecting"', s.connection === 'reconnecting');
    ok('a WebSocket-reported reconnect never touches the preserved friends/everyone data', s.friends.length === 2 && s.everyone.length === 1);

    // ── REGRESSION TEST for the real v1.105.0 bug: the WebSocket layer no
    //    longer has an 'auth-required' status at all. REST refresh() is now
    //    the SOLE authority for that verdict. Prove: (a) REST can still
    //    correctly raise auth-required, (b) a WS 'reconnecting'/'connecting'
    //    blip can never downgrade that away, hiding a real "please reconnect
    //    with Discord" behind a misleading "still trying", and (c) only a
    //    real WS 'connected' (a successful, freshly-verified hello-ack) or a
    //    real REST success can clear it. ─────────────────────────────────
    state.shouldFail = true;
    state.failureErrorCode = 'AUTH_ERROR';
    await useFriendsPresence.getState().refresh();
    ok('REST AUTH_ERROR still correctly produces "auth-required"', useFriendsPresence.getState().connection === 'auth-required');

    useFriendsPresence.getState().applyWsStatus('reconnecting');
    ok('REPRODUCED THE FIX: a WebSocket "reconnecting" signal must NOT overwrite a valid REST-derived "auth-required" verdict', useFriendsPresence.getState().connection === 'auth-required');

    useFriendsPresence.getState().applyWsStatus('connecting');
    ok('a WebSocket "connecting" signal also must not clear a real "auth-required" verdict', useFriendsPresence.getState().connection === 'auth-required');

    useFriendsPresence.getState().applyWsStatus('connected');
    ok('REPRODUCED THE FIX: only a real WebSocket "connected" (a successful hello-ack) can clear "auth-required"', useFriendsPresence.getState().connection === 'connected');

    // ── REST success can restore "connected" after a WS failure — the
    //    other required recovery path (no WebSocket success needed at all,
    //    since REST already independently proves the session is valid). ──
    state.shouldFail = true;
    state.failureErrorCode = 'AUTH_ERROR';
    await useFriendsPresence.getState().refresh();
    ok('(setup) connection is "auth-required" again before the WS-failure-then-REST-recovery check', useFriendsPresence.getState().connection === 'auth-required');
    useFriendsPresence.getState().applyWsStatus('reconnecting');
    ok('(setup) a WebSocket failure signal arrives while auth-required, and does not change anything', useFriendsPresence.getState().connection === 'auth-required');
    state.shouldFail = false;
    state.failureErrorCode = 'SERVER_ERROR';
    await useFriendsPresence.getState().refresh();
    ok('REPRODUCED THE FIX: REST success alone restores "connected" after a WS failure, with no WebSocket success required', useFriendsPresence.getState().connection === 'connected');

    useFriendsPresence.getState().applyWsStatus('connecting');
    ok('REPRODUCED THE FIX: a stray "connecting" callback right after a proven "connected" state does not downgrade it back', useFriendsPresence.getState().connection === 'connected');

    restoreSupabaseMock();

    console.log(`\nFRIENDS PRESENCE STORE TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
