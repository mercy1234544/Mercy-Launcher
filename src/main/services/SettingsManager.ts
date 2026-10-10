import Store from 'electron-store';

// Main-process-backed app preferences — the ones that need to survive
// restarts and affect main-process behavior (tray, auto-update, download
// location). Renderer-only UI prefs (theme, favorites, notifications) stay
// in localStorage next to the rest of the renderer state; this store is only
// for settings that this process itself has to read.
export interface SettingsSchema {
  minimizeToTray: boolean;
  autoUpdate: boolean;
  downloadPath: string | null;
  /** Shows the technical options (catalog address, signing keys, connection overrides). Off for everyone by default. */
  developerMode: boolean;
}

const DEFAULTS: SettingsSchema = {
  minimizeToTray: false,
  autoUpdate: true,
  downloadPath: null,
  developerMode: false,
};

export class SettingsManager {
  private store: Store<SettingsSchema>;

  constructor() {
    this.store = new Store<SettingsSchema>({ name: 'mercy-settings', defaults: DEFAULTS });
  }

  get<K extends keyof SettingsSchema>(key: K): SettingsSchema[K] {
    return this.store.get(key);
  }

  set<K extends keyof SettingsSchema>(key: K, value: SettingsSchema[K]): void {
    this.store.set(key, value);
  }

  getAll(): SettingsSchema {
    return { ...DEFAULTS, ...(this.store.store as Partial<SettingsSchema>) };
  }
}
