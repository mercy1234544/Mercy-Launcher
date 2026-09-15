// Account/auth state for the store's Exclusive access + Admin Panel.
// Talks to Supabase (see src/renderer/lib/supabase.ts). All methods no-op
// safely when Supabase isn't configured yet.
import { create } from 'zustand';
import { supabase, usernameToAuthEmail, Profile, Role, isSupabaseConfigured } from '../lib/supabase';

interface AuthState {
  initialized: boolean;
  loading: boolean;
  profile: Profile | null;          // logged-in account (null = signed out)
  entitlements: string[];           // script_ids this account can download
  /** True only after a securely-stored credential (see
   *  MercyCredentialStore.ts) was actually tried and Supabase rejected it —
   *  a real, distinct "your saved sign-in stopped working" state, never
   *  confused with "never signed in at all". Cleared on the next successful
   *  sign-in. */
  reauthFailed: boolean;
  /** Whether a securely-stored credential currently exists — a display-only
   *  flag (kept in sync by refreshSavedCredentialFlag(), never gated behind
   *  decrypting anything) for UI like "a saved sign-in exists for X". */
  hasSavedCredential: boolean;
  /** The saved credential's username, WITHOUT ever decrypting the password
   *  — for "Remembered sign-in: <username>" display only. */
  savedCredentialUsername: string | null;

  init: () => Promise<void>;
  /** `remember` (default true — closest to this app's prior always-remember
   *  behavior) controls ONLY whether a successful sign-in/sign-up securely
   *  saves the credential for next launch; it never changes how the actual
   *  Supabase authentication itself works. */
  signUp: (username: string, password: string, email?: string, remember?: boolean) => Promise<{ error?: string }>;
  signIn: (username: string, password: string, remember?: boolean) => Promise<{ error?: string }>;
  /** Full "Log out" — ends the Supabase session AND forgets any securely
   *  stored credential. This is the existing behavior Marketplace's "Log
   *  out" button already relies on and must keep relying on unchanged. */
  signOut: () => Promise<void>;
  /** "Disconnect Mercy Account" — ends the CURRENT Supabase session only.
   *  Deliberately does NOT touch a securely-stored credential: a temporary
   *  disconnect (or the app simply restarting) must never silently forget a
   *  password the user explicitly asked to have remembered. Only an
   *  explicit forgetCredential() (or the full signOut()) does that. */
  disconnectSession: () => Promise<void>;
  /** "Forget saved sign-in" — removes ONLY the securely-stored credential,
   *  never touching whatever Supabase session may currently be active. */
  forgetCredential: () => Promise<void>;
  /** Re-reads hasSavedCredential from the real secure store (cheap — never
   *  decrypts the password) after any action that could have changed it. */
  refreshSavedCredentialFlag: () => Promise<void>;
  refresh: () => Promise<void>;

  // Admin/owner actions (RLS enforces who may actually do these).
  searchUsers: (query: string) => Promise<Profile[]>;
  getUserEntitlements: (userId: string) => Promise<string[]>;
  grant: (userId: string, scriptId: string) => Promise<{ error?: string }>;
  revoke: (userId: string, scriptId: string) => Promise<{ error?: string }>;
  setRole: (userId: string, role: Role) => Promise<{ error?: string }>;
}

const friendly = (msg?: string): string => {
  const m = (msg || '').toLowerCase();
  if (m.includes('already registered') || m.includes('already exists')) return 'That username is already taken.';
  if (m.includes('invalid login')) return 'Wrong username or password.';
  if (m.includes('password')) return 'Password must be at least 6 characters.';
  if (m.includes('row-level security') || m.includes('violates')) return 'You do not have permission to do that.';
  return msg || 'Something went wrong. Try again.';
};

async function loadProfileAndEntitlements(): Promise<{ profile: Profile | null; entitlements: string[] }> {
  if (!supabase) return { profile: null, entitlements: [] };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { profile: null, entitlements: [] };

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, username, email, role, created_at')
    .eq('id', user.id)
    .single();

  const { data: ents } = await supabase
    .from('entitlements')
    .select('script_id')
    .eq('user_id', user.id);

  return {
    profile: (profile as Profile) ?? null,
    entitlements: (ents ?? []).map((e: any) => e.script_id),
  };
}

// One-shot per app session — set the instant a stored-credential reauth
// attempt is made (success or failure), so a bad/rotated saved password can
// never turn into a silent retry storm against Supabase. A genuinely new
// attempt only happens after a fresh app launch.
let attemptedStoredReauth = false;

