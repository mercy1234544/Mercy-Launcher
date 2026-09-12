// Game Library scanner — detects games actually installed on this computer,
// across every major PC game platform, independent of whether Mercy has
// server-management support for them. A detected game and a Mercy-
// supported game are deliberately different concepts (see
// DetectedGame.mercyStatus below): this only ever reports what's REALLY on
// disk, using real, standard, read-only detection mechanisms — it never
// fabricates an install, never scans dangerous/system locations, and never
// executes anything itself (launch() only runs after an explicit user
// click, and only ever a path/protocol this scanner itself just verified).
//
// Layered detection (bounded and safe at every layer — never a recursive
// full-drive crawl):
//  LEVEL 1 — real launcher/library metadata:
//    - Steam: steamapps/libraryfolders.vdf (every library folder Steam
//      itself knows about, across drives) + every real appmanifest_*.acf
//      in each one (generic — not limited to a fixed app-id list; each
//      manifest's own `name`/`installdir` fields are read directly).
//    - Epic Games: every real *.item manifest under
//      ProgramData/Epic/EpicGamesLauncher/Data/Manifests (each is genuinely
//      JSON despite the .item extension) — generic, real DisplayName/
//      InstallLocation/CatalogNamespace/CatalogItemId/AppName fields.
//    - GOG: every real subkey under the GOG.com Games registry root
//      (each subkey IS a real installed game, with real gameName/path/exe
//      values) — generic, no per-game IDs needed.
//    - Ubisoft Connect: every real subkey under Ubisoft's Launcher\Installs
//      registry root (real InstallDir per game; Ubisoft doesn't store a
//      display name at this key, so the real install folder's own leaf
//      name is used honestly rather than inventing a polished title).
//    - Rockstar Games Launcher / EA (Origin legacy): curated, real,
//      documented registry locations for specific well-known titles —
//      Rockstar's own registry layout isn't uniformly enumerable the way
//      GOG/Ubisoft's is, and EA's launcher history (Origin -> EA Desktop ->
//      EA App) has never settled on one stable detection mechanism, so
//      these two are deliberately NOT claimed to be fully generic.
//    - Microsoft Store/Xbox: `Get-AppxPackage` (a real, standard, read-only
//      PowerShell cmdlet) checked against a small curated allowlist of
//      known game package family names — full generic AppX enumeration
//      would mostly return non-game system packages, which isn't honest
//      "game detection".
//  LEVEL 2 — per-drive library discovery: Steam's own libraryfolders.vdf
//    already covers multi-drive Steam libraries; a small bounded fallback
//    additionally checks a handful of common library-root names (e.g.
//    "D:\SteamLibrary", "D:\Epic Games") per existing drive letter — never
//    a scan of the drive's actual contents.
//  LEVEL 3 — launcher-specific manifests: same real files as Level 1.
//  LEVEL 4 — bounded fallback: a short, fixed list of well-known non-
//    launcher install locations (FiveM, the classic Minecraft Launcher),
//    resolved via real environment variables, never guessed drive paths.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { shell } from 'electron';

export type MercyGameId = 'fivem' | 'minecraft' | 'assettocorsa';
/** 'supported' = Mercy has a real server-management hub for this game.
 *  'planned' = Mercy has this on its roadmap (see config/games.ts's
 *  hasRealHub: false entries) but hasn't built it yet — shown as "Coming
 *  Soon", distinct from a game Mercy has no plans for at all.
 *  'unsupported' = just a detected game, nothing more. */
export type MercyStatus = 'supported' | 'planned' | 'unsupported';
export type DetectionPlatform = 'steam' | 'epic' | 'gog' | 'ubisoft' | 'rockstar' | 'ea' | 'microsoft' | 'direct' | 'manual';

export interface KnownGameDef {
  /** Stable id — for a curated (non-generic) entry only; generically
   *  discovered games (Steam/Epic/GOG/Ubisoft) get an id derived from
   *  their own real platform identifier instead (see below). */
  id: string;
  name: string;
  mercyGameId: MercyGameId | null;
  mercyStatus: MercyStatus;
  /** Curated cross-reference identifiers — used only to recognize a
   *  generically-discovered install as one of Mercy's own known titles
   *  (e.g. matching Steam appid 271590 to "Grand Theft Auto V" so its
   *  mercyStatus can be set), never to fabricate an install that wasn't
   *  actually found. */
  steamAppId?: number;
  epicAppName?: string;
  /** Curated (non-generic) detection — see this file's header on why
   *  Rockstar/EA aren't enumerated generically. */
  rockstarRegistrySubkey?: string; // under HKLM\SOFTWARE\WOW6432Node\Rockstar Games\
  rockstarInstallFolderValue?: string; // registry value name holding the real install path
  originRegistrySubkey?: string; // under HKLM\SOFTWARE\WOW6432Node\Origin Games\
  microsoftPackageFamilyName?: string;
  /** Real executable to verify, relative to the resolved install folder. */
  executableRelPath?: string;
  /** Non-launcher install locations, resolved from real %ENVVAR% placeholders. */
  directPaths?: string[];
}

