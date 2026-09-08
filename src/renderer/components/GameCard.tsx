import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Globe2 } from 'lucide-react';
import { getGameAssets } from './gameAssets';
import { LOGO_STYLES } from './GameArt';

// The one place a Home game card is assembled. Real licensed art (see
// gameAssets.ts for the exact file paths) always wins over the illustrated
// fallback — nothing here needs to change when files are dropped in.
//
// Each card exposes two distinct, separately-clickable actions — they are
// not the same thing and must never be merged:
//   - "Manage / Create Servers" → the game's own hub, for a server the USER
//     owns/runs themselves (real today for FiveM; an honest Coming Soon
//     page for the others, same as before).
//   - "Mercy's Servers" → official servers MERCY operates, for players to
//     join. Nothing exists there yet, so it opens a real Coming Soon page
//     (MercyServers.tsx) rather than a fake server list.
export interface GameCardProps {
  id: string;
  label: string;
  path: string;
  tagline: string;
  Art: React.ComponentType;
}

// Cinematic grading applied to every card — vignette + a faint film-grain
// texture — so real photos and the illustrated fallback both read as
// "graded footage" rather than a flat image, matching a launcher's
// promotional-card look.
function CinematicGrade() {
  const id = React.useId();
  return (
    <>
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at 50% 40%, transparent 35%, rgba(0,0,0,0.5) 100%)' }} />
      <svg className="absolute inset-0 w-full h-full pointer-events-none mix-blend-overlay opacity-[0.06]">
        <filter id={`grain-${id}`}><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" /></filter>
        <rect width="100%" height="100%" filter={`url(#grain-${id})`} />
      </svg>
    </>
  );
}

export default function GameCard({ id, label, path, tagline, Art }: GameCardProps) {
  const navigate = useNavigate();
  const assets = getGameAssets(id);
  const logo = LOGO_STYLES[id];
  const mercyServersPath = `/mercy-servers/${id}`;

  return (
    <div className="group relative rounded-2xl overflow-hidden border border-overlay-6 hover:border-primary-500/40 transition-all duration-300 shadow-lg hover:shadow-glow hover:-translate-y-1 flex flex-col">
      {/* Hero art — also a click shortcut to the primary action */}
      <button onClick={() => navigate(path)} className="relative h-36 text-left shrink-0 overflow-hidden" aria-label={`Manage or create ${label} servers`}>
        <div className="absolute inset-0 transition-transform duration-500 ease-out group-hover:scale-[1.06] group-hover:brightness-110">
          {assets.background ? <img src={assets.background} alt="" className="w-full h-full object-cover" /> : <Art />}
        </div>
        {assets.overlay && <img src={assets.overlay} alt="" className="absolute inset-0 w-full h-full object-cover pointer-events-none" />}
        <CinematicGrade />
        <div className="absolute inset-0 bg-gradient-to-t from-surface-950 via-surface-950/40 to-transparent" />
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 ring-1 ring-inset ring-primary-500/30" />
        <div className="relative h-full flex items-end p-4">
          {assets.logo ? (
            <img src={assets.logo} alt={label} className="max-h-9 max-w-[75%] object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]" />
          ) : (
            <span className={`relative inline-block px-3 py-1.5 rounded-md overflow-hidden ${logo.badgeClass}`} style={{ boxShadow: '0 3px 10px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.25), inset 0 -1px 0 rgba(0,0,0,0.25)' }}>
              <span className="absolute inset-0 bg-gradient-to-b from-white/25 via-transparent to-transparent pointer-events-none" />
              <span className={`relative inline-block text-base leading-none drop-shadow ${logo.textClass}`}>{label}</span>
            </span>
          )}
        </div>
      </button>

      {/* Actions — two distinct, separately-clickable rows */}
      <div className="bg-surface-900/60 p-3.5 space-y-2 flex-1 flex flex-col justify-center">
        <p className="text-[11px] text-surface-500 -mt-0.5 mb-0.5">{tagline}</p>
        <button onClick={() => navigate(path)}
          className="w-full flex items-center justify-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl bg-primary-600 text-white hover:bg-primary-500 active:scale-[0.98] transition-all duration-150">
          Manage / Create Servers <ArrowRight size={13} />
        </button>
        <button onClick={() => navigate(mercyServersPath)}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-overlay-6 bg-overlay-3 hover:bg-overlay-6 hover:border-overlay-10 active:scale-[0.98] transition-all duration-150 text-left group/mercy">
          <span className="flex items-center gap-2 min-w-0">
            <Globe2 size={14} className="text-primary-300 shrink-0" />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-surface-100">Mercy's Servers</span>
              <span className="block text-[10px] text-surface-500 truncate">Join official Mercy servers</span>
            </span>
          </span>
          <ArrowRight size={13} className="text-surface-600 group-hover/mercy:text-primary-300 group-hover/mercy:translate-x-0.5 transition-all shrink-0" />
        </button>
      </div>
    </div>
  );
}
