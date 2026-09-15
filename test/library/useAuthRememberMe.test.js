// useAuth.ts — "Remember my Mercy account" (remember parameter),
// disconnectSession() vs forgetCredential() vs the full signOut(), and the
// reactive hasSavedCredential/savedCredentialUsername display flags. Same
// require.extensions['.ts'] + module-stub technique as
// test/library/useAuthReauth.test.js.
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

function makeFakeSupabase({ profile = null } = {}) {
  const calls = { signInWithPassword: [], signUp: [], signOut: 0 };
  let currentUserId = null;
  return {
    calls,
    auth: {
      getUser: async () => ({ data: { user: currentUserId ? { id: currentUserId } : null } }),
      signInWithPassword: async (args) => { calls.signInWithPassword.push(args); if (profile) currentUserId = profile.id; return { error: null }; },
      signUp: async (args) => { calls.signUp.push(args); if (profile) currentUserId = profile.id; return { error: null }; },
      signOut: async () => { calls.signOut++; currentUserId = null; return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: (table) => ({
      select: () => ({
        eq: () => {
          if (table === 'profiles') return { single: async () => ({ data: currentUserId ? profile : null }) };
          return Promise.resolve({ data: [] });
        },
      }),
    }),
  };
}

function freshUseAuth({ supabaseClient, electronAPI }) {
  delete require.cache[AUTH_STORE_PATH];
  const restore = stubModule(SUPABASE_PATH, {
    supabase: supabaseClient,
    usernameToAuthEmail: (u) => `${u.trim().toLowerCase()}@users.fivembuilder.app`,
    isSupabaseConfigured: () => true,
  });
  global.window = { electronAPI };
  const restoreHook = installTsRequireHook();
  let mod;
  try { mod = require(AUTH_STORE_PATH); } finally { restoreHook(); }
  return { useAuth: mod.useAuth, restore };
}

function fakeCredentialsApi() {
  const calls = { save: [], clear: 0, hasStored: 0, getStoredUsername: 0 };
  let stored = null;
  return {
    calls,
    getStored: () => stored,
    mercyCredentials: {
      save: async (username, password) => { calls.save.push({ username, password }); stored = { username, password }; return true; },
      load: async () => stored,
      hasStored: async () => { calls.hasStored++; return !!stored; },
      getStoredUsername: async () => { calls.getStoredUsername++; return stored?.username ?? null; },
      clear: async () => { calls.clear++; stored = null; },
    },
  };
}

(async () => {
  try {
    // ── Remember-me CHECKED (default) saves the credential. ────────────────
    {
      const fakeSb = makeFakeSupabase({ profile: { id: 'u1', username: 'alice', email: null, role: 'user', created_at: '' } });
      const cred = fakeCredentialsApi();
      const { useAuth } = freshUseAuth({ supabaseClient: fakeSb, electronAPI: cred });
      await useAuth.getState().signIn('alice', 'correcthorse', true);
      ok('REPRODUCED THE FIX: remember=true (the default) saves the credential on a successful sign-in', cred.calls.save.length === 1 && cred.calls.save[0].username === 'alice');
      ok('hasSavedCredential reactively becomes true after a remembered sign-in', useAuth.getState().hasSavedCredential === true);
      ok('savedCredentialUsername reflects the real saved username', useAuth.getState().savedCredentialUsername === 'alice');
    }

    // ── Remember-me UNCHECKED does NOT save the credential. ─────────────────
    {
      const fakeSb = makeFakeSupabase({ profile: { id: 'u2', username: 'bob', email: null, role: 'user', created_at: '' } });
      const cred = fakeCredentialsApi();
      const { useAuth } = freshUseAuth({ supabaseClient: fakeSb, electronAPI: cred });
      await useAuth.getState().signIn('bob', 'anotherpassword', false);
      ok('REPRODUCED THE FIX: remember=false does NOT save the credential, even on a successful sign-in', cred.calls.save.length === 0);
      ok('hasSavedCredential correctly stays false when nothing was remembered', useAuth.getState().hasSavedCredential === false);
      ok('the user is still genuinely signed in even though nothing was remembered', useAuth.getState().profile?.username === 'bob');
    }

    // ── Remember-me also applies to signUp(). ───────────────────────────────
    {
      const fakeSb = makeFakeSupabase({ profile: { id: 'u3', username: 'carol', email: null, role: 'user', created_at: '' } });
      const cred = fakeCredentialsApi();
      const { useAuth } = freshUseAuth({ supabaseClient: fakeSb, electronAPI: cred });
      await useAuth.getState().signUp('carol', 'anotherpassword', undefined, false);
      ok('remember=false on signUp also skips saving the credential', cred.calls.save.length === 0);
    }

    // ── disconnectSession(): ends the session but PRESERVES the stored
    //    credential — a temporary disconnect must never silently forget a
    //    password the user explicitly asked to have remembered. ────────────
    {
      const fakeSb = makeFakeSupabase({ profile: { id: 'u4', username: 'dave', email: null, role: 'user', created_at: '' } });
      const cred = fakeCredentialsApi();
      const { useAuth } = freshUseAuth({ supabaseClient: fakeSb, electronAPI: cred });
      await useAuth.getState().signIn('dave', 'password123', true);
      ok('(setup) dave is signed in with a remembered credential', useAuth.getState().profile?.username === 'dave' && useAuth.getState().hasSavedCredential === true);

      await useAuth.getState().disconnectSession();
      ok('REPRODUCED THE FIX: disconnectSession() ends the active Mercy session', useAuth.getState().profile === null);
      ok('REPRODUCED THE FIX: disconnectSession() does NOT touch the securely-stored credential — it is still there for next time', cred.calls.clear === 0 && cred.getStored() !== null);
      ok('hasSavedCredential still correctly reports true after a mere disconnect', useAuth.getState().hasSavedCredential === true);
    }

    // ── forgetCredential(): removes ONLY the stored credential, independent
    //    of whatever session is currently active. ──────────────────────────
    {
      const fakeSb = makeFakeSupabase({ profile: { id: 'u5', username: 'eve', email: null, role: 'user', created_at: '' } });
      const cred = fakeCredentialsApi();
      const { useAuth } = freshUseAuth({ supabaseClient: fakeSb, electronAPI: cred });
      await useAuth.getState().signIn('eve', 'password123', true);

      await useAuth.getState().forgetCredential();
      ok('REPRODUCED THE FIX: forgetCredential() ("Forget saved sign-in") actually clears the stored credential', cred.calls.clear === 1 && cred.getStored() === null);
      ok('hasSavedCredential correctly flips to false', useAuth.getState().hasSavedCredential === false);
      ok('forgetCredential() does NOT sign the user out of their current, still-active session', useAuth.getState().profile?.username === 'eve');
      ok('forgetCredential() never touches the real Supabase session at all', fakeSb.calls.signOut === 0);
    }

    // ── The full signOut() ("Log out", used by Marketplace) still does BOTH
    //    — its existing, unchanged behavior. ────────────────────────────────
    {
      const fakeSb = makeFakeSupabase({ profile: { id: 'u6', username: 'frank', email: null, role: 'user', created_at: '' } });
      const cred = fakeCredentialsApi();
      const { useAuth } = freshUseAuth({ supabaseClient: fakeSb, electronAPI: cred });
      await useAuth.getState().signIn('frank', 'password123', true);
      await useAuth.getState().signOut();
      ok('Marketplace\'s existing "Log out" (signOut()) behavior is UNCHANGED: it ends the session', useAuth.getState().profile === null);
      ok('Marketplace\'s existing "Log out" behavior is UNCHANGED: it also forgets the stored credential', cred.getStored() === null);
    }

    console.log(`\nUSE AUTH REMEMBER-ME / DISCONNECT / FORGET TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
