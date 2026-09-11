// Game Library scanner — detects games actually installed on this
// computer, independent of whether Mercy has server-management support for
// them. A detected game and a Mercy-supported game are deliberately
// different concepts (see DetectedGame.mercyGameId below): this only ever
// reports what's REALLY on disk, using real, standard, read-only detection
// mechanisms — it never fabricates an install, never scans dangerous/system
// locations, and never executes anything itself (launch() only runs after
// an explicit user click, and only ever the exact executable path this
// scanner itself just verified exists).
//
// Detection sources, both real and standard, no guessing:
//  - Steam: reads the real steamapps/libraryfolders.vdf (Steam's own record
//    of every library folder the user has configured, across any drive —
//    this is how multi-drive Steam libraries are covered without a blind
//    per-drive filesystem crawl) and, for each installed app, the real
//    appmanifest_<appid>.acf's own `installdir` field — never assumes a
//    game's folder name matches its display name.
//  - A short, fixed list of well-known non-Steam install locations (e.g.
//    FiveM's real AppData location) — resolved via real environment
//    variables, not guessed drive paths.
//  - A small, bounded check of common per-drive Steam library roots (e.g.
//    "D:\SteamLibrary") as a fallback when Steam's own registry key isn't
//    found — a handful of fixed relative-path checks per existing drive
//    letter, never a recursive scan of the drive itself.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { shell } from 'electron';

export type MercyGameId = 'fivem' | 'minecraft' | 'assettocorsa';

export interface KnownGameDef {
  id: string;
  name: string;
  /** Set only when Mercy has real server-management support for this game
   *  (see config/games.ts on the renderer side) — a detected game with
   *  mercyGameId: null is genuinely just "found on this PC", nothing more. */
  mercyGameId: MercyGameId | null;
  /** Steam App ID, for games commonly distributed via Steam. */
  steamAppId?: number;
  /** The real folder name Steam itself uses under steamapps/common/ — only
   *  used as a fallback when no appmanifest_<id>.acf is found. */
  steamFolderFallback?: string;
  /** Real executable to verify, relative to the resolved install folder
   *  (may include subfolders, e.g. "Bin64/Game.exe"). */
  executableRelPath: string;
  /** Non-Steam install locations to check directly. May contain %ENVVAR%
   *  placeholders, resolved from real process.env at scan time. */
  directPaths?: string[];
}

export interface DetectedGame {
  id: string;
  name: string;
  mercyGameId: MercyGameId | null;
  installPath: string;
  executablePath: string;
  source: 'steam' | 'direct';
  detectedAt: string;
}

// Maintainable, deliberately small starter list — real, well-known games
// with stable, documented install shapes. Add more by appending an entry;
// nothing else in this file needs to change for a new game to be picked up.
export const KNOWN_GAMES: KnownGameDef[] = [
  {
    id: 'fivem', name: 'FiveM', mercyGameId: 'fivem',
    executableRelPath: 'FiveM.exe',
    directPaths: ['%LOCALAPPDATA%\\FiveM\\FiveM Application Data'],
  },
  {
    id: 'minecraft-launcher', name: 'Minecraft Launcher', mercyGameId: 'minecraft',
    executableRelPath: 'MinecraftLauncher.exe',
    directPaths: ['%ProgramFiles(x86)%\\Minecraft Launcher', '%ProgramFiles%\\Minecraft Launcher'],
  },
  {
    id: 'assetto-corsa', name: 'Assetto Corsa', mercyGameId: 'assettocorsa',
    steamAppId: 244210, steamFolderFallback: 'assettocorsa',
    executableRelPath: 'acs.exe',
  },
  {
    id: 'beamng-drive', name: 'BeamNG.drive', mercyGameId: null,
    steamAppId: 284160, steamFolderFallback: 'BeamNG.drive',
    executableRelPath: 'Bin64\\BeamNG.drive.x64.exe',
  },
  {
    id: 'gta5', name: 'Grand Theft Auto V', mercyGameId: null,
    steamAppId: 271590, steamFolderFallback: 'Grand Theft Auto V',
    executableRelPath: 'GTA5.exe',
  },
  {
    id: 'cs2', name: 'Counter-Strike 2', mercyGameId: null,
    steamAppId: 730, steamFolderFallback: 'Counter-Strike Global Offensive',
    executableRelPath: 'game\\bin\\win64\\cs2.exe',
  },
];

