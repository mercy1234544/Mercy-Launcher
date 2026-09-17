// Friends & Presence visibility settings -> heartbeat regression coverage.
//
// WHY THIS FILE EXISTS: two real v1.106.1 users reported that
// appearOnline/showCurrentGame were always persisted as false on the
// production Mercy API, regardless of what they toggled in the Friends &
// Presence Settings UI. A full, reproducible investigation traced every
// link in the real chain — the checkbox, useFriendsPresence.ts's
// updateSettings()/init()/the real 5-second poll loop, the real compiled
// PresenceManager.ts (including persistence across a fresh instance, i.e.
// a real app restart), and the real compiled MercyFriendsClient.ts's
// request-body construction — and found every one of them behaves
// correctly today. No defect was found or fixed; this file exists to prove
// that and to catch a REAL regression here in the future, since this exact
// pipeline had essentially no test coverage of its own before this report
// (see test/presence/mercyFriendsClient.test.js for the sendHeartbeat
// body-construction half of this same investigation, and
// test/presence/service.test.js for PresenceManager's own persistence).
//
// This uses the same real-store-against-a-scripted-window-mock technique
// already established in friendsPresenceStore.test.js, extended with a
// window.electronAPI.presence mock (getSettings/setSettings/getLocal) that
// friendsPresenceStore.test.js doesn't need — plus a simulated on-disk
// store (a plain variable outside any one store instance) so "reopening
// the app" can be modeled as a genuinely fresh store module instance
// reading back whatever the previous instance persisted, exactly like a
// real electron-store-backed file would.
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

async function freshStoreModule() {
  delete require.cache[STORE_PATH];
  const restoreHook = installTsRequireHook();
  try {
    return require(STORE_PATH).useFriendsPresence;
  } finally {
    restoreHook();
  }
}

/** A fresh window.electronAPI mock, backed by the SAME `diskState` object a
 *  test passes in — so calling this twice with the same `diskState` models
 *  two genuinely independent renderer sessions (e.g. two windows, or a
 *  close+reopen) sharing the one real main-process settings store. */
function makeWindowMock(diskState, heartbeatCalls) {
  const mercyFriends = {
    isConfigured: async () => true,
    getFriends: async () => ({ data: [] }),
    getEveryone: async () => ({ data: [] }),
    listIncomingRequests: async () => ({ data: [] }),
    listOutgoingRequests: async () => ({ data: [] }),
    listJoinRequests: async () => ({ data: { incoming: [], outgoing: [] } }),
    sendHeartbeat: async (settings, activity) => { heartbeatCalls.push({ settings: { ...settings }, activity }); return {}; },
    subscribe: async () => {},
    unsubscribe: async () => {},
    onChanged: () => () => {},
    onStatus: () => () => {},
  };
  const presence = {
    getSettings: async () => ({ ...diskState.settings }),
    setSettings: async (s) => { diskState.settings = { ...s }; },
    getLocal: async () => ({ status: 'online', visibility: 'private', activity: null }),
  };
  return { electronAPI: { mercyFriends, presence } };
}

