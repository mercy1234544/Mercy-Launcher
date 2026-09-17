// Centralised app-wide auth state. Both the access gate and the title-bar
// account surface read from here, so there's a single source of truth and a
// single revalidation timer. The session token itself never reaches the
// renderer — this only holds the boolean/username the main process returns.
import { create } from 'zustand';

export interface AppAuthStatus {
  enabled: boolean;
  authorized: boolean;
  username?: string;
  reason?: string;
  stale?: boolean;
  expiresAt?: number;
  entitlements?: string[]; // future: per-feature access; absent => authorized means full access
  /** Verified Discord snowflake ID (see VSAuthStatus in VehicleStudioAuth.ts
   *  for why this is trustworthy). Friends & Presence uses this as the
   *  user's identity instead of a separate Mercy account. */
  discordId?: string;
  /** Discord avatar hash — combine with discordId to build a CDN URL
   *  (https://cdn.discordapp.com/avatars/{discordId}/{discordAvatar}.png). */
  discordAvatar?: string;
}

interface AppAuthState {
  status: AppAuthStatus | null;
  loading: boolean;
  inited: boolean;
  init: () => void;
  refresh: () => Promise<void>;
  startLogin: () => Promise<void>;
  redeem: (code: string) => Promise<{ ok: boolean; username?: string; error?: string; message?: string }>;
  signOut: () => Promise<void>;
  hasEntitlement: (key: string) => boolean;
}

let revalidateTimer: ReturnType<typeof setInterval> | null = null;

export const useAppAuth = create<AppAuthState>((set, get) => ({
  status: null,
  loading: true,
  inited: false,

  init: () => {
    if (get().inited) return;
    set({ inited: true });
    get().refresh();
    if (revalidateTimer) clearInterval(revalidateTimer);
    // Periodic revalidation — catches server-side revocation / expiry.
    revalidateTimer = setInterval(() => get().refresh(), 2 * 60 * 1000);
  },

  refresh: async () => {
    try {
      const s = await window.electronAPI?.vsAuth?.status();
      set({ status: s || { enabled: false, authorized: true }, loading: false });
    } catch {
      // No IPC (e.g. browser preview) → treat as open so dev/preview isn't blocked.
      set({ status: { enabled: false, authorized: true }, loading: false });
    }
  },

  startLogin: async () => { try { await window.electronAPI?.vsAuth?.startLogin(); } catch {} },

  redeem: async (code: string) => {
    const r = await window.electronAPI.vsAuth.redeem(code);
    if (r.ok) await get().refresh();
    return r;
  },

  signOut: async () => { try { await window.electronAPI?.vsAuth?.logout(); } catch {} await get().refresh(); },

  // Future-ready: with no entitlements field, authorized === full access.
  hasEntitlement: (key: string) => {
    const st = get().status;
    if (!st) return false;
    if (!st.entitlements) return st.authorized;
    return st.entitlements.includes(key);
  },
}));

// Dev-only handle for testing the gate in the browser preview. Dead-code
// eliminated from production builds (import.meta.env.DEV === false there).
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) (window as any).__appAuth = useAppAuth;
