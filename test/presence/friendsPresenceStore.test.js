// Real behavioral test for the store-level fix in
// src/renderer/stores/useFriendsPresence.ts required by
// docs/mercy-api-contract.md's own "Client-side implication": a
// transient/auth failure from the Mercy API must NEVER overwrite the
// visible friends list with an empty result — only flip the connection
// indicator and keep whatever was last successfully known.
//
// The real bug this fixes: every getX() in friendsPresence.ts resolves
// `{ data: [], error }` on failure, and the OLD refresh() blindly wrote
// that empty array into state on ANY error — wiping Friends/Everyone
// Playing/requests to nothing on a one-off network blip (exactly the
// reported "Retry may restore the shell but Friends remains empty"
// symptom).
//
// This mocks src/renderer/lib/friendsPresence.ts at the module boundary
// (a scripted fake, not this project's own real network code) so the
// REAL useFriendsPresence.ts store logic runs unmodified against
// controllable success/failure responses — real zustand, real store
// methods, only the network layer beneath it is faked.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const STORE_PATH = path.resolve(__dirname, '../../src/renderer/stores/useFriendsPresence.ts');
const FRIENDS_PRESENCE_PATH = path.resolve(__dirname, '../../src/renderer/lib/friendsPresence.ts');
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

    // A scripted fake of the ENTIRE friendsPresence.ts surface — every
    // call configurable per-test via `state`, matching the real module's
    // exact exported shape so the real store code calling it is none the
    // wiser.
    const state = {
      friends: [{ friendId: 'f1', username: 'Alice', status: 'online', activityLabel: null, mercyGameId: null, serverId: null, serverName: null }],
      everyone: [{ userId: 'u1', username: 'Bob', activityLabel: null, mercyGameId: null, isFriend: false, requestPending: false }],
      incoming: [], outgoing: [],
      joins: { incoming: [], outgoing: [] },
      shouldFail: false,
      failureErrorCode: 'SERVER_ERROR',
    };
    const maybeFail = (data) => state.shouldFail ? { data, error: 'Unable to connect to Mercy services.', errorCode: state.failureErrorCode } : { data };

    const restoreFriendsPresenceMock = stubModule(FRIENDS_PRESENCE_PATH, {
      isMercyApiConfigured: () => true,
      getFriendsPresence: async () => maybeFail(state.friends),
      getEveryonePlaying: async () => maybeFail(state.everyone),
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
      subscribeToFriendsUpdates: () => () => {},
    });
    const restoreSupabaseMock = stubModule(SUPABASE_PATH, {
      supabase: null,
      isSupabaseConfigured: () => false,
    });
    global.window = { electronAPI: undefined };

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

    // ── An AUTH_ERROR failure must be reported as 'auth-required', a
    //    genuinely distinct state from a plain network/server outage — the
    //    fix needs a different user action (sign in again) than a retry. ──
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

    useFriendsPresence.getState().applyWsStatus('auth-required');
    ok('applyWsStatus("auth-required") (e.g. a hello-rejected AUTH_ERROR) is reflected in connection', useFriendsPresence.getState().connection === 'auth-required');

    useFriendsPresence.getState().applyWsStatus('connected');
    ok('applyWsStatus("connected") (a real hello-ack) restores connection to "connected"', useFriendsPresence.getState().connection === 'connected');

    useFriendsPresence.getState().applyWsStatus('connecting');
    ok('REPRODUCED THE FIX: a stray "connecting" callback right after a proven "connected" state does not downgrade it back', useFriendsPresence.getState().connection === 'connected');

    restoreFriendsPresenceMock();
    restoreSupabaseMock();

    console.log(`\nFRIENDS PRESENCE STORE TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
