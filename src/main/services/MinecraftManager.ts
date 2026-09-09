// Minecraft server lifecycle — the second real game backend, built following
// ServerManager.ts's own conventions (JSON-file registry in userData, a
// Map<string, ChildProcess> for live processes, console lines broadcast to
// the renderer over IPC) rather than inventing a new pattern. Deliberately
// NOT generalized into a shared "GameServerManager" with FiveM — there's
// only one other real implementation to compare against, so any such
// abstraction today would be guesswork (see config/games.ts's own comment
// on the same principle).
//
// Server types are limited to Vanilla and Paper — both are a single signed
// jar download from a real, versioned API (Mojang's piston-meta, PaperMC's
// v3 "Fill" API). Fabric/Forge/NeoForge all require running a separate Java
// installer with server-specific flags, which is a materially different and
// riskier flow; rather than fake it, they're simply not offered yet.
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess, execFile } from 'child_process';
import { BrowserWindow } from 'electron';
import axios from 'axios';
import archiver from 'archiver';
import extractZip from 'extract-zip';

export type MinecraftServerType = 'vanilla' | 'paper';
export type MinecraftServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface MinecraftServer {
  id: string;
  name: string;
  installPath: string;
  version: string;
  serverType: MinecraftServerType;
  jarFile: string;
  ramMB: number;
  port: number;
  status: MinecraftServerStatus;
  pid: number | null;
  startedAt: string | null;
  autoRestart: boolean;
  lastBackup: string | null;
  createdAt: string;
  updatedAt: string;
  /** The Java major version this server's jar actually requires. Populated
   *  from the distributor's own real metadata at create/import time (see
   *  resolveVanillaJarUrl/resolvePaperJavaRequirement); falls back to the
   *  heuristic table below only when that lookup wasn't possible (e.g. an
   *  imported server, or offline). Null means "never determined". */
  requiredJavaMajor: number | null;
  /** Explicit user-picked Java runtime executable path. Null means "auto-
   *  select the closest compatible installed runtime at start time". */
  javaPath: string | null;
  /** Last friendly, human-readable failure reason (e.g. a translated
   *  UnsupportedClassVersionError). Cleared on the next successful start. */
  lastError: string | null;
}

export interface MinecraftCreateConfig {
  name: string;
  installPath: string;
  version: string;
  serverType: MinecraftServerType;
  ramMB: number;
  port: number;
  acceptedEula: boolean;
  /** Optional explicit Java runtime to pin this server to (from the Create
   *  Server wizard's runtime picker). Omit to auto-select at start time. */
  javaPath?: string | null;
}

export interface JavaRuntime {
  path: string;
  version: string;
  major: number;
  /** Where this runtime was found — 'PATH', 'JAVA_HOME', or the install root it was scanned from. */
  source: string;
}

export interface MinecraftBackup {
  id: string;
  serverId: string;
  name: string;
  path: string;
  size: number;
  createdAt: string;
}

interface KnownPlayer { name: string; online: boolean; lastSeen: string; }

interface RestartTracker { attempts: number; windowStart: number; }

const MAX_CONSOLE_LINES = 2000;
const MAX_AUTO_RESTART_ATTEMPTS = 3;
const AUTO_RESTART_WINDOW_MS = 5 * 60 * 1000;

// FALLBACK ONLY. The real, authoritative Java requirement always comes from
// the server distributor's own metadata — Mojang's per-version manifest
// (`javaVersion.majorVersion`) for Vanilla, PaperMC's Fill API
// (`version.java.version.minimum`) for Paper — fetched live in
// getRequiredJavaForVersion() below and cached on the server record at
// create/import time. This table only kicks in when that lookup fails
// (offline, an imported server with no matching online version, etc.), so it
// only needs to get the well-known HISTORICAL boundaries right; it is
// deliberately NOT the source of truth for "what does the newest Minecraft
// version need", since that changes over time and a hardcoded ceiling here
// would just reproduce the exact bug this table exists to avoid repeating.
// Ordered oldest-first; each entry's `major` applies from `from` (inclusive)
// up to the next entry's `from`.
const JAVA_REQUIREMENT_BOUNDARIES: { from: [number, number, number]; major: number }[] = [
  { from: [1, 0, 0], major: 8 },
  { from: [1, 17, 0], major: 16 },
  { from: [1, 18, 0], major: 17 },
  { from: [1, 20, 5], major: 21 },
];

