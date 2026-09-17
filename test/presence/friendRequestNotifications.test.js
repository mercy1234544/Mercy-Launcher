// Real behavioral test for the friend-request notification feature added to
// src/renderer/stores/useFriendsPresence.ts: an incoming friend request that
// arrives WHILE the app is open must raise an in-app notification (via
// useNotifications), but:
//   - the very first refresh() of a session must NEVER notify about requests
//     that already existed before the app opened (it only "seeds" silently)
//   - a request already known from a previous refresh must never re-notify
//   - teardown() must reset the seed so a fresh session re-seeds cleanly
//     instead of treating every pre-existing request as "new" forever, or
//     (the opposite bug) never seeding again after the very first mount.
//
// Same technique as friendsPresenceStore.test.js: mock window.electronAPI at
// the boundary, transpile the real .ts store files with TypeScript's own
// compiler, and run the real zustand store logic unmodified.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const STORE_PATH = path.resolve(__dirname, '../../src/renderer/stores/useFriendsPresence.ts');
const NOTIFICATIONS_PATH = path.resolve(__dirname, '../../src/renderer/stores/useNotifications.ts');
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
    delete require.cache[NOTIFICATIONS_PATH];

    const state = {
      friends: [], everyone: [],
      incoming: [],
      outgoing: [],
      joins: { incoming: [], outgoing: [] },
    };
    const pass2 = (data) => ({ data });

    const mercyFriends = {
      isConfigured: async () => true,
      getFriends: async () => pass2(state.friends),
      getEveryone: async () => pass2(state.everyone),
      listIncomingRequests: async () => pass2(state.incoming),
      listOutgoingRequests: async () => pass2(state.outgoing),
      listJoinRequests: async () => pass2(state.joins),
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
    // No real DOM/localStorage in this Node test — useNotifications.ts
    // already wraps every localStorage access in try/catch specifically so
    // it degrades to an in-memory-only store when it's unavailable.
    global.window = { electronAPI: { mercyFriends } };

    const restoreHook = installTsRequireHook();
    let useFriendsPresence, useNotifications;
    try {
      ({ useFriendsPresence } = require(STORE_PATH));
      ({ useNotifications } = require(NOTIFICATIONS_PATH));
    } finally {
      restoreHook();
    }

    // ── The very first refresh() of a session must seed silently: a
    //    request that already existed before the app opened must NOT
    //    raise a notification. ──────────────────────────────────────────
    state.incoming = [{ id: 'r1', fromUserId: 'u1', fromUsername: 'Alice', createdAt: new Date().toISOString() }];
    await useFriendsPresence.getState().refresh();
    ok(
      'REPRODUCED THE FIX: the first refresh of a session seeds pre-existing incoming requests WITHOUT notifying',
      useNotifications.getState().notifications.length === 0
    );

    // ── A refresh with no change must not re-notify about the same
    //    already-known request. ─────────────────────────────────────────
    await useFriendsPresence.getState().refresh();
    ok(
      'an unchanged incoming request list never re-notifies on a later refresh',
      useNotifications.getState().notifications.length === 0
    );

    // ── A genuinely NEW incoming request arriving after the seed must
    //    raise exactly one in-app notification, correctly attributed. ───
    state.incoming = [
      ...state.incoming,
      { id: 'r2', fromUserId: 'u2', fromUsername: 'Bob', createdAt: new Date().toISOString() },
    ];
    await useFriendsPresence.getState().refresh();
    let notifs = useNotifications.getState().notifications;
    ok('REPRODUCED THE FIX: a genuinely new incoming friend request raises exactly one notification', notifs.length === 1);
    ok('the notification is categorized as "friend"', notifs[0]?.category === 'friend');
    ok('the notification names the requester', notifs[0]?.message.includes('Bob'));

    // ── That same request must not notify again on a subsequent
    //    unchanged refresh. ─────────────────────────────────────────────
    await useFriendsPresence.getState().refresh();
    ok('a request already notified about does not notify again', useNotifications.getState().notifications.length === 1);

    // ── Two simultaneously-new requests both notify. ────────────────────
    state.incoming = [
      ...state.incoming,
      { id: 'r3', fromUserId: 'u3', fromUsername: 'Carol', createdAt: new Date().toISOString() },
      { id: 'r4', fromUserId: 'u4', fromUsername: 'Dave', createdAt: new Date().toISOString() },
    ];
    await useFriendsPresence.getState().refresh();
    notifs = useNotifications.getState().notifications;
    ok('multiple simultaneously-new incoming requests each raise their own notification', notifs.length === 3);

    // ── teardown() resets the seed so a fresh session re-seeds silently
    //    instead of either notifying about everything again or never
    //    seeding at all. ──────────────────────────────────────────────
    useFriendsPresence.getState().teardown();
    useNotifications.setState({ notifications: [] });
    // state.incoming still holds r1..r4 from "before this new session".
    await useFriendsPresence.getState().refresh();
    ok(
      'REPRODUCED THE FIX: after teardown(), the next refresh() re-seeds silently (no stale requests are treated as new)',
      useNotifications.getState().notifications.length === 0
    );

    // ── And after that fresh seed, a genuinely new request still
    //    correctly notifies. ────────────────────────────────────────────
    state.incoming = [
      ...state.incoming,
      { id: 'r5', fromUserId: 'u5', fromUsername: 'Erin', createdAt: new Date().toISOString() },
    ];
    await useFriendsPresence.getState().refresh();
    ok('a new request after a teardown+reseed still notifies correctly', useNotifications.getState().notifications.length === 1);

    restoreSupabaseMock();

    console.log(`\nFRIEND REQUEST NOTIFICATION TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
