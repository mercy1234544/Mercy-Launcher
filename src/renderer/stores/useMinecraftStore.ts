import { create } from 'zustand';

// Minecraft's own server list — deliberately separate from useAppStore
// (which is documented as FiveM-specific; see its own header comment).
interface MinecraftState {
  servers: MinecraftServer[];
  setServers: (servers: MinecraftServer[]) => void;
  upsertServer: (server: MinecraftServer) => void;
  removeServer: (id: string) => void;
}

export const useMinecraftStore = create<MinecraftState>((set, get) => ({
  servers: [],
  setServers: (servers) => set({ servers }),
  upsertServer: (server) => {
    const existing = get().servers.some((s) => s.id === server.id);
    set({ servers: existing ? get().servers.map((s) => (s.id === server.id ? server : s)) : [...get().servers, server] });
  },
  removeServer: (id) => set({ servers: get().servers.filter((s) => s.id !== id) }),
}));
