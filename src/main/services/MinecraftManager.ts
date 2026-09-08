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
}

export interface MinecraftCreateConfig {
  name: string;
  installPath: string;
  version: string;
  serverType: MinecraftServerType;
  ramMB: number;
  port: number;
  acceptedEula: boolean;
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

// Rough, well-known Java-major requirement per Minecraft release line. Not
// exhaustive to every patch, but correct for the boundaries that matter —
// used as a warning, not a hard block, since a newer JDK usually still runs
// older servers fine.
function requiredJavaMajor(mcVersion: string): number {
  const parts = mcVersion.split('.').map((n) => parseInt(n, 10));
  const maj = parts[0], min = parts[1] ?? 0, patch = parts[2] ?? 0;
  if (maj !== 1) return 21;
  if (min > 20 || (min === 20 && patch >= 5)) return 21; // 1.20.5+
  if (min >= 18) return 17; // 1.18 – 1.20.4
  if (min === 17) return 16; // 1.17.x
  return 8; // pre-1.17
}

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
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
  async detectJava(): Promise<{ found: boolean; version: string | null; major: number | null }> {
    return new Promise((resolve) => {
      execFile('java', ['-version'], (err, _stdout, stderr) => {
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

  javaRequirementFor(mcVersion: string): number { return requiredJavaMajor(mcVersion); }

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
      if (config.serverType === 'vanilla') {
        const resolved = await this.resolveVanillaJarUrl(config.version);
        jarUrl = resolved.url;
      } else {
        const resolved = await this.resolvePaperJarUrl(config.version);
        jarUrl = resolved.url;
        jarName = resolved.name;
      }

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
    };
    this.servers.push(server);
    this.save();
    return { success: true, server };
  }

  // ── Process control ─────────────────────────────────────────────────────
  async startServer(id: string): Promise<{ success: boolean; error?: string }> {
    const server = this.getServer(id);
    if (!server) return { success: false, error: 'Server not found.' };
    if (this.processes.has(id)) return { success: false, error: 'Server is already running.' };
    const jarPath = path.join(server.installPath, server.jarFile);
    if (!fs.existsSync(jarPath)) return { success: false, error: `Server jar not found: ${server.jarFile}` };

    this.intentionalStop.delete(id);
    server.status = 'starting';
    server.updatedAt = new Date().toISOString();
    this.save();
    this.broadcast('minecraft:statusChange', { serverId: id, status: 'starting' });

    const proc = spawn('java', [`-Xmx${server.ramMB}M`, `-Xms${Math.min(server.ramMB, 1024)}M`, '-jar', server.jarFile, 'nogui'], {
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
      for (const line of chunk.toString().split(/\r?\n/)) if (line) this.appendConsole(id, `[ERROR] ${line}`);
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
      current.status = 'error';
      this.appendConsole(id, `[Mercy] Server process exited unexpectedly (code ${code}, signal ${signal}).`);
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