(async () => {
  try {
    const restoreSupabaseMock = stubModule(SUPABASE_PATH, { supabase: null, isSupabaseConfigured: () => false });

    // ── 1. Both visibility settings default to the intended, privacy-safe
    //    state: off, until the user explicitly opts in. ────────────────────
    {
      const diskState = { settings: { appearOnline: false, showCurrentGame: false, showCurrentServer: false } };
      global.window = makeWindowMock(diskState, []);
      const useFriendsPresence = await freshStoreModule();
      ok('the store\'s initial settings (before init()) are fully private by default', useFriendsPresence.getState().settings.appearOnline === false && useFriendsPresence.getState().settings.showCurrentGame === false);
      await useFriendsPresence.getState().init();
      ok('after init() reads a fresh, never-configured install, settings are still fully private', useFriendsPresence.getState().settings.appearOnline === false && useFriendsPresence.getState().settings.showCurrentGame === false);
      useFriendsPresence.getState().teardown();
    }

    // ── 2/3. Appear Online ON/OFF -> the real 5s poll loop's heartbeat call
    //    carries the correct value, proven with the REAL timer (not a
    //    mocked clock), matching exactly what a real user toggling the
    //    checkbox and waiting would see. ───────────────────────────────────
    {
      const diskState = { settings: { appearOnline: false, showCurrentGame: false, showCurrentServer: false } };
      const heartbeatCalls = [];
      global.window = makeWindowMock(diskState, heartbeatCalls);
      const useFriendsPresence = await freshStoreModule();
      await useFriendsPresence.getState().init();

      await useFriendsPresence.getState().updateSettings({ appearOnline: true });
      ok('REPRODUCED THE INVESTIGATION: turning Appear Online on is reflected in the store immediately', useFriendsPresence.getState().settings.appearOnline === true);
      ok('the toggle is persisted to the main-process settings store (the real IPC call), not just the renderer', diskState.settings.appearOnline === true);
      await new Promise((r) => setTimeout(r, 5500));
      ok('the real heartbeat poll loop sends appearOnline: true after the toggle', heartbeatCalls.length > 0 && heartbeatCalls[heartbeatCalls.length - 1].settings.appearOnline === true);

      await useFriendsPresence.getState().updateSettings({ appearOnline: false });
      ok('turning Appear Online back off is reflected in the store immediately', useFriendsPresence.getState().settings.appearOnline === false);
      await new Promise((r) => setTimeout(r, 5500));
      ok('the next heartbeat correctly sends appearOnline: false — never stuck on a previous true value', heartbeatCalls[heartbeatCalls.length - 1].settings.appearOnline === false);

      useFriendsPresence.getState().teardown();
    }

    // ── 4/5. Show Current Mercy Server ON/OFF -> the real heartbeat carries
    //    the correct showCurrentServer value (the UI's actual "Show Current
    //    Mercy Server" checkbox maps to this field — see Library.tsx's
    //    PRIVACY_TOGGLES; showCurrentGame is the separate "Show Current
    //    Game" checkbox, covered alongside it here too since both are part
    //    of the same reported symptom). ─────────────────────────────────────
    {
      const diskState = { settings: { appearOnline: true, showCurrentGame: false, showCurrentServer: false } };
      const heartbeatCalls = [];
      global.window = makeWindowMock(diskState, heartbeatCalls);
      const useFriendsPresence = await freshStoreModule();
      await useFriendsPresence.getState().init();

      await useFriendsPresence.getState().updateSettings({ showCurrentServer: true });
      await new Promise((r) => setTimeout(r, 5500));
      ok('REPRODUCED THE INVESTIGATION: turning Show Current Mercy Server on sends showCurrentServer: true on the next heartbeat', heartbeatCalls[heartbeatCalls.length - 1].settings.showCurrentServer === true);

      await useFriendsPresence.getState().updateSettings({ showCurrentServer: false });
      await new Promise((r) => setTimeout(r, 5500));
      ok('turning Show Current Mercy Server back off sends showCurrentServer: false on the next heartbeat', heartbeatCalls[heartbeatCalls.length - 1].settings.showCurrentServer === false);

      await useFriendsPresence.getState().updateSettings({ showCurrentGame: true });
      await new Promise((r) => setTimeout(r, 5500));
      ok('turning Show Current Game on sends showCurrentGame: true on the next heartbeat (the other, separate toggle)', heartbeatCalls[heartbeatCalls.length - 1].settings.showCurrentGame === true);

      await useFriendsPresence.getState().updateSettings({ showCurrentGame: false });
      await new Promise((r) => setTimeout(r, 5500));
      ok('turning Show Current Game back off sends showCurrentGame: false on the next heartbeat', heartbeatCalls[heartbeatCalls.length - 1].settings.showCurrentGame === false);

      useFriendsPresence.getState().teardown();
    }

    // ── 6. Persistence across a real app restart: a genuinely fresh store
    //    module instance (require cache cleared) and a fresh
    //    window.electronAPI mock instance, sharing only `diskState` (which
    //    models the real electron-store-backed file surviving a restart). ──
    {
      const diskState = { settings: { appearOnline: false, showCurrentGame: false, showCurrentServer: false } };

      // "Session 1" — first launch, user opts in.
      let calls1 = [];
      global.window = makeWindowMock(diskState, calls1);
      let useFriendsPresence = await freshStoreModule();
      await useFriendsPresence.getState().init();
      await useFriendsPresence.getState().updateSettings({ appearOnline: true, showCurrentGame: true });
      useFriendsPresence.getState().teardown();

      // "Session 2" — the app is fully closed and reopened. No further
      // toggle here: the persisted choice alone must be what a fresh
      // session picks up and sends.
      let calls2 = [];
      global.window = makeWindowMock(diskState, calls2);
      useFriendsPresence = await freshStoreModule();
      ok('a brand-new store instance starts from its own default state (not leaking session 1\'s in-memory state)', useFriendsPresence.getState().settings.appearOnline === false);
      await useFriendsPresence.getState().init();
      ok('REPRODUCED THE INVESTIGATION: after init() on a fresh session, the PERSISTED true values are picked up correctly — settings survive a real app restart', useFriendsPresence.getState().settings.appearOnline === true && useFriendsPresence.getState().settings.showCurrentGame === true);
      await new Promise((r) => setTimeout(r, 5500));
      ok('the very first heartbeat sent after reopening the app (with no further toggle) already carries the persisted true values', calls2.length > 0 && calls2[0].settings.appearOnline === true && calls2[0].settings.showCurrentGame === true);
      useFriendsPresence.getState().teardown();
    }

    // ── 7. The heartbeat retains the current settings across multiple
    //    consecutive polls — never drifts, never reverts on its own between
    //    heartbeats with no user action in between. ─────────────────────────
    {
      const diskState = { settings: { appearOnline: true, showCurrentGame: true, showCurrentServer: true } };
      const heartbeatCalls = [];
      global.window = makeWindowMock(diskState, heartbeatCalls);
      const useFriendsPresence = await freshStoreModule();
      await useFriendsPresence.getState().init();

      // Force two consecutive heartbeats a poll tick apart with no setting
      // change in between (HEARTBEAT_MIN_INTERVAL_MS is 30s in real usage,
      // but activity changes also force one — toggling a NO-OP update with
      // the same values exercises the same "force next heartbeat" path
      // without changing what should be sent).
      await useFriendsPresence.getState().updateSettings({ appearOnline: true });
      await new Promise((r) => setTimeout(r, 5500));
      const first = heartbeatCalls[heartbeatCalls.length - 1].settings;
      await useFriendsPresence.getState().updateSettings({ appearOnline: true });
      await new Promise((r) => setTimeout(r, 5500));
      const second = heartbeatCalls[heartbeatCalls.length - 1].settings;
      ok('two consecutive heartbeats with no real setting change send the identical, correct values both times', first.appearOnline === true && first.showCurrentGame === true && first.showCurrentServer === true && second.appearOnline === true && second.showCurrentGame === true && second.showCurrentServer === true);

      useFriendsPresence.getState().teardown();
    }

    restoreSupabaseMock();

    console.log(`\nPRESENCE SETTINGS -> HEARTBEAT TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