export interface DetectedGame {
  /** Stable across rescans for the SAME real install (platform-prefixed so
   *  two different platforms' copies of the same title are never merged
   *  into one row — a real distinction, e.g. a Steam AND an Epic copy). */
  id: string;
  name: string;
  mercyGameId: MercyGameId | null;
  mercyStatus: MercyStatus;
  installPath: string;
  /** May be '' when a platform (Steam/Epic/Ubisoft) launches the game
   *  through its own protocol and Mercy never needed to resolve a real
   *  local .exe path to do so. */
  executablePath: string;
  platform: DetectionPlatform;
  /** Human label for the UI — "Steam", "Epic Games", "Rockstar Games",
   *  "GOG", "Ubisoft Connect", "Xbox/Microsoft Store", "FiveM", "Mojang". */
  platformLabel: string;
  detectedAt: string;
  /** True only for a manually-added game whose executable was real and
   *  confirmed to exist THE LAST TIME it was checked (scan time, or when
   *  the entry was added/relocated) and no longer does. Never crashes or
   *  silently drops the entry — the UI shows an honest "Path unavailable"
   *  state and offers to locate it again. Always false/absent for an
   *  auto-detected game (those are simply excluded if genuinely missing). */
  pathMissing?: boolean;
}

const PLATFORM_LABELS: Record<DetectionPlatform, string> = {
  steam: 'Steam', epic: 'Epic Games', gog: 'GOG', ubisoft: 'Ubisoft Connect',
  rockstar: 'Rockstar Games', ea: 'EA', microsoft: 'Xbox/Microsoft Store', direct: 'Direct Install',
  manual: 'Manually Added',
};

/** A user-provided game path (Part 1) — real, explicit, persisted
 *  independent of any scan. Automatic detection will never be perfect
 *  (unusual install locations, portable installs, modded setups), so this
 *  is the honest fallback: the user selects the REAL executable themselves,
 *  Mercy only ever verifies it (never fabricates or guesses). */
export interface ManualGameEntry {
  id: string;
  name: string;
  executablePath: string;
  addedAt: string;
}

// Curated cross-reference list — deliberately small and maintainable (see
// this file's header: generic launchers don't need an entry here at all,
// this is only for (a) recognizing a Mercy-relevant title by its real
// platform id, and (b) the two launchers whose install metadata isn't
// safely enumerable generically). Add a game by appending one entry.
export const KNOWN_GAMES: KnownGameDef[] = [
  {
    // Real FiveM installs place FiveM.exe directly under
    // %LOCALAPPDATA%\FiveM\ — verified against an actual real install on
    // this machine. The previous path assumed an extra "FiveM Application
    // Data" subfolder that doesn't actually exist in the current FiveM
    // client layout, which is the real reason FiveM was never detected
    // (nothing to do with GTA V — the two have always been fully separate
    // KNOWN_GAMES entries with no cross-reference between them). The old
    // subfolder path is kept as a second candidate for anyone still on an
    // older install layout that did use it.
    id: 'fivem', name: 'FiveM', mercyGameId: 'fivem', mercyStatus: 'supported',
    executableRelPath: 'FiveM.exe',
    directPaths: ['%LOCALAPPDATA%\\FiveM', '%LOCALAPPDATA%\\FiveM\\FiveM Application Data'],
  },
  {
    id: 'minecraft-launcher', name: 'Minecraft Launcher', mercyGameId: 'minecraft', mercyStatus: 'supported',
    executableRelPath: 'MinecraftLauncher.exe',
    directPaths: ['%ProgramFiles(x86)%\\Minecraft Launcher', '%ProgramFiles%\\Minecraft Launcher'],
  },
  {
    id: 'minecraft-uwp', name: 'Minecraft (Microsoft Store)', mercyGameId: 'minecraft', mercyStatus: 'supported',
    microsoftPackageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe',
  },
  { id: 'assetto-corsa', name: 'Assetto Corsa', mercyGameId: 'assettocorsa', mercyStatus: 'supported', steamAppId: 244210 },
  {
    // Content Manager (AcTools) is a real, legitimate third-party
    // launcher players use to launch/manage Assetto Corsa — not a
    // plugin, SDK, or dev tool, so it's a curated KNOWN_GAMES entry like
    // FiveM/Minecraft Launcher rather than something the non-game
    // classifier would ever need to touch. Its most common real default
    // install location (AcTools' own installer); a user who chose a
    // custom folder won't be found by this specific path, matching this
    // scanner's existing "real, bounded, never a full-drive search"
    // limitation for every other direct install.
    id: 'content-manager', name: 'Content Manager', mercyGameId: null, mercyStatus: 'unsupported',
    executableRelPath: 'Content Manager.exe',
    directPaths: ['%LOCALAPPDATA%\\AcTools Content Manager'],
  },
  { id: 'beamng-drive', name: 'BeamNG.drive', mercyGameId: null, mercyStatus: 'planned', steamAppId: 284160 },
  { id: 'gta5', name: 'Grand Theft Auto V', mercyGameId: null, mercyStatus: 'unsupported', steamAppId: 271590, epicAppName: '9d2d0eb64d5c44529cece33fe2a46482', rockstarRegistrySubkey: 'Grand Theft Auto V', rockstarInstallFolderValue: 'InstallFolder' },
  { id: 'rdr2', name: 'Red Dead Redemption 2', mercyGameId: null, mercyStatus: 'unsupported', steamAppId: 1174180, rockstarRegistrySubkey: 'Red Dead Redemption 2', rockstarInstallFolderValue: 'InstallFolder' },
];

