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
import crypto from 'crypto';
import os from 'os';
import net from 'net';
import dgram from 'dgram';
import https from 'https';
import { spawn, ChildProcess, execFile } from 'child_process';
import { BrowserWindow } from 'electron';
import axios from 'axios';
import archiver from 'archiver';
import extractZip from 'extract-zip';

// 'bedrock' added alongside the existing Java variants — Bedrock Dedicated
// Server has no Vanilla/Paper distinction, so it's just its own value here.
export type MinecraftServerType = 'vanilla' | 'paper' | 'bedrock';
export type MinecraftEdition = 'java' | 'bedrock';
export type MinecraftServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface MinecraftServer {
  id: string;
  name: string;
  installPath: string;
  version: string;
  serverType: MinecraftServerType;
  /** 'java' for vanilla/paper, 'bedrock' for a native Bedrock Dedicated
   *  Server. Servers persisted before Bedrock support existed have no
   *  edition field on disk at all — load() back-fills it from serverType
   *  the first time an old record is read, defaulting to 'java' (the only
   *  edition that ever existed), never guessing 'bedrock' for an old record. */
  edition: MinecraftEdition;
  /** Java-only — the jar Mercy launches with `java -jar <jarFile>`. Always
   *  '' for a Bedrock server, which launches bedrock_server.exe directly. */
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
  /** Content Mercy itself installed from the Marketplace — plugins (Paper
   *  only) and datapacks (both server types). Never includes mods, since
   *  Mercy doesn't run a mod loader for any supported server type. */
  installedContent: InstalledContent[];
}

export interface MinecraftWorldOptions {
  seed?: string;
  gamemode?: 'survival' | 'creative' | 'adventure' | 'spectator';
  difficulty?: 'peaceful' | 'easy' | 'normal' | 'hard';
  hardcore?: boolean;
  onlineMode?: boolean;
  maxPlayers?: number;
  motd?: string;
  viewDistance?: number;
  simulationDistance?: number;
  pvp?: boolean;
  whitelist?: boolean;
  /** Bedrock only — its "allow cheats" toggle. Java has no equivalent
   *  single server.properties key (commands are gated per-player/op). */
  allowCheats?: boolean;
}

export interface MinecraftCreateConfig extends MinecraftWorldOptions {
  name: string;
  installPath: string;
  /** Ignored for Bedrock — its version is whatever Mojang/Microsoft's
   *  download API currently serves for the chosen channel, resolved
   *  server-side and stored on the created record. */
  version: string;
  serverType: MinecraftServerType;
  ramMB: number;
  port: number;
  /** Java only. Bedrock Dedicated Server has no eula.txt-style acceptance
   *  file at all — Mojang's EULA still applies, but there's nothing to
   *  write, so this is ignored entirely for a Bedrock create. */
  acceptedEula: boolean;
  /** Optional explicit Java runtime to pin this server to (from the Create
   *  Server wizard's runtime picker). Omit to auto-select at start time.
   *  Ignored for Bedrock — it never launches a JVM. */
  javaPath?: string | null;
  /** Bedrock only — which of Mojang/Microsoft's currently-published builds
   *  to install. There is no historical version list for Bedrock the way
   *  there is for Java (see fetchBedrockVersions()), so this is the only
   *  choice offered. Defaults to 'stable'. */
  bedrockChannel?: 'stable' | 'preview';
}

export interface InstalledContent {
  id: string;
  kind: 'plugin' | 'datapack';
  source: 'modrinth';
  projectId: string;
  projectName: string;
  versionId: string;
  versionNumber: string;
  fileName: string;
  /** Relative to the server's install directory — where the file actually
   *  lives right now (moves when enabled/disabled). */
  relPath: string;
  sha1: string;
  size: number;
  enabled: boolean;
  installedAt: string;
  dependencies: { projectId: string; projectName: string; dependencyType: string }[];
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

export interface MinecraftConnectionInfo {
  serverId: string;
  serverName: string;
  serverType: MinecraftServerType;
  version: string;
  /** Real and derived from the server's own record — 'java' for
   *  vanilla/paper, 'bedrock' for a native Bedrock Dedicated Server. */
  edition: MinecraftEdition;
  status: MinecraftServerStatus;
  port: number;
  /** This machine's real, non-internal LAN IPv4 address, if one exists. */
  lanAddress: string | null;
  /** Java only. Null = not checked (server isn't running, so there's
   *  nothing to verify, OR this is a Bedrock server — see raknet below).
   *  true/false = a real TCP connection to 127.0.0.1:port was actually
   *  attempted just now — never assumed from process state alone. */
  portListening: boolean | null;
  /** Java only — whether Bedrock clients could join THIS Java server via a
   *  separately-installed Geyser plugin. Always the "not applicable" shape
   *  for an edition:'bedrock' server, which needs no such bridge. */
  bedrock: {
    /** True only if a real installed plugin whose name suggests Geyser was
     *  found on this server — never assumed true for a plain Java server. */
    possible: boolean;
    detectedPlugin: string | null;
    note: string;
  };
  /** Bedrock only — a real RakNet "Unconnected Ping" probe against the
   *  server's own configured UDP port (see checkRakNetReachable()). Always
   *  null for a Java server, which uses portListening (TCP) instead. */
  raknet: { checked: boolean; reachable: boolean | null; note: string } | null;
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
  /** Last real CPU-time sample per server, used to derive a CPU% from the
   *  delta between two samples (see getProcessStats()) — never a fabricated
   *  or estimated number. Cleared whenever the process isn't running so a
   *  stale sample from a previous run can never be diffed against a new one. */
  private resourceSamples: Map<string, { cpuMs: number; sampledAt: number }> = new Map();

  private javaRuntimesDir: string;

  constructor(private userDataPath: string) {
    const dataDir = path.join(userDataPath, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.dataFile = path.join(dataDir, 'minecraft-servers.json');
    this.backupsDir = path.join(userDataPath, 'minecraft-backups');
    if (!fs.existsSync(this.backupsDir)) fs.mkdirSync(this.backupsDir, { recursive: true });
    this.javaRuntimesDir = path.join(userDataPath, 'java-runtimes');
    if (!fs.existsSync(this.javaRuntimesDir)) fs.mkdirSync(this.javaRuntimesDir, { recursive: true });
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.dataFile)) {
        this.servers = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
        // Back-compat: every server persisted before Bedrock support has no
        // `edition` field on disk at all (it didn't exist yet). Default it
        // to 'java' — the only edition that could have ever been created or
        // imported at the time — never inferred as 'bedrock' for an old
        // record. Also normalizes a missing jarFile (shouldn't happen for a
        // real Java record, but keeps reads defensive) to '' rather than
        // undefined so string operations on it never throw.
        let migrated = false;
        for (const s of this.servers as any[]) {
          if (!s.edition) { s.edition = s.serverType === 'bedrock' ? 'bedrock' : 'java'; migrated = true; }
          if (typeof s.jarFile !== 'string') { s.jarFile = ''; migrated = true; }
        }
        if (migrated) this.save();
      }
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

  /** Defense-in-depth guard for the one genuinely destructive filesystem
   *  operation Mercy performs: refuses to delete a server's own registered
   *  directory if it's a drive root, suspiciously shallow, or overlaps with
   *  Mercy's own app/userData directories or well-known Windows system
   *  locations — independent of whatever the registry happens to say. */
  private isSafeServerDirectory(installPath: string): { safe: boolean; reason?: string } {
    let resolved: string;
    try { resolved = fs.realpathSync.native ? fs.realpathSync.native(path.resolve(installPath)) : path.resolve(installPath); }
    catch { resolved = path.resolve(installPath); }
    const parsed = path.parse(resolved);
    if (resolved === parsed.root) return { safe: false, reason: 'Refusing to delete a drive root.' };
    const depth = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean).length;
    if (depth < 2) return { safe: false, reason: 'This directory looks too shallow to be a real server folder — refusing to delete it as a precaution.' };
    // Mercy's OWN directories: block only if deleting `resolved` would
    // engulf/destroy one of them (exact match, or resolved is an ANCESTOR
    // of it) — a server directory merely NESTED INSIDE userData (unusual,
    // but a legitimate choice, and exactly what a disposable temp-dir test
    // setup looks like) is fine to delete, since that only removes that one
    // subtree and leaves the rest of Mercy's own data untouched.
    const ownDirs = [this.userDataPath, this.backupsDir, process.resourcesPath, process.execPath ? path.dirname(process.execPath) : '']
      .filter(Boolean).map((p) => path.resolve(p as string));
    for (const guarded of ownDirs) {
      if (resolved === guarded || isPathInside(guarded, resolved)) {
        return { safe: false, reason: 'Refusing to delete a directory that would remove Mercy\'s own application data.' };
      }
    }
    // OS-level system locations: nobody should ever have a real Minecraft
    // server installed under these, so both directions are blocked —
    // unlike Mercy's own directories, there's no legitimate "nested inside"
    // case here worth allowing.
    const systemDirs = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'].map((p) => path.resolve(p));
    for (const guarded of systemDirs) {
      if (resolved === guarded || isPathInside(resolved, guarded) || isPathInside(guarded, resolved)) {
        return { safe: false, reason: 'Refusing to delete a directory under a protected system location.' };
      }
    }
    return { safe: true };
  }

