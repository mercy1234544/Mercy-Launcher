import { create } from 'zustand';

// Assetto Corsa's own server list — separate from useAppStore (FiveM) and
// useMinecraftStore, matching the established one-store-per-game pattern.
interface AssettoCorsaState {
  servers: AssettoCorsaServer[];
  setServers: (servers: AssettoCorsaServer[]) => void;
  upsertServer: (server: AssettoCorsaServer) => void;
  removeServer: (id: string) => void;
}

export const useAssettoCorsaStore = create<AssettoCorsaState>((set, get) => ({
  servers: [],
  setServers: (servers) => set({ servers }),
  upsertServer: (server) => {
    const existing = get().servers.some((s) => s.id === server.id);
    set({ servers: existing ? get().servers.map((s) => (s.id === server.id ? server : s)) : [...get().servers, server] });
  },
  removeServer: (id) => set({ servers: get().servers.filter((s) => s.id !== id) }),
}));
