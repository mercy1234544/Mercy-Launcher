// Assetto Corsa dedicated server lifecycle — Mercy's second real racing/sim
// backend, built following MinecraftManager.ts's own conventions (JSON-file
// registry in userData, a Map<string, ChildProcess> for live processes,
// console lines broadcast to the renderer over IPC) rather than inventing a
// new pattern. Deliberately NOT generalized into a shared "GameServerManager"
// with Minecraft/FiveM — there are only two-three real implementations to
// compare against, so any such abstraction today would be guesswork (see
// MinecraftManager.ts's and config/games.ts's own comments on the same
// principle).
//
// Real, documented Assetto Corsa dedicated server facts this file relies on
// (stable since the server's release and unchanged for years — this is not
// guesswork):
//  - The dedicated server binary is `acServer.exe` on Windows and `acServer`
//    (no extension) on Linux. Spawn logic below branches on process.platform
//    rather than hardcoding the Windows name, so the process layer can run
//    unmodified on a future Linux host (see this file's own header note on
//    scope — no actual remote/SSH deployment is built here, just no
//    Windows-only assumptions baked into the local spawn code).
//  - Configuration lives in `cfg/server_cfg.ini` (server settings + session
//    list) and `cfg/entry_list.ini` (one car slot per [CAR_n] section) next
//    to the executable. Both are plain `key=value` under `[SECTION]`
//    headers — no nesting, no JSON — so this file has its own tiny
//    read/write helpers rather than pulling in an INI library.
//  - Real installed content lives under `<AC install>/content/cars/<id>/`
//    (a `ui/ui_car.json` with real name/brand/tags, plus `data.acd` or a
//    `data/` folder, plus `skins/<name>/`) and
//    `<AC install>/content/tracks/<id>/` (a `ui/ui_track.json` for a
//    single-layout track, or one `ui/<layout>/ui_track.json` per layout for
//    a multi-layout track like ks_nordschleife). Detection/validation below
//    reads these real files — it never invents a car or track that isn't
//    actually on disk.
//  - The vanilla dedicated server has NO documented interactive stdin
//    command protocol the way Minecraft's console does (no "say"/"kick"
//    commands typed into stdin) — real-world server wrappers just terminate
//    the process to stop it. Mercy's Console tab is therefore a real,
//    read-only tail of the process's own stdout/stderr, not a command
//    input — pretending otherwise would be a fabricated capability.
//  - There is also no single, version-stable "server is ready" log line
//    Mercy can rely on across every server build the way Mojang/Microsoft's
//    lines are for Minecraft. Rather than guess a string and risk servers
//    appearing stuck on "Starting…" forever, readiness is verified the same
//    honest way Minecraft/Bedrock verify LIVE reachability elsewhere in
//    this app: by checking whether the server's own configured UDP port is
//    actually bound (see waitForUdpPortBound()) — a real, verifiable signal
//    independent of any particular server build's log wording.
import fs from 'fs';
import path from 'path';
import os from 'os';
import dgram from 'dgram';
import { spawn, ChildProcess, execFile } from 'child_process';
import { BrowserWindow } from 'electron';
import archiver from 'archiver';
import extractZip from 'extract-zip';

export type AssettoCorsaServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface AcSessionConfig {
  enabled: boolean;
  name: string;
  /** Practice/Qualify: minutes. Race: either laps OR minutes (real AC
   *  servers accept either — timeMinutes is used when laps is 0). */
  timeMinutes: number;
  laps: number;
  /** Race only (WAIT_TIME) — seconds between sessions. */
  waitTimeSeconds: number;
}

export interface AcCarEntry {
  /** Real installed car folder id (content/cars/<model>). */
  model: string;
  /** Real installed skin folder name under that car, or '' for the car's default/first skin. */
  skin: string;
  ballastKg: number;
  restrictor: number;
  spectatorMode: boolean;
}

export interface AssettoCorsaSessions {
  practice: AcSessionConfig;
  qualify: AcSessionConfig;
  race: AcSessionConfig;
}

export interface AssettoCorsaServer {
  id: string;
  name: string;
  /** This server's own folder — contains cfg/ and the acServer executable. */
  installPath: string;
  /** The AC game installation's content root (contains cars/ and tracks/)
   *  used to validate track/car selections. '' if never established (e.g.
   *  a very old import) — content-dependent features degrade honestly
   *  rather than guessing. */
  contentRoot: string;
  track: string;
  /** '' when the track has no distinct named layout. */
  trackLayout: string;
  cars: AcCarEntry[];
  maxClients: number;
  udpPort: number;
  tcpPort: number;
  httpPort: number;
  password: string;
  adminPassword: string;
  registerToLobby: boolean;
  sessions: AssettoCorsaSessions;
  damageMultiplier: number;
  fuelRate: number;
  tyreWearRate: number;
  allowedTyresOut: number;
  /** Real ABS_ALLOWED semantics: 0 off, 1 factory-fitted only, 2 forced on for all cars. */
  absAllowed: 0 | 1 | 2;
  tcAllowed: 0 | 1 | 2;
  stabilityAllowed: boolean;
  autoclutchAllowed: boolean;
  tyreBlanketsAllowed: boolean;
  /** Semicolon-separated compound letters, e.g. "V;H;M;S". */
  legalTyres: string;
  /** Real base-game time-of-day control (0-360 degrees) — NOT a day/night
   *  cycle; see this file's header + WEATHER_DAY_NIGHT_NOTE below. */
  sunAngle: number;
  /** A real weather preset folder name under content/weather/<name> — a
   *  single static preset, not live weather transitions (see note below). */
  weatherGraphics: string;
  ambientTemp: number;
  roadTemp: number;
  status: AssettoCorsaServerStatus;
  pid: number | null;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  /** The REAL Assetto Corsa central lobby's own registration outcome for
   *  the CURRENT run — deliberately separate from `status` (Part 5/8): a
   *  server the AC public lobby rejects as unreachable (typically no port
   *  forwarding) is still a genuinely running local/LAN/Mercy-relay server.
   *  'unknown' is the honest default — the base dedicated server has no
   *  documented "lobby registration succeeded" line to confirm success by
   *  (see this file's header), so this only ever flips to 'unreachable'
   *  upon actually observing the real, stable AC central-server rejection
   *  text in this run's own console output. Reset to 'unknown' on every
   *  fresh start. */
  lobbyStatus: 'unknown' | 'unreachable';
}

export interface AcCreateConfig {
  name: string;
  installPath: string;
  contentRoot: string;
  track: string;
  trackLayout?: string;
  cars: AcCarEntry[];
  maxClients?: number;
  udpPort?: number;
  tcpPort?: number;
  httpPort?: number;
  password?: string;
  adminPassword?: string;
  registerToLobby?: boolean;
  sessions?: Partial<AssettoCorsaSessions>;
  damageMultiplier?: number;
  fuelRate?: number;
  tyreWearRate?: number;
  allowedTyresOut?: number;
  absAllowed?: 0 | 1 | 2;
  tcAllowed?: 0 | 1 | 2;
  stabilityAllowed?: boolean;
  autoclutchAllowed?: boolean;
  tyreBlanketsAllowed?: boolean;
  legalTyres?: string;
  sunAngle?: number;
  weatherGraphics?: string;
  ambientTemp?: number;
  roadTemp?: number;
}

export interface AcCarInfo {
  id: string;
  name: string;
  brand: string;
  tags: string[];
  skins: string[];
  /** True only when the car's own required files (ui/ui_car.json plus
   *  data.acd or a data/ folder) were genuinely found on disk. */
  valid: boolean;
}

export interface AcTrackLayoutInfo { layout: string; name: string; }
export interface AcTrackInfo {
  id: string;
  name: string;
  tags: string[];
  layouts: AcTrackLayoutInfo[];
  valid: boolean;
}

// What "day/night/weather/traffic" actually means for a real AC dedicated
// server, kept as one clear, honest reference rather than scattered
// assumptions — see Section 7 of the spec this was built against:
//  - REAL, server-configurable today (exposed below): SUN_ANGLE (a static
//    time-of-day lighting angle, not a progressing clock) and a single
//    WEATHER_0 preset (a fixed weather/temperature snapshot for the whole
//    session, not a live transition).
//  - NOT server-configurable by the base dedicated server: live weather
//    transitions (rain starting/stopping), real-time day/night progression
//    during a session, and AI/background traffic. Those are CLIENT-SIDE
//    Content Manager / CSP features (e.g. the "Sol" weather app, CSP's
//    traffic scripting) that every connecting client runs locally — the
//    dedicated server process has no control surface for them at all, so
//    Mercy does not expose fake controls for them. A server can still be
//    used with CSP/traffic-equipped tracks (like Shutoko) — Mercy just
//    doesn't pretend to configure the parts it structurally can't.
export const AC_WEATHER_DAY_NIGHT_NOTE =
  'SUN_ANGLE and a weather preset are real, static server settings. Live weather transitions, real-time day/night progression, and AI traffic are Content Manager/CSP client-side features the dedicated server has no control over — Mercy does not fake controls for them.';

const MAX_CONSOLE_LINES = 2000;
const DEFAULT_WEATHER = '3_clear';

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Tolerant JSON parse for real-world ui_car.json/ui_track.json files, which
 *  are sometimes hand-edited by content creators and ship with a stray BOM
 *  or a trailing comma — a strict JSON.parse on those would falsely report
 *  genuinely-installed content as invalid. Strict parsing is tried first;
 *  only on failure are a BOM and trailing commas stripped and parsing
 *  retried. Never invents fields that aren't present either way. */