  /** Real, deliberate deletion. Stops the process first if running, verifies
   *  the directory is actually safe to remove, and only drops the server
   *  from the registry after filesystem deletion genuinely succeeded — a
   *  failed or partial deletion leaves the server registered so the user can
   *  retry rather than silently losing track of orphaned files. Backups are
   *  a separate, explicit opt-in (never deleted just because the server is). */
  async deleteServer(id: string, deleteFiles: boolean, deleteBackups = false): Promise<{ success: boolean; error?: string }> {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };

    if (this.processes.has(id)) {
      const proc = this.processes.get(id)!;
      this.intentionalStop.add(id);
      try { proc.kill('SIGKILL'); } catch {}
      const deadline = Date.now() + 10000;
      while (this.processes.has(id) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (this.processes.has(id)) {
        return { success: false, error: 'Could not stop the running server process — try Force Stop first, then delete.' };
      }
    }

    if (deleteFiles && fs.existsSync(server.installPath)) {
      const safety = this.isSafeServerDirectory(server.installPath);
      if (!safety.safe) return { success: false, error: safety.reason };
      try {
        fs.rmSync(server.installPath, { recursive: true, force: true });
      } catch (e: any) {
        return { success: false, error: `Failed to delete server files: ${e?.message || 'unknown error'}. The server was left registered so you can retry.` };
      }
      if (fs.existsSync(server.installPath)) {
        return { success: false, error: 'Server files could not be fully removed (a file may still be in use). The server was left registered so you can retry.' };
      }
    }

    if (deleteBackups) {
      for (const b of this.listBackups(id)) this.deleteBackup(b.id);
    }

    // Filesystem deletion (if requested) genuinely succeeded — now, and only
    // now, drop it from the registry.
    this.servers = this.servers.filter((s) => s.id !== id);
    this.consoleBuffers.delete(id);
    this.players.delete(id);
    this.restartTracker.delete(id);
    this.resourceSamples.delete(id);
    this.save();
    return { success: true };
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
      this.javaRuntimesDir, // Mercy's own downloadAndInstallJava() extracts here
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

  /** Downloads a real Java runtime for the machine that doesn't have one,
   *  from Eclipse Adoptium's real, public, official Temurin build API
   *  (https://api.adoptium.net) — never a system-wide installer. This
   *  extracts a portable JDK zip into Mercy's own userData directory only;
   *  it never runs an .msi, never touches JAVA_HOME/PATH/the registry, and
   *  never modifies system Java configuration. ALWAYS triggered by an
   *  explicit user action (the "Install Java X" button) — never run on its
   *  own, so nothing is ever installed without the user seeing and choosing it. */
  async downloadAndInstallJava(major: number, onProgress?: (pct: number, message: string) => void): Promise<{ success: boolean; javaPath?: string; error?: string }> {
    try {
      onProgress?.(2, 'Finding a Java build…');
      const res = await axios.get(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot`, {
        params: { os: 'windows', architecture: 'x64', image_type: 'jdk' }, timeout: 15000,
      });
      const asset = (res.data || [])[0];
      const pkg = asset?.binary?.package;
      if (!pkg?.link) return { success: false, error: `Could not find a Windows Java ${major} build from Adoptium.` };

      const targetDir = path.join(this.javaRuntimesDir, `jdk-${major}`);
      if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(targetDir, { recursive: true });

      const zipPath = path.join(this.javaRuntimesDir, pkg.name);
      onProgress?.(5, `Downloading ${pkg.name}…`);
      await this.downloadFile(pkg.link, zipPath, (pct) => onProgress?.(5 + Math.round(pct * 0.7), `Downloading ${pkg.name}…`));

      if (pkg.checksum) {
        onProgress?.(78, 'Verifying download…');
        const actual = await new Promise<string>((resolve, reject) => {
          const hash = crypto.createHash('sha256');
          const stream = fs.createReadStream(zipPath);
          stream.on('data', (c) => hash.update(c));
          stream.on('end', () => resolve(hash.digest('hex')));
          stream.on('error', reject);
        });
        if (actual !== pkg.checksum) {
          fs.unlinkSync(zipPath);
          return { success: false, error: 'Downloaded Java build failed checksum verification — the download may be corrupt. Try again.' };
        }
      }

      onProgress?.(85, 'Extracting…');
      await extractZip(zipPath, { dir: targetDir });
      fs.unlinkSync(zipPath);

      // Adoptium's zip contains one top-level folder (e.g. "jdk-25.0.4.1+1")
      // — flatten it so targetDir/bin/java.exe matches the same one-level
      // layout detectAllJavaRuntimes() already scans for every other vendor.
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const inner = entries.find((e) => e.isDirectory());
      if (inner && !fs.existsSync(path.join(targetDir, 'bin'))) {
        const innerPath = path.join(targetDir, inner.name);
        for (const child of fs.readdirSync(innerPath)) {
          fs.renameSync(path.join(innerPath, child), path.join(targetDir, child));
        }
        fs.rmdirSync(innerPath);
      }

      const javaExe = path.join(targetDir, 'bin', 'java.exe');
      if (!fs.existsSync(javaExe)) return { success: false, error: 'Extraction completed but java.exe was not found in the expected location.' };

      onProgress?.(95, 'Verifying installed runtime…');
      const info = await this.probeJava(javaExe);
      if (!info.found || info.major !== major) {
        return { success: false, error: `Installed runtime reported Java ${info.major ?? 'unknown'}, expected ${major}.` };
      }

      onProgress?.(100, 'Done');
      return { success: true, javaPath: javaExe };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Java installation failed.' };
    }
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

  /** The real, official Bedrock Dedicated Server download links — the exact
   *  same API minecraft.net/download/server/bedrock's own page calls
   *  (https://net-secondary.web.minecraft-services.net/api/v1.0/download/links).
   *  Unlike Java, Mojang/Microsoft don't publish a historical version
   *  manifest for Bedrock — this endpoint only ever returns the CURRENT
   *  stable and preview builds, so "Latest Stable"/"Latest Preview" is
   *  genuinely the full choice, not a simplification of a longer list. */
  async fetchBedrockVersions(): Promise<{
    stable: { version: string; url: string };
    preview: { version: string; url: string } | null;
  }> {
    const res = await axios.get('https://net-secondary.web.minecraft-services.net/api/v1.0/download/links', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MercyLauncher' },
    });
    const links: { downloadType: string; downloadUrl: string }[] = res.data?.result?.links || [];
    const find = (type: string) => links.find((l) => l.downloadType === type)?.downloadUrl;
    const stableUrl = find('serverBedrockWindows');
    const previewUrl = find('serverBedrockPreviewWindows');
    if (!stableUrl) throw new Error('Could not resolve the official Bedrock Dedicated Server download — Mojang/Microsoft\'s download API may be unavailable right now.');
    const parseVersion = (url: string) => (url.match(/bedrock-server-([\d.]+)\.zip/i) || [])[1] || 'unknown';
    return {
      stable: { version: parseVersion(stableUrl), url: stableUrl },
      preview: previewUrl ? { version: parseVersion(previewUrl), url: previewUrl } : null,
    };
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

  /** A second download path used ONLY for the Bedrock Dedicated Server zip
   *  (www.minecraft.net's Akamai-fronted Azure Blob CDN). Verified live,
   *  reproducibly: axios (via the follow-redirects package it uses
   *  internally) hangs indefinitely against this specific host until its
   *  own timeout fires, even with redirects/keep-alive/compression all
   *  disabled — while Node's built-in `https` module and the global
   *  `fetch` both complete in under 2 seconds against the exact same URL.
   *  This is a real, reproduced axios/CDN incompatibility, not a Mojang/
   *  Microsoft-side problem — piston-meta.mojang.com, fill.papermc.io, and
   *  net-secondary.web.minecraft-services.net all continue to work fine
   *  through the existing axios-based downloadFile()/fetchBedrockVersions()
   *  above, so that method is left completely untouched for Java to avoid
   *  any regression risk; this is a narrow, additional path used only here. */
  private downloadFileNative(url: string, destPath: string, onProgress?: (pct: number) => void, redirectsLeft = 5): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) { reject(new Error('Too many redirects downloading the Bedrock server.')); return; }
          this.downloadFileNative(res.headers.location, destPath, onProgress, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`Download failed with HTTP ${res.statusCode}.`)); return; }
        const total = parseInt(String(res.headers['content-length'] || '0'), 10);
        let received = 0;
        const writer = fs.createWriteStream(destPath);
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (onProgress && total) onProgress(Math.round((received / total) * 100));
        });
        res.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Download timed out.')));
      req.on('error', reject);
    });
  }

  /** Creates a fresh server. Dispatches to the Bedrock-specific flow (a
   *  single .zip download, no JVM, no eula.txt) for serverType 'bedrock';
   *  everything below this branch is the existing, unchanged Java flow. */
  async createServer(config: MinecraftCreateConfig, onProgress?: (pct: number, message: string) => void): Promise<{ success: boolean; server?: MinecraftServer; error?: string }> {
    if (config.serverType === 'bedrock') return this.createBedrockServer(config, onProgress);
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
      const props = this.defaultProperties(config.port, config);
      fs.writeFileSync(path.join(config.installPath, 'server.properties'), props, 'utf-8');

      const now = new Date().toISOString();
      const server: MinecraftServer = {
        id: this.generateId(), name: config.name, installPath: config.installPath,
        version: config.version, serverType: config.serverType, edition: 'java', jarFile: jarName,
        ramMB: config.ramMB, port: config.port, status: 'stopped', pid: null, startedAt: null,
        autoRestart: false, lastBackup: null, createdAt: now, updatedAt: now,
        requiredJavaMajor: requiredJava, javaPath: config.javaPath || null, lastError: null, installedContent: [],
      };
      this.servers.push(server);
      this.save();
      onProgress?.(100, 'Done');
      return { success: true, server };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Server creation failed.' };
    }
  }

  /** Real Bedrock server creation: resolves the current build from
   *  Mojang/Microsoft's own download API, downloads the official .zip,
   *  extracts it in place, verifies bedrock_server.exe actually exists,
   *  registers the server, then applies the user's chosen settings on top
   *  of Mojang's own shipped server.properties via writeProperties() — so
   *  every property Mojang ships that the wizard doesn't ask about is
   *  preserved exactly as they defined it, rather than Mercy guessing a
   *  full Bedrock property set from scratch. */
  private async createBedrockServer(config: MinecraftCreateConfig, onProgress?: (pct: number, message: string) => void): Promise<{ success: boolean; server?: MinecraftServer; error?: string }> {
    try {
      if (config.port < 1 || config.port > 65535) return { success: false, error: 'Port must be between 1 and 65535.' };
      if (fs.existsSync(config.installPath) && fs.readdirSync(config.installPath).length > 0) {
        return { success: false, error: 'That folder already has files in it. Choose an empty folder, or use Import for an existing server.' };
      }
      fs.mkdirSync(config.installPath, { recursive: true });

      onProgress?.(5, 'Resolving the official Bedrock download…');
      const links = await this.fetchBedrockVersions();
      const channel = config.bedrockChannel === 'preview' ? links.preview : links.stable;
      if (!channel) return { success: false, error: 'The Preview channel is not currently published by Mojang/Microsoft\'s download API. Try Stable instead.' };

      const zipPath = path.join(config.installPath, '_bedrock_download.zip');
      onProgress?.(10, `Downloading Bedrock Dedicated Server ${channel.version}…`);
      await this.downloadFileNative(channel.url, zipPath, (pct) => onProgress?.(10 + Math.round(pct * 0.7), `Downloading Bedrock Dedicated Server ${channel.version}…`));

      onProgress?.(82, 'Extracting…');
      await extractZip(zipPath, { dir: config.installPath });
      try { fs.unlinkSync(zipPath); } catch {}

      const exePath = path.join(config.installPath, 'bedrock_server.exe');
      if (!fs.existsSync(exePath)) {
        return { success: false, error: 'The download completed, but bedrock_server.exe was not found after extracting it — the archive may not match the expected Windows Bedrock Dedicated Server layout.' };
      }

      const now = new Date().toISOString();
      const server: MinecraftServer = {
        id: this.generateId(), name: config.name, installPath: config.installPath,
        version: channel.version, serverType: 'bedrock', edition: 'bedrock', jarFile: '',
        ramMB: 0, port: config.port, status: 'stopped', pid: null, startedAt: null,
        autoRestart: false, lastBackup: null, createdAt: now, updatedAt: now,
        requiredJavaMajor: null, javaPath: null, lastError: null, installedContent: [],
      };
      this.servers.push(server);
      this.save();

      onProgress?.(92, 'Applying server settings…');
      const changes: Record<string, string> = { 'server-port': String(config.port) };
      if (config.motd) changes['server-name'] = config.motd;
      if (config.gamemode && config.gamemode !== 'spectator') changes['gamemode'] = config.gamemode;
      if (config.difficulty) changes['difficulty'] = config.difficulty;
      if (typeof config.maxPlayers === 'number') changes['max-players'] = String(config.maxPlayers);
      if (typeof config.onlineMode === 'boolean') changes['online-mode'] = String(config.onlineMode);
      if (typeof config.allowCheats === 'boolean') changes['allow-cheats'] = String(config.allowCheats);
      if (typeof config.viewDistance === 'number') changes['view-distance'] = String(config.viewDistance);
      if (typeof config.whitelist === 'boolean') changes['allow-list'] = String(config.whitelist);
      if (config.seed) changes['level-seed'] = config.seed;
      this.writeProperties(server.id, changes);

      onProgress?.(100, 'Done');
      return { success: true, server };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Bedrock server creation failed.' };
    }
  }

  /** Java-only default server.properties generator. Bedrock never calls
   *  this — see createBedrockServer(), which keeps Mojang's own shipped
   *  server.properties and only overrides the specific keys the wizard
   *  collected, via the shared writeProperties(). */
  private defaultProperties(port: number, opts: MinecraftWorldOptions = {}): string {
    const lines = [
      '#Minecraft server properties — generated by Mercy Launcher',
      `server-port=${port}`,
      `motd=${opts.motd ?? 'A Mercy Launcher Server'}`,
      `gamemode=${opts.gamemode ?? 'survival'}`,
      `difficulty=${opts.difficulty ?? 'easy'}`,
      `hardcore=${opts.hardcore ?? false}`,
      `max-players=${opts.maxPlayers ?? 20}`,
      `online-mode=${opts.onlineMode ?? true}`,
      `pvp=${opts.pvp ?? true}`,
      `view-distance=${opts.viewDistance ?? 10}`,
      `simulation-distance=${opts.simulationDistance ?? 10}`,
      'spawn-protection=16',
      'allow-flight=false',
      `white-list=${opts.whitelist ?? false}`,
      'enable-command-block=false',
      'level-name=world',
    ];
    if (opts.seed) lines.push(`level-seed=${opts.seed}`);
    lines.push('');
    return lines.join('\n');
  }

  // ── Import existing server ──────────────────────────────────────────────
  /** Real, edition-aware detection. Checked in this order:
   *   1. bedrock_server.exe present → a genuine Bedrock Dedicated Server
   *      install, identified by its actual, unique executable — never
   *      guessed from folder name or any other heuristic.
   *   2. Otherwise falls through to the existing Java heuristics (a server
   *      jar, eula.txt, or server.properties) — completely unchanged.
   *  A folder with neither is correctly rejected for both editions; nothing
   *  here can misclassify an arbitrary folder as a Minecraft server of
   *  either kind. */
  async detectExistingServer(dirPath: string): Promise<{
    valid: boolean; reason?: string; edition?: MinecraftEdition; jarFile?: string; version?: string; serverType?: MinecraftServerType;
    hasProperties: boolean; hasWorld: boolean; hasEula: boolean; port?: number; ambiguous?: boolean;
  }> {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return { valid: false, reason: 'That path does not exist or is not a folder.', hasProperties: false, hasWorld: false, hasEula: false };
    }
    const entries = fs.readdirSync(dirPath);
    const hasProperties = entries.includes('server.properties');
    const hasBedrockExe = entries.some((f) => f.toLowerCase() === 'bedrock_server.exe');
    const props = hasProperties ? fs.readFileSync(path.join(dirPath, 'server.properties'), 'utf-8') : '';
    // These two keys only ever appear in a Bedrock Dedicated Server's
    // server.properties — Java's own property set has no equivalents —
    // so their presence is a real (not folder-name-based) edition signal
    // even when bedrock_server.exe itself isn't present in the folder.
    const hasBedrockOnlyProps = hasProperties && (/^server-portv6=/m.test(props) || /^texturepack-required=/m.test(props));

    if (hasBedrockExe) {
      const worldsDir = path.join(dirPath, 'worlds');
      const hasWorld = fs.existsSync(worldsDir) && (() => {
        try { return fs.readdirSync(worldsDir).length > 0; } catch { return false; }
      })();
      let port: number | undefined;
      if (hasProperties) {
        const m = props.match(/^server-port=(\d+)/m);
        if (m) port = parseInt(m[1], 10);
      }
      return { valid: true, edition: 'bedrock', serverType: 'bedrock', hasProperties, hasWorld, hasEula: false, port };
    }

    const jarFile = entries.find((f) => f.toLowerCase().endsWith('.jar') && !f.toLowerCase().includes('installer'));
    const hasEula = entries.includes('eula.txt');
    const hasJavaWorld = entries.some((f) => {
      try { return fs.statSync(path.join(dirPath, f)).isDirectory() && fs.existsSync(path.join(dirPath, f, 'level.dat')); } catch { return false; }
    });
    const hasBedrockWorld = (() => {
      const worldsDir = path.join(dirPath, 'worlds');
      if (!fs.existsSync(worldsDir)) return false;
      try { return fs.readdirSync(worldsDir).some((w) => fs.existsSync(path.join(worldsDir, w, 'db'))); } catch { return false; }
    })();
    const hasWorld = hasJavaWorld || hasBedrockWorld;

    if (!jarFile && !hasProperties && !hasEula && !hasWorld) {
      return { valid: false, reason: 'No Minecraft server files were found in this folder — looked for a Java server jar/eula.txt/server.properties, or bedrock_server.exe for a Bedrock server.', hasProperties, hasWorld, hasEula };
    }

    // No server jar and no bedrock_server.exe: there is no real executable
    // signature for either edition. If we found genuine Bedrock-only
    // property keys or a Bedrock-shaped world (worlds/<name>/db), it's
    // still identifiable as Bedrock (missing its binary). Otherwise this is
    // truly ambiguous — refuse to guess (never assume Java by default) and
    // report it so the caller can ask the user to choose explicitly.
    if (!jarFile) {
      if (hasBedrockOnlyProps || hasBedrockWorld) {
        let port: number | undefined;
        if (hasProperties) { const m = props.match(/^server-port=(\d+)/m); if (m) port = parseInt(m[1], 10); }
        return { valid: false, edition: 'bedrock', reason: 'This looks like a Bedrock Edition server folder, but bedrock_server.exe is missing — it cannot be imported without the actual Bedrock server executable.', hasProperties, hasWorld, hasEula, port };
      }
      if (hasEula || hasJavaWorld) {
        return { valid: false, edition: 'java', reason: 'This looks like a Java Edition server folder, but no server .jar file was found — it cannot be imported without the actual server jar.', hasProperties, hasWorld, hasEula };
      }
      return { valid: false, ambiguous: true, reason: 'Could not tell whether this is a Java or Bedrock server — no server .jar, no bedrock_server.exe, and no edition-specific signature was found in this folder.', hasProperties, hasWorld, hasEula };
    }

    let serverType: MinecraftServerType = 'vanilla';
    if (/paper/i.test(jarFile)) serverType = 'paper';
    let port: number | undefined;
    if (hasProperties) {
      const m = props.match(/^server-port=(\d+)/m);
      if (m) port = parseInt(m[1], 10);
    }
    return { valid: true, edition: 'java', jarFile, serverType, hasProperties, hasWorld, hasEula, port };
  }

  async importServer(dirPath: string, name: string, ramMB: number): Promise<{ success: boolean; server?: MinecraftServer; error?: string }> {
    const detected = await this.detectExistingServer(dirPath);
    if (!detected.valid) return { success: false, error: detected.reason || 'Could not recognize a Minecraft server in that folder.' };
    if (this.servers.some((s) => path.resolve(s.installPath) === path.resolve(dirPath))) {
      return { success: false, error: 'This server is already registered in Mercy Launcher.' };
    }
    const now = new Date().toISOString();

    if (detected.edition === 'bedrock') {
      const server: MinecraftServer = {
        id: this.generateId(), name, installPath: dirPath,
        version: 'unknown', serverType: 'bedrock', edition: 'bedrock', jarFile: '',
        ramMB: 0, port: detected.port ?? 19132, status: 'stopped', pid: null, startedAt: null,
        autoRestart: false, lastBackup: null, createdAt: now, updatedAt: now,
        requiredJavaMajor: null, javaPath: null, lastError: null, installedContent: [],
      };
      this.servers.push(server);
      this.save();
      return { success: true, server };
    }

    if (!detected.jarFile) return { success: false, error: 'Could not find a server jar in that folder.' };
    const server: MinecraftServer = {
      id: this.generateId(), name, installPath: dirPath,
      version: 'unknown', serverType: detected.serverType || 'vanilla', edition: 'java', jarFile: detected.jarFile,
      ramMB, port: detected.port ?? 25565, status: 'stopped', pid: null, startedAt: null,
      autoRestart: false, lastBackup: null, createdAt: now, updatedAt: now,
      // Version is unknown for an imported server, so the real Java
      // requirement can't be looked up from Mojang/PaperMC metadata — start()
      // falls back to the historical-boundaries heuristic in that case, and
      // the panel lets the user pin a specific runtime manually if needed.
      requiredJavaMajor: null, javaPath: null, lastError: null, installedContent: [],
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

  /** Edition dispatch — the only place that decides HOW a server launches.
   *  Everything downstream (PID tracking, console buffering, auto-restart,
   *  crash detection) is shared via wireProcess(); only the spawn call
   *  itself and the "is it actually up yet" detector differ per edition. */
  async startServer(id: string): Promise<{ success: boolean; error?: string }> {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    if (this.processes.has(id)) return { success: false, error: 'Server is already running.' };
    return server.edition === 'bedrock' ? this.launchBedrockProcess(server) : this.launchJavaProcess(server);
  }

  /** Shared process wiring: console buffering/broadcast, the "just became
   *  running" status transition (via a caller-supplied line detector so
   *  each edition can recognize its own real startup line), PID/uptime
   *  tracking, and crash-triggered auto-restart. Identical for both
   *  editions per the audit — Bedrock's stdin/stdout/exit behavior is
   *  process-shaped the same way Java's is; only the spawn command and the
   *  log lines to look for differ, which the caller provides. */
  private wireProcess(id: string, proc: ChildProcess, opts: { isRunningLine: (line: string) => boolean; translateError?: (line: string) => string | null }) {
    const server = this.getServer(id);
    if (!server) return;

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        this.appendConsole(id, line);
        if (opts.isRunningLine(line) && server.status !== 'running') {
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
        const friendly = opts.translateError?.(line);
        if (friendly) {
          this.appendConsole(id, `[Mercy] ${friendly}`);
          server.lastError = friendly;
          this.save();
        }
      }
    });

    proc.on('exit', (code, signal) => {
      this.processes.delete(id);
      this.resourceSamples.delete(id); // never diff a stale CPU-time sample against this server's next run
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
  }

  private async launchJavaProcess(server: MinecraftServer): Promise<{ success: boolean; error?: string }> {
    const id = server.id;
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

    this.wireProcess(id, proc, {
      isRunningLine: (line) => /Done \(/.test(line),
      translateError: translateClassVersionError,
    });

    return { success: true };
  }

  /** Bedrock never touches Java at all — no resolveLaunchJava(), no JVM
   *  flags, no jar. bedrock_server.exe is spawned directly with its
   *  install directory as cwd (matching how the Java path also uses cwd
   *  for relative asset loads), and its own real startup line
   *  ("...Server started.", stable across both the old and new Bedrock
   *  log timestamp formats per Microsoft's own documentation) is what
   *  flips status to 'running' — never Java's "Done (". */
  private async launchBedrockProcess(server: MinecraftServer): Promise<{ success: boolean; error?: string }> {
    const id = server.id;
    const exePath = path.join(server.installPath, 'bedrock_server.exe');
    if (!fs.existsSync(exePath)) return { success: false, error: `bedrock_server.exe was not found in ${server.installPath}. The install may be incomplete or corrupted.` };

    this.intentionalStop.delete(id);
    server.status = 'starting';
    server.lastError = null;
    server.updatedAt = new Date().toISOString();
    this.save();
    this.broadcast('minecraft:statusChange', { serverId: id, status: 'starting' });

    const proc = spawn(exePath, [], { cwd: server.installPath });
    this.processes.set(id, proc);
    server.pid = proc.pid ?? null;
    server.startedAt = new Date().toISOString();
    this.save();

    this.wireProcess(id, proc, {
      isRunningLine: (line) => /server started\.?\s*$/i.test(line.trim()),
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

  /** Queries Windows' own real per-process metrics via PowerShell's
   *  Get-Process — the same reliable, built-in mechanism Task Manager and
   *  Resource Monitor are built on, rather than a browser-only guess (which
   *  has no way to see an arbitrary OS process's CPU/memory at all).
   *  TotalProcessorTime is CUMULATIVE CPU time since the process started
   *  (not a percentage), by design — getProcessStats() below diffs two
   *  samples to derive a real, non-fabricated CPU%. WorkingSet64 is real,
   *  current physical memory (RSS), not estimated. Returns null (not a
   *  guessed value) if the process can't be queried for any reason. */
  private queryProcessMetrics(pid: number): Promise<{ cpuMs: number; memoryBytes: number } | null> {
    return new Promise((resolve) => {
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
    });
  }

  /** Real PID/uptime (unchanged) plus real, live per-process CPU%/memory —
   *  never invented or estimated. CPU% is derived from the delta between
   *  this call's real cumulative-CPU-time sample and the previous call's
   *  (normalized across all logical cores, matching modern Task Manager's
   *  convention), so the FIRST call after a server starts (or after a gap
   *  in polling) has no prior sample to diff against and honestly reports
   *  cpuPercent: null rather than a made-up number — the renderer shows
   *  this as "Measuring…" for one tick. metricsAvailable is false (with a
   *  reason) if Windows itself couldn't be queried, e.g. the process
   *  already exited between the status check and the query. */
  async getProcessStats(id: string): Promise<{
    pid: number | null; uptimeMs: number | null;
    cpuPercent: number | null; memoryBytes: number | null;
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
      return { pid, uptimeMs, cpuPercent: null, memoryBytes: null, metricsAvailable: false, metricsError: 'Could not read process metrics from Windows.' };
    }

    const now = Date.now();
    const prev = this.resourceSamples.get(id);
    this.resourceSamples.set(id, { cpuMs: raw.cpuMs, sampledAt: now });

    let cpuPercent: number | null = null;
    if (prev && now > prev.sampledAt) {
      const deltaCpuMs = raw.cpuMs - prev.cpuMs;
      const deltaWallMs = now - prev.sampledAt;
      const cores = os.cpus().length || 1;
      cpuPercent = Math.max(0, Math.min(100, (deltaCpuMs / (deltaWallMs * cores)) * 100));
    }

    return { pid, uptimeMs, cpuPercent, memoryBytes: raw.memoryBytes, metricsAvailable: true };
  }

  // ── Connection info ──────────────────────────────────────────────────────
  /** Actually attempts a real TCP connection to 127.0.0.1:port — the only
   *  honest way to know whether something is really listening, rather than
   *  inferring it from the Java process merely existing (a server can be
   *  running but still be mid-startup, bound to a different port than
   *  configured, or have crashed its listener while the process lingers). */
  private checkPortListening(port: number, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let done = false;
      const finish = (result: boolean) => {
        if (done) return;
        done = true;
        try { socket.destroy(); } catch {}
        resolve(result);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      try { socket.connect(port, '127.0.0.1'); } catch { finish(false); }
    });
  }

  /** This machine's own real, non-internal IPv4 address — never a fabricated
   *  or example address, and null (not a placeholder) when none is found
   *  (e.g. no network adapter is up). */
  private getLanAddress(): string | null {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return null;
  }

  /** RakNet's fixed 16-byte "offline message data ID" magic number — part
   *  of the real, public RakNet wire protocol (used by every Bedrock
   *  client/server and third-party server-status tools), not something
   *  Mercy invented. Both the Unconnected Ping Mercy sends and the
   *  Unconnected Pong a real server replies with carry this exact value. */
  private static readonly RAKNET_MAGIC = Buffer.from([0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78]);

  /** Builds a real RakNet "ID_UNCONNECTED_PING" packet: 1-byte message ID
   *  (0x01), an 8-byte timestamp the server echoes back, the 16-byte magic
   *  number above, and an 8-byte random "client GUID". This is the exact
   *  discovery packet the real Minecraft Bedrock client sends to populate
   *  its server list — not a fabricated probe. */
  private buildUnconnectedPing(): Buffer {
    const buf = Buffer.alloc(1 + 8 + 16 + 8);
    let offset = 0;
    buf.writeUInt8(0x01, offset); offset += 1;
    buf.writeBigInt64BE(BigInt(Date.now()), offset); offset += 8;
    MinecraftManager.RAKNET_MAGIC.copy(buf, offset); offset += 16;
    crypto.randomBytes(8).copy(buf, offset);
    return buf;
  }

  /** A REAL RakNet Unconnected Ping/Pong exchange over raw UDP — the only
   *  honest way to verify a Bedrock server is actually answering. Bedrock's
   *  protocol (RakNet) is UDP, so the TCP-based checkPortListening() used
   *  for Java is structurally incapable of verifying it (a Bedrock server
   *  doesn't listen on a TCP socket at all — that check would always report
   *  "not listening" even for a perfectly healthy Bedrock server). This
   *  sends a real ping and only reports "reachable" if a real Unconnected
   *  Pong (ID 0x1C, with the same magic number echoed back) is received —
   *  never inferred from a UDP send() merely not throwing, since UDP is
   *  connectionless and that would prove nothing. */
  private checkRakNetReachable(port: number, timeoutMs = 2000): Promise<{ checked: boolean; reachable: boolean | null; note: string }> {
    return new Promise((resolve) => {
      let done = false;
      const socket = dgram.createSocket('udp4');
      const finish = (result: { checked: boolean; reachable: boolean | null; note: string }) => {
        if (done) return;
        done = true;
        try { socket.close(); } catch {}
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish({ checked: true, reachable: false, note: 'The server process is running, but did not answer a real RakNet ping on this port within 2 seconds — it may still be loading the world, or something else may be bound to this port.' });
      }, timeoutMs);

      socket.once('error', (err) => {
        clearTimeout(timer);
        finish({ checked: false, reachable: null, note: `Could not perform the RakNet check: ${err.message}.` });
      });

      socket.once('message', (msg) => {
        clearTimeout(timer);
        const looksValid = msg.length >= 35 && msg[0] === 0x1c && msg.subarray(17, 33).equals(MinecraftManager.RAKNET_MAGIC);
        finish(looksValid
          ? { checked: true, reachable: true, note: 'Server answered a real RakNet ping — it is reachable and accepting connections.' }
          : { checked: true, reachable: false, note: 'Received a UDP response on this port, but it was not a valid RakNet reply — something other than Bedrock may be using this port.' });
      });

      try {
        socket.send(this.buildUnconnectedPing(), port, '127.0.0.1', (err) => {
          if (err) { clearTimeout(timer); finish({ checked: false, reachable: null, note: `Could not send the RakNet ping: ${err.message}.` }); }
        });
      } catch (e: any) {
        clearTimeout(timer);
        finish({ checked: false, reachable: null, note: `Could not perform the RakNet check: ${e?.message || 'unknown error'}.` });
      }
    });
  }

  /** Real connection info for the Connect tab — always recomputed from the
   *  server's CURRENT record and a live reachability check, never cached,
   *  so it can't go stale after the user edits the port/version/type. */
  async getConnectionInfo(id: string): Promise<MinecraftConnectionInfo | null> {
    const server = this.getServer(id);
    if (!server) return null;

    // Checked whenever a process is actually alive (running, still starting
    // up, or mid-graceful-stop) — a Minecraft server typically binds its
    // socket well before it finishes loading, so "starting" can genuinely
    // already be accepting connections. Only skipped when there's
    // definitely no process to check (stopped/error).
    const processIsAlive = server.status === 'running' || server.status === 'starting' || server.status === 'stopping';
    const lan = this.getLanAddress();

    if (server.edition === 'bedrock') {
      const raknet = processIsAlive
        ? await this.checkRakNetReachable(server.port)
        : { checked: false, reachable: null, note: 'Server is not running.' };
      return {
        serverId: id, serverName: server.name, serverType: server.serverType, version: server.version,
        edition: 'bedrock', status: server.status, port: server.port,
        lanAddress: lan ? `${lan}:${server.port}` : null,
        portListening: null,
        bedrock: { possible: false, detectedPlugin: null, note: 'Not applicable — this is already a native Bedrock server, so no Geyser bridge is needed.' },
        raknet,
      };
    }

    const portListening = processIsAlive ? await this.checkPortListening(server.port) : null;

    // Bedrock is only ever possible through a real installed Geyser plugin
    // (Paper only) — never assumed for a plain Vanilla/Paper server, and
    // never claimed "configured" just because the plugin file exists;
    // Geyser also needs its own config, which Mercy doesn't verify here.
    const geyser = server.installedContent.find((c) => /geyser/i.test(c.projectName) || /geyser/i.test(c.fileName));
    const bedrock = geyser
      ? {
          possible: true, detectedPlugin: geyser.projectName,
          note: `"${geyser.projectName}" is installed, which can let Bedrock Edition clients connect through this same port — but only if Geyser's own configuration is set up correctly. Mercy detected the plugin, not a working Bedrock connection.`,
        }
      : {
          possible: false, detectedPlugin: null,
          note: server.serverType === 'paper'
            ? 'This is a Java Edition server. Bedrock Edition players cannot connect unless a Geyser plugin is installed and configured (Marketplace → search "Geyser").'
            : 'This is a Java Edition Vanilla server. Bedrock Edition players cannot connect at all — Geyser requires a Paper server.',
        };

    return {
      serverId: id, serverName: server.name, serverType: server.serverType, version: server.version,
      edition: 'java', status: server.status, port: server.port,
      lanAddress: lan ? `${lan}:${server.port}` : null,
      portListening, bedrock, raknet: null,
    };
  }

  // ── Players (derived from real console output — no query/RCON assumed) ──
  /** Edition-aware: Java's console phrases join/leave as "X joined/left the
   *  game"; Bedrock's phrases it entirely differently ("Player connected:
   *  X, xuid: ..." / "Player disconnected: X..."), confirmed against
   *  Bedrock Dedicated Server's own real log output. Matching Java's regex
   *  against Bedrock's log (or vice versa) would silently match nothing —
   *  this dispatches by the server's actual edition rather than trying one
   *  pattern and hoping. */
  private trackPlayerFromLine(id: string, line: string) {
    const server = this.getServer(id);
    if (!server) return;
    const map = this.players.get(id) || new Map<string, KnownPlayer>();

    if (server.edition === 'bedrock') {
      const connected = line.match(/Player connected:\s*([^,]+),/i);
      const disconnected = line.match(/Player disconnected:\s*([^,]+)/i);
      if (!connected && !disconnected) return;
      if (connected) { const name = connected[1].trim(); map.set(name, { name, online: true, lastSeen: new Date().toISOString() }); }
      if (disconnected) { const name = disconnected[1].trim(); if (map.has(name)) { const p = map.get(name)!; p.online = false; p.lastSeen = new Date().toISOString(); } }
      this.players.set(id, map);
      return;
    }

    const joined = line.match(/: (\w+) joined the game/);
    const left = line.match(/: (\w+) left the game/);
    if (!joined && !left) return;
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
      // Keep the registry's own port field in sync — the Connect tab (and
      // everything else that reads server.port) must never show a stale
      // port after the user changes it here rather than in the wizard.
      if (Object.prototype.hasOwnProperty.call(changes, 'server-port')) {
        const parsed = parseInt(changes['server-port'], 10);
        if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 && parsed !== server.port) {
          server.port = parsed;
          server.updatedAt = new Date().toISOString();
          this.save();
        }
      }
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

  /** Resolves a path relative to a server's install directory, refusing any
   *  traversal outside it — the same guarantee listFiles/readServerFile/
   *  writeServerFile rely on, exposed so MinecraftMarketplace's content
   *  installer can place files safely without duplicating the logic. */
  resolveWithinServer(id: string, relPath: string): string | null {
    const server = this.getServer(id);
    if (!server) return null;
    return this.resolveServerRelative(server, relPath);
  }

  getServerType(id: string): MinecraftServerType | null { return this.getServer(id)?.serverType ?? null; }
  getInstallPath(id: string): string | null { return this.getServer(id)?.installPath ?? null; }

  /** The world/level directory name from server.properties (defaults to "world"). */
  getLevelName(id: string): string {
    const entry = this.readProperties(id).find((p) => p.key === 'level-name');
    return entry?.value?.trim() || 'world';
  }

  // ── Installed content (Marketplace installs — plugins & datapacks only;
  // Mercy never installs mods, since it doesn't run a mod loader) ─────────
  getInstalledContent(id: string): InstalledContent[] { return this.getServer(id)?.installedContent || []; }

  addInstalledContent(id: string, content: InstalledContent): boolean {
    const server = this.getServer(id);
    if (!server) return false;
    server.installedContent.push(content);
    server.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  updateInstalledContent(id: string, contentId: string, patch: Partial<InstalledContent>): boolean {
    const server = this.getServer(id);
    if (!server) return false;
    const item = server.installedContent.find((c) => c.id === contentId);
    if (!item) return false;
    Object.assign(item, patch);
    server.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  removeInstalledContent(id: string, contentId: string): InstalledContent | null {
    const server = this.getServer(id);
    if (!server) return null;
    const idx = server.installedContent.findIndex((c) => c.id === contentId);
    if (idx === -1) return null;
    const [removed] = server.installedContent.splice(idx, 1);
    server.updatedAt = new Date().toISOString();
    this.save();
    return removed;
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

  // ── Security: shared archive-extraction guards ──────────────────────────
  // Both world import and pack install extract an untrusted zip into a
  // temp dir first (never straight into the server) and run this before
  // touching anything else. extract-zip/yauzl already normalizes entry
  // paths (real zip-slip protection), but this is defense in depth: every
  // extracted entry must resolve strictly inside `root`, and none may be a
  // symlink/junction (neither a Minecraft world nor a resource/behavior
  // pack legitimately needs one — Windows zip extraction doesn't normally
  // create them, but this closes the door regardless of platform).
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

  private checkArchiveSize(zipPath: string, maxBytes: number, label: string) {
    const size = fs.statSync(zipPath).size;
    if (size > maxBytes) throw new Error(`${label} is too large (${(size / 1024 / 1024).toFixed(0)} MB, max ${(maxBytes / 1024 / 1024).toFixed(0)} MB).`);
  }

  // ── Worlds (real import/export, edition-aware) ───────────────────────────
  private readonly MAX_WORLD_ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024; // 5GB
  private readonly MAX_PACK_ARCHIVE_BYTES = 500 * 1024 * 1024; // 500MB

  /** Real per-edition world location — Java's level-name folder sits
   *  directly under the server root; Bedrock's sits under worlds/. Reads
   *  the raw property (not getLevelName(), which is Java-only-shaped and
   *  used by Marketplace datapack placement — this needs the correct
   *  per-edition default instead of always falling back to "world"). */
  private getWorldPaths(server: MinecraftServer): { dir: string; levelName: string } {
    let levelName = '';
    try { levelName = this.readProperties(server.id).find((p) => p.key === 'level-name')?.value?.trim() || ''; } catch {}
    if (!levelName) levelName = server.edition === 'bedrock' ? 'Bedrock level' : 'world';
    const dir = server.edition === 'bedrock' ? path.join(server.installPath, 'worlds', levelName) : path.join(server.installPath, levelName);
    return { dir, levelName };
  }

  /** Real, signature-based edition detection for an extracted world folder
   *  — never a filename/extension guess. Bedrock worlds use LevelDB (a
   *  real "db" subfolder); Java worlds never have one and instead have a
   *  binary-NBT level.dat directly in the world folder. Checks the
   *  extraction root itself first, then one level of subdirectories (a
   *  zip commonly has the world as a single top-level folder). */
  private findWorldRoot(extractDir: string): { root: string; edition: MinecraftEdition } | null {
    const check = (dir: string): MinecraftEdition | null => {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
      const entries = fs.readdirSync(dir);
      if (entries.includes('db') && fs.statSync(path.join(dir, 'db')).isDirectory()) return 'bedrock';
      if (entries.includes('level.dat')) return 'java';
      return null;
    };
    const direct = check(extractDir);
    if (direct) return { root: extractDir, edition: direct };
    for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(extractDir, entry.name);
      const found = check(sub);
      if (found) return { root: sub, edition: found };
    }
    return null;
  }

  getWorldInfo(id: string): { levelName: string; exists: boolean; sizeBytes: number | null; edition: MinecraftEdition } | null {
    const server = this.getServer(id);
    if (!server) return null;
    const { dir, levelName } = this.getWorldPaths(server);
    const exists = fs.existsSync(dir);
    let sizeBytes: number | null = null;
    if (exists) {
      try {
        let total = 0;
        const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } };
        walk(dir);
        sizeBytes = total;
      } catch {}
    }
    return { levelName, exists, sizeBytes, edition: server.edition };
  }

  /** Exports JUST the world folder (never the whole server) as a real,
   *  externally-usable zip — the world keeps its own folder name as the
   *  zip's top-level entry so re-importing it (here or in real Minecraft)
   *  is unambiguous. Refuses while running, matching restoreBackup()'s
   *  existing safety precedent, so the copy can never be read mid-write. */
  async exportWorld(id: string, destZipPath: string): Promise<{ success: boolean; error?: string }> {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    if (this.processes.has(id)) return { success: false, error: 'Stop the server before exporting its world.' };
    const { dir, levelName } = this.getWorldPaths(server);
    if (!fs.existsSync(dir)) return { success: false, error: `No world found (looked for "${levelName}").` };
    try {
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(destZipPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(dir, levelName);
        archive.finalize();
      });
      return { success: true };
    } catch (e: any) {
      try { if (fs.existsSync(destZipPath)) fs.unlinkSync(destZipPath); } catch {}
      return { success: false, error: e?.message || 'World export failed.' };
    }
  }

  /** Real import: extracts to a secure temp dir under userData first (never
   *  straight into the server), validates it's a genuine world via its real
   *  on-disk signature, refuses an edition mismatch outright, and requires
   *  explicit confirmation (needsConfirmation) before replacing an existing
   *  world — which itself gets a real backup (registered in the same
   *  backup index the Backups tab already shows) before being touched. */
  async importWorld(id: string, sourceZipPath: string, confirmReplace = false): Promise<{ success: boolean; error?: string; needsConfirmation?: boolean; detectedEdition?: MinecraftEdition }> {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    if (this.processes.has(id)) return { success: false, error: 'Stop the server before importing a world.' };
    if (!fs.existsSync(sourceZipPath)) return { success: false, error: 'Selected file does not exist.' };

    let tmpRoot = '';
    try {
      this.checkArchiveSize(sourceZipPath, this.MAX_WORLD_ARCHIVE_BYTES, 'World archive');
      tmpRoot = path.join(this.userDataPath, 'tmp', `world-import-${id}-${Date.now()}`);
      fs.mkdirSync(tmpRoot, { recursive: true });
      await extractZip(sourceZipPath, { dir: tmpRoot });
      this.assertNoTraversal(tmpRoot);

      const found = this.findWorldRoot(tmpRoot);
      if (!found) return { success: false, error: 'Could not find a recognizable Minecraft world in that archive (no level.dat or Bedrock db/ folder).' };
      if (found.edition !== server.edition) {
        return {
          success: false,
          detectedEdition: found.edition,
          error: `This is a ${found.edition === 'bedrock' ? 'Bedrock' : 'Java'} world, but this server is ${server.edition === 'bedrock' ? 'Bedrock' : 'Java'} Edition — refusing to install a mismatched world.`,
        };
      }

      const { dir: targetDir, levelName } = this.getWorldPaths(server);
      const worldAlreadyExists = fs.existsSync(targetDir);
      if (worldAlreadyExists && !confirmReplace) {
        return { success: false, needsConfirmation: true, detectedEdition: found.edition, error: `A world ("${levelName}") already exists for this server. Importing will replace it.` };
      }

      if (worldAlreadyExists) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `${server.name.replace(/[^a-z0-9-_]/gi, '_')}-world-preimport-${timestamp}`;
        const backupPath = path.join(this.backupsDir, `${backupName}.zip`);
        await new Promise<void>((resolve, reject) => {
          const output = fs.createWriteStream(backupPath);
          const archive = archiver('zip', { zlib: { level: 6 } });
          output.on('close', resolve);
          archive.on('error', reject);
          archive.pipe(output);
          archive.directory(targetDir, levelName);
          archive.finalize();
        });
        const stats = fs.statSync(backupPath);
        const list = this.loadBackupIndex();
        list.push({ id: this.generateId(), serverId: id, name: backupName, path: backupPath, size: stats.size, createdAt: new Date().toISOString() });
        this.saveBackupIndex(list);
        fs.rmSync(targetDir, { recursive: true, force: true });
      }

      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.cpSync(found.root, targetDir, { recursive: true });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'World import failed.' };
    } finally {
      if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
    }
  }

  // ── Bedrock Resource/Behavior Packs (real, local-folder mechanism) ───────
  // Java has no server-side equivalent of a local pack folder — a Java
  // server delivers exactly one resource pack via a URL its own clients
  // download from (the resource-pack/resource-pack-sha1 server.properties
  // keys, already editable generically via Properties). Pretending Java has
  // the same local-folder pack system as Bedrock would be dishonest, so
  // this section is Bedrock-only by design, not an oversight.
  /** Mojang's own shipped manifest.json files (e.g. the default "chemistry"
   *  packs bundled with every Bedrock Dedicated Server download) use `//`
   *  and `/* *\/` comments, which are valid in Bedrock's JSONC-flavored
   *  manifests but not in strict JSON. Strips them (respecting string
   *  literals so a `//` inside a quoted value is left alone) before
   *  JSON.parse, so genuinely valid, real Mojang-shipped manifests aren't
   *  misreported as invalid. */
  private stripJsonComments(input: string): string {
    let out = '';
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      const next = input[i + 1];
      if (inLineComment) {
        if (c === '\n') { inLineComment = false; out += c; }
        continue;
      }
      if (inBlockComment) {
        if (c === '*' && next === '/') { inBlockComment = false; i++; }
        continue;
      }
      if (inString) {
        out += c;
        if (c === '\\') { out += next; i++; continue; }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; out += c; continue; }
      if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
      if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
      out += c;
    }
    return out;
  }

  private parseBedrockManifestFile(filePath: string): any {
    const raw = fs.readFileSync(filePath, 'utf-8');
    try { return JSON.parse(raw); } catch { return JSON.parse(this.stripJsonComments(raw)); }
  }

  /** Real Bedrock packs often put loc keys (e.g. "pack.name") in the
   *  manifest and define the actual display string in texts/en_US.lang —
   *  Mojang's own bundled "chemistry" packs do exactly this. A raw,
   *  unresolved loc key looks like confusing placeholder text to a user, so
   *  this detects that shape and resolves it against the pack's own lang
   *  file when one exists. */
  private looksLikeBedrockLocKey(s: string): boolean {
    return /^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(s.trim());
  }

  private resolveBedrockLangValue(packDir: string, key: string): string | null {
    for (const lang of ['en_US.lang', 'en_GB.lang']) {
      const langPath = path.join(packDir, 'texts', lang);
      if (!fs.existsSync(langPath)) continue;
      try {
        for (const line of fs.readFileSync(langPath, 'utf-8').split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq === -1) continue;
          if (trimmed.slice(0, eq).trim() === key) {
            // Bedrock lang lines may carry a trailing "\t##comment".
            const value = trimmed.slice(eq + 1).split('\t')[0].trim();
            if (value) return value;
          }
        }
      } catch {}
    }
    return null;
  }

  /** Resolves a manifest string for display: a real, human-written value is
   *  used as-is; a raw loc key is resolved via the pack's lang file when
   *  possible, and otherwise replaced with `fallback` rather than shown
   *  verbatim (never "pack.name"/"pack.description" on screen). */
  private resolveBedrockDisplayString(packDir: string, raw: string | undefined, fallback: string): string {
    const value = (raw || '').trim();
    if (!value) return fallback;
    if (!this.looksLikeBedrockLocKey(value)) return value;
    const resolved = this.resolveBedrockLangValue(packDir, value);
    return resolved || fallback;
  }

  /** Finds a genuine manifest.json (with a real, valid header.uuid + a
   *  3-number header.version — never assumed from the archive/file name)
   *  at the extraction root or one level of subdirectories. */
  private findManifestRoot(extractDir: string): { root: string; manifest: any } | null {
    return this.findAllManifestRoots(extractDir)[0] || null;
  }

  /** Same real-manifest search as findManifestRoot, but collects EVERY valid
   *  manifest found (direct dir + one level of subdirs) instead of stopping
   *  at the first — needed for a real Bedrock .mcaddon container, which
   *  legitimately ships a resource pack AND a behavior pack side by side in
   *  one archive. */
  private findAllManifestRoots(extractDir: string): { root: string; manifest: any }[] {
    const tryDir = (dir: string): any | null => {
      const p = path.join(dir, 'manifest.json');
      if (!fs.existsSync(p)) return null;
      try {
        const m = this.parseBedrockManifestFile(p);
        if (!this.isValidBedrockManifest(m)) return null;
        return m;
      } catch { return null; }
    };
    const found: { root: string; manifest: any }[] = [];
    const direct = tryDir(extractDir);
    if (direct) found.push({ root: extractDir, manifest: direct });
    for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(extractDir, entry.name);
      const m = tryDir(sub);
      if (m) found.push({ root: sub, manifest: m });
    }
    return found;
  }

  /** Shared "place a validated manifest folder into resource_packs/
   *  behavior_packs" step used by both a single-pack install and a
   *  multi-pack add-on install — one real copy/naming implementation, never
   *  duplicated. */
  private placeFoundPack(server: MinecraftServer, kind: 'resource_packs' | 'behavior_packs', foundRoot: string, manifestName: string | undefined, fallbackBaseName: string): { folderName: string } {
    const packsDir = path.join(server.installPath, kind);
    fs.mkdirSync(packsDir, { recursive: true });
    // Resolve a loc key (e.g. "pack.name") against the pack's own lang file
    // before using it as the folder name too — otherwise a pack whose
    // manifest uses lang keys but ships without its lang file would end up
    // in a folder literally named "pack.name" on disk.
    const resolvedDisplayName = this.resolveBedrockDisplayString(foundRoot, manifestName, fallbackBaseName);
    const baseName = resolvedDisplayName.replace(/[^a-z0-9-_ .]/gi, '_').trim() || 'pack';
    let folderName = baseName;
    let targetDir = path.join(packsDir, folderName);
    let suffix = 2;
    while (fs.existsSync(targetDir)) { folderName = `${baseName} (${suffix})`; targetDir = path.join(packsDir, folderName); suffix++; }
    fs.cpSync(foundRoot, targetDir, { recursive: true });
    return { folderName };
  }

  private isValidBedrockManifest(m: any): boolean {
    const uuid = m?.header?.uuid;
    const version = m?.header?.version;
    const validUuid = typeof uuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
    const validVersion = Array.isArray(version) && version.length === 3 && version.every((n: any) => Number.isInteger(n));
    return validUuid && validVersion;
  }

  private bedrockActivationFile(server: MinecraftServer, kind: 'resource_packs' | 'behavior_packs'): string {
    const { dir } = this.getWorldPaths(server);
    return path.join(dir, kind === 'resource_packs' ? 'world_resource_packs.json' : 'world_behavior_packs.json');
  }

  private readBedrockActivation(server: MinecraftServer, kind: 'resource_packs' | 'behavior_packs'): { pack_id: string; version: number[] }[] {
    try {
      const raw = fs.readFileSync(this.bedrockActivationFile(server, kind), 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  /** Lists real installed packs by scanning resource_packs/behavior_packs
   *  and reading each folder's own manifest.json — never assumes a pack is
   *  active just because its folder exists; "enabled" is cross-referenced
   *  against the world's own real world_resource_packs.json/
   *  world_behavior_packs.json activation list. */
  listBedrockPacks(id: string, kind: 'resource_packs' | 'behavior_packs'): {
    folderName: string; uuid: string | null; name: string; version: string; description: string; valid: boolean; invalidReason?: string; enabled: boolean;
  }[] {
    const server = this.getServer(id);
    if (!server || server.edition !== 'bedrock') return [];
    const packsDir = path.join(server.installPath, kind);
    if (!fs.existsSync(packsDir)) return [];
    const activation = this.readBedrockActivation(server, kind);

    const results: ReturnType<MinecraftManager['listBedrockPacks']> = [];
    for (const entry of fs.readdirSync(packsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folderName = entry.name;
      const packDir = path.join(packsDir, folderName);
      const manifestPath = path.join(packDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        results.push({ folderName, uuid: null, name: folderName, version: 'unknown', description: '', valid: false, invalidReason: 'No manifest.json found.', enabled: false });
        continue;
      }
      try {
        const manifest = this.parseBedrockManifestFile(manifestPath);
        if (!this.isValidBedrockManifest(manifest)) {
          results.push({
            folderName, uuid: typeof manifest?.header?.uuid === 'string' ? manifest.header.uuid : null,
            name: this.resolveBedrockDisplayString(packDir, manifest?.header?.name, folderName),
            version: 'unknown',
            description: this.resolveBedrockDisplayString(packDir, manifest?.header?.description, ''),
            valid: false, invalidReason: 'manifest.json has no valid header.uuid/header.version.', enabled: false,
          });
          continue;
        }
        const uuid = manifest.header.uuid as string;
        const versionArr = manifest.header.version as number[];
        const enabled = activation.some((a) => a.pack_id === uuid && Array.isArray(a.version) && a.version.length === 3 && a.version.every((n, i) => n === versionArr[i]));
        results.push({
          folderName, uuid,
          name: this.resolveBedrockDisplayString(packDir, manifest.header.name, folderName),
          version: versionArr.join('.'),
          description: this.resolveBedrockDisplayString(packDir, manifest.header.description, ''),
          valid: true, enabled,
        });
      } catch {
        results.push({ folderName, uuid: null, name: folderName, version: 'unknown', description: '', valid: false, invalidReason: 'manifest.json is not valid JSON.', enabled: false });
      }
    }
    return results;
  }

  /** Real install: extract to a secure temp dir, validate a genuine
   *  manifest.json exists, then move into place — never overwriting an
   *  unrelated existing folder (a name collision gets a numbered suffix
   *  instead). */
  async installBedrockPack(id: string, kind: 'resource_packs' | 'behavior_packs', zipPath: string): Promise<{ success: boolean; error?: string; folderName?: string }> {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    if (server.edition !== 'bedrock') return { success: false, error: 'This server is not Bedrock Edition.' };
    if (!fs.existsSync(zipPath)) return { success: false, error: 'Selected file does not exist.' };

    let tmpRoot = '';
    try {
      this.checkArchiveSize(zipPath, this.MAX_PACK_ARCHIVE_BYTES, 'Pack archive');
      tmpRoot = path.join(this.userDataPath, 'tmp', `pack-import-${id}-${Date.now()}`);
      fs.mkdirSync(tmpRoot, { recursive: true });
      await extractZip(zipPath, { dir: tmpRoot });
      this.assertNoTraversal(tmpRoot);

      const found = this.findManifestRoot(tmpRoot);
      if (!found) return { success: false, error: 'Could not find a valid manifest.json (with a real header.uuid and header.version) in that archive.' };

      const { folderName } = this.placeFoundPack(server, kind, found.root, found.manifest.header.name, path.basename(zipPath, path.extname(zipPath)));
      return { success: true, folderName };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Pack install failed.' };
    } finally {
      if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
    }
  }

  /** Installs a real Bedrock .mcaddon-style container: an archive that
   *  legitimately bundles a resource pack AND a behavior pack side by side
   *  (each its own manifest.json). Reuses the exact same validation/copy
   *  logic as installBedrockPack via placeFoundPack — this is not a second
   *  pack-management system, just an entry point that dispatches each
   *  manifest it finds to the correct existing kind based on its own real
   *  module type, instead of assuming an archive contains only one pack. */
  async installBedrockAddon(id: string, zipPath: string): Promise<{ success: boolean; error?: string; installedResourcePack?: string; installedBehaviorPack?: string }> {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    if (server.edition !== 'bedrock') return { success: false, error: 'This server is not Bedrock Edition.' };
    if (!fs.existsSync(zipPath)) return { success: false, error: 'Selected file does not exist.' };

    let tmpRoot = '';
    try {
      this.checkArchiveSize(zipPath, this.MAX_PACK_ARCHIVE_BYTES, 'Add-on archive');
      tmpRoot = path.join(this.userDataPath, 'tmp', `addon-import-${id}-${Date.now()}`);
      fs.mkdirSync(tmpRoot, { recursive: true });
      await extractZip(zipPath, { dir: tmpRoot });
      this.assertNoTraversal(tmpRoot);

      const found = this.findAllManifestRoots(tmpRoot);
      if (found.length === 0) return { success: false, error: 'Could not find a valid manifest.json (with a real header.uuid and header.version) in that archive.' };

      const fallbackBaseName = path.basename(zipPath, path.extname(zipPath));
      let installedResourcePack: string | undefined;
      let installedBehaviorPack: string | undefined;
      for (const f of found) {
        const moduleTypes: string[] = Array.isArray(f.manifest?.modules) ? f.manifest.modules.map((m: any) => m?.type).filter((t: any) => typeof t === 'string') : [];
        const isBehavior = moduleTypes.includes('data');
        const isResource = moduleTypes.includes('resources') || moduleTypes.includes('client_data') || moduleTypes.includes('interface');
        // A manifest with no recognizable module type is skipped rather than guessed into the wrong folder.
        if (isBehavior && !installedBehaviorPack) {
          installedBehaviorPack = this.placeFoundPack(server, 'behavior_packs', f.root, f.manifest.header.name, fallbackBaseName).folderName;
        } else if (isResource && !installedResourcePack) {
          installedResourcePack = this.placeFoundPack(server, 'resource_packs', f.root, f.manifest.header.name, fallbackBaseName).folderName;
        }
      }
      if (!installedResourcePack && !installedBehaviorPack) {
        return { success: false, error: 'Found a manifest.json in that archive, but could not tell whether it was a resource pack or behavior pack (no recognizable module type).' };
      }
      return { success: true, installedResourcePack, installedBehaviorPack };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Add-on install failed.' };
    } finally {
      if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
    }
  }

  /** Enables/disables ONE pack by editing only its own entry in the real
   *  world_resource_packs.json/world_behavior_packs.json — backed up first,
   *  every other entry left untouched (never a blind full rewrite). */
  setBedrockPackEnabled(id: string, kind: 'resource_packs' | 'behavior_packs', uuid: string, version: number[], enabled: boolean): { success: boolean; error?: string } {
    const server = this.getServer(id);
    if (!server || server.edition !== 'bedrock') return { success: false, error: 'Not a Bedrock server.' };
    const { dir: worldDir } = this.getWorldPaths(server);
    fs.mkdirSync(worldDir, { recursive: true });
    const file = this.bedrockActivationFile(server, kind);
    let list = this.readBedrockActivation(server, kind);
    try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch {}

    const idx = list.findIndex((e) => e.pack_id === uuid);
    if (enabled) {
      if (idx === -1) list.push({ pack_id: uuid, version });
      else list[idx] = { pack_id: uuid, version };
    } else if (idx !== -1) {
      list.splice(idx, 1);
    }

    try {
      fs.writeFileSync(file, JSON.stringify(list, null, 2));
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to update pack activation.' };
    }
  }

  /** Removes a pack's folder and strips any matching activation entries —
   *  every other pack's own folder and activation entry is left untouched. */
  removeBedrockPack(id: string, kind: 'resource_packs' | 'behavior_packs', folderName: string, uuid: string | null): { success: boolean; error?: string } {
    const server = this.getServer(id);
    if (!server || server.edition !== 'bedrock') return { success: false, error: 'Not a Bedrock server.' };
    const packsRoot = path.resolve(path.join(server.installPath, kind));
    const packDir = path.resolve(path.join(packsRoot, folderName));
    if (!isPathInside(packDir, packsRoot)) return { success: false, error: 'Invalid pack folder.' };
    try {
      if (fs.existsSync(packDir)) fs.rmSync(packDir, { recursive: true, force: true });
      if (uuid) {
        const file = this.bedrockActivationFile(server, kind);
        if (fs.existsSync(file)) {
          const list = this.readBedrockActivation(server, kind);
          const next = list.filter((e) => e.pack_id !== uuid);
          if (next.length !== list.length) { try { fs.copyFileSync(file, `${file}.bak`); } catch {} fs.writeFileSync(file, JSON.stringify(next, null, 2)); }
        }
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to remove pack.' };
    }
  }
}
