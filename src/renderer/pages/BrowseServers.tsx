import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Compass, ArrowLeft, Server } from 'lucide-react';
import { GAMES, type GameDef } from '../config/games';

// Honest landing state for the "Browse Servers" quick action. Real
// server discovery isn't built for any game yet — this says so plainly,
// per game, rather than showing fabricated server listings. Pick a game
// first (mirrors how the rest of the app is organized by game), then see
// the same honest "not built yet" message scoped to that game.
export default function BrowseServers() {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<GameDef | null>(null);

  return (
    <div className="h-full flex items-center justify-center p-7">
      <div className="max-w-lg w-full text-center">
        <div className="w-16 h-16 rounded-2xl bg-orange-500/15 border border-orange-500/25 flex items-center justify-center mx-auto mb-5">
          <Compass size={28} className="text-orange-300" />
        </div>
        <h1 className="text-2xl font-extrabold text-surface-100">Browse Servers</h1>

        {!picked ? (
          <>
            <p className="text-sm text-surface-400 mt-2 leading-relaxed">Which game do you want to find servers for?</p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              {GAMES.map((g) => (
                <button key={g.id} onClick={() => setPicked(g)}
                  className="flex items-center gap-3 p-3.5 rounded-xl border border-overlay-6 bg-surface-900/40 hover:bg-overlay-4 hover:border-primary-500/30 transition-all text-left">
                  <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${g.tintBadge}`}><g.icon size={18} /></div>
                  <p className="text-sm font-semibold text-surface-100">{g.label}</p>
                </button>
              ))}
            </div>
            <div className="mt-6">
              <button onClick={() => navigate('/')} className="btn-secondary text-xs py-2 flex items-center gap-1.5 mx-auto"><ArrowLeft size={13} /> Back to Home</button>
            </div>
          </>
        ) : (
          <>
            <span className="inline-block text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-overlay-6 text-surface-400 border border-overlay-10 mt-3 mb-3">Coming Soon</span>
            <p className="text-sm text-surface-400 leading-relaxed">
              Real-time {picked.label} server discovery — with player counts, ping, and one-click join — is planned for a follow-up update. It isn't built yet, so there's nothing live to show here.
            </p>
            <div className="mt-6 flex items-center justify-center gap-2">
              <button onClick={() => navigate('/my-servers')} className="btn-primary text-xs py-2 flex items-center gap-1.5"><Server size={13} /> Go to My Servers</button>
              <button onClick={() => setPicked(null)} className="btn-secondary text-xs py-2 flex items-center gap-1.5"><ArrowLeft size={13} /> Choose a different game</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
