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
export type DetectionPlatform = 'steam' | 'epic' | 'gog' | 'ubisoft' | 'rockstar' | 'ea' | 'microsoft' | 'direct';

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
}

const PLATFORM_LABELS: Record<DetectionPlatform, string> = {
  steam: 'Steam', epic: 'Epic Games', gog: 'GOG', ubisoft: 'Ubisoft Connect',
  rockstar: 'Rockstar Games', ea: 'EA', microsoft: 'Xbox/Microsoft Store', direct: 'Direct Install',
};

// Curated cross-reference list — deliberately small and maintainable (see
// this file's header: generic launchers don't need an entry here at all,
// this is only for (a) recognizing a Mercy-relevant title by its real
// platform id, and (b) the two launchers whose install metadata isn't
// safely enumerable generically). Add a game by appending one entry.
export const KNOWN_GAMES: KnownGameDef[] = [
  {
    id: 'fivem', name: 'FiveM', mercyGameId: 'fivem', mercyStatus: 'supported',
    executableRelPath: 'FiveM.exe',
    directPaths: ['%LOCALAPPDATA%\\FiveM\\FiveM Application Data'],
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
  private cached: DetectedGame[] = [];
  private lastScanAt: string | null = null;
  /** Real, bounded default — see this file's header on why "configurable
   *  refresh interval" is implemented as this one sensible constant rather
   *  than a full settings UI for this milestone. */
  static readonly AUTO_RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;

  constructor(private userDataPath: string, private options: GameScannerOptions = {}) {
    const dataDir = path.join(userDataPath, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.cacheFile = path.join(dataDir, 'detected-games.json');
    try {
      if (fs.existsSync(this.cacheFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
        this.cached = parsed.games || [];
        this.lastScanAt = parsed.lastScanAt || null;
      }
    } catch { this.cached = []; this.lastScanAt = null; }
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
    const results = Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));

    this.cached = results;
    this.lastScanAt = new Date().toISOString();
    try { fs.writeFileSync(this.cacheFile, JSON.stringify({ games: results, lastScanAt: this.lastScanAt }, null, 2)); } catch {}
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