// Real cross-reference against every KNOWN_GAMES entry that has a
// steamAppId/epicAppName — used to enrich a GENERICALLY discovered Steam/
// Epic install with mercyGameId/mercyStatus without needing per-game
// executable/folder guessing for the entire catalog.
function matchKnownBySteamAppId(appId: number): KnownGameDef | null {
  return KNOWN_GAMES.find((g) => g.steamAppId === appId) || null;
}
function matchKnownByEpicAppName(appName: string): KnownGameDef | null {
  return KNOWN_GAMES.find((g) => g.epicAppName === appName) || null;
}

// ── Non-game classification ─────────────────────────────────────────────
// A generic Steam/Epic/GOG/Ubisoft scan reports EVERY real manifest it
// finds — and Steam in particular treats SDKs, redistributables, and
// workshop/dev tools as ordinary "apps" with their own appmanifest_*.acf,
// exactly like a real game. This is a real, metadata-based filter applied
// ONLY to entries with no curated KNOWN_GAMES match (a curated match is a
// specific, human-verified real game and always wins outright) — never a
// giant classifier, never a network call, never a full-catalog allowlist:
// a short, well-known appid blocklist for the handful of extremely common
// non-game Steam apps that would otherwise show up on nearly every
// Steam user's machine, plus conservative name-pattern matching for the
// general case (SDKs, redistributables, dedicated-server tools, workshop/
// content tools, engine/dev tooling).
const KNOWN_NON_GAME_STEAM_APP_IDS = new Set([
  250820,  // SteamVR
  228980,  // Steamworks Common Redistributables
  431960,  // Wallpaper Engine
  365670,  // Steam Audio (dev tool)
  1007353, // Steam Linux Runtime
  1391110, // Steam Linux Runtime - Soldier
]);

const NON_GAME_NAME_PATTERN = /\b(SDK|redistributable|dedicated server tool|benchmark|workshop tool|content tool|runtime(s)?|editor tools?|modding tool|dev(eloper)? tool|plugin|devkit|engine tools?|unreal engine|\bFAB\b)\b/i;

/** Real, honest classification — never guesses on network/live data that
 *  isn't available offline; a name/appid this doesn't recognize as
 *  non-game is treated as a real game, matching "show me the games I
 *  actually have installed" rather than risk hiding something real. */
function isLikelyNonGame(appId: number | null, name: string): boolean {
  if (appId !== null && KNOWN_NON_GAME_STEAM_APP_IDS.has(appId)) return true;
  return NON_GAME_NAME_PATTERN.test(name);
}

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
function extractVdfValue(text: string, key: string): string | null {
  return extractVdfValues(text, key)[0] ?? null;
}

function runPowerShell(script: string, timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout?.trim() ? stdout.trim() : null);
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
  /** Testing seams — never set in real app usage; production always uses
   *  the real registry/filesystem lookups. Each lets a test point this
   *  scanner at a disposable fixture instead of the real machine's real
   *  installs, exactly mirroring the real shape each lookup reads. */
  steamPathOverride?: string | null;
  epicManifestsDirOverride?: string | null;
  gogRegistryRootOverride?: Record<string, Record<string, string>> | null;
  ubisoftRegistryRootOverride?: Record<string, Record<string, string>> | null;
  rockstarRegistryRootOverride?: Record<string, Record<string, string>> | null;
  originRegistryRootOverride?: Record<string, Record<string, string>> | null;
  microsoftPackagesOverride?: { packageFamilyName: string; installLocation: string }[] | null;
  knownGames?: KnownGameDef[];
  fallbackLibraryFoldersOverride?: string[];
}