function resolveEnvPlaceholders(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
}

/** Extracts every `"key" "value"` pair from a real Steam VDF/ACF file —
 *  both formats use the same flat quoted-key/quoted-value shape for the
 *  fields this scanner needs, so a small regex is genuinely sufficient
 *  here; a full VDF parser would be more machinery than this reads. */
function extractVdfValues(text: string, key: string): string[] {
  const re = new RegExp(`"${key}"\\s*"([^"]*)"`, 'gi');
  const values: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) values.push(m[1]);
  return values;
}

function readSteamRegistryPath(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "(Get-ItemProperty -Path 'HKCU:\\Software\\Valve\\Steam' -Name SteamPath -ErrorAction SilentlyContinue).SteamPath",
    ], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const p = stdout?.trim();
      resolve(!err && p ? p.replace(/\//g, '\\') : null);
    });
  });
}

function existingDriveLetters(): string[] {
  if (process.platform !== 'win32') return [];
  const drives: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    try { if (fs.existsSync(`${letter}:\\`)) drives.push(letter); } catch {}
  }
  return drives;
}

export interface GameScannerOptions {
  /** Testing seam: skips the real Windows registry/default-path Steam
   *  lookup and uses this instead (a disposable fixture directory shaped
   *  like a real Steam install). Pass null to simulate "Steam not found".
   *  Never set in real app usage — production always uses the real lookup. */
  steamPathOverride?: string | null;
  /** Testing seam: use a disposable fixture game list instead of the real
   *  KNOWN_GAMES, so tests never depend on (or risk matching) whatever is
   *  actually installed on the machine running them. */
  knownGames?: KnownGameDef[];
  /** Testing seam: replaces the real per-drive-letter fallback scan (which
   *  enumerates real Windows drive letters) with a fixed list. */
  fallbackLibraryFoldersOverride?: string[];
}

export class GameScanner {
  private cacheFile: string;
  private cached: DetectedGame[] = [];