function parseAcJsonFile(filePath: string): any {
  const raw = fs.readFileSync(filePath, 'utf-8');
  try { return JSON.parse(raw); }
  catch {
    const cleaned = raw.replace(/^\uFEFF/, '').replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(cleaned);
  }
}

/** Minimal real INI reader for AC's own plain `[SECTION]` / `key=value`
 *  format — `;`-prefixed lines are comments, matching AC's real config
 *  files. No nesting, no arrays beyond the semicolon-joined strings AC
 *  itself uses (e.g. CARS=car_a;car_b) — anything more would be inventing
 *  structure AC's format doesn't have. */
function parseIni(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) { current = {}; sections[sectionMatch[1]] = current; continue; }
    const eq = line.indexOf('=');
    if (eq === -1 || !current) continue;
    current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return sections;
}

function iniNum(sections: Record<string, Record<string, string>>, section: string, key: string, fallback: number): number {
  const v = sections[section]?.[key];
  const n = v !== undefined ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function iniStr(sections: Record<string, Record<string, string>>, section: string, key: string, fallback: string): string {
  return sections[section]?.[key] ?? fallback;
}
function iniBool01(sections: Record<string, Record<string, string>>, section: string, key: string, fallback: boolean): boolean {
  const v = sections[section]?.[key];
  return v === undefined ? fallback : v === '1';
}

export class AssettoCorsaManager {
  private dataFile: string;
  private backupsDir: string;
  private runtimeFile: string;
  private servers: AssettoCorsaServer[] = [];
  private processes: Map<string, ChildProcess> = new Map();
  private consoleBuffers: Map<string, string[]> = new Map();
  private intentionalStop: Set<string> = new Set();
  private resourceSamples: Map<string, { cpuMs: number; sampledAt: number }> = new Map();

  constructor(private userDataPath: string) {
    const dataDir = path.join(userDataPath, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.dataFile = path.join(dataDir, 'assettocorsa-servers.json');
    this.runtimeFile = path.join(dataDir, 'assettocorsa-runtime.json');
    this.backupsDir = path.join(userDataPath, 'assettocorsa-backups');
    if (!fs.existsSync(this.backupsDir)) fs.mkdirSync(this.backupsDir, { recursive: true });
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.dataFile)) this.servers = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
    } catch { this.servers = []; }
  }

  private save() {
    try { fs.writeFileSync(this.dataFile, JSON.stringify(this.servers, null, 2)); } catch {}
  }

  // ── Dedicated-server RUNTIME (Part 9) — a real, one-time-configured
  // location holding the legitimate Assetto Corsa dedicated-server files
  // (acServer.exe and its own companion files), distinct from any single
  // server's own configuration. Never fabricated, never downloaded — the
  // user points Mercy at their own real, legally-obtained install (typically
  // Steam's "Assetto Corsa Dedicated Server" app, or a copy of one). Kept as
  // its own small JSON file (not part of the servers array) since it's
  // shared across every server, not per-server state. ─────────────────────
  getRuntimePath(): string | null {
    try {
      if (!fs.existsSync(this.runtimeFile)) return null;
      const { runtimePath } = JSON.parse(fs.readFileSync(this.runtimeFile, 'utf-8'));
      return typeof runtimePath === 'string' && runtimePath ? runtimePath : null;
    } catch { return null; }
  }

  /** Real validation only — checks the REAL executable actually exists at
   *  the given folder. Never assumes, never creates a fake acServer.exe. */
  validateRuntimeFolder(dirPath: string): { valid: boolean; error?: string } {
    if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return { valid: false, error: 'That folder does not exist.' };
    }
    const exePath = path.join(dirPath, this.executableName());
    if (!fs.existsSync(exePath)) {
      return { valid: false, error: `${this.executableName()} was not found in that folder. Select the folder containing your real Assetto Corsa dedicated-server installation.` };
    }
    return { valid: true };
  }

  setRuntimePath(dirPath: string): { success: boolean; error?: string } {
    const check = this.validateRuntimeFolder(dirPath);
    if (!check.valid) return { success: false, error: check.error };
    try {
      fs.writeFileSync(this.runtimeFile, JSON.stringify({ runtimePath: dirPath }, null, 2));
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Could not save the runtime location.' };
    }
  }

  /** Real, honest per-server readiness check — used both by startServer()
   *  itself (so a start attempt fails for the same reasons this reports)
   *  and by the renderer to show a real setup screen instead of a cryptic
   *  error the first time a server is started. Never fabricates readiness:
   *  every field reflects something actually checked on disk/network just
   *  now, not cached or assumed. */
  async getServerReadiness(id: string): Promise<{
    ready: boolean;
    runtimeConfigured: boolean;
    executablePresent: boolean;
    configPresent: boolean;
    contentValid: boolean;
    contentError?: string;
    contentLinked: boolean;
    contentLinkError?: string;
    portAvailable: boolean;
    portError?: string;
  } | null> {
    const server = this.getServer(id);
    if (!server) return null;
    const runtimeConfigured = !!this.getRuntimePath();
    const executablePresent = fs.existsSync(path.join(server.installPath, this.executableName()));
    const configPresent = fs.existsSync(path.join(server.installPath, 'cfg', 'server_cfg.ini')) && fs.existsSync(path.join(server.installPath, 'cfg', 'entry_list.ini'));

    let contentValid = true, contentError: string | undefined;
    if (server.contentRoot) {
      const trackCheck = this.validateTrack(server.contentRoot, server.track, server.trackLayout);
      if (!trackCheck.valid) { contentValid = false; contentError = trackCheck.error; }
      for (const car of server.cars) {
        if (!contentValid) break;
        const carCheck = this.validateCar(server.contentRoot, car.model);
        if (!carCheck.valid) { contentValid = false; contentError = carCheck.error; }
      }
    }
    // Real check that the server's OWN folder can actually see its content
    // (Part 7) — distinct from contentValid above, which only confirms the
    // content exists in contentRoot. A real acServer.exe process resolves
    // content/... relative to ITS OWN working directory, so this is the
    // check that actually predicts the "file not found" runtime errors.
    const linkResult = this.linkServerContent(id);
    const contentLinked = linkResult.success;
    const contentLinkError = linkResult.error;

    const portFree = this.processes.has(id) ? true : await this.isUdpPortFree(server.udpPort);
    const portAvailable = portFree;
    const portError = portFree ? undefined : `UDP port ${server.udpPort} is already in use by another program on this computer.`;

    return {
      ready: executablePresent && configPresent && contentValid && contentLinked && portAvailable,
      runtimeConfigured, executablePresent, configPresent, contentValid, contentError, contentLinked, contentLinkError, portAvailable, portError,
    };
  }

  /** This machine's own real, non-internal IPv4 address — never a
   *  fabricated/example address, null when none is found. Same real
   *  technique MinecraftManager.getLanAddress() already uses; kept as its
   *  own small copy here rather than a shared abstraction, matching this
   *  file's own header note on why AC isn't folded into a generic
   *  "GameServerManager" — there are too few real implementations to
   *  compare against to safely extract shared code yet. */
  private getLanAddress(): string | null {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return null;
  }

  /** Real connection facts for THIS server, for the exact same join-
   *  negotiation flow Minecraft already uses (see
   *  ConnectionNegotiator.planHostEndpoint(), which is game-agnostic and
   *  requires nothing AC-specific — this is the one piece that was
   *  missing). `portListening` is never assumed true just because the
   *  process is running: it's the real, PID-scoped OS query
   *  (isProcessListeningOnUdpPort — the same technique that fixed the
   *  "UDP port never came up" readiness bug) confirming the real UDP game
   *  socket is genuinely bound right now. */
  async getConnectionInfo(id: string): Promise<{ lanAddress: string | null; port: number; portListening: boolean | null } | null> {
    const server = this.getServer(id);
    if (!server) return null;
    const proc = this.processes.get(id);
    const portListening = server.status === 'running' && server.pid
      ? await this.isProcessListeningOnUdpPort(server.pid, server.udpPort)
      : (proc ? null : false); // 'starting' with no confirmed bind yet is honestly unknown, not false
    return { lanAddress: this.getLanAddress(), port: server.udpPort, portListening };
  }

  /** Real per-server content staging — the root-cause fix for "file not
   *  found" errors under content/... for cars/tracks that genuinely DO
   *  exist in contentRoot. The real acServer.exe process resolves
   *  `content/cars/<model>`, `content/tracks/<track>`, `content/weather/
   *  <preset>`, etc. RELATIVE TO ITS OWN WORKING DIRECTORY (this server's
   *  installPath) — never relative to the separately-configured
   *  contentRoot Mercy itself uses for browsing/selection/validation.
   *  ensureRuntimeFilesPresent() above deliberately never COPIES content/
   *  (to avoid GB-scale duplication per server) but never provided any
   *  alternative for the real process to actually see it either — this is
   *  that alternative: a single directory junction (Windows) / symlink
   *  (elsewhere), not a copy, so this costs no meaningful disk space
   *  regardless of the shared library's real size, and NTFS junctions
   *  don't require administrator privileges the way symbolic links do.
   *  Never touches a real, already-existing `content/` directory (e.g. an
   *  older full-copy install, or content the user placed there manually)
   *  — only ever creates or replaces a STALE link. */
  linkServerContent(id: string): { success: boolean; error?: string } {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    if (!server.contentRoot) return { success: true }; // nothing to link — content-dependent checks already degrade honestly elsewhere
    const contentLink = path.join(server.installPath, 'content');
    try {
      if (fs.existsSync(contentLink)) {
        const st = fs.lstatSync(contentLink);
        if (!st.isSymbolicLink()) return { success: true }; // a real directory already sits here — never touch/delete real content
        let real: string | null = null;
        try { real = fs.realpathSync(contentLink); } catch { /* target no longer exists — definitely stale */ }
        if (real && path.resolve(real) === path.resolve(server.contentRoot)) return { success: true }; // already correct
        fs.unlinkSync(contentLink); // stale link only — never a real directory
      }
      fs.mkdirSync(path.dirname(contentLink), { recursive: true });
      fs.symlinkSync(server.contentRoot, contentLink, process.platform === 'win32' ? 'junction' : 'dir');
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || `Could not link this server's content folder to ${server.contentRoot}.` };
    }
  }

  /** Real, best-effort population of a server's own folder from the
   *  configured runtime — copies the runtime's own real top-level files
   *  (the executable and its actual companion files) into the server's
   *  installPath, never the runtime's own `content/` folder (that's the
   *  large, already-shared car/track data referenced separately via
   *  contentRoot — copying it here would be exactly the unnecessary GB-scale
   *  duplication Part 10 warns against; see linkServerContent() above for
   *  how the real process still sees it). Never overwrites a file that's
   *  already really there (e.g. this server's own cfg/ is left alone). */
  ensureRuntimeFilesPresent(id: string): { success: boolean; error?: string } {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    if (fs.existsSync(path.join(server.installPath, this.executableName()))) return { success: true };
    const runtimePath = this.getRuntimePath();
    if (!runtimePath) return { success: false, error: 'No Assetto Corsa dedicated-server runtime is configured yet.' };
    const check = this.validateRuntimeFolder(runtimePath);
    if (!check.valid) return { success: false, error: `The configured runtime is no longer valid: ${check.error}` };
    try {
      fs.mkdirSync(server.installPath, { recursive: true });
      for (const entry of fs.readdirSync(runtimePath, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.toLowerCase() === 'content') continue; // shared via contentRoot, never duplicated
        const dest = path.join(server.installPath, entry.name);
        if (fs.existsSync(dest)) continue; // never overwrite something already really there
        fs.cpSync(path.join(runtimePath, entry.name), dest, { recursive: true });
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Could not copy the runtime files into this server.' };
    }
  }

  /** Real OS-level check — tries to bind the port ourselves; EADDRINUSE
   *  means something else genuinely already holds it. Symmetric to
   *  waitForUdpPortBound()'s own real bind-probe technique, just checking
   *  the opposite condition before a start rather than confirming one after. */
  private isUdpPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = dgram.createSocket('udp4');
      probe.once('error', (err: any) => { probe.close(); resolve(err?.code !== 'EADDRINUSE'); });
      probe.once('listening', () => { probe.close(); resolve(true); });
      try { probe.bind(port); } catch { resolve(true); }
    });
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** Guarded against a missing real Electron BrowserWindow (require('electron')
   *  resolves to a plain path string outside an actual Electron process) so
   *  deterministic tests can exercise the real process lifecycle — real
   *  spawn, real exit handling — under plain `node` without a renderer to
   *  broadcast to, exactly like this app's own real behavior before any
   *  window has opened. */
  private broadcast(channel: string, data: any) {
    if (typeof BrowserWindow?.getAllWindows !== 'function') return;
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, data);
  }

  private appendConsole(id: string, line: string) {
    const buf = this.consoleBuffers.get(id) || [];
    buf.push(line);
    if (buf.length > MAX_CONSOLE_LINES) buf.splice(0, buf.length - MAX_CONSOLE_LINES);
    this.consoleBuffers.set(id, buf);
    this.broadcast('assettocorsa:console', { serverId: id, line });
  }

  getConsoleBuffer(id: string): string[] { return this.consoleBuffers.get(id) || []; }
  getAllServers(): AssettoCorsaServer[] { return this.servers; }
  getServer(id: string): AssettoCorsaServer | undefined { return this.servers.find((s) => s.id === id); }
  isRunning(id: string): boolean { return this.processes.has(id); }

  private executableName(): string { return process.platform === 'win32' ? 'acServer.exe' : 'acServer'; }

  // ── Content detection (real files only, never fabricated) ────────────────

  detectCars(contentRoot: string): AcCarInfo[] {
    const carsDir = path.join(contentRoot, 'cars');
    if (!fs.existsSync(carsDir)) return [];
    const results: AcCarInfo[] = [];
    for (const entry of fs.readdirSync(carsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const carDir = path.join(carsDir, entry.name);
      const hasData = fs.existsSync(path.join(carDir, 'data.acd')) || fs.existsSync(path.join(carDir, 'data'));
      const uiPath = path.join(carDir, 'ui', 'ui_car.json');
      let name = entry.name, brand = '', tags: string[] = [];
      if (fs.existsSync(uiPath)) {
        try {
          const ui = parseAcJsonFile(uiPath);
          if (typeof ui.name === 'string' && ui.name.trim()) name = ui.name;
          if (typeof ui.brand === 'string') brand = ui.brand;
          if (Array.isArray(ui.tags)) tags = ui.tags.filter((t: any) => typeof t === 'string');
        } catch { /* malformed ui_car.json — still list the car, just without real metadata beyond its folder name */ }
      }
      const skinsDir = path.join(carDir, 'skins');
      const skins = fs.existsSync(skinsDir)
        ? fs.readdirSync(skinsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
        : [];
      results.push({ id: entry.name, name, brand, tags, skins, valid: hasData && fs.existsSync(uiPath) });
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  detectTracks(contentRoot: string): AcTrackInfo[] {
    const tracksDir = path.join(contentRoot, 'tracks');
    if (!fs.existsSync(tracksDir)) return [];
    const results: AcTrackInfo[] = [];
    for (const entry of fs.readdirSync(tracksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const trackDir = path.join(tracksDir, entry.name);
      const uiDir = path.join(trackDir, 'ui');
      const directUi = path.join(uiDir, 'ui_track.json');
      const layouts: AcTrackLayoutInfo[] = [];
      let name = entry.name, tags: string[] = [];
      if (fs.existsSync(directUi)) {
        try {
          const ui = parseAcJsonFile(directUi);
          if (typeof ui.name === 'string' && ui.name.trim()) name = ui.name;
          if (Array.isArray(ui.tags)) tags = ui.tags.filter((t: any) => typeof t === 'string');
        } catch {}
      } else if (fs.existsSync(uiDir)) {
        // Multi-layout track: one ui/<layout>/ui_track.json per real layout.
        for (const layoutEntry of fs.readdirSync(uiDir, { withFileTypes: true })) {
          if (!layoutEntry.isDirectory()) continue;
          const layoutUi = path.join(uiDir, layoutEntry.name, 'ui_track.json');
          if (!fs.existsSync(layoutUi)) continue;
          let layoutName = layoutEntry.name;
          try {
            const ui = parseAcJsonFile(layoutUi);
            if (typeof ui.name === 'string' && ui.name.trim()) layoutName = ui.name;
            if (tags.length === 0 && Array.isArray(ui.tags)) tags = ui.tags.filter((t: any) => typeof t === 'string');
          } catch {}
          layouts.push({ layout: layoutEntry.name, name: layoutName });
        }
      }
      const valid = fs.existsSync(directUi) || layouts.length > 0;
      results.push({ id: entry.name, name, tags, layouts, valid });
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Real validation — never assumes a track/car exists just because it was
   *  typed/selected; always re-checks the actual filesystem at the time of
   *  use (create/import/start), matching Minecraft's own "never trust a
   *  stale selection" philosophy. */
  validateTrack(contentRoot: string, track: string, layout: string): { valid: boolean; error?: string } {
    if (!contentRoot) return { valid: false, error: 'No Assetto Corsa content location is configured — cannot validate the track.' };
    const trackDir = path.join(contentRoot, 'tracks', track);
    if (!fs.existsSync(trackDir)) return { valid: false, error: `Track "${track}" was not found under ${path.join(contentRoot, 'tracks')}.` };
    const directUi = path.join(trackDir, 'ui', 'ui_track.json');
    if (fs.existsSync(directUi)) return { valid: true };
    if (layout) {
      const layoutUi = path.join(trackDir, 'ui', layout, 'ui_track.json');
      if (fs.existsSync(layoutUi)) return { valid: true };
      return { valid: false, error: `Track "${track}" exists, but layout "${layout}" was not found.` };
    }
    return { valid: false, error: `Track "${track}" has multiple layouts — a layout must be selected.` };
  }

  validateCar(contentRoot: string, model: string): { valid: boolean; error?: string } {
    if (!contentRoot) return { valid: false, error: 'No Assetto Corsa content location is configured — cannot validate this car.' };
    const carDir = path.join(contentRoot, 'cars', model);
    if (!fs.existsSync(carDir)) return { valid: false, error: `Car "${model}" was not found under ${path.join(contentRoot, 'cars')}.` };
    const hasData = fs.existsSync(path.join(carDir, 'data.acd')) || fs.existsSync(path.join(carDir, 'data'));
    if (!hasData) return { valid: false, error: `Car "${model}" is missing its data.acd/data — this looks like an incomplete install.` };
    return { valid: true };
  }

  /** Best-effort: the real, standard Steam library path for Assetto Corsa's
   *  content folder — only ever returned if BOTH cars/ and tracks/ genuinely
   *  exist there. Returns null (never a guess) otherwise; the user picks a
   *  folder manually in that case. */
  detectDefaultContentRoot(): string | null {
    const candidates = process.platform === 'win32'
      ? ['C:\\Program Files (x86)\\Steam\\steamapps\\common\\assettocorsa\\content', 'C:\\Steam\\steamapps\\common\\assettocorsa\\content']
      : [path.join(os.homedir(), '.steam/steam/steamapps/common/assettocorsa/content'), path.join(os.homedir(), '.local/share/Steam/steamapps/common/assettocorsa/content')];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'cars')) && fs.existsSync(path.join(c, 'tracks'))) return c;
    }
    return null;
  }

  /** Real installed weather presets — content/weather/<name>/weather.ini
   *  ships with every base AC install (e.g. "3_clear", "7_summer_day_clear")
   *  and any CSP/track-specific weather mod adds more the same way. Never a
   *  hardcoded guess list — only presets actually found on disk. */
  detectWeatherPresets(contentRoot: string): string[] {
    const weatherDir = path.join(contentRoot, 'weather');
    if (!fs.existsSync(weatherDir)) return [];
    return fs.readdirSync(weatherDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(weatherDir, e.name, 'weather.ini')))
      .map((e) => e.name)
      .sort();
  }

  // ── Config file generation (real server_cfg.ini / entry_list.ini) ────────

  private defaultSessions(): AssettoCorsaSessions {
    return {
      practice: { enabled: true, name: 'Practice', timeMinutes: 10, laps: 0, waitTimeSeconds: 0 },
      qualify: { enabled: true, name: 'Qualify', timeMinutes: 10, laps: 0, waitTimeSeconds: 0 },
      race: { enabled: true, name: 'Race', timeMinutes: 0, laps: 10, waitTimeSeconds: 60 },
    };
  }

  private buildServerCfgIni(server: AssettoCorsaServer): string {
    const lines: string[] = [];
    lines.push('[SERVER]');
    lines.push(`NAME=${server.name}`);
    lines.push(`CARS=${server.cars.map((c) => c.model).join(';')}`);
    lines.push(`TRACK=${server.track}`);
    lines.push(`CONFIG_TRACK=${server.trackLayout || ''}`);
    lines.push(`SUN_ANGLE=${server.sunAngle}`);
    lines.push(`MAX_CLIENTS=${server.maxClients}`);
    lines.push(`UDP_PORT=${server.udpPort}`);
    lines.push(`TCP_PORT=${server.tcpPort}`);
    lines.push(`HTTP_PORT=${server.httpPort}`);
    lines.push(`REGISTER_TO_LOBBY=${server.registerToLobby ? 1 : 0}`);
    lines.push(`PICKUP_MODE_ENABLED=1`);
    lines.push(`LOOP_MODE=1`);
    lines.push(`SLEEP_TIME=1`);
    lines.push(`CLIENT_SEND_INTERVAL_HZ=18`);
    lines.push(`PASSWORD=${server.password}`);
    lines.push(`ADMIN_PASSWORD=${server.adminPassword}`);
    lines.push(`LEGAL_TYRES=${server.legalTyres}`);
    lines.push(`FUEL_RATE=${server.fuelRate}`);
    lines.push(`DAMAGE_MULTIPLIER=${server.damageMultiplier}`);
    lines.push(`TYRE_WEAR_RATE=${server.tyreWearRate}`);
    lines.push(`ALLOWED_TYRES_OUT=${server.allowedTyresOut}`);
    lines.push(`ABS_ALLOWED=${server.absAllowed}`);
    lines.push(`TC_ALLOWED=${server.tcAllowed}`);
    lines.push(`STABILITY_ALLOWED=${server.stabilityAllowed ? 1 : 0}`);
    lines.push(`AUTOCLUTCH_ALLOWED=${server.autoclutchAllowed ? 1 : 0}`);
    lines.push(`TYRE_BLANKETS_ALLOWED=${server.tyreBlanketsAllowed ? 1 : 0}`);
    lines.push(`FORCE_VIRTUAL_MIRROR=0`);
    lines.push(`MAX_BALLAST_KG=100`);
    lines.push(`RACE_PIT_WINDOW_START=0`);
    lines.push(`RACE_PIT_WINDOW_END=0`);
    lines.push(`REVERSED_GRID_RACE_POSITIONS=0`);
    lines.push('');
    lines.push('[DYNAMIC_TRACK]');
    lines.push('SESSION_START=96');
    lines.push('RANDOMNESS=1');
    lines.push('SESSION_TRANSFER=80');
    lines.push('LAP_GAIN=10');
    lines.push('');

    const pushSession = (header: string, s: AcSessionConfig, useLaps: boolean) => {
      if (!s.enabled) return;
      lines.push(`[${header}]`);
      lines.push(`NAME=${s.name}`);
      if (useLaps && s.laps > 0) lines.push(`LAPS=${s.laps}`); else lines.push(`TIME=${s.timeMinutes}`);
      if (header === 'RACE') lines.push(`WAIT_TIME=${s.waitTimeSeconds}`);
      lines.push('');
    };
    pushSession('PRACTICE', server.sessions.practice, false);
    pushSession('QUALIFY', server.sessions.qualify, false);
    pushSession('RACE', server.sessions.race, true);

    lines.push('[WEATHER_0]');
    lines.push(`GRAPHICS=${server.weatherGraphics}`);
    lines.push(`BASE_TEMPERATURE_AMBIENT=${server.ambientTemp}`);
    lines.push(`BASE_TEMPERATURE_ROAD=${server.roadTemp}`);
    lines.push('VARIATION_AMBIENT=1');
    lines.push('VARIATION_ROAD=1');
    lines.push('WIND_BASE_SPEED_MIN=0');
    lines.push('WIND_BASE_SPEED_MAX=0');
    lines.push('WIND_BASE_DIRECTION=0');
    lines.push('WIND_VARIATION_DIRECTION=0');
    return lines.join('\n') + '\n';
  }

  private buildEntryListIni(server: AssettoCorsaServer): string {
    const lines: string[] = [];
    server.cars.forEach((car, i) => {
      lines.push(`[CAR_${i}]`);
      lines.push(`MODEL=${car.model}`);
      lines.push(`SKIN=${car.skin}`);
      lines.push(`SPECTATOR_MODE=${car.spectatorMode ? 1 : 0}`);
      lines.push('DRIVERNAME=');
      lines.push('TEAM=');
      lines.push('GUID=');
      lines.push(`BALLAST=${car.ballastKg}`);
      lines.push(`RESTRICTOR=${car.restrictor}`);
      lines.push('');
    });
    return lines.join('\n') + '\n';
  }

  private writeConfigFiles(server: AssettoCorsaServer) {
    const cfgDir = path.join(server.installPath, 'cfg');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'server_cfg.ini'), this.buildServerCfgIni(server));
    fs.writeFileSync(path.join(cfgDir, 'entry_list.ini'), this.buildEntryListIni(server));
  }

  // ── Create / Import ───────────────────────────────────────────────────────

  private validateCreateContent(cfg: AcCreateConfig): { valid: boolean; error?: string } {
    if (!cfg.cars || cfg.cars.length === 0) return { valid: false, error: 'At least one car is required.' };
    const trackCheck = this.validateTrack(cfg.contentRoot, cfg.track, cfg.trackLayout || '');
    if (!trackCheck.valid) return trackCheck;
    for (const car of cfg.cars) {
      const carCheck = this.validateCar(cfg.contentRoot, car.model);
      if (!carCheck.valid) return carCheck;
    }
    return { valid: true };
  }

  private portsInUseByOtherServer(udpPort: number, httpPort: number, excludeId?: string): string | null {
    for (const s of this.servers) {
      if (s.id === excludeId) continue;
      if (s.udpPort === udpPort) return `UDP/TCP port ${udpPort} is already used by "${s.name}".`;
      if (s.httpPort === httpPort) return `HTTP port ${httpPort} is already used by "${s.name}".`;
    }
    return null;
  }

  async createServer(cfg: AcCreateConfig): Promise<{ success: boolean; server?: AssettoCorsaServer; error?: string }> {
    const validation = this.validateCreateContent(cfg);
    if (!validation.valid) return { success: false, error: validation.error };

    const udpPort = cfg.udpPort ?? 9600;
    const tcpPort = cfg.tcpPort ?? udpPort;
    const httpPort = cfg.httpPort ?? 8081;
    const portConflict = this.portsInUseByOtherServer(udpPort, httpPort);
    if (portConflict) return { success: false, error: portConflict };

    if (fs.existsSync(cfg.installPath) && fs.readdirSync(cfg.installPath).length > 0) {
      return { success: false, error: 'That folder already exists and is not empty. Choose an empty folder for the new server.' };
    }

    const now = new Date().toISOString();
    const defaults = this.defaultSessions();
    const server: AssettoCorsaServer = {
      id: this.generateId(), name: cfg.name, installPath: cfg.installPath, contentRoot: cfg.contentRoot,
      track: cfg.track, trackLayout: cfg.trackLayout || '', cars: cfg.cars,
      maxClients: cfg.maxClients ?? 18, udpPort, tcpPort, httpPort,
      password: cfg.password || '', adminPassword: cfg.adminPassword || '',
      registerToLobby: cfg.registerToLobby ?? true,
      sessions: {
        practice: { ...defaults.practice, ...cfg.sessions?.practice },
        qualify: { ...defaults.qualify, ...cfg.sessions?.qualify },
        race: { ...defaults.race, ...cfg.sessions?.race },
      },
      damageMultiplier: cfg.damageMultiplier ?? 100, fuelRate: cfg.fuelRate ?? 100, tyreWearRate: cfg.tyreWearRate ?? 100,
      allowedTyresOut: cfg.allowedTyresOut ?? 2, absAllowed: cfg.absAllowed ?? 1, tcAllowed: cfg.tcAllowed ?? 1,
      stabilityAllowed: cfg.stabilityAllowed ?? false, autoclutchAllowed: cfg.autoclutchAllowed ?? true, tyreBlanketsAllowed: cfg.tyreBlanketsAllowed ?? true,
      legalTyres: cfg.legalTyres || 'V;H;M;S',
      sunAngle: cfg.sunAngle ?? 48, weatherGraphics: cfg.weatherGraphics || DEFAULT_WEATHER,
      ambientTemp: cfg.ambientTemp ?? 18, roadTemp: cfg.roadTemp ?? 24,
      status: 'stopped', pid: null, startedAt: null, createdAt: now, updatedAt: now, lastError: null,
      lobbyStatus: 'unknown',
    };

    try {
      fs.mkdirSync(server.installPath, { recursive: true });
      this.writeConfigFiles(server);
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to write server configuration files.' };
    }

    this.servers.push(server);
    const linkResult = this.linkServerContent(server.id);
    if (!linkResult.success) {
      // Real content problem detected BEFORE the server is ever started
      // (Part 7) — never leave a server registered whose real content the
      // dedicated server process would fail to find at runtime.
      this.servers = this.servers.filter((s) => s.id !== server.id);
      return { success: false, error: linkResult.error };
    }
    this.save();
    return { success: true, server };
  }

  /** Real detection for the Import dialog — never guesses from a folder
   *  name, only from the actual real config files AC itself writes. */
  async detectExistingServer(dirPath: string): Promise<{ valid: boolean; reason?: string; hasExecutable?: boolean }> {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return { valid: false, reason: 'That path does not exist or is not a folder.' };
    }
    const cfgPath = path.join(dirPath, 'cfg', 'server_cfg.ini');
    if (!fs.existsSync(cfgPath)) return { valid: false, reason: 'No cfg/server_cfg.ini was found in that folder — this doesn\'t look like an Assetto Corsa server install.' };
    const hasExecutable = fs.existsSync(path.join(dirPath, this.executableName()));
    return { valid: true, hasExecutable };
  }

  async importServer(dirPath: string, name: string, contentRoot: string): Promise<{ success: boolean; server?: AssettoCorsaServer; error?: string }> {
    const detected = await this.detectExistingServer(dirPath);
    if (!detected.valid) return { success: false, error: detected.reason };
    if (this.servers.some((s) => path.resolve(s.installPath) === path.resolve(dirPath))) {
      return { success: false, error: 'This server is already registered in Mercy Launcher.' };
    }

    const cfgText = fs.readFileSync(path.join(dirPath, 'cfg', 'server_cfg.ini'), 'utf-8');
    const cfg = parseIni(cfgText);
    let entrySections: Record<string, Record<string, string>> = {};
    const entryPath = path.join(dirPath, 'cfg', 'entry_list.ini');
    if (fs.existsSync(entryPath)) entrySections = parseIni(fs.readFileSync(entryPath, 'utf-8'));

    const cars: AcCarEntry[] = Object.keys(entrySections)
      .filter((k) => /^CAR_\d+$/.test(k))
      .sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10))
      .map((k) => ({
        model: iniStr({ [k]: entrySections[k] }, k, 'MODEL', ''),
        skin: iniStr({ [k]: entrySections[k] }, k, 'SKIN', ''),
        ballastKg: iniNum({ [k]: entrySections[k] }, k, 'BALLAST', 0),
        restrictor: iniNum({ [k]: entrySections[k] }, k, 'RESTRICTOR', 0),
        spectatorMode: iniBool01({ [k]: entrySections[k] }, k, 'SPECTATOR_MODE', false),
      }))
      .filter((c) => c.model);

    const track = iniStr(cfg, 'SERVER', 'TRACK', '');
    const trackLayout = iniStr(cfg, 'SERVER', 'CONFIG_TRACK', '');
    if (!track) return { success: false, error: 'server_cfg.ini has no TRACK set — nothing to import.' };
    if (cars.length === 0) return { success: false, error: 'No cars found in entry_list.ini — nothing to import.' };

    if (contentRoot) {
      const trackCheck = this.validateTrack(contentRoot, track, trackLayout);
      if (!trackCheck.valid) return { success: false, error: trackCheck.error };
      for (const car of cars) {
        const carCheck = this.validateCar(contentRoot, car.model);
        if (!carCheck.valid) return { success: false, error: carCheck.error };
      }
    }

    const defaults = this.defaultSessions();
    const readSession = (header: string, fallback: AcSessionConfig): AcSessionConfig => ({
      enabled: !!cfg[header],
      name: iniStr(cfg, header, 'NAME', fallback.name),
      timeMinutes: iniNum(cfg, header, 'TIME', fallback.timeMinutes),
      laps: iniNum(cfg, header, 'LAPS', fallback.laps),
      waitTimeSeconds: iniNum(cfg, header, 'WAIT_TIME', fallback.waitTimeSeconds),
    });

    const now = new Date().toISOString();
    const server: AssettoCorsaServer = {
      id: this.generateId(), name: name || iniStr(cfg, 'SERVER', 'NAME', 'Imported Server'),
      installPath: dirPath, contentRoot, track, trackLayout, cars,
      maxClients: iniNum(cfg, 'SERVER', 'MAX_CLIENTS', 18),
      udpPort: iniNum(cfg, 'SERVER', 'UDP_PORT', 9600), tcpPort: iniNum(cfg, 'SERVER', 'TCP_PORT', 9600), httpPort: iniNum(cfg, 'SERVER', 'HTTP_PORT', 8081),
      password: iniStr(cfg, 'SERVER', 'PASSWORD', ''), adminPassword: iniStr(cfg, 'SERVER', 'ADMIN_PASSWORD', ''),
      registerToLobby: iniBool01(cfg, 'SERVER', 'REGISTER_TO_LOBBY', true),
      sessions: { practice: readSession('PRACTICE', defaults.practice), qualify: readSession('QUALIFY', defaults.qualify), race: readSession('RACE', defaults.race) },
      damageMultiplier: iniNum(cfg, 'SERVER', 'DAMAGE_MULTIPLIER', 100), fuelRate: iniNum(cfg, 'SERVER', 'FUEL_RATE', 100), tyreWearRate: iniNum(cfg, 'SERVER', 'TYRE_WEAR_RATE', 100),
      allowedTyresOut: iniNum(cfg, 'SERVER', 'ALLOWED_TYRES_OUT', 2),
      absAllowed: iniNum(cfg, 'SERVER', 'ABS_ALLOWED', 1) as 0 | 1 | 2, tcAllowed: iniNum(cfg, 'SERVER', 'TC_ALLOWED', 1) as 0 | 1 | 2,
      stabilityAllowed: iniBool01(cfg, 'SERVER', 'STABILITY_ALLOWED', false),
      autoclutchAllowed: iniBool01(cfg, 'SERVER', 'AUTOCLUTCH_ALLOWED', true), tyreBlanketsAllowed: iniBool01(cfg, 'SERVER', 'TYRE_BLANKETS_ALLOWED', true),
      legalTyres: iniStr(cfg, 'SERVER', 'LEGAL_TYRES', 'V;H;M;S'),
      sunAngle: iniNum(cfg, 'SERVER', 'SUN_ANGLE', 48), weatherGraphics: iniStr(cfg, 'WEATHER_0', 'GRAPHICS', DEFAULT_WEATHER),
      ambientTemp: iniNum(cfg, 'WEATHER_0', 'BASE_TEMPERATURE_AMBIENT', 18), roadTemp: iniNum(cfg, 'WEATHER_0', 'BASE_TEMPERATURE_ROAD', 24),
      status: 'stopped', pid: null, startedAt: null, createdAt: now, updatedAt: now, lastError: null,
      lobbyStatus: 'unknown',
    };

    this.servers.push(server);
    this.save();
    if (contentRoot) this.linkServerContent(server.id); // best-effort on import — the existing folder already has its own real content today
    return { success: true, server };
  }

  updateServer(id: string, patch: Partial<AcCreateConfig>): { success: boolean; error?: string } {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    if (this.processes.has(id)) return { success: false, error: 'Stop the server before changing its configuration.' };

    const merged: AcCreateConfig = {
      name: patch.name ?? server.name, installPath: server.installPath, contentRoot: patch.contentRoot ?? server.contentRoot,
      track: patch.track ?? server.track, trackLayout: patch.trackLayout ?? server.trackLayout, cars: patch.cars ?? server.cars,
      maxClients: patch.maxClients ?? server.maxClients, udpPort: patch.udpPort ?? server.udpPort, tcpPort: patch.tcpPort ?? server.tcpPort, httpPort: patch.httpPort ?? server.httpPort,
      password: patch.password ?? server.password, adminPassword: patch.adminPassword ?? server.adminPassword, registerToLobby: patch.registerToLobby ?? server.registerToLobby,
      sessions: { practice: { ...server.sessions.practice, ...patch.sessions?.practice }, qualify: { ...server.sessions.qualify, ...patch.sessions?.qualify }, race: { ...server.sessions.race, ...patch.sessions?.race } },
      damageMultiplier: patch.damageMultiplier ?? server.damageMultiplier, fuelRate: patch.fuelRate ?? server.fuelRate, tyreWearRate: patch.tyreWearRate ?? server.tyreWearRate,
      allowedTyresOut: patch.allowedTyresOut ?? server.allowedTyresOut, absAllowed: patch.absAllowed ?? server.absAllowed, tcAllowed: patch.tcAllowed ?? server.tcAllowed,
      stabilityAllowed: patch.stabilityAllowed ?? server.stabilityAllowed, autoclutchAllowed: patch.autoclutchAllowed ?? server.autoclutchAllowed, tyreBlanketsAllowed: patch.tyreBlanketsAllowed ?? server.tyreBlanketsAllowed,
      legalTyres: patch.legalTyres ?? server.legalTyres, sunAngle: patch.sunAngle ?? server.sunAngle, weatherGraphics: patch.weatherGraphics ?? server.weatherGraphics,
      ambientTemp: patch.ambientTemp ?? server.ambientTemp, roadTemp: patch.roadTemp ?? server.roadTemp,
    };
    const validation = this.validateCreateContent(merged);
    if (!validation.valid) return { success: false, error: validation.error };
    const portConflict = this.portsInUseByOtherServer(merged.udpPort!, merged.httpPort!, id);
    if (portConflict) return { success: false, error: portConflict };

    Object.assign(server, merged, { updatedAt: new Date().toISOString() });
    try { this.writeConfigFiles(server); } catch (e: any) { return { success: false, error: e?.message || 'Failed to write configuration.' }; }
    const linkResult = this.linkServerContent(server.id);
    if (!linkResult.success) return { success: false, error: linkResult.error };
    this.save();
    return { success: true };
  }

  // ── Deletion (same drive-root/system-dir safety gate as Minecraft) ───────
  private isSafeServerDirectory(installPath: string): { safe: boolean; reason?: string } {
    let resolved: string;
    try { resolved = fs.realpathSync.native ? fs.realpathSync.native(path.resolve(installPath)) : path.resolve(installPath); }
    catch { resolved = path.resolve(installPath); }
    const parsed = path.parse(resolved);
    if (resolved === parsed.root) return { safe: false, reason: 'Refusing to delete a drive root.' };
    const depth = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean).length;
    if (depth < 2) return { safe: false, reason: 'This directory looks too shallow to be a real server folder — refusing to delete it as a precaution.' };
    const ownDirs = [this.userDataPath, this.backupsDir, process.resourcesPath, process.execPath ? path.dirname(process.execPath) : '']
      .filter(Boolean).map((p) => path.resolve(p as string));
    for (const guarded of ownDirs) {
      if (resolved === guarded || isPathInside(guarded, resolved)) return { safe: false, reason: 'Refusing to delete a directory that would remove Mercy\'s own application data.' };
    }
    const systemDirs = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'].map((p) => path.resolve(p));
    for (const guarded of systemDirs) {
      if (resolved === guarded || isPathInside(resolved, guarded) || isPathInside(guarded, resolved)) return { safe: false, reason: 'Refusing to delete a directory under a protected system location.' };
    }
    return { safe: true };
  }

  async deleteServer(id: string, deleteFiles: boolean): Promise<{ success: boolean; error?: string }> {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    if (this.processes.has(id)) this.stopServer(id, true);

    if (deleteFiles && fs.existsSync(server.installPath)) {
      const safety = this.isSafeServerDirectory(server.installPath);
      if (!safety.safe) return { success: false, error: safety.reason };
      try { fs.rmSync(server.installPath, { recursive: true, force: true }); }
      catch (e: any) { return { success: false, error: `Failed to delete server files: ${e?.message || 'unknown error'}` }; }
    }

    this.servers = this.servers.filter((s) => s.id !== id);
    this.save();
    this.consoleBuffers.delete(id);
    this.resourceSamples.delete(id);
    return { success: true };
  }

  // ── Process lifecycle ──────────────────────────────────────────────────
  /** Real, PID-scoped readiness check — see this file's own header note on
   *  why AC has no reliable "ready" log line to grep for.
   *
   *  This is DELIBERATELY NOT a "try to bind the port myself" probe (that
   *  was the actual bug: on Windows, a UDP socket that itself sets
   *  SO_REUSEADDR — a common, legitimate technique real game servers use so
   *  they can rebind quickly after a crash/restart without waiting for the
   *  OS to release the old socket — allows a COMPLETELY UNRELATED process
   *  to also successfully bind the SAME port. When acServer.exe's own UDP
   *  socket has that flag set, Mercy's own probe bind would SUCCEED
   *  alongside it rather than fail with EADDRINUSE, so the old check
   *  concluded "nothing is listening" even while the real server was
   *  genuinely running and reachable — exactly the reported "Server
   *  started" / "[Mercy] UDP port never came up" contradiction). Querying
   *  the OS's own real socket table for the EXACT pid we spawned has none
   *  of that ambiguity: it can never be confused by an unrelated process on
   *  the same port, and it can never falsely say "not bound" just because
   *  our own probe was allowed to coexist. */
  async isProcessListeningOnUdpPort(pid: number, port: number): Promise<boolean> {
    if (process.platform === 'win32') {
      return new Promise((resolve) => {
        execFile('powershell', [
          '-NoProfile', '-NonInteractive', '-Command',
          `if (Get-NetUDPEndpoint -OwningProcess ${pid} -LocalPort ${port} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
        ], { timeout: 5000, windowsHide: true }, (err, stdout) => {
          if (err) return resolve(false);
          resolve(stdout.trim().toLowerCase() === 'yes');
        });
      });
    }
    // Future Linux host (see this file's own header on spawn portability):
    // `ss` reports the owning pid directly with -p, avoiding the same
    // ambiguity as the Windows path above.
    return new Promise((resolve) => {
      execFile('ss', ['-lunp'], { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout) return resolve(false);
        const found = stdout.split('\n').some((line) => line.includes(`:${port} `) && line.includes(`pid=${pid},`));
        resolve(found);
      });
    });
  }

  private waitForServerReady(pid: number, port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = async () => {
        if (await this.isProcessListeningOnUdpPort(pid, port)) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(poll, 500);
      };
      poll();
    });
  }

  /** The one, real, stable text the official Assetto Corsa central lobby
   *  emits when it rejects a server as unreachable (no port forwarding) —
   *  see this file's header + Part 5/8's own architecture note: this is
   *  deliberately tracked SEPARATELY from `status`, since a server the
   *  public AC lobby can't reach is still a genuinely running local/LAN/
   *  Mercy-relay server. Matched loosely (case-insensitive substring, not
   *  the full exact punctuation) so minor formatting differences across
   *  acServer builds don't silently stop this from being detected. */
  private static readonly LOBBY_REJECTION_PATTERN = /invalid\s*server.*port\s*forwarding/i;

  async startServer(id: string): Promise<{ success: boolean; error?: string; runtimeRequired?: boolean }> {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    if (this.processes.has(id)) return { success: false, error: 'Server is already running.' };

    // Real pre-start checklist (Part 9): runtime, then config, then content,
    // then port — each a real check, never assumed from a prior success.
    this.ensureRuntimeFilesPresent(id); // best-effort; the exe check right after is the real gate
    const exePath = path.join(server.installPath, this.executableName());
    if (!fs.existsSync(exePath)) {
      const runtimeConfigured = !!this.getRuntimePath();
      return {
        success: false, runtimeRequired: true,
        error: runtimeConfigured
          ? `${this.executableName()} still isn't present in this server's own folder even after checking the configured runtime — the runtime folder may no longer be valid.`
          : `This server has been configured, but the Assetto Corsa dedicated-server runtime has not been installed/configured yet.`,
      };
    }
    if (!fs.existsSync(path.join(server.installPath, 'cfg', 'server_cfg.ini')) || !fs.existsSync(path.join(server.installPath, 'cfg', 'entry_list.ini'))) {
      return { success: false, error: 'This server\'s configuration files (cfg/server_cfg.ini, cfg/entry_list.ini) are missing.' };
    }
    if (server.contentRoot) {
      const trackCheck = this.validateTrack(server.contentRoot, server.track, server.trackLayout);
      if (!trackCheck.valid) return { success: false, error: trackCheck.error };
      for (const car of server.cars) {
        const carCheck = this.validateCar(server.contentRoot, car.model);
        if (!carCheck.valid) return { success: false, error: carCheck.error };
      }
    }
    // Real content-visibility check (Part 7) — refreshed on every start so a
    // stale/removed link, or a contentRoot that moved, is caught here rather
    // than surfacing as a runtime "file not found" from acServer.exe itself.
    const linkResult = this.linkServerContent(id);
    if (!linkResult.success) return { success: false, error: linkResult.error };
    if (!(await this.isUdpPortFree(server.udpPort))) {
      return { success: false, error: `UDP port ${server.udpPort} is already in use by another program on this computer. Stop that program or change this server's port.` };
    }

    this.intentionalStop.delete(id);
    server.status = 'starting';
    server.lastError = null;
    server.lobbyStatus = 'unknown'; // this run's own outcome — never carried over from a previous run
    server.updatedAt = new Date().toISOString();
    this.save();
    this.broadcast('assettocorsa:statusChange', { serverId: id, status: 'starting' });

    const proc = spawn(exePath, [], { cwd: server.installPath });
    this.processes.set(id, proc);
    server.pid = proc.pid ?? null;
    server.startedAt = new Date().toISOString();
    this.save();

    const scanForLobbyRejection = (line: string) => {
      if (server.lobbyStatus === 'unreachable') return; // already recorded for this run
      if (!AssettoCorsaManager.LOBBY_REJECTION_PATTERN.test(line)) return;
      server.lobbyStatus = 'unreachable';
      this.save();
      // Reuses the existing statusChange channel (never `status` itself,
      // which stays about the LOCAL process) — the renderer's existing
      // listener already re-fetches the full server record on this event,
      // so this needs no new IPC channel to reach the UI.
      this.broadcast('assettocorsa:statusChange', { serverId: id, status: server.status });
    };
    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) { if (line) { this.appendConsole(id, line); scanForLobbyRejection(line); } }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) { if (line) { this.appendConsole(id, `[ERROR] ${line}`); scanForLobbyRejection(line); } }
    });
    proc.on('exit', (code, signal) => {
      this.processes.delete(id);
      this.resourceSamples.delete(id);
      const wasIntentional = this.intentionalStop.has(id);
      this.intentionalStop.delete(id);
      const current = this.getServer(id);
      if (!current) return;
      current.pid = null;
      current.startedAt = null;
      current.updatedAt = new Date().toISOString();
      current.status = wasIntentional ? 'stopped' : 'error';
      if (!wasIntentional) {
        const lobbyNote = current.lobbyStatus === 'unreachable' ? ' Note: the AC public lobby had rejected this server as unreachable — that is a separate, non-fatal state and is not the reason recorded for this exit.' : '';
        this.appendConsole(id, `[Mercy] Server process exited unexpectedly (code ${code}, signal ${signal}).${lobbyNote}`);
      }
      this.save();
      this.broadcast('assettocorsa:statusChange', { serverId: id, status: current.status });
    });
    proc.on('error', (err) => {
      this.appendConsole(id, `[Mercy] Failed to start: ${err.message}`);
      server.status = 'error';
      this.save();
      this.broadcast('assettocorsa:statusChange', { serverId: id, status: 'error' });
    });

    // Verify real readiness in the background — never blocks the caller,
    // matching Minecraft's own "starting" -> "running" async transition.
    // Local server health only: the official AC public lobby's own
    // accept/reject decision (tracked separately as lobbyStatus above) is
    // never part of this check — see this file's header + Part 5/8.
    (async () => {
      const pid = proc.pid;
      const bound = pid ? await this.waitForServerReady(pid, server.udpPort, 20000) : false;
      const stillTracked = this.processes.get(id) === proc;
      if (!stillTracked) return; // exited or was replaced before we finished checking
      if (bound) {
        server.status = 'running';
        this.save();
        this.broadcast('assettocorsa:statusChange', { serverId: id, status: 'running' });
      } else {
        this.appendConsole(id, `[Mercy] UDP port ${server.udpPort} never came up after 20s — the process is running but may not have started correctly.`);
      }
    })();

    return { success: true };
  }

  stopServer(id: string, force = false): boolean {
    const proc = this.processes.get(id);
    const server = this.getServer(id);
    if (!proc || !server) return false;
    this.intentionalStop.add(id);
    if (server.status !== 'stopping') {
      server.status = 'stopping';
      this.save();
      this.broadcast('assettocorsa:statusChange', { serverId: id, status: 'stopping' });
    }
    // The real dedicated server has no documented stdin shutdown command
    // (see this file's header) — termination is the real, honest mechanism.
    proc.kill(force ? 'SIGKILL' : 'SIGTERM');
    setTimeout(() => { if (this.processes.has(id)) proc.kill('SIGKILL'); }, 10000);
    return true;
  }

  restartServer(id: string): boolean {
    const server = this.getServer(id);
    if (!server) return false;
    const proc = this.processes.get(id);
    if (proc) {
      this.intentionalStop.add(id);
      proc.once('exit', () => { this.startServer(id).catch(() => {}); });
      proc.kill('SIGTERM');
      setTimeout(() => { if (this.processes.has(id)) proc.kill('SIGKILL'); }, 10000);
      return true;
    }
    this.startServer(id).catch(() => {});
    return true;
  }

  /** Cross-platform real per-process metrics — PowerShell on Windows
   *  (matches MinecraftManager's own technique exactly), `ps` on
   *  Linux/macOS (both ship it standard) so this doesn't need a rewrite to
   *  work once a real Linux acServer host exists. */
  private queryProcessMetrics(pid: number): Promise<{ cpuMs: number; memoryBytes: number } | null> {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        execFile('powershell', [
          '-NoProfile', '-NonInteractive', '-Command',
          `Get-Process -Id ${pid} -ErrorAction Stop | Select-Object @{N='cpuMs';E={$_.TotalProcessorTime.TotalMilliseconds}}, @{N='mem';E={$_.WorkingSet64}} | ConvertTo-Json -Compress`,
        ], { timeout: 5000, windowsHide: true }, (err, stdout) => {
          if (err || !stdout?.trim()) return resolve(null);
          try {
            const parsed = JSON.parse(stdout.trim());
            if (typeof parsed.cpuMs !== 'number' || typeof parsed.mem !== 'number') return resolve(null);
            resolve({ cpuMs: parsed.cpuMs, memoryBytes: parsed.mem });
          } catch { resolve(null); }
        });
        return;
      }
      execFile('ps', ['-p', String(pid), '-o', 'time=,rss='], { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout?.trim()) return resolve(null);
        const parts = stdout.trim().split(/\s+/);
        if (parts.length < 2) return resolve(null);
        const timeParts = parts[0].split(':').map(Number); // [HH:]MM:SS
        if (timeParts.some(Number.isNaN)) return resolve(null);
        const seconds = timeParts.length === 3 ? timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2] : timeParts[0] * 60 + timeParts[1];
        const rssKb = Number(parts[1]);
        if (Number.isNaN(rssKb)) return resolve(null);
        resolve({ cpuMs: seconds * 1000, memoryBytes: rssKb * 1024 });
      });
    });
  }

  async getProcessStats(id: string): Promise<{
    pid: number | null; uptimeMs: number | null; cpuPercent: number | null; memoryBytes: number | null;
    metricsAvailable: boolean; metricsError?: string;
  }> {
    const server = this.getServer(id);
    if (!server || !server.pid || !server.startedAt || !this.processes.has(id)) {
      this.resourceSamples.delete(id);
      return { pid: null, uptimeMs: null, cpuPercent: null, memoryBytes: null, metricsAvailable: false };
    }
    const pid = server.pid;
    const uptimeMs = Date.now() - new Date(server.startedAt).getTime();
    const raw = await this.queryProcessMetrics(pid);
    if (!raw) {
      this.resourceSamples.delete(id);
      return { pid, uptimeMs, cpuPercent: null, memoryBytes: null, metricsAvailable: false, metricsError: 'Could not read process metrics from the OS.' };
    }
    const prev = this.resourceSamples.get(id);
    const now = Date.now();
    this.resourceSamples.set(id, { cpuMs: raw.cpuMs, sampledAt: now });
    if (!prev) return { pid, uptimeMs, cpuPercent: null, memoryBytes: raw.memoryBytes, metricsAvailable: true };
    const cpuDeltaMs = raw.cpuMs - prev.cpuMs;
    const wallDeltaMs = now - prev.sampledAt;
    const cpuPercent = wallDeltaMs > 0 ? Math.max(0, (cpuDeltaMs / wallDeltaMs) * 100 / os.cpus().length) : null;
    return { pid, uptimeMs, cpuPercent, memoryBytes: raw.memoryBytes, metricsAvailable: true };
  }

  // ── Files (safe, scoped to the server's own install directory) ──────────
  private resolveServerRelative(server: AssettoCorsaServer, relPath: string): string | null {
    const root = path.resolve(server.installPath);
    const target = path.resolve(root, relPath || '.');
    return isPathInside(target, root) || target === root ? target : null;
  }

  resolveWithinServer(id: string, relPath: string): string | null {
    const server = this.getServer(id);
    if (!server) return null;
    return this.resolveServerRelative(server, relPath);
  }

  listFiles(id: string, relPath: string): { name: string; path: string; type: 'file' | 'directory'; size: number; modified: string }[] | null {
    const server = this.getServer(id);
    if (!server) return null;
    const target = this.resolveServerRelative(server, relPath);
    if (!target || !fs.existsSync(target)) return null;
    return fs.readdirSync(target, { withFileTypes: true }).map((e) => {
      const full = path.join(target, e.name);
      const stats = fs.statSync(full);
      return { name: e.name, path: path.relative(server.installPath, full), type: e.isDirectory() ? 'directory' as const : 'file' as const, size: stats.size, modified: stats.mtime.toISOString() };
    }).sort((a, b) => (a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name)));
  }

  readServerFile(id: string, relPath: string): string | null {
    const target = this.resolveWithinServer(id, relPath);
    if (!target || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return null;
    try { return fs.readFileSync(target, 'utf-8'); } catch { return null; }
  }

  writeServerFile(id: string, relPath: string, content: string): boolean {
    const target = this.resolveWithinServer(id, relPath);
    if (!target) return false;
    try { fs.writeFileSync(target, content, 'utf-8'); return true; } catch { return false; }
  }

  // ── Backups (same real zip-the-folder approach as Minecraft) ─────────────
  private backupIndexFile(): string { return path.join(this.backupsDir, 'index.json'); }
  private loadBackupIndex(): { id: string; serverId: string; name: string; path: string; size: number; createdAt: string }[] {
    try { return JSON.parse(fs.readFileSync(this.backupIndexFile(), 'utf-8')); } catch { return []; }
  }
  private saveBackupIndex(list: ReturnType<AssettoCorsaManager['loadBackupIndex']>) {
    try { fs.writeFileSync(this.backupIndexFile(), JSON.stringify(list, null, 2)); } catch {}
  }

  listBackups(serverId: string) { return this.loadBackupIndex().filter((b) => b.serverId === serverId); }

  async createBackup(serverId: string): Promise<{ success: boolean; error?: string }> {
    const server = this.getServer(serverId);
    if (!server) return { success: false, error: 'Server not found.' };
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${server.name.replace(/[^a-z0-9-_]/gi, '_')}-${timestamp}`;
    const backupPath = path.join(this.backupsDir, `${name}.zip`);
    try {
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(backupPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        // Walk only the server's OWN top-level entries rather than
        // archive.directory(server.installPath, false) — that would follow
        // the real `content` junction/symlink (see linkServerContent()) and
        // back up the entire shared, potentially huge content library into
        // every single per-server backup, which is both slow and pointless
        // (that data isn't per-server). Never following a symlink here also
        // means restoreBackup() can never overwrite the shared content
        // location the link actually points to.
        for (const entry of fs.readdirSync(server.installPath, { withFileTypes: true })) {
          if (entry.name === 'content' || entry.isSymbolicLink()) continue;
          const full = path.join(server.installPath, entry.name);
          if (entry.isDirectory()) archive.directory(full, entry.name);
          else archive.file(full, { name: entry.name });
        }
        archive.finalize();
      });
      const stats = fs.statSync(backupPath);
      const list = this.loadBackupIndex();
      list.push({ id: this.generateId(), serverId, name, path: backupPath, size: stats.size, createdAt: new Date().toISOString() });
      this.saveBackupIndex(list);
      return { success: true };
    } catch (e: any) {
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
      return { success: false, error: e?.message || 'Backup failed.' };
    }
  }

  deleteBackup(backupId: string): boolean {
    const list = this.loadBackupIndex();
    const item = list.find((b) => b.id === backupId);
    if (!item) return false;
    try { if (fs.existsSync(item.path)) fs.unlinkSync(item.path); } catch {}
    this.saveBackupIndex(list.filter((b) => b.id !== backupId));
    return true;
  }

  async restoreBackup(backupId: string): Promise<{ success: boolean; error?: string }> {
    const backup = this.loadBackupIndex().find((b) => b.id === backupId);
    if (!backup || !fs.existsSync(backup.path)) return { success: false, error: 'Backup not found.' };
    const server = this.getServer(backup.serverId);
    if (!server) return { success: false, error: 'Server not found.' };
    if (this.processes.has(server.id)) return { success: false, error: 'Stop the server before restoring a backup.' };
    try {
      await extractZip(backup.path, { dir: server.installPath });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Restore failed.' };
    }
  }

  // ── Content import (real archives only, path-traversal-safe) ─────────────
  private assertNoTraversal(root: string) {
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (!isPathInside(full, root)) throw new Error('Archive contained an entry outside the expected extraction directory.');
        const lst = fs.lstatSync(full);
        if (lst.isSymbolicLink()) throw new Error('Archive contained a symlink/junction, which is not allowed.');
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(root);
  }

  private checkArchiveSize(zipPath: string, maxBytes: number) {
    const size = fs.statSync(zipPath).size;
    if (size > maxBytes) throw new Error(`Archive is too large (${(size / 1024 / 1024).toFixed(0)} MB, max ${(maxBytes / 1024 / 1024).toFixed(0)} MB).`);
  }

  private readonly MAX_CONTENT_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — real AC car/track packages can be large (high-poly tracks especially)

  /** Finds a real car folder (one with ui/ui_car.json + data.acd/data/)
   *  anywhere up to one level deep in the extracted archive — mirrors
   *  MinecraftManager's own findManifestRoot pattern for the same reason:
   *  real-world packages are sometimes zipped with an extra wrapper folder. */
  private findCarRoot(extractDir: string): string | null {
    const looksLikeCar = (dir: string) => fs.existsSync(path.join(dir, 'ui', 'ui_car.json')) && (fs.existsSync(path.join(dir, 'data.acd')) || fs.existsSync(path.join(dir, 'data')));
    if (looksLikeCar(extractDir)) return extractDir;
    for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(extractDir, entry.name);
      if (looksLikeCar(sub)) return sub;
    }
    return null;
  }

  private findTrackRoot(extractDir: string): string | null {
    const looksLikeTrack = (dir: string) => {
      const uiDir = path.join(dir, 'ui');
      if (!fs.existsSync(uiDir)) return false;
      if (fs.existsSync(path.join(uiDir, 'ui_track.json'))) return true;
      return fs.readdirSync(uiDir, { withFileTypes: true }).some((e) => e.isDirectory() && fs.existsSync(path.join(uiDir, e.name, 'ui_track.json')));
    };
    if (looksLikeTrack(extractDir)) return extractDir;
    for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(extractDir, entry.name);
      if (looksLikeTrack(sub)) return sub;
    }
    return null;
  }

  async importCarContent(contentRoot: string, zipPath: string): Promise<{ success: boolean; error?: string; carId?: string }> {
    if (!contentRoot) return { success: false, error: 'No Assetto Corsa content location is configured.' };
    if (!fs.existsSync(zipPath)) return { success: false, error: 'Selected file does not exist.' };
    let tmpRoot = '';
    try {
      this.checkArchiveSize(zipPath, this.MAX_CONTENT_ARCHIVE_BYTES);
      tmpRoot = path.join(this.userDataPath, 'tmp', `ac-car-import-${Date.now()}`);
      fs.mkdirSync(tmpRoot, { recursive: true });
      await extractZip(zipPath, { dir: tmpRoot });
      this.assertNoTraversal(tmpRoot);

      const found = this.findCarRoot(tmpRoot);
      if (!found) return { success: false, error: 'Could not find a valid car in that archive (needs ui/ui_car.json plus data.acd or a data/ folder).' };

      // A real wrapper folder's own name is the meaningful id; but when the
      // car sits directly at the zip root (found === tmpRoot), tmpRoot's own
      // name is just this import's random temp dir — fall back to the real
      // zip's own filename instead, never a random/meaningless id.
      const carId = found === tmpRoot ? path.basename(zipPath, path.extname(zipPath)) : path.basename(found);
      const carsDir = path.join(contentRoot, 'cars');
      fs.mkdirSync(carsDir, { recursive: true });
      const targetDir = path.join(carsDir, carId);
      if (fs.existsSync(targetDir)) return { success: false, error: `A car named "${carId}" already exists — remove it first or rename the archive's folder before importing.` };

      fs.cpSync(found, targetDir, { recursive: true });
      return { success: true, carId };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Car import failed.' };
    } finally {
      if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
    }
  }

  async importTrackContent(contentRoot: string, zipPath: string): Promise<{ success: boolean; error?: string; trackId?: string }> {
    if (!contentRoot) return { success: false, error: 'No Assetto Corsa content location is configured.' };
    if (!fs.existsSync(zipPath)) return { success: false, error: 'Selected file does not exist.' };
    let tmpRoot = '';
    try {
      this.checkArchiveSize(zipPath, this.MAX_CONTENT_ARCHIVE_BYTES);
      tmpRoot = path.join(this.userDataPath, 'tmp', `ac-track-import-${Date.now()}`);
      fs.mkdirSync(tmpRoot, { recursive: true });
      await extractZip(zipPath, { dir: tmpRoot });
      this.assertNoTraversal(tmpRoot);

      const found = this.findTrackRoot(tmpRoot);
      if (!found) return { success: false, error: 'Could not find a valid track in that archive (needs a ui/ui_track.json, directly or per-layout).' };

      // Same real-id fallback as importCarContent above — never a random
      // temp-directory name when the track sits directly at the zip root.
      const trackId = found === tmpRoot ? path.basename(zipPath, path.extname(zipPath)) : path.basename(found);
      const tracksDir = path.join(contentRoot, 'tracks');
      fs.mkdirSync(tracksDir, { recursive: true });
      const targetDir = path.join(tracksDir, trackId);
      if (fs.existsSync(targetDir)) return { success: false, error: `A track named "${trackId}" already exists — remove it first or rename the archive's folder before importing.` };

      fs.cpSync(found, targetDir, { recursive: true });
      return { success: true, trackId };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Track import failed.' };
    } finally {
      if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
    }
  }
}
