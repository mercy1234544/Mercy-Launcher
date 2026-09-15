// useAuth.ts — secure credential save on sign-in, one-shot stored-credential
// reauth on init(), and credential clearing on sign-out. Uses the same
// require.extensions['.ts'] + module-stub technique established in
// test/presence/friendsPresenceStore.test.js for testing a real zustand
// store's actual logic (not a source-text guess) against a scripted fake
// of its dependencies.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const AUTH_STORE_PATH = path.resolve(__dirname, '../../src/renderer/stores/useAuth.ts');
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

// A real, STATEFUL fake — mirrors what a real Supabase client actually
// does: a successful signInWithPassword()/signUp() genuinely changes what
// the NEXT getUser() call sees, and signOut() genuinely clears it. A
// static/fixed getUser() return value would falsely fail every test that
// signs in and then expects the resulting profile to actually load.
function makeFakeSupabase({ initiallySignedIn = false, signInImpl, signUpImpl, profile = null, entitlements = [] } = {}) {
  const calls = { signInWithPassword: [], signUp: [], signOut: 0 };
  let currentUserId = initiallySignedIn && profile ? profile.id : null;
  return {
    calls,
    auth: {
      getUser: async () => ({ data: { user: currentUserId ? { id: currentUserId } : null } }),
      signInWithPassword: async (args) => {
        calls.signInWithPassword.push(args);
        const result = signInImpl ? signInImpl(args) : { error: null };
        if (!result.error && profile) currentUserId = profile.id;
        return result;
      },
      signUp: async (args) => {
        calls.signUp.push(args);
        const result = signUpImpl ? signUpImpl(args) : { error: null };
        if (!result.error && profile) currentUserId = profile.id;
        return result;
      },
      signOut: async () => { calls.signOut++; currentUserId = null; return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: (table) => ({
      select: () => ({
        eq: () => {
          if (table === 'profiles') return { single: async () => ({ data: currentUserId ? profile : null }) };
          return Promise.resolve({ data: currentUserId ? entitlements : [] });
        },
      }),
    }),
  };
}

function freshUseAuth({ supabaseClient, electronAPI }) {
  delete require.cache[AUTH_STORE_PATH];
  const restoreSupabaseMock = stubModule(SUPABASE_PATH, {
    supabase: supabaseClient,
    usernameToAuthEmail: (u) => `${u.trim().toLowerCase()}@users.fivembuilder.app`,
    isSupabaseConfigured: () => true,
  });
  global.window = { electronAPI };
  const restoreHook = installTsRequireHook();
  let mod;
  try { mod = require(AUTH_STORE_PATH); } finally { restoreHook(); }
  return { useAuth: mod.useAuth, restore: () => restoreSupabaseMock() };
}

function fakeCredentialsApi(initial = {}) {
  const calls = { save: [], load: 0, hasStored: 0, clear: 0 };
  let stored = initial.stored || null;
  return {
    calls,
    mercyCredentials: {
      save: async (username, password) => { calls.save.push({ username, password }); stored = { username, password }; return true; },
      load: async () => { calls.load++; return stored; },
      hasStored: async () => { calls.hasStored++; return !!stored; },
      getStoredUsername: async () => stored?.username ?? null,
      clear: async () => { calls.clear++; stored = null; },
    },
  };
}

(async () => {
  try {
    // ── Successful signIn saves the credential securely. ──────────────────
    {
      const fakeSb = makeFakeSupabase({ profile: { id: 'u1', username: 'alice', email: null, role: 'user', created_at: '' } });
      const cred = fakeCredentialsApi();
      const { useAuth } = freshUseAuth({ supabaseClient: fakeSb, electronAPI: cred });
      const result = await useAuth.getState().signIn('alice', 'correcthorse');
      ok('a successful signIn resolves with no error', !result.error);
      ok('signIn populates the real profile from Supabase', useAuth.getState().profile?.username === 'alice');
      ok('REPRODUCED THE FIX: a successful signIn securely saves the credential via the injected secure store, never localStorage', cred.calls.save.length === 1 && cred.calls.save[0].username === 'alice' && cred.calls.save[0].password === 'correcthorse');
    }

    // ── Successful signUp also saves the credential (same one Mercy
    //    account system, not a separate Friends account). ─────────────────
    {
      const fakeSb = makeFakeSupabase({ profile: { id: 'u2', username: 'bob', email: null, role: 'user', created_at: '' } });
      const cred = fakeCredentialsApi();
      const { useAuth } = freshUseAuth({ supabaseClient: fakeSb, electronAPI: cred });
      await useAuth.getState().signUp('bob', 'anotherpassword');
      ok('signUp also securely saves the credential', cred.calls.save.length === 1 && cred.calls.save[0].username === 'bob');
    }

    // ── signOut clears the securely-stored credential (Disconnect). ───────
    {
      const fakeSb = makeFakeSupabase({ profile: { id: 'u3', username: 'carol', email: null, role: 'user', created_at: '' } });
      const cred = fakeCredentialsApi({ stored: { username: 'carol', password: 'x' } });
      const { useAuth } = freshUseAuth({ supabaseClient: fakeSb, electronAPI: cred });
      await useAuth.getState().signIn('carol', 'x');
      await useAuth.getState().signOut();
      ok('signOut (Disconnect) clears the real Supabase session', useAuth.getState().profile === null);
      ok('REPRODUCED THE FIX: signOut also securely forgets the stored credential', cred.calls.clear === 1);
    }

    // ── init(): no session at all, no stored credential -> stays signed
    //    out honestly, no reauth attempt made. ─────────────────────────────
    {
      const fakeSb = makeFakeSupabase();
      const cred = fakeCredentialsApi();
      const { useAuth } = freshUseAuth({ supabaseClient: fakeSb, electronAPI: cred });
      await useAuth.getState().init();
      ok('with no session and no stored credential, profile stays null (honestly signed out)', useAuth.getState().profile === null);
      ok('reauthFailed is not set when there was nothing to even try', useAuth.getState().reauthFailed === false);
    }

    // ── init(): no session, but a securely-stored credential exists and is
    //    still valid -> ONE automatic reauth attempt, succeeds. ────────────
    {
      const fakeSb = makeFakeSupabase({
        profile: { id: 'u4', username: 'dave', email: null, role: 'user', created_at: '' },
      });
      const cred = fakeCredentialsApi({ stored: { username: 'dave', password: 'still-good' } });
      const { useAuth } = freshUseAuth({ supabaseClient: fakeSb, electronAPI: cred });
      await useAuth.getState().init();
      ok('REPRODUCED THE FIX: a valid stored credential is used to automatically restore the session, no restart or re-typing needed', useAuth.getState().profile?.username === 'dave');
      ok('exactly one signIn attempt was made using the real stored credential', fakeSb.calls.signInWithPassword.length === 1);
      ok('reauthFailed is false after a successful automatic reauth', useAuth.getState().reauthFailed === false);
    }

    // ── init(): stored credential exists but is no longer valid -> ONE
    //    attempt, fails cleanly, reauthFailed is set, no retry storm. ──────
    {
      const fakeSb = makeFakeSupabase({
        signInImpl: () => ({ error: { message: 'Invalid login credentials' } }),
      });
      const cred = fakeCredentialsApi({ stored: { username: 'eve', password: 'stale-password' } });
      const { useAuth } = freshUseAuth({ supabaseClient: fakeSb, electronAPI: cred });
      await useAuth.getState().init();
      ok('REPRODUCED THE FIX: a rejected stored credential leaves the user honestly signed out, not a fake success', useAuth.getState().profile === null);
      ok('REPRODUCED THE FIX: reauthFailed is set to a distinct true, never confused with "never signed in"', useAuth.getState().reauthFailed === true);
      ok('exactly one signIn attempt was made — never a retry loop within init()', fakeSb.calls.signInWithPassword.length === 1);

      // Calling init() again (e.g. a second mount) must NOT hammer the
      // server again this session — the one-shot module-level guard.
      await useAuth.getState().init();
      ok('REPRODUCED THE FIX: a second init() call does NOT attempt the rejected credential again — no endless reconnect loop', fakeSb.calls.signInWithPassword.length === 1);
    }

    console.log(`\nUSE AUTH REAUTH TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
