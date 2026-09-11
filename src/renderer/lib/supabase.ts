// Supabase client for the accounts + friends/presence system.
//
// OWNER SETUP: copy .env.example to .env at the repo root and fill in your
// project's real values (Supabase → Project Settings → API) — see that file
// for exactly which variables are required. Vite only exposes env vars
// prefixed VITE_ to renderer code, and .env/.env.local are already
// gitignored, so real credentials never get hardcoded or committed. The
// anon key is meant to be public regardless — security is enforced by the
// Row Level Security policies in supabase/schema.sql and
// supabase/friends_presence_schema.sql, not by hiding this key.
//
// Until real values are supplied, these fall back to the same placeholder
// sentinel this file always used, so isSupabaseConfigured() stays false and
// the whole account/friends/presence UI stays in its existing honest
// "not deployed yet" state — unchanged local-dev behavior.
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'PASTE_YOUR_SUPABASE_URL_HERE';
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'PASTE_YOUR_SUPABASE_ANON_KEY_HERE';

export function isSupabaseConfigured(): boolean {
  return !SUPABASE_URL.startsWith('PASTE') && !SUPABASE_ANON_KEY.startsWith('PASTE');
}

// A single shared client (or null when not configured yet).
export const supabase: SupabaseClient | null = isSupabaseConfigured()
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

// Accounts are username-first. Supabase Auth keys on email, so we map each
// username to a stable internal address; the optional real email is kept in the
// profile for recovery/contact. Usernames are lowercased + stripped to keep the
// mapping deterministic (so login by username needs no pre-auth lookup).
export const AUTH_EMAIL_DOMAIN = 'users.fivembuilder.app';
export function usernameToAuthEmail(username: string): string {
  const slug = username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return `${slug}@${AUTH_EMAIL_DOMAIN}`;
}

// ── Shared types ────────────────────────────────────────────────────────────
export type Role = 'user' | 'admin' | 'owner';

export interface Profile {
  id: string;
  username: string;
  email: string | null;
  role: Role;
  created_at: string;
}

export interface Entitlement {
  id: string;
  user_id: string;
  script_id: string;
  granted_by: string | null;
  granted_at: string;
}