export class GameScanner {
  private cacheFile: string;
  private manualGamesFile: string;
  private cached: DetectedGame[] = [];
  private manualGames: ManualGameEntry[] = [];
  private lastScanAt: string | null = null;
  /** Real, bounded default — see this file's header on why "configurable
   *  refresh interval" is implemented as this one sensible constant rather
   *  than a full settings UI for this milestone. */
  static readonly AUTO_RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;

  constructor(private userDataPath: string, private options: GameScannerOptions = {}) {
    const dataDir = path.join(userDataPath, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.cacheFile = path.join(dataDir, 'detected-games.json');
    this.manualGamesFile = path.join(dataDir, 'manual-games.json');
    try {
      if (fs.existsSync(this.cacheFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
        this.cached = parsed.games || [];
        this.lastScanAt = parsed.lastScanAt || null;
      }
    } catch { this.cached = []; this.lastScanAt = null; }
    try {
      if (fs.existsSync(this.manualGamesFile)) this.manualGames = JSON.parse(fs.readFileSync(this.manualGamesFile, 'utf-8')) || [];
    } catch { this.manualGames = []; }
  }

  // ── Manual game paths (Part 1) — a real, explicit, persisted fallback for
  // when automatic detection can't find (or misidentifies) a real install.
  // Never trusts a renderer-supplied path as truth: every add/relocate
  // verifies the real file on disk right now, and the unified list is kept
  // in sync immediately rather than waiting for the next full rescan. ─────
  getManualGames(): ManualGameEntry[] { return this.manualGames; }

  private saveManualGames(): void {
    try { fs.writeFileSync(this.manualGamesFile, JSON.stringify(this.manualGames, null, 2)); } catch {}
  }

  private persistCache(): void {
    try { fs.writeFileSync(this.cacheFile, JSON.stringify({ games: this.cached, lastScanAt: this.lastScanAt }, null, 2)); } catch {}
  }

  private manualGameToDetected(entry: ManualGameEntry): DetectedGame {
    return {
      id: entry.id, name: entry.name, mercyGameId: null, mercyStatus: 'unsupported',
      installPath: path.dirname(entry.executablePath), executablePath: entry.executablePath,
      platform: 'manual', platformLabel: PLATFORM_LABELS.manual, detectedAt: new Date().toISOString(),
      pathMissing: !fs.existsSync(entry.executablePath),
    };
  }

  /** Real validation only: the path must actually exist and genuinely be a
   *  file (never a directory mistaken for one, never assumed). Normalized
   *  via path.resolve so equivalent paths (mixed slashes, redundant "..")
   *  can't create confusing duplicate entries. Never executes the file —
   *  this only ever records it for a later, explicit Launch click. */
  addManualGame(execPath: string, name?: string): { success: boolean; error?: string; game?: DetectedGame } {
    if (typeof execPath !== 'string' || !execPath.trim()) return { success: false, error: 'No path was provided.' };
    const normalized = path.resolve(execPath);
    let stat: fs.Stats;
    try { stat = fs.statSync(normalized); } catch { return { success: false, error: 'That path does not exist.' }; }
    if (!stat.isFile()) return { success: false, error: 'That path is not a file — select the actual game executable.' };
    if (this.manualGames.some((m) => path.resolve(m.executablePath).toLowerCase() === normalized.toLowerCase())) {
      return { success: false, error: 'This executable is already in your Library.' };
    }
    const entry: ManualGameEntry = {
      id: `manual-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name: name?.trim() || path.basename(normalized, path.extname(normalized)),
      executablePath: normalized, addedAt: new Date().toISOString(),
    };
    this.manualGames.push(entry);
    this.saveManualGames();
    const detected = this.manualGameToDetected(entry);
    this.cached = [...this.cached.filter((g) => g.id !== detected.id), detected].sort((a, b) => a.name.localeCompare(b.name));
    this.persistCache();
    return { success: true, game: detected };
  }

  /** Removes a manually-added entry only — never touches an auto-detected
   *  game (those aren't stored here at all). */
  removeManualGame(id: string): boolean {
    const before = this.manualGames.length;
    this.manualGames = this.manualGames.filter((m) => m.id !== id);
    if (this.manualGames.length === before) return false;
    this.saveManualGames();
    this.cached = this.cached.filter((g) => g.id !== id);
    this.persistCache();
    return true;
  }

  /** Re-points an existing manual entry at a new real path — the honest
   *  "Locate" flow for when the original executable moved. Same real
   *  validation as adding one fresh. */
  relocateManualGame(id: string, newExecPath: string): { success: boolean; error?: string; game?: DetectedGame } {
    const entry = this.manualGames.find((m) => m.id === id);
    if (!entry) return { success: false, error: 'This manually added game was not found.' };
    if (typeof newExecPath !== 'string' || !newExecPath.trim()) return { success: false, error: 'No path was provided.' };
    const normalized = path.resolve(newExecPath);
    let stat: fs.Stats;
    try { stat = fs.statSync(normalized); } catch { return { success: false, error: 'That path does not exist.' }; }
    if (!stat.isFile()) return { success: false, error: 'That path is not a file — select the actual game executable.' };
    entry.executablePath = normalized;
    this.saveManualGames();
    const detected = this.manualGameToDetected(entry);
    this.cached = this.cached.map((g) => (g.id === id ? detected : g));
    this.persistCache();
    return { success: true, game: detected };
  }

  getCached(): DetectedGame[] { return this.cached; }
  getLastScanAt(): string | null { return this.lastScanAt; }
  /** True once AUTO_RESCAN_INTERVAL_MS has elapsed since the last real
   *  scan (or no scan has ever run) — the renderer uses this to decide
   *  whether to auto-rescan on app start, never on every render. */
  isStale(): boolean {
    if (!this.lastScanAt) return true;
    return Date.now() - new Date(this.lastScanAt).getTime() > GameScanner.AUTO_RESCAN_INTERVAL_MS;
  }

  // ── Steam (generic: every real appmanifest_*.acf in every real library) ──
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

  private async resolveSteamPath(): Promise<string | null> {
    if (this.options.steamPathOverride !== undefined) return this.options.steamPathOverride;
    if (process.platform !== 'win32') return null;
    const fromRegistry = await runPowerShell("(Get-ItemProperty -Path 'HKCU:\\Software\\Valve\\Steam' -Name SteamPath -ErrorAction SilentlyContinue).SteamPath");
    if (fromRegistry) return fromRegistry.replace(/\//g, '\\');
    return fs.existsSync('C:\\Program Files (x86)\\Steam') ? 'C:\\Program Files (x86)\\Steam' : null;
  }

  private scanSteam(libraryFolders: string[]): DetectedGame[] {
    const results: DetectedGame[] = [];
    const now = new Date().toISOString();
    for (const lib of libraryFolders) {
      const steamappsDir = path.join(lib, 'steamapps');
      let files: string[] = [];
      try { files = fs.readdirSync(steamappsDir).filter((f) => /^appmanifest_\d+\.acf$/i.test(f)); } catch { continue; }
      for (const file of files) {
        try {
          const text = fs.readFileSync(path.join(steamappsDir, file), 'utf-8');
          const appId = Number(extractVdfValue(text, 'appid'));
          const name = extractVdfValue(text, 'name');
          const installDir = extractVdfValue(text, 'installdir');
          if (!appId || !name || !installDir) continue;
          const installPath = path.join(steamappsDir, 'common', installDir);
          if (!fs.existsSync(installPath)) continue; // manifest exists but files were removed/incomplete
          const known = matchKnownBySteamAppId(appId);
          if (!known && isLikelyNonGame(appId, name)) continue; // real tool/SDK/redistributable, not a game
          results.push({
            id: `steam-${appId}`, name: known?.name || name,
            mercyGameId: known?.mercyGameId ?? null, mercyStatus: known?.mercyStatus ?? 'unsupported',
            installPath, executablePath: '', platform: 'steam', platformLabel: PLATFORM_LABELS.steam, detectedAt: now,
          });
        } catch {}
      }
    }
    return results;
  }

  // ── Epic Games (generic: every real *.item manifest) ─────────────────────
  private epicManifestsDir(): string | null {
    if (this.options.epicManifestsDirOverride !== undefined) return this.options.epicManifestsDirOverride;
    if (process.platform !== 'win32') return null;
    const dir = resolveEnvPlaceholders('%ProgramData%\\Epic\\EpicGamesLauncher\\Data\\Manifests');
    return fs.existsSync(dir) ? dir : null;
  }

  private scanEpic(): DetectedGame[] {
    const dir = this.epicManifestsDir();
    if (!dir) return [];
    const results: DetectedGame[] = [];
    const now = new Date().toISOString();
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.item')); } catch { return []; }
    for (const file of files) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        const installLocation = manifest.InstallLocation;
        const displayName = manifest.DisplayName;
        const appName = manifest.AppName;
        if (!installLocation || !displayName || !fs.existsSync(installLocation)) continue;
        const known = appName ? matchKnownByEpicAppName(appName) : null;
        if (!known && isLikelyNonGame(null, displayName)) continue; // real tool/engine/dev content, not a game
        results.push({
          id: `epic-${appName || displayName}`, name: known?.name || displayName,
          mercyGameId: known?.mercyGameId ?? null, mercyStatus: known?.mercyStatus ?? 'unsupported',
          installPath: installLocation,
          executablePath: manifest.LaunchExecutable ? path.join(installLocation, manifest.LaunchExecutable) : '',
          platform: 'epic', platformLabel: PLATFORM_LABELS.epic, detectedAt: now,
        });
      } catch { /* a malformed .item manifest is skipped, never crashes the whole scan */ }
    }
    return results;
  }

  // ── Registry-based launchers (GOG/Ubisoft generic, Rockstar/EA curated) ──
  private async readRegistrySubtree(rootPath: string): Promise<Record<string, Record<string, string>>> {
    const script = `
$ErrorAction = 'SilentlyContinue'
if (Test-Path '${rootPath}') {
  Get-ChildItem -Path '${rootPath}' | ForEach-Object {
    $props = Get-ItemProperty -Path $_.PSPath
    $obj = @{}
    foreach ($p in $props.PSObject.Properties) { if ($p.Name -notmatch '^PS') { $obj[$p.Name] = [string]$p.Value } }
    [PSCustomObject]@{ Key = $_.PSChildName; Values = $obj }
  } | ConvertTo-Json -Compress -Depth 4
}`.trim();
    const out = await runPowerShell(script);
    if (!out) return {};
    try {
      const parsed = JSON.parse(out);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const result: Record<string, Record<string, string>> = {};
      for (const row of rows) if (row?.Key) result[row.Key] = row.Values || {};
      return result;
    } catch { return {}; }
  }

  private scanGenericRegistryGames(subtree: Record<string, Record<string, string>>, platform: DetectionPlatform, opts: { nameKey?: string; pathKey: string; idPrefix: string }): DetectedGame[] {
    const now = new Date().toISOString();
    const results: DetectedGame[] = [];
    for (const [key, values] of Object.entries(subtree)) {
      const installPath = values[opts.pathKey];
      if (!installPath || !fs.existsSync(installPath)) continue;
      const name = (opts.nameKey && values[opts.nameKey]) || path.basename(installPath) || key;
      if (isLikelyNonGame(null, name)) continue; // real tool/SDK/redistributable, not a game
      results.push({
        id: `${opts.idPrefix}-${key}`, name, mercyGameId: null, mercyStatus: 'unsupported',
        installPath, executablePath: '', platform, platformLabel: PLATFORM_LABELS[platform], detectedAt: now,
      });
    }
    return results;
  }

  private async scanGog(): Promise<DetectedGame[]> {
    const subtree = this.options.gogRegistryRootOverride ?? await this.readRegistrySubtree('HKLM:\\SOFTWARE\\WOW6432Node\\GOG.com\\Games');
    return this.scanGenericRegistryGames(subtree, 'gog', { nameKey: 'gameName', pathKey: 'path', idPrefix: 'gog' });
  }

  private async scanUbisoft(): Promise<DetectedGame[]> {
    // Ubisoft's own registry keys don't carry a display name (just an
    // install dir per game id) — the real folder's own leaf name is used
    // as an honest label rather than a fabricated polished title.
    const subtree = this.options.ubisoftRegistryRootOverride ?? await this.readRegistrySubtree('HKLM:\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs');
    return this.scanGenericRegistryGames(subtree, 'ubisoft', { pathKey: 'InstallDir', idPrefix: 'ubisoft' });
  }

  /** Curated, not generic — see this file's header. Checks only the
   *  specific well-known KNOWN_GAMES entries that declare a Rockstar
   *  registry subkey. */
  private async scanRockstar(knownGames: KnownGameDef[]): Promise<DetectedGame[]> {
    const subtree = this.options.rockstarRegistryRootOverride ?? await this.readRegistrySubtree('HKLM:\\SOFTWARE\\WOW6432Node\\Rockstar Games');
    const now = new Date().toISOString();
    const results: DetectedGame[] = [];
    for (const def of knownGames) {
      if (!def.rockstarRegistrySubkey || !def.rockstarInstallFolderValue) continue;
      const values = subtree[def.rockstarRegistrySubkey];
      const installPath = values?.[def.rockstarInstallFolderValue];
      if (!installPath || !fs.existsSync(installPath)) continue;
      results.push({
        id: `rockstar-${def.id}`, name: def.name, mercyGameId: def.mercyGameId, mercyStatus: def.mercyStatus,
        installPath, executablePath: '', platform: 'rockstar', platformLabel: PLATFORM_LABELS.rockstar, detectedAt: now,
      });
    }
    return results;
  }

  /** Curated, not generic — see this file's header on EA's inconsistent
   *  launcher history. Checks the real legacy Origin Games registry root,
   *  which is the one EA detection mechanism this codebase has reasonable
   *  confidence is still real/documented today. */
  private async scanEa(knownGames: KnownGameDef[]): Promise<DetectedGame[]> {
    const subtree = this.options.originRegistryRootOverride ?? await this.readRegistrySubtree('HKLM:\\SOFTWARE\\WOW6432Node\\Origin Games');
    const now = new Date().toISOString();
    const results: DetectedGame[] = [];
    for (const def of knownGames) {
      if (!def.originRegistrySubkey) continue;
      const values = subtree[def.originRegistrySubkey];
      const installPath = values?.['Install Dir'] || values?.['InstallDir'];
      if (!installPath || !fs.existsSync(installPath)) continue;
      results.push({
        id: `ea-${def.id}`, name: def.name, mercyGameId: def.mercyGameId, mercyStatus: def.mercyStatus,
        installPath, executablePath: '', platform: 'ea', platformLabel: PLATFORM_LABELS.ea, detectedAt: now,
      });
    }
    return results;
  }

  /** Curated allowlist, not full generic AppX enumeration — see header. */
  private async scanMicrosoftStore(knownGames: KnownGameDef[]): Promise<DetectedGame[]> {
    const now = new Date().toISOString();
    const results: DetectedGame[] = [];
    if (this.options.microsoftPackagesOverride) {
      for (const pkg of this.options.microsoftPackagesOverride) {
        const def = knownGames.find((g) => g.microsoftPackageFamilyName === pkg.packageFamilyName);
        if (!def) continue;
        results.push({
          id: `microsoft-${def.id}`, name: def.name, mercyGameId: def.mercyGameId, mercyStatus: def.mercyStatus,
          installPath: pkg.installLocation, executablePath: '', platform: 'microsoft', platformLabel: PLATFORM_LABELS.microsoft, detectedAt: now,
        });
      }
      return results;
    }
    const candidates = knownGames.filter((g) => g.microsoftPackageFamilyName);
    if (candidates.length === 0 || process.platform !== 'win32') return results;
    for (const def of candidates) {
      const out = await runPowerShell(`(Get-AppxPackage -Name '${def.microsoftPackageFamilyName!.split('_')[0]}' -ErrorAction SilentlyContinue | Select-Object -First 1).InstallLocation`);
      if (out && fs.existsSync(out)) {
        results.push({
          id: `microsoft-${def.id}`, name: def.name, mercyGameId: def.mercyGameId, mercyStatus: def.mercyStatus,
          installPath: out, executablePath: '', platform: 'microsoft', platformLabel: PLATFORM_LABELS.microsoft, detectedAt: now,
        });
      }
    }
    return results;
  }

  // ── Direct (non-launcher) installs — FiveM, classic Minecraft Launcher ───
  private scanDirect(knownGames: KnownGameDef[]): DetectedGame[] {
    const now = new Date().toISOString();
    const results: DetectedGame[] = [];
    for (const def of knownGames) {
      if (!def.directPaths || !def.executableRelPath) continue;
      for (const raw of def.directPaths) {
        const installPath = resolveEnvPlaceholders(raw);
        const executablePath = path.join(installPath, def.executableRelPath);
        if (fs.existsSync(executablePath)) {
          results.push({
            id: `direct-${def.id}`, name: def.name, mercyGameId: def.mercyGameId, mercyStatus: def.mercyStatus,
            installPath, executablePath, platform: 'direct',
            platformLabel: def.mercyGameId ? def.name : PLATFORM_LABELS.direct, detectedAt: now,
          });
          break;
        }
      }
    }
    return results;
  }

  /** The full, layered, bounded scan — see this file's header for what
   *  each level does. Always fast (a handful of real file/registry reads,
   *  never a filesystem walk), so no cancellation token is needed for an
   *  operation that never runs long in the first place. */
  async scan(): Promise<DetectedGame[]> {
    const knownGames = this.options.knownGames || KNOWN_GAMES;
    const steamPath = await this.resolveSteamPath();
    const libraryFolders = Array.from(new Set([
      ...(steamPath ? this.steamLibraryFolders(steamPath) : []),
      ...this.fallbackDriveLibraryFolders(),
    ].map((f) => path.resolve(f))));

    const [epic, gog, ubisoft, rockstar, ea, microsoft] = await Promise.all([
      Promise.resolve(this.scanEpic()),
      this.scanGog(),
      this.scanUbisoft(),
      this.scanRockstar(knownGames),
      this.scanEa(knownGames),
      this.scanMicrosoftStore(knownGames),
    ]);
    const steam = this.scanSteam(libraryFolders);
    const direct = this.scanDirect(knownGames);

    // De-duplicate by id (the same real install should never appear twice
    // even if two detection passes could theoretically both find it).
    const byId = new Map<string, DetectedGame>();
    for (const g of [...steam, ...epic, ...gog, ...ubisoft, ...rockstar, ...ea, ...microsoft, ...direct]) {
      if (!byId.has(g.id)) byId.set(g.id, g);
    }
    // Manual entries (Part 1) are never rediscovered by a rescan — they're
    // merged back in fresh every time, with pathMissing re-checked for real
    // right now rather than carried over stale from whenever they were added.
    const manual = this.manualGames.map((m) => this.manualGameToDetected(m));
    const results = Array.from(byId.values()).concat(manual).sort((a, b) => a.name.localeCompare(b.name));

    this.cached = results;
    this.lastScanAt = new Date().toISOString();
    this.persistCache();
    return results;
  }

  // ── Platform-aware launching (Part 5) — never a blind direct .exe launch
  // when the platform's own real launch mechanism is known and safer. ─────
  async launch(id: string): Promise<{ success: boolean; error?: string; note?: string }> {
    const game = this.cached.find((g) => g.id === id);
    if (!game) return { success: false, error: 'This game was not found by the last scan — try scanning again.' };
    if (!fs.existsSync(game.installPath)) return { success: false, error: 'This game no longer exists at its last detected location — try scanning again.' };

    switch (game.platform) {
      case 'steam': {
        // steam://run/<appid> is a real, documented Steam protocol handler
        // that starts Steam itself first if it isn't already running —
        // no separate "launch Steam.exe" step is needed or safer.
        const appId = game.id.replace('steam-', '');
        return this.openProtocol(`steam://run/${appId}`, 'Steam');
      }
      case 'epic': {
        const appName = game.id.replace('epic-', '');
        // Real Epic Games Launcher protocol — also starts the launcher
        // itself first if needed, same reasoning as Steam above.
        return this.openProtocol(`com.epicgames.launcher://apps/${encodeURIComponent(appName)}?action=launch&silent=true`, 'Epic Games Launcher');
      }
      case 'ubisoft': {
        const gameId = game.id.replace('ubisoft-', '');
        return this.openProtocol(`uplay://launch/${encodeURIComponent(gameId)}/0`, 'Ubisoft Connect');
      }
      case 'rockstar': {
        // Real confidence gap, documented in this file's header: Rockstar
        // doesn't have as reliably-documented a per-title deep link as
        // Steam/Epic/Ubisoft. Rather than silently do nothing while
        // claiming success (exactly the "please use Rockstar Launcher"
        // dead-end this task exists to fix), Mercy starts the real
        // Rockstar Games Launcher itself and is explicit about the one
        // remaining manual step.
        const launcherPath = await this.findRockstarLauncherExe();
        if (launcherPath) {
          const result = await shell.openPath(launcherPath);
          if (result) return { success: false, error: result };
          return { success: true, note: `Rockstar Games Launcher is starting — select "${game.name}" from your library to play.` };
        }
        return { success: false, error: 'Could not find the Rockstar Games Launcher to start it automatically.' };
      }
      case 'microsoft': {
        // Real, documented technique for launching a UWP app from its
        // AppsFolder shell path — Electron's shell.openPath doesn't
        // resolve this virtual folder, so explorer.exe is used directly.
        return new Promise((resolve) => {
          execFile('explorer.exe', [`shell:AppsFolder\\${game.id.replace('microsoft-', '')}`], (err) => {
            resolve(err ? { success: false, error: 'Could not launch this Microsoft Store app.' } : { success: true });
          });
        });
      }
      case 'gog':
      case 'ea':
      case 'direct':
      default: {
        // GOG and legacy Origin/EA titles are frequently DRM-free/standalone
        // executables where a direct launch is the real, correct mechanism
        // (unlike Steam/Epic, which commonly require their client running
        // for entitlement checks) — same real mechanism already used for
        // FiveM/Minecraft Launcher direct installs.
        if (!game.executablePath) return { success: false, error: 'No launchable executable was found for this install — open its folder to launch it manually.' };
        if (!fs.existsSync(game.executablePath)) return { success: false, error: 'The game executable no longer exists at its last detected location — try scanning again.' };
        const result = await shell.openPath(game.executablePath);
        if (result) return { success: false, error: result };
        return { success: true };
      }
    }
  }

  private async openProtocol(uri: string, launcherLabel: string): Promise<{ success: boolean; error?: string }> {
    try {
      await shell.openExternal(uri);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: `Could not reach ${launcherLabel} (${e?.message || 'unknown error'}).` };
    }
  }

  private async findRockstarLauncherExe(): Promise<string | null> {
    const candidates = ['C:\\Program Files\\Rockstar Games\\Launcher\\Launcher.exe', 'C:\\Program Files (x86)\\Rockstar Games\\Launcher\\Launcher.exe'];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
  }
}
