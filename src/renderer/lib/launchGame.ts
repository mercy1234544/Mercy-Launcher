// "Launch Game" for a running Mercy-managed server — reuses the existing
// GameScanner detection/launch system (games.getCached()/games.launch())
// exactly as-is; this file only adds the per-game "which detected entry is
// the right one for a player's game client" selection logic. It never
// launches a dedicated-server executable (acServer.exe, a Minecraft/FiveM
// server jar/exe) — those are separate, already-running processes Mercy
// itself manages; this is specifically the PLAYER's own game client.
//
// Content Manager (a real, legitimate third-party AC launcher — see
// GameScanner.ts's own KNOWN_GAMES entry) is REQUIRED for Assetto Corsa
// multiplayer through Mercy — plain acs.exe/AssettoCorsa.exe just opens the
// single-player menu with no way to hand it a specific server to join, so
// "Launch Game" for AC never falls back to it. This used to silently do
// exactly that: pickLaunchTarget matched on the literal id 'content-manager',
// but GameScanner's own curated-direct-detection path actually produces
// 'direct-content-manager' (see GameScanner.ts's scanDirect() — every
// direct-detected entry is prefixed) — a real id never once matched here,
// so this "preference" was silent dead code and every AC launch fell
// straight through to plain Assetto Corsa. isContentManager() below matches
// on the real id pattern AND by name (so a manually-added Content Manager —
// see Library's "Add Game", which assigns a random manual-* id — is
// recognized too, not just an auto-detected one).
export type LaunchGameGameId = 'minecraft' | 'assettocorsa' | 'fivem';

function isContentManager(g: DetectedGame): boolean {
  return g.id === 'content-manager' || g.id.endsWith('-content-manager') || g.name.trim().toLowerCase() === 'content manager';
}

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
    // Content Manager only — never plain Assetto Corsa. See this file's
    // header: plain acs.exe/AssettoCorsa.exe has no way to be pointed at a
    // specific server, so falling back to it here would silently launch
    // the wrong thing rather than fail honestly. If Content Manager isn't
    // detected, the caller's notDetected path handles telling the user why.
    return games.find(isContentManager) ?? null;
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
      error: gameId === 'assettocorsa'
        ? `Mercy couldn't find Content Manager on this PC — it's required to launch Assetto Corsa multiplayer through Mercy (plain Assetto Corsa can't be pointed at a specific server). Add it from the Library ("Add Game") by selecting its executable once you know where it's installed.`
        : `Mercy couldn't find a real installed ${gameId === 'minecraft' ? 'Minecraft' : 'FiveM'} application on this PC. Add it from the Library (gear icon → Change Path) once you know where it's installed.`,
    };
  }
  return window.electronAPI.games.launch(target.id);
}
