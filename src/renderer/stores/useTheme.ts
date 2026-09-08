import { create } from 'zustand';
import { getTheme, THEMES, type ThemeTokens } from '../config/themes';

// Applies a flat map of CSS-var-name → value directly onto :root. This is
// the ONLY place that touches the DOM for theming — everything else in the
// app just reads the resulting `var(--token)` through existing Tailwind
// classes, so no component needed to change for this to work app-wide.
function applyToDom(vars: Record<string, string>) {
  const root = document.documentElement.style;
  for (const [key, value] of Object.entries(vars)) {
    if (value) root.setProperty(`--${key}`, value);
    else root.removeProperty(`--${key}`);
  }
}

function presetToFlat(tokens: ThemeTokens): Record<string, string> {
  return { ...tokens } as unknown as Record<string, string>;
}

interface ThemeState {
  activeThemeId: string;
  /** Sparse overrides on top of the active preset — bare CSS var names (no `--`), including `nav-*` keys. */
  customTokens: Record<string, string>;
  hasCustomTheme: boolean;
  avatarDataUrl: string | null;
  loaded: boolean;

  init: () => Promise<void>;
  previewPreset: (id: string) => void;
  previewToken: (key: string, value: string) => void;
  previewNavColor: (navId: string, color: string) => void;
  clearNavColor: (navId: string) => void;
  save: () => Promise<void>;
  discardChanges: () => void;
  restoreDefault: () => Promise<void>;
  pickAvatar: () => Promise<{ success: boolean; error?: string | null }>;
  removeAvatar: () => Promise<void>;
}

export const useTheme = create<ThemeState>((set, get) => ({
  activeThemeId: 'mercy-default',
  customTokens: {},
  hasCustomTheme: false,
  avatarDataUrl: null,
  loaded: false,

  init: async () => {
    let saved: { activeThemeId: string; customTokens: Record<string, string>; hasCustomTheme: boolean } | null = null;
    try { saved = await window.electronAPI?.theme?.get(); } catch {}
    const activeThemeId = saved?.activeThemeId || 'mercy-default';
    const customTokens = saved?.customTokens || {};
    applyToDom({ ...presetToFlat(getTheme(activeThemeId).tokens), ...customTokens });
    let avatarDataUrl: string | null = null;
    try { avatarDataUrl = (await window.electronAPI?.theme?.getAvatar()) ?? null; } catch {}
    set({ activeThemeId, customTokens, hasCustomTheme: !!saved?.hasCustomTheme, avatarDataUrl, loaded: true });
  },

  // "Preview" methods only touch the DOM + in-memory state — nothing is
  // persisted until save(), so the user can experiment freely and back out.
  previewPreset: (id) => {
    applyToDom(presetToFlat(getTheme(id).tokens));
    // A fresh preset clears prior custom overrides in the live preview —
    // save() will persist that as a clean preset switch.
    set({ activeThemeId: id, customTokens: {}, hasCustomTheme: false });
  },

  previewToken: (key, value) => {
    applyToDom({ [key]: value });
    set((s) => ({ customTokens: { ...s.customTokens, [key]: value }, hasCustomTheme: true }));
  },

  previewNavColor: (navId, color) => {
    const key = `nav-${navId}`;
    applyToDom({ [key]: color });
    set((s) => ({ customTokens: { ...s.customTokens, [key]: color }, hasCustomTheme: true }));
  },

  clearNavColor: (navId) => {
    const key = `nav-${navId}`;
    applyToDom({ [key]: '' });
    set((s) => {
      const next = { ...s.customTokens };
      delete next[key];
      return { customTokens: next, hasCustomTheme: Object.keys(next).length > 0 };
    });
  },

  save: async () => {
    const { activeThemeId, customTokens, hasCustomTheme } = get();
    try {
      await window.electronAPI?.theme?.setActive(activeThemeId);
      if (hasCustomTheme && Object.keys(customTokens).length > 0) await window.electronAPI?.theme?.setCustom(customTokens);
    } catch {}
  },

  discardChanges: async () => {
    // Re-read the last SAVED state from main and re-apply it, throwing away
    // any un-saved live preview.
    let saved: { activeThemeId: string; customTokens: Record<string, string>; hasCustomTheme: boolean } | null = null;
    try { saved = await window.electronAPI?.theme?.get(); } catch {}
    const activeThemeId = saved?.activeThemeId || 'mercy-default';
    const customTokens = saved?.customTokens || {};
    applyToDom({ ...presetToFlat(getTheme(activeThemeId).tokens), ...customTokens });
    set({ activeThemeId, customTokens, hasCustomTheme: !!saved?.hasCustomTheme });
  },

  restoreDefault: async () => {
    // Clear every key any previous custom edit or preset could have set —
    // both real ThemeTokens keys and nav-* overrides — before applying the
    // clean default, so nothing stale survives underneath it.
    const root = document.documentElement.style;
    const allTokenKeys = new Set<string>();
    for (const t of THEMES) for (const k of Object.keys(t.tokens)) allTokenKeys.add(k);
    for (const navId of ['home', 'library', 'downloads', 'settings', 'admin']) allTokenKeys.add(`nav-${navId}`);
    for (const key of Object.keys(get().customTokens)) allTokenKeys.add(key);
    for (const k of allTokenKeys) root.removeProperty(`--${k}`);
    applyToDom(presetToFlat(getTheme('mercy-default').tokens));
    set({ activeThemeId: 'mercy-default', customTokens: {}, hasCustomTheme: false });
    try { await window.electronAPI?.theme?.reset(); } catch {}
  },

  pickAvatar: async () => {
    try {
      const result = await window.electronAPI?.theme?.pickAvatar();
      if (result?.success && result.dataUrl) set({ avatarDataUrl: result.dataUrl });
      return { success: !!result?.success, error: result?.error };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Could not open file picker.' };
    }
  },

  removeAvatar: async () => {
    try { await window.electronAPI?.theme?.removeAvatar(); } catch {}
    set({ avatarDataUrl: null });
  },
}));