export const useAuth = create<AuthState>((set, get) => ({
  initialized: false,
  loading: false,
  profile: null,
  entitlements: [],
  reauthFailed: false,
  hasSavedCredential: false,
  savedCredentialUsername: null,

  init: async () => {
    if (!isSupabaseConfigured() || !supabase) { set({ initialized: true }); return; }
    const { profile, entitlements } = await loadProfileAndEntitlements();
    set({ profile, entitlements, initialized: true });
    await get().refreshSavedCredentialFlag();
    // React to token refresh / sign-in / sign-out from other tabs or flows.
    supabase.auth.onAuthStateChange(async () => {
      const next = await loadProfileAndEntitlements();
      set({ profile: next.profile, entitlements: next.entitlements });
    });

    // The normal Supabase session-restore path above (getUser(), backed by
    // the persisted session + autoRefreshToken) already covers the common
    // case. Only when that finds NO valid session at all do we fall back to
    // a securely-stored username/password (see MercyCredentialStore.ts) —
    // and only ONCE per app launch, never a repeating loop. A real,
    // reproduced bug this avoids: showing "Please sign in again" for a user
    // who is genuinely still logged into the launcher's separate Discord/
    // Vehicle Studio access gate but never actually connected a Mercy
    // account session for Friends/Presence.
    if (!profile && !attemptedStoredReauth) {
      attemptedStoredReauth = true;
      try {
        const stored = await window.electronAPI?.mercyCredentials?.load?.();
        if (stored) {
          // Preserve whatever "remember" choice already produced this saved
          // credential — a successful automatic reauth re-saves the exact
          // same thing, a failed one leaves it alone (see forgetCredential()
          // for the only path that actually removes it).
          const result = await get().signIn(stored.username, stored.password, true);
          set({ reauthFailed: !!result.error });
        }
      } catch { /* no secure storage / IPC unavailable — stay signed out honestly */ }
    }
  },

  signUp: async (username, password, email, remember = true) => {
    if (!supabase) return { error: 'Accounts are not set up yet.' };
    set({ loading: true });
    try {
      const { error } = await supabase.auth.signUp({
        email: usernameToAuthEmail(username),
        password,
        options: { data: { username: username.trim(), email: email?.trim() || null } },
      });
      if (error) return { error: friendly(error.message) };
      const next = await loadProfileAndEntitlements();
      set({ profile: next.profile, entitlements: next.entitlements, reauthFailed: false });
      // Best-effort — a machine with no OS secure-storage available (see
      // MercyCredentialStore.save()'s own return value) just means the
      // password isn't remembered next launch, never a hard failure here.
      if (remember) await window.electronAPI?.mercyCredentials?.save?.(username.trim(), password).catch(() => {});
      await get().refreshSavedCredentialFlag();
      return {};
    } finally { set({ loading: false }); }
  },

  signIn: async (username, password, remember = true) => {
    if (!supabase) return { error: 'Accounts are not set up yet.' };
    set({ loading: true });
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: usernameToAuthEmail(username),
        password,
      });
      if (error) return { error: friendly(error.message) };
      const next = await loadProfileAndEntitlements();
      set({ profile: next.profile, entitlements: next.entitlements, reauthFailed: false });
      if (remember) await window.electronAPI?.mercyCredentials?.save?.(username.trim(), password).catch(() => {});
      await get().refreshSavedCredentialFlag();
      return {};
    } finally { set({ loading: false }); }
  },

  signOut: async () => {
    await supabase?.auth.signOut();
    // Full "Log out" (Marketplace's existing button) also forgets the
    // securely-stored credential — this is the app's original, unchanged
    // sign-out behavior. Friends & Presence's own "Disconnect Mercy
    // Account" deliberately uses disconnectSession() instead, which does
    // NOT do this (see that method's own comment for why).
    await window.electronAPI?.mercyCredentials?.clear?.().catch(() => {});
    set({ profile: null, entitlements: [], reauthFailed: false });
    await get().refreshSavedCredentialFlag();
  },

  disconnectSession: async () => {
    await supabase?.auth.signOut();
    set({ profile: null, entitlements: [], reauthFailed: false });
    // Deliberately no mercyCredentials.clear() here — see this method's own
    // doc comment on AuthState. The saved credential (if any) is untouched
    // and will be used again on the next automatic reauth or the next time
    // the user clicks Connect.
  },

  forgetCredential: async () => {
    await window.electronAPI?.mercyCredentials?.clear?.().catch(() => {});
    await get().refreshSavedCredentialFlag();
  },

  refreshSavedCredentialFlag: async () => {
    try {
      const has = await window.electronAPI?.mercyCredentials?.hasStored?.();
      const username = has ? await window.electronAPI?.mercyCredentials?.getStoredUsername?.() : null;
      set({ hasSavedCredential: !!has, savedCredentialUsername: username ?? null });
    } catch {
      set({ hasSavedCredential: false, savedCredentialUsername: null });
    }
  },

  refresh: async () => {
    const next = await loadProfileAndEntitlements();
    set({ profile: next.profile, entitlements: next.entitlements });
  },

  searchUsers: async (query) => {
    if (!supabase) return [];
    const q = query.trim();
    let req = supabase.from('profiles').select('id, username, email, role, created_at').order('created_at', { ascending: false }).limit(30);
    if (q) req = supabase.from('profiles').select('id, username, email, role, created_at').ilike('username', `%${q}%`).limit(30);
    const { data } = await req;
    return (data as Profile[]) ?? [];
  },

  getUserEntitlements: async (userId) => {
    if (!supabase) return [];
    const { data } = await supabase.from('entitlements').select('script_id').eq('user_id', userId);
    return (data ?? []).map((e: any) => e.script_id);
  },

  grant: async (userId, scriptId) => {
    if (!supabase) return { error: 'Not set up.' };
    const me = get().profile?.id ?? null;
    const { error } = await supabase.from('entitlements')
      .upsert({ user_id: userId, script_id: scriptId, granted_by: me }, { onConflict: 'user_id,script_id', ignoreDuplicates: true });
    if (error) return { error: friendly(error.message) };
    return {};
  },

  revoke: async (userId, scriptId) => {
    if (!supabase) return { error: 'Not set up.' };
    const { error } = await supabase.from('entitlements').delete().eq('user_id', userId).eq('script_id', scriptId);
    if (error) return { error: friendly(error.message) };
    return {};
  },

  setRole: async (userId, role) => {
    if (!supabase) return { error: 'Not set up.' };
    const { error } = await supabase.from('profiles').update({ role }).eq('id', userId);
    if (error) return { error: friendly(error.message) };
    return {};
  },
}));
