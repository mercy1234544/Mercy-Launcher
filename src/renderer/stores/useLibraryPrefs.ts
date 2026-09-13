import { create } from 'zustand';

// Renderer-only UI preference (same persisted-localStorage pattern as
// useFavorites.ts) — the main process never needs to know whether this
// section is shown, so this deliberately does NOT go through
// SettingsManager (that store is reserved for prefs the main process
// itself has to read; see its own header comment).
const STORAGE_KEY = 'mercy-library-prefs';

interface LibraryPrefs {
  showDetectedApps: boolean;
}

function load(): LibraryPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { showDetectedApps: true, ...JSON.parse(raw) };
  } catch {}
  // Defaults to shown — this section already existed and was always
  // visible before this preference existed, so defaulting to hidden would
  // be a silent regression for every current user.
  return { showDetectedApps: true };
}

function save(prefs: LibraryPrefs) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch {}
}

interface LibraryPrefsState extends LibraryPrefs {
  setShowDetectedApps: (v: boolean) => void;
}

export const useLibraryPrefs = create<LibraryPrefsState>((set, get) => ({
  ...load(),
  setShowDetectedApps: (v) => {
    set({ showDetectedApps: v });
    save({ showDetectedApps: v });
  },
}));