function compareVersionTuples(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function requiredJavaMajor(mcVersion: string): number {
  const parts = mcVersion.split('.').map((n) => parseInt(n, 10) || 0);
  const tuple: [number, number, number] = [parts[0] ?? 1, parts[1] ?? 0, parts[2] ?? 0];
  let result = JAVA_REQUIREMENT_BOUNDARIES[0].major;
  for (const boundary of JAVA_REQUIREMENT_BOUNDARIES) {
    if (compareVersionTuples(tuple, boundary.from) >= 0) result = boundary.major;
  }
  return result;
}

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Class file major version → Java major version. Stable arithmetic Oracle
// has used since Java 8 (class file 52), so this works for any future Java
// release without needing a lookup table: Java 8=52, 11=55, 17=61, 21=65,
// 25=69, and so on (+1 class-file major per +1 Java major).
export function javaMajorFromClassFileVersion(classFileMajor: number): number {
  return classFileMajor - 44;
}

/** Parses a real UnsupportedClassVersionError line into a friendly, version-
 *  agnostic explanation. Returns null if the line doesn't match. */
export function translateClassVersionError(line: string): string | null {
  const m = line.match(/class file version (\d+)\.\d+[\s\S]*?up to (\d+)\.\d+/);
  if (!m) return null;
  const requiredJava = javaMajorFromClassFileVersion(parseInt(m[1], 10));
  const availableJava = javaMajorFromClassFileVersion(parseInt(m[2], 10));
  return `This Minecraft server requires Java ${requiredJava}, but Mercy is currently using Java ${availableJava}. Select a compatible Java runtime for this server (Settings tab) and start it again.`;
}

/** Any installed runtime with major >= required can run the jar (the JVM
 *  runs bytecode compiled for its own version or older, never newer) — pick
 *  the closest match rather than the newest available, so we don't jump to
 *  an unnecessarily newer JVM than what the distributor tested against. */
export function selectCompatibleRuntime(runtimes: JavaRuntime[], requiredMajor: number): JavaRuntime | null {
  const compatible = runtimes.filter((r) => r.major >= requiredMajor);
  if (compatible.length === 0) return null;
  compatible.sort((a, b) => a.major - b.major);
  return compatible[0];
}

export class MinecraftManager {
  private dataFile: string;
  private backupsDir: string;
  private servers: MinecraftServer[] = [];
  private processes: Map<string, ChildProcess> = new Map();
  private consoleBuffers: Map<string, string[]> = new Map();
  private players: Map<string, Map<string, KnownPlayer>> = new Map();
  private intentionalStop: Set<string> = new Set();
  private restartTracker: Map<string, RestartTracker> = new Map();

  constructor(private userDataPath: string) {
    const dataDir = path.join(userDataPath, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.dataFile = path.join(dataDir, 'minecraft-servers.json');
    this.backupsDir = path.join(userDataPath, 'minecraft-backups');
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

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  private broadcast(channel: string, data: any) {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, data);
  }

  private appendConsole(id: string, line: string) {
    const buf = this.consoleBuffers.get(id) || [];
    buf.push(line);
    if (buf.length > MAX_CONSOLE_LINES) buf.splice(0, buf.length - MAX_CONSOLE_LINES);
    this.consoleBuffers.set(id, buf);
    this.broadcast('minecraft:console', { serverId: id, line });
    this.trackPlayerFromLine(id, line);
  }

  // ── Registry ────────────────────────────────────────────────────────────
  getAllServers(): MinecraftServer[] { return this.servers; }
  getServer(id: string): MinecraftServer | undefined { return this.servers.find((s) => s.id === id); }
  getConsoleBuffer(id: string): string[] { return this.consoleBuffers.get(id) || []; }

  async deleteServer(id: string, deleteFiles: boolean): Promise<boolean> {
    if (this.processes.has(id)) return false; // must stop first
    const server = this.getServer(id);
    if (!server) return false;
    if (deleteFiles && fs.existsSync(server.installPath)) {
      try { fs.rmSync(server.installPath, { recursive: true, force: true }); } catch {}
    }
    this.servers = this.servers.filter((s) => s.id !== id);
    this.consoleBuffers.delete(id);
    this.players.delete(id);
    this.save();
    return true;
  }

  // ── Java detection ──────────────────────────────────────────────────────
  /** Probes a single `java` executable (PATH-resolved name, or an absolute path). */
  private probeJava(javaExe: string): Promise<{ found: boolean; version: string | null; major: number | null }> {
    return new Promise((resolve) => {
      execFile(javaExe, ['-version'], (err, _stdout, stderr) => {
        if (err) return resolve({ found: false, version: null, major: null });
        // java -version prints to stderr: e.g. `openjdk version "21.0.12" 2026-...`
        const m = stderr.match(/version "(\d+)(?:\.(\d+))?/);
        if (!m) return resolve({ found: true, version: stderr.split('\n')[0] || null, major: null });
        // Old versioning ("1.8.0_x") reports major as the second group.
        const major = m[1] === '1' ? parseInt(m[2] || '0', 10) : parseInt(m[1], 10);
        resolve({ found: true, version: stderr.split('\n')[0] || null, major });
      });
    });
  }

  /** Back-compat single-runtime check: whatever `java` resolves to on PATH. */
  async detectJava(): Promise<{ found: boolean; version: string | null; major: number | null }> {
    return this.probeJava('java');
  }

  /** Enumerates EVERY Java runtime Mercy can find on this machine — PATH,
   *  JAVA_HOME, and the well-known Windows install roots used by the major
   *  JDK distributors — so a server can be matched against a compatible one
   *  even when it isn't the PATH default. Each candidate's version is
   *  determined by actually executing it, never guessed from a folder name. */
  async detectAllJavaRuntimes(): Promise<JavaRuntime[]> {
    const candidates: { exe: string; source: string }[] = [];
    if (process.env.JAVA_HOME) {
      candidates.push({ exe: path.join(process.env.JAVA_HOME, 'bin', 'java.exe'), source: 'JAVA_HOME' });
    }
    const installRoots = [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files (x86)\\Java',
    ];
    for (const root of installRoots) {
      try {
        if (!fs.existsSync(root)) continue;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const exe = path.join(root, entry.name, 'bin', 'java.exe');
          if (fs.existsSync(exe)) candidates.push({ exe, source: root });
        }
      } catch { /* inaccessible install root — skip it, not fatal */ }
    }
    candidates.push({ exe: 'java', source: 'PATH' });

    const seen = new Set<string>();
    const runtimes: JavaRuntime[] = [];
    for (const { exe, source } of candidates) {
      const key = exe.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const info = await this.probeJava(exe);
      if (!info.found || info.major === null) continue;
      // Resolve PATH's `java` to its real absolute location so a Program
      // Files scan hit and the PATH entry pointing at the same install don't
      // show up twice.
      let resolvedPath = exe;
      if (exe === 'java') {
        try {
          const where = await new Promise<string>((resolve) => {
            execFile('where', ['java'], (err, stdout) => resolve(err ? '' : stdout.split(/\r?\n/)[0].trim()));
          });
          if (where) resolvedPath = where;
        } catch { /* keep bare 'java' if resolution fails */ }
      }
      if (seen.has(resolvedPath.toLowerCase()) && resolvedPath !== exe) continue;
      seen.add(resolvedPath.toLowerCase());
      runtimes.push({ path: resolvedPath, version: info.version || '', major: info.major, source });
    }
    return runtimes;
  }

  javaRequirementFor(mcVersion: string): number { return requiredJavaMajor(mcVersion); }

  /** The REAL Java requirement for a specific version/server-type, straight
   *  from the distributor's own metadata (Mojang for Vanilla, PaperMC's Fill
   *  API for Paper). Falls back to the historical-boundaries heuristic only
   *  if that lookup fails — e.g. offline, or an unpublished/unknown version. */
  async getRequiredJavaForVersion(serverType: MinecraftServerType, version: string): Promise<number> {
    try {
      if (serverType === 'vanilla') {
        const resolved = await this.resolveVanillaJarUrl(version);
        if (resolved.javaMajor) return resolved.javaMajor;
      } else {
        const res = await axios.get(`https://fill.papermc.io/v3/projects/paper/versions/${version}`, { timeout: 10000 });
        const min = res.data?.version?.java?.version?.minimum;
        if (typeof min === 'number') return min;
      }
    } catch { /* fall through to the heuristic below */ }
    return requiredJavaMajor(version);
  }

  // ── Version catalogs (real, live) ───────────────────────────────────────
  async fetchVanillaVersions(): Promise<{ id: string; type: string; releaseTime: string }[]> {
    const res = await axios.get('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { timeout: 10000 });
    return (res.data.versions || []).map((v: any) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
  }

  async fetchPaperVersions(): Promise<string[]> {
    const res = await axios.get('https://fill.papermc.io/v3/projects/paper', { timeout: 10000 });
    const versions: string[] = [];
    for (const group of Object.values(res.data.versions || {}) as string[][]) versions.push(...group);
    return versions;
  }

  // ── Download + create ───────────────────────────────────────────────────
  private async resolveVanillaJarUrl(version: string): Promise<{ url: string; sha1: string; javaMajor: number | null }> {
    const manifest = await axios.get('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { timeout: 10000 });
    const entry = (manifest.data.versions || []).find((v: any) => v.id === version);
    if (!entry) throw new Error(`Unknown Minecraft version: ${version}`);
    const detail = await axios.get(entry.url, { timeout: 10000 });
    const server = detail.data.downloads?.server;
    if (!server) throw new Error(`No server download available for ${version}`);
    return { url: server.url, sha1: server.sha1, javaMajor: detail.data.javaVersion?.majorVersion ?? null };
  }

  private async resolvePaperJarUrl(version: string): Promise<{ url: string; name: string }> {
    const builds = await axios.get(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds`, { timeout: 10000 });
    const list = builds.data as any[];
    if (!Array.isArray(list) || list.length === 0) throw new Error(`No Paper builds found for ${version}`);
    const latest = list[0]; // Fill API returns newest-first
    const dl = latest.downloads?.['server:default'];
    if (!dl) throw new Error(`No server download in latest Paper build for ${version}`);
    return { url: dl.url, name: dl.name };
  }

  private async downloadFile(url: string, destPath: string, onProgress?: (pct: number) => void): Promise<void> {
    const res = await axios.get(url, { responseType: 'stream', timeout: 30000 });
    const total = parseInt(String(res.headers['content-length'] || '0'), 10);
    let received = 0;
    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(destPath);
      res.data.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (onProgress && total) onProgress(Math.round((received / total) * 100));
      });
      res.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
      res.data.on('error', reject);
    });
  }

  /** Creates a fresh server: downloads the real jar, writes eula.txt (only if accepted), generates server.properties. */
  async createServer(config: MinecraftCreateConfig, onProgress?: (pct: number, message: string) => void): Promise<{ success: boolean; server?: MinecraftServer; error?: string }> {
    try {
      if (!config.acceptedEula) return { success: false, error: 'The Minecraft EULA must be accepted to create a server.' };
      if (config.port < 1 || config.port > 65535) return { success: false, error: 'Port must be between 1 and 65535.' };
      if (config.ramMB < 512) return { success: false, error: 'RAM allocation must be at least 512 MB.' };
      if (fs.existsSync(config.installPath) && fs.readdirSync(config.installPath).length > 0) {
        return { success: false, error: 'That folder already has files in it. Choose an empty folder, or use Import for an existing server.' };
      }
      fs.mkdirSync(config.installPath, { recursive: true });

      onProgress?.(5, 'Resolving download…');
      let jarUrl: string; let jarName = 'server.jar';
      let requiredJava: number | null = null;
      if (config.serverType === 'vanilla') {
        const resolved = await this.resolveVanillaJarUrl(config.version);
        jarUrl = resolved.url;
        requiredJava = resolved.javaMajor;
      } else {
        const resolved = await this.resolvePaperJarUrl(config.version);
        jarUrl = resolved.url;
        jarName = resolved.name;
      }
      if (requiredJava === null) requiredJava = await this.getRequiredJavaForVersion(config.serverType, config.version);

      const jarPath = path.join(config.installPath, jarName);
      onProgress?.(10, 'Downloading server jar…');
      await this.downloadFile(jarUrl, jarPath, (pct) => onProgress?.(10 + Math.round(pct * 0.75), 'Downloading server jar…'));

      onProgress?.(88, 'Accepting EULA…');
      fs.writeFileSync(path.join(config.installPath, 'eula.txt'), `# Accepted via Mercy Launcher\neula=true\n`, 'utf-8');

      onProgress?.(92, 'Writing server.properties…');
      const props = this.defaultProperties(config.port);
      fs.writeFileSync(path.join(config.installPath, 'server.properties'), props, 'utf-8');

      const now = new Date().toISOString();
      const server: MinecraftServer = {
        id: this.generateId(), name: config.name, installPath: config.installPath,
        version: config.version, serverType: config.serverType, jarFile: jarName,
        ramMB: config.ramMB, port: config.port, status: 'stopped', pid: null, startedAt: null,
        autoRestart: false, lastBackup: null, createdAt: now, updatedAt: now,
        requiredJavaMajor: requiredJava, javaPath: config.javaPath || null, lastError: null,
      };
      this.servers.push(server);
      this.save();
      onProgress?.(100, 'Done');
      return { success: true, server };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Server creation failed.' };
    }
  }

  private defaultProperties(port: number): string {
    return [
      '#Minecraft server properties — generated by Mercy Launcher',
      `server-port=${port}`,
      'motd=A Mercy Launcher Server',
      'gamemode=survival',
      'difficulty=easy',
      'max-players=20',
      'online-mode=true',
      'pvp=true',
      'view-distance=10',
      'simulation-distance=10',
      'spawn-protection=16',
      'allow-flight=false',
      'white-list=false',
      'enable-command-block=false',
      'level-name=world',
      '',
    ].join('\n');
  }

  // ── Import existing server ──────────────────────────────────────────────
  async detectExistingServer(dirPath: string): Promise<{
    valid: boolean; reason?: string; jarFile?: string; version?: string; serverType?: MinecraftServerType;
    hasProperties: boolean; hasWorld: boolean; hasEula: boolean; port?: number;
  }> {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return { valid: false, reason: 'That path does not exist or is not a folder.', hasProperties: false, hasWorld: false, hasEula: false };
    }
    const entries = fs.readdirSync(dirPath);
    const jarFile = entries.find((f) => f.toLowerCase().endsWith('.jar') && !f.toLowerCase().includes('installer'));
    const hasEula = entries.includes('eula.txt');
    const hasProperties = entries.includes('server.properties');
    const hasWorld = entries.some((f) => {
      try { return fs.statSync(path.join(dirPath, f)).isDirectory() && fs.existsSync(path.join(dirPath, f, 'level.dat')); } catch { return false; }
    });
    if (!jarFile && !hasProperties && !hasEula) {
      return { valid: false, reason: 'No Minecraft server files (server jar, server.properties, eula.txt) were found in this folder.', hasProperties, hasWorld, hasEula };
    }
    let serverType: MinecraftServerType = 'vanilla';
    if (jarFile && /paper/i.test(jarFile)) serverType = 'paper';
    let port: number | undefined;
    if (hasProperties) {
      const props = fs.readFileSync(path.join(dirPath, 'server.properties'), 'utf-8');
      const m = props.match(/^server-port=(\d+)/m);
      if (m) port = parseInt(m[1], 10);
    }
    return { valid: true, jarFile, serverType, hasProperties, hasWorld, hasEula, port };
  }

  async importServer(dirPath: string, name: string, ramMB: number): Promise<{ success: boolean; server?: MinecraftServer; error?: string }> {
    const detected = await this.detectExistingServer(dirPath);
    if (!detected.valid || !detected.jarFile) return { success: false, error: detected.reason || 'Could not find a server jar in that folder.' };
    if (this.servers.some((s) => path.resolve(s.installPath) === path.resolve(dirPath))) {
      return { success: false, error: 'This server is already registered in Mercy Launcher.' };
    }
    const now = new Date().toISOString();
    const server: MinecraftServer = {
      id: this.generateId(), name, installPath: dirPath,
      version: 'unknown', serverType: detected.serverType || 'vanilla', jarFile: detected.jarFile,
      ramMB, port: detected.port ?? 25565, status: 'stopped', pid: null, startedAt: null,
      autoRestart: false, lastBackup: null, createdAt: now, updatedAt: now,
      // Version is unknown for an imported server, so the real Java
      // requirement can't be looked up from Mojang/PaperMC metadata — start()
      // falls back to the historical-boundaries heuristic in that case, and
      // the panel lets the user pin a specific runtime manually if needed.
      requiredJavaMajor: null, javaPath: null, lastError: null,
    };
    this.servers.push(server);
    this.save();
    return { success: true, server };
  }

  // ── Process control ─────────────────────────────────────────────────────
  /** Resolves which Java runtime a server would actually launch with, and
   *  whether it's compatible — used by both startServer() (as a hard gate)
   *  and the UI (to show the ✓/❌ next to "Selected Runtime" live). Never
   *  spawns anything itself. */
  async resolveLaunchJava(server: MinecraftServer): Promise<{
    ok: boolean; required: number; javaPath: string | null; major: number | null; error?: string;
  }> {
    const required = server.requiredJavaMajor ?? requiredJavaMajor(server.version);
    if (server.javaPath) {
      const info = await this.probeJava(server.javaPath);
      if (!info.found || info.major === null) {
        return { ok: false, required, javaPath: server.javaPath, major: null, error: `Could not run the selected Java runtime at "${server.javaPath}". It may have been moved or uninstalled.` };
      }
      if (info.major < required) {
        return { ok: false, required, javaPath: server.javaPath, major: info.major, error: `Java ${required} is required for Minecraft ${server.version}, but Java ${info.major} is currently selected.` };
      }
      return { ok: true, required, javaPath: server.javaPath, major: info.major };
    }
    // No explicit pin — auto-select the closest installed compatible runtime.
    const runtimes = await this.detectAllJavaRuntimes();
    const chosen = selectCompatibleRuntime(runtimes, required);
    if (!chosen) {
      if (runtimes.length === 0) {
        return { ok: false, required, javaPath: null, major: null, error: `Java ${required} is required for Minecraft ${server.version}, but no Java runtime was found on this machine at all. Install Java ${required}+ and try again.` };
      }
      // At least one runtime exists but none qualify — report it the same
      // way a pinned-but-wrong selection is reported (this IS "what would
      // have launched by default" before this check existed): the PATH
      // default if it's among what was found, else the closest-but-still-
      // incompatible one, so the message names a concrete, currently-
      // selected version exactly like the spec's example.
      const wouldHaveUsed = runtimes.find((r) => r.source === 'PATH') || [...runtimes].sort((a, b) => b.major - a.major)[0];
      const others = runtimes.filter((r) => r !== wouldHaveUsed).map((r) => `Java ${r.major}`);
      const otherNote = others.length ? ` (also installed: ${others.join(', ')}, also incompatible)` : '';
      return { ok: false, required, javaPath: wouldHaveUsed.path, major: wouldHaveUsed.major, error: `Java ${required} is required for Minecraft ${server.version}, but Java ${wouldHaveUsed.major} is currently selected${otherNote}.` };
    }
    return { ok: true, required, javaPath: chosen.path, major: chosen.major };
  }

  setServerJavaPath(id: string, javaPath: string | null): boolean {
    const server = this.getServer(id);
    if (!server) return false;
    server.javaPath = javaPath;
    server.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  async startServer(id: string): Promise<{ success: boolean; error?: string }> {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    if (this.processes.has(id)) return { success: false, error: 'Server is already running.' };
    const jarPath = path.join(server.installPath, server.jarFile);
    if (!fs.existsSync(jarPath)) return { success: false, error: `Server jar not found: ${server.jarFile}` };

    // Never spawn an incompatible JVM — this is the hard gate that replaces
    // the raw UnsupportedClassVersionError crash with a clear, actionable
    // error before any process is started.
    const javaCheck = await this.resolveLaunchJava(server);
    if (!javaCheck.ok || !javaCheck.javaPath) {
      server.lastError = javaCheck.error || 'No compatible Java runtime available.';
      server.updatedAt = new Date().toISOString();
      this.save();
      return { success: false, error: javaCheck.error || 'No compatible Java runtime available.' };
    }
    const javaExe = javaCheck.javaPath;

    this.intentionalStop.delete(id);
    server.status = 'starting';
    server.lastError = null;
    server.updatedAt = new Date().toISOString();
    this.save();
    this.broadcast('minecraft:statusChange', { serverId: id, status: 'starting' });

    const proc = spawn(javaExe, [`-Xmx${server.ramMB}M`, `-Xms${Math.min(server.ramMB, 1024)}M`, '-jar', server.jarFile, 'nogui'], {
      cwd: server.installPath,
    });
    this.processes.set(id, proc);
    server.pid = proc.pid ?? null;
    server.startedAt = new Date().toISOString();
    this.save();

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        this.appendConsole(id, line);
        if (/Done \(/.test(line) && server.status !== 'running') {
          server.status = 'running';
          this.save();
          this.broadcast('minecraft:statusChange', { serverId: id, status: 'running' });
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue;
        this.appendConsole(id, `[ERROR] ${line}`);
        const friendly = translateClassVersionError(line);
        if (friendly) {
          this.appendConsole(id, `[Mercy] ${friendly}`);
          server.lastError = friendly;
          this.save();
        }
      }
    });

    proc.on('exit', (code, signal) => {
      this.processes.delete(id);
      const wasIntentional = this.intentionalStop.has(id);
      this.intentionalStop.delete(id);
      const current = this.getServer(id);
      if (!current) return;
      current.pid = null;
      current.startedAt = null;
      current.updatedAt = new Date().toISOString();

      if (wasIntentional) {
        current.status = 'stopped';
        this.save();
        this.broadcast('minecraft:statusChange', { serverId: id, status: 'stopped' });
        return;
      }

      // Unexpected termination — a real crash, not a user-requested stop.
      // If we already identified a specific, friendly cause (e.g. a Java
      // version mismatch) from the process's own output, surface that
      // instead of the generic "exited unexpectedly" message.
      current.status = 'error';
      this.appendConsole(id, current.lastError
        ? `[Mercy] ${current.lastError}`
        : `[Mercy] Server process exited unexpectedly (code ${code}, signal ${signal}).`);
      this.save();
      this.broadcast('minecraft:statusChange', { serverId: id, status: 'error' });

      if (current.autoRestart) {
        const tracker = this.restartTracker.get(id) || { attempts: 0, windowStart: Date.now() };
        if (Date.now() - tracker.windowStart > AUTO_RESTART_WINDOW_MS) { tracker.attempts = 0; tracker.windowStart = Date.now(); }
        tracker.attempts += 1;
        this.restartTracker.set(id, tracker);
        if (tracker.attempts <= MAX_AUTO_RESTART_ATTEMPTS) {
          this.appendConsole(id, `[Mercy] Auto-restarting (attempt ${tracker.attempts}/${MAX_AUTO_RESTART_ATTEMPTS})…`);
          setTimeout(() => { this.startServer(id).catch(() => {}); }, 3000);
        } else {
          this.appendConsole(id, `[Mercy] Auto-restart gave up after ${MAX_AUTO_RESTART_ATTEMPTS} crashes within ${AUTO_RESTART_WINDOW_MS / 60000} minutes.`);
        }
      }
    });

    proc.on('error', (err) => {
      this.appendConsole(id, `[Mercy] Failed to start: ${err.message}`);
      server.status = 'error';
      this.save();
      this.broadcast('minecraft:statusChange', { serverId: id, status: 'error' });
    });

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
      this.broadcast('minecraft:statusChange', { serverId: id, status: 'stopping' });
    }
    if (force) {
      proc.kill('SIGKILL');
    } else {
      proc.stdin?.write('stop\n');
      // Grace period, then force-kill if the process is still alive.
      setTimeout(() => { if (this.processes.has(id)) proc.kill('SIGKILL'); }, 20000);
    }
    return true;
  }

  restartServer(id: string): boolean {
    const server = this.getServer(id);
    if (!server) return false;
    this.intentionalStop.add(id);
    const proc = this.processes.get(id);
    if (proc) {
      proc.once('exit', () => { this.startServer(id).catch(() => {}); });
      proc.stdin?.write('stop\n');
      setTimeout(() => { if (this.processes.has(id)) proc.kill('SIGKILL'); }, 20000);
      return true;
    }
    this.startServer(id).catch(() => {});
    return true;
  }

  setAutoRestart(id: string, enabled: boolean): boolean {
    const server = this.getServer(id);
    if (!server) return false;
    server.autoRestart = enabled;
    server.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  sendCommand(id: string, command: string): boolean {
    const proc = this.processes.get(id);
    if (!proc || !proc.stdin) return false;
    proc.stdin.write(`${command}\n`);
    return true;
  }

  getProcessStats(id: string): { pid: number | null; uptimeMs: number | null } {
    const server = this.getServer(id);
    if (!server || !server.pid || !server.startedAt) return { pid: null, uptimeMs: null };
    return { pid: server.pid, uptimeMs: Date.now() - new Date(server.startedAt).getTime() };
  }

  // ── Players (derived from real console output — no query/RCON assumed) ──
  private trackPlayerFromLine(id: string, line: string) {
    const joined = line.match(/: (\w+) joined the game/);
    const left = line.match(/: (\w+) left the game/);
    if (!joined && !left) return;
    const map = this.players.get(id) || new Map<string, KnownPlayer>();
    if (joined) map.set(joined[1], { name: joined[1], online: true, lastSeen: new Date().toISOString() });
    if (left && map.has(left[1])) { const p = map.get(left[1])!; p.online = false; p.lastSeen = new Date().toISOString(); }
    this.players.set(id, map);
  }

  getPlayers(id: string): KnownPlayer[] {
    const map = this.players.get(id);
    return map ? Array.from(map.values()) : [];
  }

  // ── server.properties: preserve unknown keys, only touch what changed ──
  readProperties(id: string): { key: string; value: string; isComment: boolean; raw: string }[] {
    const server = this.getServer(id);
    if (!server) return [];
    const file = path.join(server.installPath, 'server.properties');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter((l) => l.length > 0).map((raw) => {
      if (raw.trim().startsWith('#')) return { key: '', value: '', isComment: true, raw };
      const idx = raw.indexOf('=');
      if (idx === -1) return { key: '', value: '', isComment: true, raw };
      return { key: raw.slice(0, idx), value: raw.slice(idx + 1), isComment: false, raw };
    });
  }

  writeProperties(id: string, changes: Record<string, string>): { success: boolean; error?: string } {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    const file = path.join(server.installPath, 'server.properties');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split(/\r?\n/) : [];
    const seen = new Set<string>();
    const next = lines.map((line) => {
      if (line.trim().startsWith('#') || !line.includes('=')) return line;
      const key = line.slice(0, line.indexOf('='));
      if (Object.prototype.hasOwnProperty.call(changes, key)) { seen.add(key); return `${key}=${changes[key]}`; }
      return line;
    });
    for (const [key, value] of Object.entries(changes)) {
      if (!seen.has(key)) next.push(`${key}=${value}`);
    }
    // Backup before a destructive overwrite, matching the FiveM backup convention.
    try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch {}
    try {
      fs.writeFileSync(file, next.filter((l, i, arr) => l !== '' || i === arr.length - 1).join('\n'));
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to write server.properties' };
    }
  }

  // ── Files (strictly scoped to the server's own directory) ───────────────
  private resolveServerRelative(server: MinecraftServer, relPath: string): string | null {
    const root = path.resolve(server.installPath);
    const resolved = path.resolve(root, relPath || '.');
    if (!isPathInside(resolved, root) && resolved !== root) return null;
    return resolved;
  }

  listFiles(id: string, relPath: string): { name: string; path: string; type: 'file' | 'directory'; size: number; modified: string }[] | null {
    const server = this.getServer(id);
    if (!server) return null;
    const target = this.resolveServerRelative(server, relPath);
    if (!target || !fs.existsSync(target)) return null;
    return fs.readdirSync(target, { withFileTypes: true }).map((e) => {
      const full = path.join(target, e.name);
      const stats = fs.statSync(full);
      return {
        name: e.name,
        path: path.relative(server.installPath, full),
        type: e.isDirectory() ? 'directory' as const : 'file' as const,
        size: stats.size,
        modified: stats.mtime.toISOString(),
      };
    }).sort((a, b) => (a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name)));
  }

  readServerFile(id: string, relPath: string): string | null {
    const server = this.getServer(id);
    if (!server) return null;
    const target = this.resolveServerRelative(server, relPath);
    if (!target || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return null;
    try { return fs.readFileSync(target, 'utf-8'); } catch { return null; }
  }

  writeServerFile(id: string, relPath: string, content: string): boolean {
    const server = this.getServer(id);
    if (!server) return false;
    const target = this.resolveServerRelative(server, relPath);
    if (!target) return false;
    try { fs.writeFileSync(target, content, 'utf-8'); return true; } catch { return false; }
  }

  // ── Backups ──────────────────────────────────────────────────────────────
  private backupIndexFile() { return path.join(this.backupsDir, 'index.json'); }
  private loadBackupIndex(): MinecraftBackup[] {
    try { return fs.existsSync(this.backupIndexFile()) ? JSON.parse(fs.readFileSync(this.backupIndexFile(), 'utf-8')) : []; } catch { return []; }
  }
  private saveBackupIndex(list: MinecraftBackup[]) { fs.writeFileSync(this.backupIndexFile(), JSON.stringify(list, null, 2)); }

  async createBackup(id: string): Promise<{ success: boolean; backup?: MinecraftBackup; error?: string }> {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${server.name.replace(/[^a-z0-9-_]/gi, '_')}-${timestamp}`;
    const destPath = path.join(this.backupsDir, `${name}.zip`);
    try {
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(destPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(server.installPath, false);
        archive.finalize();
      });
      const stats = fs.statSync(destPath);
      const backup: MinecraftBackup = { id: this.generateId(), serverId: id, name, path: destPath, size: stats.size, createdAt: new Date().toISOString() };
      const list = this.loadBackupIndex();
      list.push(backup);
      this.saveBackupIndex(list);
      server.lastBackup = backup.createdAt;
      this.save();
      return { success: true, backup };
    } catch (e: any) {
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
      return { success: false, error: e?.message || 'Backup failed.' };
    }
  }

  listBackups(id: string): MinecraftBackup[] { return this.loadBackupIndex().filter((b) => b.serverId === id); }

  async restoreBackup(backupId: string): Promise<{ success: boolean; error?: string }> {
    const list = this.loadBackupIndex();
    const backup = list.find((b) => b.id === backupId);
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

  deleteBackup(backupId: string): boolean {
    const list = this.loadBackupIndex();
    const idx = list.findIndex((b) => b.id === backupId);
    if (idx === -1) return false;
    try { if (fs.existsSync(list[idx].path)) fs.unlinkSync(list[idx].path); } catch {}
    list.splice(idx, 1);
    this.saveBackupIndex(list);
    return true;
  }

  isRunning(id: string): boolean { return this.processes.has(id); }
}