  constructor(private userDataPath: string, private options: GameScannerOptions = {}) {
    const dataDir = path.join(userDataPath, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.cacheFile = path.join(dataDir, 'detected-games.json');
    try { if (fs.existsSync(this.cacheFile)) this.cached = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8')); } catch { this.cached = []; }
  }

  getCached(): DetectedGame[] { return this.cached; }

  /** Every real Steam library folder Steam itself knows about — the main
   *  install path plus every entry in libraryfolders.vdf. Never guessed. */
  private steamLibraryFolders(steamPath: string): string[] {
    const folders = [steamPath];
    try {
      const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
      if (fs.existsSync(vdfPath)) {
        const text = fs.readFileSync(vdfPath, 'utf-8');
        for (const p of extractVdfValues(text, 'path')) {
          const normalized = p.replace(/\\\\/g, '\\');
          if (!folders.includes(normalized)) folders.push(normalized);
        }
      }
    } catch {}
    return folders;
  }

  /** Bounded, safe fallback for a Steam library that exists at a common
   *  root on some OTHER drive but isn't registered under the primary Steam
   *  install (e.g. a portable/secondary Steam setup) — a handful of fixed
   *  relative checks per existing drive letter, never a recursive scan. */
  private fallbackDriveLibraryFolders(): string[] {
    if (this.options.fallbackLibraryFoldersOverride) return this.options.fallbackLibraryFoldersOverride;
    const folders: string[] = [];
    for (const letter of existingDriveLetters()) {
      for (const rel of ['SteamLibrary', 'Steam', 'Games\\SteamLibrary']) {
        const candidate = `${letter}:\\${rel}`;
        try { if (fs.existsSync(path.join(candidate, 'steamapps'))) folders.push(candidate); } catch {}
      }
    }
    return folders;
  }

  private resolveSteamInstall(def: KnownGameDef, libraryFolders: string[]): { installPath: string; executablePath: string } | null {
    if (!def.steamAppId) return null;
    for (const lib of libraryFolders) {
      const steamappsDir = path.join(lib, 'steamapps');
      const manifestPath = path.join(steamappsDir, `appmanifest_${def.steamAppId}.acf`);
      let installDir: string | null = null;
      if (fs.existsSync(manifestPath)) {
        try {
          const values = extractVdfValues(fs.readFileSync(manifestPath, 'utf-8'), 'installdir');
          if (values[0]) installDir = values[0];
        } catch {}
      }
      const candidates = [installDir, def.steamFolderFallback].filter((v): v is string => !!v);
      for (const dir of candidates) {
        const installPath = path.join(steamappsDir, 'common', dir);
        const executablePath = path.join(installPath, def.executableRelPath);
        if (fs.existsSync(executablePath)) return { installPath, executablePath };
      }
    }
    return null;
  }

  private resolveDirectInstall(def: KnownGameDef): { installPath: string; executablePath: string } | null {
    for (const raw of def.directPaths || []) {
      const installPath = resolveEnvPlaceholders(raw);
      const executablePath = path.join(installPath, def.executableRelPath);
      if (fs.existsSync(executablePath)) return { installPath, executablePath };
    }
    return null;
  }

  async scan(): Promise<DetectedGame[]> {
    const steamPath = this.options.steamPathOverride !== undefined
      ? this.options.steamPathOverride
      : process.platform === 'win32'
        ? (await readSteamRegistryPath()) || (fs.existsSync('C:\\Program Files (x86)\\Steam') ? 'C:\\Program Files (x86)\\Steam' : null)
        : null;
    const libraryFolders = [
      ...(steamPath ? this.steamLibraryFolders(steamPath) : []),
      ...this.fallbackDriveLibraryFolders(),
    ];
    // De-duplicate library folders (registry-found + drive-fallback can overlap).
    const uniqueLibraries = Array.from(new Set(libraryFolders.map((f) => path.resolve(f))));

    const knownGames = this.options.knownGames || KNOWN_GAMES;
    const now = new Date().toISOString();
    const results: DetectedGame[] = [];
    const seenIds = new Set<string>();
    for (const def of knownGames) {
      if (seenIds.has(def.id)) continue; // never a duplicate entry for the same known game
      const viaSteam = def.steamAppId ? this.resolveSteamInstall(def, uniqueLibraries) : null;
      const resolved = viaSteam || this.resolveDirectInstall(def);
      if (!resolved) continue;
      results.push({
        id: def.id, name: def.name, mercyGameId: def.mercyGameId,
        installPath: resolved.installPath, executablePath: resolved.executablePath,
        source: viaSteam ? 'steam' : 'direct', detectedAt: now,
      });
      seenIds.add(def.id);
    }

    this.cached = results;
    try { fs.writeFileSync(this.cacheFile, JSON.stringify(results, null, 2)); } catch {}
    return results;
  }

  /** Launches a REAL, already-verified executable — only ever one this
   *  scanner itself resolved and that still exists on disk right now, and
   *  only in response to this explicit call (never automatically). Uses
   *  Electron's own shell.openPath, the same sanctioned mechanism already
   *  used elsewhere in this app to open files/folders. */
  async launch(id: string): Promise<{ success: boolean; error?: string }> {
    const game = this.cached.find((g) => g.id === id);
    if (!game) return { success: false, error: 'This game was not found by the last scan — try scanning again.' };
    if (!fs.existsSync(game.executablePath)) return { success: false, error: 'The game executable no longer exists at its last detected location — try scanning again.' };
    const result = await shell.openPath(game.executablePath);
    if (result) return { success: false, error: result };
    return { success: true };
  }
}
