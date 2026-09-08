import type { ComponentType } from 'react';
import { Car, Blocks, FlagTriangleRight, Truck } from 'lucide-react';
import { FiveMArt, MinecraftArt, AssettoCorsaArt, BeamNGArt } from '../components/GameArt';

// Single source of truth for "what games does Mercy Launcher know about."
// Before this existed, the same four games (id/label/path/icon/color/art)
// were declared separately in Home.tsx, Settings.tsx, Library.tsx, and
// MercyServers.tsx, each with its own slightly different shape — adding a
// fifth game meant touching all four and hoping nothing drifted. This is the
// one place that changes now; everything else reads from it.
//
// `hasRealHub: false` is the only thing that gates a game into "Coming Soon"
// treatment — flip it once a real hub exists for that game (the way FiveM's
// already is) and every consumer below picks it up automatically.
export type GameId = 'fivem' | 'minecraft' | 'assettocorsa' | 'beamng';

export interface GameDef {
  id: GameId;
  label: string;
  /** Route to the game's own hub — a real one for FiveM, ComingSoon for the rest. */
  path: string;
  hasRealHub: boolean;
  icon: ComponentType<{ size?: number | string; className?: string }>;
  /** Icon-only color, e.g. for a plain <Icon className={tint} />. */
  tint: string;
  /** Full icon-badge treatment: bg + border + text color together. */
  tintBadge: string;
  /** Illustrated hero fallback used when no real art file is dropped in (see gameAssets.ts). */
  Art: ComponentType;
  tagline: string;
}

export const GAMES: GameDef[] = [
  {
    id: 'fivem', label: 'FiveM', path: '/fivem', hasRealHub: true,
    icon: Car, tint: 'text-orange-300', tintBadge: 'bg-orange-500/15 border-orange-500/25 text-orange-300',
    Art: FiveMArt, tagline: 'Manage your FiveM servers.',
  },
  {
    id: 'minecraft', label: 'Minecraft', path: '/minecraft', hasRealHub: true,
    icon: Blocks, tint: 'text-emerald-300', tintBadge: 'bg-emerald-500/15 border-emerald-500/25 text-emerald-300',
    Art: MinecraftArt, tagline: 'Manage your Minecraft servers.',
  },
  {
    id: 'assettocorsa', label: 'Assetto Corsa', path: '/assetto-corsa', hasRealHub: false,
    icon: FlagTriangleRight, tint: 'text-rose-300', tintBadge: 'bg-rose-500/15 border-rose-500/25 text-rose-300',
    Art: AssettoCorsaArt, tagline: 'Manage your Assetto Corsa servers.',
  },
  {
    id: 'beamng', label: 'BeamNG.drive', path: '/beamng', hasRealHub: false,
    icon: Truck, tint: 'text-sky-300', tintBadge: 'bg-sky-500/15 border-sky-500/25 text-sky-300',
    Art: BeamNGArt, tagline: 'Manage your BeamNG.drive servers.',
  },
];

export function getGame(id: string | undefined): GameDef | undefined {
  return GAMES.find((g) => g.id === id);
}

export function mercyServersPath(id: string): string {
  return `/mercy-servers/${id}`;
}
