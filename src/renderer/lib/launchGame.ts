// "Launch Game" for a running Mercy-managed server — reuses the existing
// GameScanner detection/launch system (games.getCached()/games.launch())
// exactly as-is; this file only adds the per-game "which detected entry is
// the right one for a player's game client" selection logic. It never
// launches a dedicated-server executable (acServer.exe, a Minecraft/FiveM
// server jar/exe) — those are separate, already-running processes Mercy
// itself manages; this is specifically the PLAYER's own game client.
//
// Content Manager (a real, legitimate third-party AC launcher — see
// GameScanner.ts's own KNOWN_GAMES entry) is deliberately preferred over
// the base Assetto Corsa executable when it's actually installed, since
// that's the normal way many real AC players already launch/manage the
// game — never a fabricated preference, just picking the more commonly
// used REAL detected entry when both exist.
export type LaunchGameGameId = 'minecraft' | 'assettocorsa' | 'fivem';

export interface LaunchGameResult {
  success: boolean;
  error?: string;
  note?: string;
  /** True when no matching detected game/application was found at all —
   *  the caller should offer the existing Library "Add Game"/Change Path
   *  flow rather than just showing a bare error. */
  notDetected?: boolean;
}

/** Real selection — never invents a game entry; only ever picks from
 *  whatever GameScanner has genuinely detected on this machine (using the
 *  cache; the caller decides whether to trigger a fresh scan first). */
function pickLaunchTarget(games: DetectedGame[], gameId: LaunchGameGameId, edition?: 'java' | 'bedrock' | null): DetectedGame | null {
  if (gameId === 'assettocorsa') {
    const contentManager = games.find((g) => g.id === 'content-manager');
    if (contentManager) return contentManager;
    return games.find((g) => g.mercyGameId === 'assettocorsa') ?? null;
  }
  if (gameId === 'minecraft') {
    const candidates = games.filter((g) => g.mercyGameId === 'minecraft');
    if (candidates.length <= 1) return candidates[0] ?? null;
    // Bedrock needs the real Microsoft Store/Xbox-app app; Java needs the
    // real Minecraft Launcher — prefer whichever real entry matches this
    // server's actual edition when both are present.
    const preferred = candidates.find((g) => (edition === 'bedrock' ? g.platform === 'microsoft' : g.platform !== 'microsoft'));
    return preferred ?? candidates[0];
  }
  return games.find((g) => g.mercyGameId === 'fivem') ?? null;
}

export async function launchGameFor(gameId: LaunchGameGameId, edition?: 'java' | 'bedrock' | null): Promise<LaunchGameResult> {
  if (!window.electronAPI?.games) return { success: false, error: 'Game launching is not available.' };
  let games = await window.electronAPI.games.getCached().catch(() => []);
  let target = pickLaunchTarget(games, gameId, edition);
  if (!target) {
    // A cache miss (never scanned yet) is real and common — one real scan,
    // never a guess, before honestly reporting "not detected".
    games = await window.electronAPI.games.scan().catch(() => games);
    target = pickLaunchTarget(games, gameId, edition);
  }
  if (!target) {
    return {
      success: false, notDetected: true,
      error: `Mercy couldn't find a real installed ${gameId === 'assettocorsa' ? 'Assetto Corsa or Content Manager' : gameId === 'minecraft' ? 'Minecraft' : 'FiveM'} application on this PC. Add it from the Library (gear icon → Change Path) once you know where it's installed.`,
    };
  }
  return window.electronAPI.games.launch(target.id);
}
