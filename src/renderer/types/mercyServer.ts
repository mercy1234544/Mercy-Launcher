// Data shape for Mercy's Servers — official servers Mercy will eventually
// operate, separate from the servers a user creates/manages themselves in
// each game's hub. Defined now so a future server list can be dropped in
// without redesigning MercyServers.tsx or the Home game cards; nothing here
// is populated with fake data — see MercyServers.tsx.
import type { GameId } from '../config/games';
export type MercyGameId = GameId;

export interface MercyServerRequiredContent {
  id: string;
  name: string;
  required: boolean;
}

export interface MercyServer {
  id: string;
  name: string;
  game: MercyGameId;
  description: string;
  status: 'online' | 'offline' | 'maintenance';
  players: number;
  maxPlayers: number;
  /** Connect info (e.g. IP:port for FiveM) — never shown until a server is real. */
  address?: string;
  version?: string;
  requiredContent: MercyServerRequiredContent[];
  joinInstructions?: string;
}
