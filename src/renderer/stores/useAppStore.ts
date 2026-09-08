// Despite the generic name, this is the FiveM server store specifically —
// `framework`/`artifactVersion`/`resourceCount` are FXServer concepts, and
// nothing here is meant to represent Minecraft/Assetto Corsa/BeamNG state.
// It also carries theme/sidebar UI state, which is a separate concern that
// ended up here historically. Left as-is rather than split/renamed: it's
// imported across ~15 files, and a rename would be pure churn with real
// regression risk for a cosmetic gain — see config/games.ts for the actual
// cross-game registry.
import { create } from 'zustand';

export interface Server {
  id: string;
  name: string;
  framework: string;
  os: string;
  database: string;
  artifactVersion: string;
  installPath: string;
  resourceCount: number;
  status: 'stopped' | 'starting' | 'running' | 'error';
  lastBackup: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActionLog {
  id: string;
  action: string;
  detail: string;
  timestamp: string;
  severity: 'info' | 'warning' | 'error' | 'success';
}

interface AppState {
  servers: Server[];
  activeServerId: string | null;
  theme: 'dark' | 'light';
  sidebarCollapsed: boolean;
  actionLog: ActionLog[];
  isElectron: boolean;

  setServers: (servers: Server[]) => void;
  setActiveServer: (id: string | null) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  addServer: (server: Server) => void;
  updateServer: (id: string, data: Partial<Server>) => void;
  removeServer: (id: string) => void;
  logAction: (action: string, detail: string, severity?: ActionLog['severity']) => void;
  getActiveServer: () => Server | undefined;
  loadFromStorage: () => void;
  saveToStorage: () => void;
}

const STORAGE_KEY = 'fivem-server-builder-state';

function loadState(): { servers: Server[]; activeServerId: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      return { servers: data.servers || [], activeServerId: data.activeServerId || null };
    }
  } catch {}
  return { servers: [], activeServerId: null };
}

function saveState(servers: Server[], activeServerId: string | null) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ servers, activeServerId }));
  } catch {}
}

export const useAppStore = create<AppState>((set, get) => {
  const initial = loadState();
  return {
    servers: initial.servers,
    activeServerId: initial.activeServerId,
    theme: (() => {
      const saved = localStorage.getItem('fivem-theme') as 'dark' | 'light' | null;
      const t = saved || 'dark';
      document.documentElement.classList.toggle('dark', t === 'dark');
      return t;
    })(),
    sidebarCollapsed: false,
    actionLog: [],
    isElectron: !!window.electronAPI,

    setServers: (servers) => {
      set({ servers });
      saveState(servers, get().activeServerId);
    },

    setActiveServer: (id) => {
      set({ activeServerId: id });
      saveState(get().servers, id);
    },

    toggleTheme: () => set((state) => {
      const newTheme = state.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', newTheme === 'dark');
      localStorage.setItem('fivem-theme', newTheme);
      return { theme: newTheme };
    }),

    toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

    addServer: (server) => {
      const servers = [...get().servers, server];
      set({ servers, activeServerId: server.id });
      saveState(servers, server.id);
    },

    updateServer: (id, data) => {
      const servers = get().servers.map(s => s.id === id ? { ...s, ...data } : s);
      set({ servers });
      saveState(servers, get().activeServerId);
    },

    removeServer: (id) => {
      const servers = get().servers.filter(s => s.id !== id);
      const activeServerId = get().activeServerId === id ? (servers[0]?.id || null) : get().activeServerId;
      set({ servers, activeServerId });
      saveState(servers, activeServerId);
    },

    logAction: (action, detail, severity = 'info') => set((state) => ({
      actionLog: [{
        id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
        action,
        detail,
        timestamp: new Date().toISOString(),
        severity,
      }, ...state.actionLog].slice(0, 100),
    })),

    getActiveServer: () => {
      const state = get();
      return state.servers.find(s => s.id === state.activeServerId);
    },

    loadFromStorage: () => {
      const data = loadState();
      set({ servers: data.servers, activeServerId: data.activeServerId });
    },

    saveToStorage: () => {
      saveState(get().servers, get().activeServerId);
    },
  };
});
