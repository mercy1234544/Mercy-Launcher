import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';
import { BrowserWindow } from 'electron';
import axios from 'axios';
import extractZip from 'extract-zip';
import { ArtifactDownloader } from './ArtifactDownloader';
import { DatabaseManager } from './DatabaseManager';

export interface ServerConfig {
  name: string;
  framework: 'esx' | 'qbcore' | 'qbox' | 'custom' | 'blank';
  os: 'windows' | 'linux';
  database: 'mariadb' | 'mysql';
  artifactVersion: string;
  licenseKey: string;
  installPath: string;
}

export interface Server {
  id: string;
  name: string;
  framework: string;
  os: string;
  database: string;
  artifactVersion: string;
  installPath: string;
  resourceCount: number;
  // 'starting' = process spawned but the server isn't ready yet (yellow dot,
  // like txAdmin's partial state). Promoted to 'running' when the console
  // shows readiness output.
  status: 'stopped' | 'starting' | 'running' | 'error';
  lastBackup: string | null;
  createdAt: string;
  updatedAt: string;
  /** Content FiveMMarketplace.ts itself installed — optional and defaulted
   *  to [] wherever read, so existing servers saved before this field
   *  existed load exactly as before (no migration, no forced re-save). */
  installedMarketplaceContent?: FiveMInstalledContent[];
}

export interface FiveMInstalledContent {
  id: string;
  source: 'github';
  /** e.g. "overextended/ox_lib" */
  repo: string;
  resourceName: string;
  /** Bracket-style category folder the resource was placed under, e.g. "[core]". */
  category: string;
  /** Relative to the server's install directory, e.g. "resources/[core]/ox_lib". */
  relPath: string;
  version: string | null;
  sha: string | null;
  enabled: boolean;
  installedAt: string;
  dependencies: string[];
}

interface ResourceToClone {
  name: string;
  repo: string;
  folder: string;
  releaseUrl?: string; // Use GitHub Releases download instead of source code
}

// ─── Resources that MUST use release builds (have compiled UI/web components) ─
// These will be downloaded from GitHub Releases, not source code
//
// ─── Essential resources every FiveM server needs ─────────────────────────────
const CORE_RESOURCES: ResourceToClone[] = [
  {
    name: 'oxmysql',
    repo: 'https://github.com/overextended/oxmysql',
    folder: '[core]',
    releaseUrl: 'https://github.com/overextended/oxmysql/releases/latest/download/oxmysql.zip',
  },
  {
    name: 'ox_lib',
    repo: 'https://github.com/overextended/ox_lib',
    folder: '[core]',
    releaseUrl: 'https://github.com/overextended/ox_lib/releases/latest/download/ox_lib.zip',
  },
];

const ESX_RESOURCES: ResourceToClone[] = [
  { name: 'es_extended', repo: 'https://github.com/esx-framework/esx_core', folder: '[esx]' },
  { name: 'esx_multicharacter', repo: 'https://github.com/esx-framework/esx_multicharacter', folder: '[esx]' },
  { name: 'esx_identity', repo: 'https://github.com/esx-framework/esx_identity', folder: '[esx]' },
  { name: 'esx_skin', repo: 'https://github.com/esx-framework/esx_skin', folder: '[esx]' },
  { name: 'esx_policejob', repo: 'https://github.com/esx-framework/esx_policejob', folder: '[esx]' },
  { name: 'esx_ambulancejob', repo: 'https://github.com/esx-framework/esx_ambulancejob', folder: '[esx]' },
  { name: 'esx_mechanicjob', repo: 'https://github.com/esx-framework/esx_mechanicjob', folder: '[esx]' },
  { name: 'esx_basicneeds', repo: 'https://github.com/esx-framework/esx_basicneeds', folder: '[esx]' },
  { name: 'esx_vehicleshop', repo: 'https://github.com/esx-framework/esx_vehicleshop', folder: '[esx]' },
  { name: 'esx_property', repo: 'https://github.com/esx-framework/esx_property', folder: '[esx]' },
];

const QBCORE_RESOURCES: ResourceToClone[] = [
  { name: 'qb-core', repo: 'https://github.com/qbcore-framework/qb-core', folder: '[qb]' },
  { name: 'qb-multicharacter', repo: 'https://github.com/qbcore-framework/qb-multicharacter', folder: '[qb]' },
  { name: 'qb-spawn', repo: 'https://github.com/qbcore-framework/qb-spawn', folder: '[qb]' },
  { name: 'qb-clothing', repo: 'https://github.com/qbcore-framework/qb-clothing', folder: '[qb]' },
  { name: 'qb-policejob', repo: 'https://github.com/qbcore-framework/qb-policejob', folder: '[qb]' },
  { name: 'qb-ambulancejob', repo: 'https://github.com/qbcore-framework/qb-ambulancejob', folder: '[qb]' },
  { name: 'qb-mechanicjob', repo: 'https://github.com/qbcore-framework/qb-mechanicjob', folder: '[qb]' },
  { name: 'qb-smallresources', repo: 'https://github.com/qbcore-framework/qb-smallresources', folder: '[qb]' },
  { name: 'qb-vehicleshop', repo: 'https://github.com/qbcore-framework/qb-vehicleshop', folder: '[qb]' },
  { name: 'qb-vehiclekeys', repo: 'https://github.com/qbcore-framework/qb-vehiclekeys', folder: '[qb]' },
  { name: 'qb-garages', repo: 'https://github.com/qbcore-framework/qb-garages', folder: '[qb]' },
  { name: 'qb-houses', repo: 'https://github.com/qbcore-framework/qb-houses', folder: '[qb]' },
  { name: 'qb-inventory', repo: 'https://github.com/qbcore-framework/qb-inventory', folder: '[qb]' },
  { name: 'qb-shops', repo: 'https://github.com/qbcore-framework/qb-shops', folder: '[qb]' },
  { name: 'qb-banking', repo: 'https://github.com/qbcore-framework/qb-banking', folder: '[qb]' },
  { name: 'qb-hud', repo: 'https://github.com/qbcore-framework/qb-hud', folder: '[qb]' },
  { name: 'qb-target', repo: 'https://github.com/qbcore-framework/qb-target', folder: '[qb]' },
  { name: 'qb-menu', repo: 'https://github.com/qbcore-framework/qb-menu', folder: '[qb]' },
  { name: 'qb-input', repo: 'https://github.com/qbcore-framework/qb-input', folder: '[qb]' },
  { name: 'qb-phone', repo: 'https://github.com/qbcore-framework/qb-phone', folder: '[qb]' },
  { name: 'qb-weathersync', repo: 'https://github.com/qbcore-framework/qb-weathersync', folder: '[qb]' },
  { name: 'progressbar', repo: 'https://github.com/qbcore-framework/progressbar', folder: '[qb]' },
];

const SHARED_RESOURCES: ResourceToClone[] = [
  { name: 'PolyZone', repo: 'https://github.com/mkafrin/PolyZone', folder: '[core]' },
  { name: 'pma-voice', repo: 'https://github.com/AvarianKnight/pma-voice', folder: '[voice]' },
  {
    name: 'ox_target',
    repo: 'https://github.com/overextended/ox_target',
    folder: '[core]',
    releaseUrl: 'https://github.com/overextended/ox_target/releases/latest/download/ox_target.zip',
  },
  {
    name: 'ox_inventory',
    repo: 'https://github.com/overextended/ox_inventory',
    folder: '[inventory]',
    releaseUrl: 'https://github.com/overextended/ox_inventory/releases/latest/download/ox_inventory.zip',
  },
  {
    name: 'ox_doorlock',
    repo: 'https://github.com/overextended/ox_doorlock',
    folder: '[utility]',
    releaseUrl: 'https://github.com/overextended/ox_doorlock/releases/latest/download/ox_doorlock.zip',
  },
  { name: 'bob74_ipl', repo: 'https://github.com/Bob74/bob74_ipl', folder: '[maps]' },
];

export class ServerManager {
  private dataPath: string;
  private serversFile: string;
  private servers: Map<string, Server> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private consoleLogs: Map<string, string[]> = new Map();
  private databaseManager: DatabaseManager | null = null;

  setDatabaseManager(dbManager: DatabaseManager) {
    this.databaseManager = dbManager;
  }

  constructor(userDataPath: string) {
    this.dataPath = path.join(userDataPath, 'data');
    this.serversFile = path.join(this.dataPath, 'servers.json');
    this.ensureDataDir();
    this.loadServers();
  }

  private ensureDataDir() {
    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath, { recursive: true });
    }
  }

  private loadServers() {
    if (fs.existsSync(this.serversFile)) {
      const data = JSON.parse(fs.readFileSync(this.serversFile, 'utf-8'));
      for (const server of data) {
        server.status = 'stopped';
        this.servers.set(server.id, server);
      }
    }
  }

  private saveServers() {
    const data = Array.from(this.servers.values());
    fs.writeFileSync(this.serversFile, JSON.stringify(data, null, 2));
  }

  private generateId(): string {
    const bytes = new Uint8Array(16);
    crypto.randomFillSync(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
  }

  getAllServers(): Server[] {
    return Array.from(this.servers.values()).map(s => {
      let resourceCount = 0;
      const resourcesPath = path.join(s.installPath, 'resources');
      if (fs.existsSync(resourcesPath)) {
        try {
          resourceCount = this.countResources(resourcesPath);
        } catch {}
      }
      return { ...s, resourceCount };
    });
  }

  private countResources(dir: string): number {
    let count = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const manifestPath = path.join(dir, entry.name, 'fxmanifest.lua');
        const resourcePath = path.join(dir, entry.name, '__resource.lua');
        if (fs.existsSync(manifestPath) || fs.existsSync(resourcePath)) {
          count++;
        } else {
          count += this.countResources(path.join(dir, entry.name));
        }
      }
    }
    return count;
  }

  getServer(id: string): Server | null {
    return this.servers.get(id) || null;
  }

  /** Resolves a path relative to a server's install directory, refusing any
   *  traversal outside it — the same guarantee MinecraftManager's own
   *  resolveWithinServer() provides, reused here for FiveMMarketplace's
   *  resource placement/removal so a malicious or malformed resource name
   *  (e.g. containing "..") can never write outside the server's own folder. */
  resolveWithinServer(id: string, relPath: string): string | null {
    const server = this.getServer(id);
    if (!server) return null;
    const root = path.resolve(server.installPath);
    const resolved = path.resolve(root, relPath || '.');
    const rel = path.relative(root, resolved);
    if (resolved !== root && (rel.startsWith('..') || path.isAbsolute(rel))) return null;
    return resolved;
  }

  // ── Marketplace-installed content tracking ──────────────────────────────
  getInstalledMarketplaceContent(id: string): FiveMInstalledContent[] {
    return this.getServer(id)?.installedMarketplaceContent || [];
  }

  addInstalledMarketplaceContent(id: string, content: FiveMInstalledContent): boolean {
    const server = this.servers.get(id);
    if (!server) return false;
    if (!server.installedMarketplaceContent) server.installedMarketplaceContent = [];
    server.installedMarketplaceContent.push(content);
    server.updatedAt = new Date().toISOString();
    this.saveServers();
    return true;
  }

  updateInstalledMarketplaceContent(id: string, contentId: string, patch: Partial<FiveMInstalledContent>): boolean {
    const server = this.servers.get(id);
    const item = server?.installedMarketplaceContent?.find((c) => c.id === contentId);
    if (!server || !item) return false;
    Object.assign(item, patch);
    server.updatedAt = new Date().toISOString();
    this.saveServers();
    return true;
  }

  removeInstalledMarketplaceContent(id: string, contentId: string): FiveMInstalledContent | null {
    const server = this.servers.get(id);
    if (!server?.installedMarketplaceContent) return null;
    const idx = server.installedMarketplaceContent.findIndex((c) => c.id === contentId);
    if (idx === -1) return null;
    const [removed] = server.installedMarketplaceContent.splice(idx, 1);
    server.updatedAt = new Date().toISOString();
    this.saveServers();
    return removed;
  }

  async createServer(config: ServerConfig): Promise<Server> {
    const id = this.generateId();
    const server: Server = {
      id,
      name: config.name,
      framework: config.framework,
      os: config.os,
      database: config.database,
      artifactVersion: config.artifactVersion,
      installPath: config.installPath,
      resourceCount: 0,
      status: 'stopped',
      lastBackup: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mainWindow = BrowserWindow.getAllWindows()[0];
    const sendProgress = (message: string, current: number, total: number) => {
      if (mainWindow) {
        mainWindow.webContents.send('server:buildProgress', { current, total, resource: '', message });
      }
    };

    // ═══════════════════════════════════════════════════════════════════
    // STEP 1: Create base directory
    // ═══════════════════════════════════════════════════════════════════
    if (!fs.existsSync(config.installPath)) {
      fs.mkdirSync(config.installPath, { recursive: true });
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 2: Download FiveM server artifacts
    // This gives us FXServer.exe, cache/, citizen/, txAdmin, all DLLs
    // ═══════════════════════════════════════════════════════════════════
    sendProgress('Downloading FiveM server artifacts...', 0, 100);

    const artifactDownloader = new ArtifactDownloader();
    artifactDownloader.on('progress', (progress: any) => {
      if (mainWindow) {
        mainWindow.webContents.send('server:buildProgress', {
          current: Math.round(progress.percent || 0),
          total: 100,
          resource: '',
          message: progress.message || `Downloading artifacts: ${Math.round(progress.percent || 0)}%`,
        });
      }
    });

    const artifactResult = await artifactDownloader.download(config.artifactVersion, config.installPath);
    if (!artifactResult.success) {
      console.error('Artifact download failed:', artifactResult.error);
      sendProgress(`ERROR: Artifact download failed — ${artifactResult.error}`, 0, 100);
      artifactDownloader.removeAllListeners();
      throw new Error(`FiveM artifact download failed: ${artifactResult.error}`);
    }

    sendProgress('✓ FiveM artifacts installed', 100, 100);

    // Save artifact version marker
    try {
      const versions = await artifactDownloader.getAvailableVersions();
      const picked = versions.find((v: any) =>
        v.version === config.artifactVersion ||
        (config.artifactVersion === 'recommended' && v.recommended) ||
        (!v.recommended && config.artifactVersion === 'latest')
      );
      const buildNum = picked?.version || config.artifactVersion;
      fs.writeFileSync(path.join(config.installPath, '.artifact-version'), buildNum, 'utf-8');
    } catch {}

    artifactDownloader.removeAllListeners();

    // ═══════════════════════════════════════════════════════════════════
    // STEP 3: Execute framework recipe (QBCore/ESX) or create blank
    // Downloads all resources using the same official txAdmin recipe
    // URLs — proper release builds, correct folder structure
    // ═══════════════════════════════════════════════════════════════════
    const resourcesDir = path.join(config.installPath, 'resources');
    if (!fs.existsSync(resourcesDir)) {
      fs.mkdirSync(resourcesDir, { recursive: true });
    }

    // Create user folders for custom additions regardless of framework
    for (const folder of ['[custom]', '[mlo]', '[vehicles]', '[vehiclescripts]']) {
      const fp = path.join(resourcesDir, folder);
      if (!fs.existsSync(fp)) fs.mkdirSync(fp, { recursive: true });
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 2.5: Set up the database (MariaDB/MySQL)
    // Starts an existing service, or downloads portable MariaDB if none
    // is installed. Creates the server's database so SQL imports work.
    // ═══════════════════════════════════════════════════════════════════
    const dbName = (config.name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'fivem').slice(0, 60);
    let dbReady = false;
    if (this.databaseManager && config.framework !== 'blank') {
      sendProgress('Setting up database (MySQL/MariaDB)...', 0, 100);
      try {
        const dbResult = await this.databaseManager.ensureRunning(true, (msg, pct) => sendProgress(msg, pct, 100));
        if (dbResult.success) {
          dbReady = await this.databaseManager.createDatabase(dbName);
          if (dbReady) {
            sendProgress(`✓ Database "${dbName}" ready (${dbResult.method})`, 100, 100);
          } else {
            sendProgress('Warning: MySQL is running but database creation failed — check credentials', 100, 100);
          }
        } else {
          sendProgress(`Warning: Could not set up database — ${dbResult.error}. Run Health Scanner to fix later.`, 100, 100);
        }
      } catch (err: any) {
        console.error('[Build] Database setup failed:', err.message);
        sendProgress(`Warning: Database setup failed — ${err.message}`, 100, 100);
      }
    }

    if (config.framework === 'qbcore' || config.framework === 'esx' || config.framework === 'qbox') {
      sendProgress('Fetching official framework recipe...', 0, 100);

      const recipeUrls: Record<string, string> = {
        qbcore: 'https://raw.githubusercontent.com/qbcore-framework/txAdminRecipe/main/qbcore.yaml',
        qbox: 'https://raw.githubusercontent.com/Qbox-project/txAdminRecipe/main/qbox.yaml',
        esx: 'https://raw.githubusercontent.com/Avanae/esx-legacy-recipe/main/recipe.yaml',
      };
      const recipeUrl = recipeUrls[config.framework];

      let recipeYaml: string;
      try {
        const resp = await axios.get(recipeUrl, { timeout: 30000 });
        recipeYaml = resp.data;
      } catch (err: any) {
        throw new Error(`Failed to fetch recipe: ${err.message}`);
      }

      const tasks = this.parseRecipeTasks(recipeYaml);
      const downloadTasks = tasks.filter(t =>
        t.action === 'download_github' || t.action === 'download_file'
      );
      const totalDownloads = downloadTasks.length;
      let completed = 0;

      for (const task of tasks) {
        try {
          switch (task.action) {
            case 'download_github': {
              completed++;
              const destName = (task.dest || '').split('/').pop() || task.src?.split('/').pop() || 'resource';
              sendProgress(
                `Downloading ${destName} (${completed}/${totalDownloads})...`,
                Math.round((completed / totalDownloads) * 100),
                100
              );
              const dest = path.join(config.installPath, task.dest || './resources');
              const ref = task.ref || 'main';
              await this.downloadGithubResource(task.src!, dest, ref, task.subpath);
              break;
            }
            case 'download_file': {
              completed++;
              const fileName = (task.url || '').split('/').pop() || 'file';
              sendProgress(
                `Downloading ${fileName} (${completed}/${totalDownloads})...`,
                Math.round((completed / totalDownloads) * 100),
                100
              );
              const fileDest = path.join(config.installPath, task.path || task.dest || './tmp/file');
              const dir = path.dirname(fileDest);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              const resp = await axios.get(task.url!, {
                responseType: 'arraybuffer',
                timeout: 120000,
                maxRedirects: 5,
              });
              fs.writeFileSync(fileDest, Buffer.from(resp.data));
              break;
            }
            case 'unzip': {
              const src = path.join(config.installPath, task.src!);
              const dest = path.join(config.installPath, task.dest!);
              if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
              if (fs.existsSync(src)) await extractZip(src, { dir: dest });
              break;
            }
            case 'move_path': {
              const src = path.join(config.installPath, task.src!);
              const dest = path.join(config.installPath, task.dest!);
              if (fs.existsSync(src)) {
                const destDir = path.dirname(dest);
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                // renameSync fails across drives on Windows — fall back to copy+delete
                try {
                  fs.renameSync(src, dest);
                } catch {
                  if (fs.statSync(src).isDirectory()) {
                    this.copyDirRecursive(src, dest);
                    fs.rmSync(src, { recursive: true, force: true });
                  } else {
                    fs.copyFileSync(src, dest);
                    fs.unlinkSync(src);
                  }
                }
              } else {
                console.warn(`[Recipe] move_path: source not found: ${src}`);
              }
              break;
            }
            case 'remove_path': {
              const target = path.join(config.installPath, task.path || task.src || '');
              if (fs.existsSync(target)) {
                fs.rmSync(target, { recursive: true, force: true });
              }
              break;
            }
            case 'copy_path': {
              const src = path.join(config.installPath, task.src!);
              const dest = path.join(config.installPath, task.dest!);
              if (fs.existsSync(src)) {
                const destDir = path.dirname(dest);
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                if (fs.statSync(src).isDirectory()) {
                  this.copyDirRecursive(src, dest);
                } else {
                  fs.copyFileSync(src, dest);
                }
              }
              break;
            }
            case 'waste_time': {
              const seconds = task.seconds || 5;
              await new Promise(r => setTimeout(r, seconds * 1000));
              break;
            }
            case 'connect_database': {
              // Database already set up in STEP 2.5 — nothing to do
              break;
            }
            case 'query_database': {
              if (!dbReady || !this.databaseManager) {
                console.warn('[Recipe] query_database skipped — database not ready');
                break;
              }
              // Recipes use either `file: ./path.sql` or inline `query: ...`
              const sqlFileRef = task.file && task.file !== 'true' ? task.file
                : (task.query && task.query.endsWith('.sql') ? task.query : null);
              if (sqlFileRef) {
                const sqlPath = path.join(config.installPath, sqlFileRef);
                sendProgress(`Importing SQL schema: ${path.basename(sqlFileRef)}...`, completed, totalDownloads);
                const ok = await this.databaseManager.importSqlFile(dbName, sqlPath);
                if (ok) sendProgress(`✓ Imported ${path.basename(sqlFileRef)} into "${dbName}"`, completed, totalDownloads);
              } else if (task.query) {
                await this.databaseManager.importSql(dbName, task.query);
              }
              break;
            }
            // skip: replace_string (we generate our own server.cfg)
          }
        } catch (err: any) {
          console.error(`[Recipe] Task FAILED (${task.action}):`, task, err.message);
          sendProgress(`Warning: ${task.action} failed for ${task.dest || task.src || task.url || ''} — ${err.message}`, completed, totalDownloads);
        }
      }
    } else if (config.framework === 'custom') {
      // Custom: just download cfx-server-data defaults + oxmysql
      sendProgress('Downloading default CFX resources...', 0, 100);
      const cfxDest = path.join(resourcesDir, '[cfx-default]');
      await this.downloadGithubResource(
        'https://github.com/citizenfx/cfx-server-data', cfxDest, 'master', 'resources'
      );
      sendProgress('Downloading oxmysql...', 50, 100);
      const oxDest = path.join(resourcesDir, '[standalone]', 'oxmysql');
      try {
        const oxResp = await axios.get(
          'https://github.com/overextended/oxmysql/releases/download/v2.14.1/oxmysql.zip',
          { responseType: 'arraybuffer', timeout: 120000, maxRedirects: 5 }
        );
        const oxZip = path.join(os.tmpdir(), `oxmysql-${Date.now()}.zip`);
        fs.writeFileSync(oxZip, Buffer.from(oxResp.data));
        if (!fs.existsSync(oxDest)) fs.mkdirSync(oxDest, { recursive: true });
        await extractZip(oxZip, { dir: path.join(resourcesDir, '[standalone]') });
        try { fs.unlinkSync(oxZip); } catch {}
      } catch (err: any) {
        console.error('[Custom] Failed to download oxmysql:', err.message);
      }
    }
    // blank = no resources at all, just artifacts

    // ═══════════════════════════════════════════════════════════════════
    // Download base CFX resources for ALL frameworks (mapmanager, chat, etc.)
    // These are required by every FiveM server but only cfx-server-data has them.
    // ═══════════════════════════════════════════════════════════════════
    if (config.framework !== 'blank') {
      const cfxDefaultDir = path.join(resourcesDir, '[cfx-default]');
      if (!fs.existsSync(path.join(cfxDefaultDir, 'chat'))) {
        sendProgress('Downloading base FiveM resources (chat, mapmanager, etc.)...', 90, 100);
        try {
          await this.downloadGithubResource(
            'https://github.com/citizenfx/cfx-server-data', cfxDefaultDir, 'master', 'resources'
          );
          console.log('[Build] Downloaded cfx-server-data base resources');
        } catch (err: any) {
          console.error('[Build] Failed to download cfx-server-data:', err.message);
          sendProgress('Warning: Could not download base resources — run Health Scanner to fix', 90, 100);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Verify critical resources were downloaded
    // ═══════════════════════════════════════════════════════════════════
    if (config.framework === 'qbcore' || config.framework === 'qbox' || config.framework === 'esx') {
      const criticalChecks: Record<string, string[]> = {
        qbox: [
          'resources/[ox]/ox_lib/fxmanifest.lua',
          'resources/[ox]/oxmysql/fxmanifest.lua',
          'resources/[ox]/ox_target/fxmanifest.lua',
          'resources/[ox]/ox_inventory/fxmanifest.lua',
          'resources/[qbx]/qbx_core/fxmanifest.lua',
        ],
        qbcore: [
          'resources/[standalone]/oxmysql/fxmanifest.lua',
          'resources/[qb]/qb-core/fxmanifest.lua',
        ],
        esx: [
          'resources/[legacy]/[esx]/es_extended/fxmanifest.lua',
        ],
      };
      const checks = criticalChecks[config.framework] || [];
      const missing: string[] = [];
      for (const check of checks) {
        const fullPath = path.join(config.installPath, check);
        if (!fs.existsSync(fullPath)) {
          missing.push(check);
          console.error(`[Recipe] MISSING critical resource: ${check}`);
        }
      }
      if (missing.length > 0) {
        sendProgress(`WARNING: ${missing.length} critical resources missing — check logs`, 95, 100);
        console.error('[Recipe] Missing resources:', missing);
      } else {
        console.log('[Recipe] All critical resources verified OK');
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 4: Generate a clean server.cfg for txAdmin
    // txAdmin's "Use Existing Server Data" requires a server.cfg to exist.
    // We write a minimal one with NO license key — txAdmin adds that
    // itself during its setup wizard. Any recipe-provided cfg with
    // broken {{template}} variables gets replaced.
    // ═══════════════════════════════════════════════════════════════════
    const cfgPath = path.join(config.installPath, 'server.cfg');
    const cleanCfg = this.generateServerCfg(config, dbName);
    fs.writeFileSync(cfgPath, cleanCfg, 'utf-8');
    console.log('[Build] Generated server.cfg for framework:', config.framework);

    // Clean up extra cfg files from recipes that have unresolved {{template}} vars
    for (const file of ['ox.cfg', 'voice.cfg', 'misc.cfg', 'permissions.cfg']) {
      const extraCfg = path.join(config.installPath, file);
      if (fs.existsSync(extraCfg)) {
        try {
          const content = fs.readFileSync(extraCfg, 'utf-8');
          if (content.includes('{{')) {
            fs.unlinkSync(extraCfg);
            console.log(`[Build] Deleted ${file} — had unresolved template vars`);
          }
        } catch {}
      }
    }

    // Generate supporting cfg files if they don't exist
    if (config.framework === 'qbox' || config.framework === 'qbcore') {
      const oxCfg = path.join(config.installPath, 'ox.cfg');
      if (!fs.existsSync(oxCfg)) {
        fs.writeFileSync(oxCfg, [
          `# Ox Configuration`,
          `set ox:printlevel 1`,
          ``,
        ].join('\n'), 'utf-8');
      }
      const permCfg = path.join(config.installPath, 'permissions.cfg');
      if (!fs.existsSync(permCfg)) {
        fs.writeFileSync(permCfg, [
          `# Permissions`,
          `# Add admin permissions here`,
          `# Example: add_principal identifier.fivem:123456 group.admin`,
          ``,
        ].join('\n'), 'utf-8');
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 5: Count resources and finalize
    // ═══════════════════════════════════════════════════════════════════
    let resourceCount = 0;
    try {
      const countResources = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const p = path.join(dir, entry.name);
          const hasManifest = fs.existsSync(path.join(p, 'fxmanifest.lua')) ||
                              fs.existsSync(path.join(p, '__resource.lua'));
          if (hasManifest) {
            resourceCount++;
          } else {
            countResources(p);
          }
        }
      };
      countResources(resourcesDir);
    } catch {}
    server.resourceCount = resourceCount;

    this.servers.set(id, server);
    this.saveServers();

    // ═══════════════════════════════════════════════════════════════════
    // STEP 6: Auto-start FXServer so txAdmin launches for registration
    // ═══════════════════════════════════════════════════════════════════
    sendProgress('Starting FXServer + txAdmin...', 98, 100);
    try {
      // Start WITHOUT server.cfg so txAdmin boots into its first-time setup wizard.
      // The user will enter their license key, server name, and select "Use Existing Server"
      // to link txAdmin to our already-downloaded resources.
      const startResult = await this.startServerRaw(id);
      if (startResult.success) {
        server.status = 'running';
        this.saveServers();
        // Don't block the build on txAdmin — finish immediately and open
        // the browser in the background the moment txAdmin responds.
        sendProgress('Server build complete! txAdmin will open automatically...', 100, 100);
        this.waitForTxAdmin(40120, 180000).then((txReady) => {
          if (txReady) {
            console.log('[Build] txAdmin is up — opening browser');
            const { shell } = require('electron');
            shell.openExternal('http://localhost:40120');
          } else {
            console.warn('[Build] txAdmin did not respond within 3 minutes');
          }
        }).catch(() => {});
      } else {
        sendProgress(`Server build complete! Auto-start failed: ${startResult.error}`, 100, 100);
      }
    } catch (err: any) {
      sendProgress(`Server build complete! Auto-start failed: ${err.message}`, 100, 100);
    }
    return server;
  }


  /**
   * Download a resource — either from a GitHub Release ZIP (pre-built) or source code.
   */
  private async downloadResource(res: ResourceToClone, destination: string): Promise<void> {
    if (res.releaseUrl) {
      await this.downloadAndExtractRelease(res.releaseUrl, destination, res.repo);
    } else {
      await this.downloadAndExtractRepo(res.repo, destination);
    }
  }

  /**
   * Download a pre-built release ZIP (e.g., ox_lib, oxmysql).
   * These ZIPs contain the resource ready-to-use, unlike source code.
   */
  private async downloadAndExtractRelease(releaseUrl: string, destination: string, repoUrl: string): Promise<void> {
    console.log(`[Download] Release build: ${releaseUrl}`);
    const response = await axios.get(releaseUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxRedirects: 5,
    });

    const tempDir = os.tmpdir();
    const zipPath = path.join(tempDir, `release-${Date.now()}.zip`);
    fs.writeFileSync(zipPath, Buffer.from(response.data));

    const extractDir = path.join(tempDir, `release-extract-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(zipPath, { dir: extractDir });

    // Release ZIPs may have a single subfolder or files directly
    const extracted = fs.readdirSync(extractDir);
    let innerDir = extractDir;
    if (extracted.length === 1) {
      const single = path.join(extractDir, extracted[0]);
      if (fs.statSync(single).isDirectory()) {
        innerDir = single;
      }
    }

    if (!fs.existsSync(destination)) {
      fs.mkdirSync(destination, { recursive: true });
    }

    this.copyDirRecursive(innerDir, destination);
    fs.writeFileSync(path.join(destination, '.fivem-builder-source'), repoUrl);

    try {
      fs.unlinkSync(zipPath);
      fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {}
  }

  /**
   * Download a GitHub repo as ZIP (source code) and extract to destination.
   * No git needed, no auth prompts.
   */
  private async downloadAndExtractRepo(repoUrl: string, destination: string): Promise<void> {
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) throw new Error('Invalid GitHub URL');
    const [, owner, repo] = match;
    const repoName = repo.replace(/\.git$/, '');

    console.log(`[Download] Source code: ${repoUrl}`);

    // Try main branch, fall back to master
    let zipUrl = `https://github.com/${owner}/${repoName}/archive/refs/heads/main.zip`;
    let response;
    try {
      response = await axios.get(zipUrl, { responseType: 'arraybuffer', timeout: 60000 });
    } catch {
      zipUrl = `https://github.com/${owner}/${repoName}/archive/refs/heads/master.zip`;
      response = await axios.get(zipUrl, { responseType: 'arraybuffer', timeout: 60000 });
    }

    const tempDir = os.tmpdir();
    const zipPath = path.join(tempDir, `${repoName}-${Date.now()}.zip`);
    fs.writeFileSync(zipPath, Buffer.from(response.data));

    const extractDir = path.join(tempDir, `${repoName}-extract-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(zipPath, { dir: extractDir });

    // GitHub ZIPs have a single subfolder like "repo-main/"
    const extracted = fs.readdirSync(extractDir);
    const innerDir = extracted.length === 1
      ? path.join(extractDir, extracted[0])
      : extractDir;

    if (!fs.existsSync(destination)) {
      fs.mkdirSync(destination, { recursive: true });
    }

    // Copy all files to destination
    this.copyDirRecursive(innerDir, destination);

    // Save source URL for future updates
    fs.writeFileSync(path.join(destination, '.fivem-builder-source'), repoUrl);

    // Cleanup
    try {
      fs.unlinkSync(zipPath);
      fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {}
  }

  private copyDirRecursive(src: string, dest: string) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  private async waitForTxAdmin(port: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        // 127.0.0.1 explicitly — "localhost" can resolve to IPv6 ::1 on
        // Windows while txAdmin only listens on IPv4, making detection
        // fail forever even though txAdmin is up.
        await axios.get(`http://127.0.0.1:${port}`, { timeout: 2000 });
        return true;
      } catch (err: any) {
        if (err.response) return true; // Got a response (even 401/403 means txAdmin is up)
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }

  private parseRecipeTasks(yaml: string): Array<Record<string, any>> {
    const tasks: Array<Record<string, any>> = [];
    const lines = yaml.split('\n');
    let inTasks = false;
    let currentTask: Record<string, any> | null = null;

    for (const line of lines) {
      const trimmed = line.trimEnd();

      if (trimmed === 'tasks:') {
        inTasks = true;
        continue;
      }
      if (!inTasks) continue;

      // New task entry
      if (/^\s+- action:\s*(.+)/.test(trimmed)) {
        if (currentTask) tasks.push(currentTask);
        const action = trimmed.match(/action:\s*(.+)/)![1].trim();
        currentTask = { action };
        continue;
      }

      // Task property
      if (currentTask && /^\s+\w+:/.test(trimmed) && !trimmed.trim().startsWith('-')) {
        const propMatch = trimmed.match(/^\s+(\w+):\s*(.*)$/);
        if (propMatch) {
          let [, key, value] = propMatch;
          value = value.replace(/^['"]|['"]$/g, '').trim();
          if (key === 'seconds') {
            currentTask[key] = parseInt(value, 10) || 5;
          } else {
            currentTask[key] = value;
          }
        }
      }
    }
    if (currentTask) tasks.push(currentTask);
    return tasks;
  }

  /** Recursively check whether a bracket folder exists under resources/. */
  private findFolderRecursive(dir: string, folderName: string, depth = 0): boolean {
    if (depth > 4) return false;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === folderName) return true;
        if (this.findFolderRecursive(path.join(dir, entry.name), folderName, depth + 1)) return true;
      }
    } catch {}
    return false;
  }

  private generateServerCfg(config: { name: string; framework: string; licenseKey?: string; installPath?: string }, dbName?: string): string {
    const lines: string[] = [];

    // Disk-aware ensures — only reference folders/resources that exist.
    // Without an installPath (shouldn't happen) we assume they exist.
    const resourcesDir = config.installPath ? path.join(config.installPath, 'resources') : null;
    const hasFolder = (folder: string) =>
      !resourcesDir || !fs.existsSync(resourcesDir) || this.findFolderRecursive(resourcesDir, folder);
    const hasRes = (name: string) =>
      !resourcesDir || !fs.existsSync(resourcesDir) || this.findResourceRecursive(resourcesDir, name);

    // Endpoints — must be at top for txAdmin
    lines.push(
      `## You CAN edit the following:`,
      `endpoint_add_tcp "0.0.0.0:30120"`,
      `endpoint_add_udp "0.0.0.0:30120"`,
      `sv_maxclients 48`,
      `set steam_webApiKey "none"`,
      ``,
    );

    // Server identity
    lines.push(
      `## You MAY edit the following:`,
    );
    if (config.licenseKey) {
      lines.push(`sv_licenseKey "${config.licenseKey}"`);
    }
    lines.push(
      `sv_hostname "${config.name}"`,
      `sets sv_projectName "${config.name}"`,
      `sets sv_projectDesc "Powered by Mercy Launcher"`,
      `sets locale "en-US"`,
      `set onesync on`,
      ``,
    );

    // Database connection — set up automatically by the builder
    if (dbName && config.framework !== 'blank') {
      lines.push(
        `# Database (managed by Mercy Launcher)`,
        `set mysql_connection_string "mysql://root@localhost:3306/${dbName}?charset=utf8mb4"`,
        ``,
      );
    }

    // Base FiveM resources. Qbox replaces basic-gamemode's spawn logic,
    // so the official Qbox cfg does not run it.
    lines.push(
      `# Base FiveM Resources (from cfx-server-data)`,
      `ensure mapmanager`,
      `ensure chat`,
      `ensure spawnmanager`,
      `ensure sessionmanager`,
      ...(config.framework === 'qbox' ? [] : [`ensure basic-gamemode`]),
      `ensure hardcap`,
      `ensure baseevents`,
      ``,
    );

    // Framework-specific config
    if (config.framework === 'qbox') {
      lines.push(
        `# Qbox config`,
        `setr qb_locale "en"`,
        `setr qbx:enableBridge "true"`,
        `set qbx:enableQueue "true"`,
        `set qbx:bucketLockdownMode "inactive"`,
        // NOTE: an empty "" value makes FXServer's cfg parser drop the argument
        // → "[cmd] Argument count mismatch (passed 1, wanted 2)" at boot.
        // Keep empty-valued convars commented out until the user fills them in.
        `# set qbx:discordLink "https://discord.gg/yourserver"`,
        `set qbx:max_jobs_per_player 1`,
        `set qbx:max_gangs_per_player 1`,
        `set qbx:setjob_replaces "true"`,
        `set qbx:setgang_replaces "true"`,
        `set qbx:cleanPlayerGroups "true"`,
        `set qbx:allowMethodOverrides "true"`,
        `set qbx:disableOverrideWarning "false"`,
        `setr qbx:enableVehiclePersistence "false"`,
        `set qbx:acknowledge "true"`,
        `setr qbx:enableGroupManagement "false"`,
        ``,
        `# Ox resources config`,
        `exec ox.cfg`,
        ``,
        `# Resources — official Qbox boot order:`,
        `# ox_lib first, then the framework (oxmysql auto-starts as a`,
        `# qbx_core dependency), then ox_target BEFORE [ox] so ox_inventory`,
        `# finds it, then the resource folders.`,
        `ensure ox_lib`,
        `ensure qbx_core`,
        `ensure ox_target`,
        `ensure [ox]`,
        `ensure [qbx]`,
        `ensure [standalone]`,
        ...(hasFolder('[voice]') ? [`ensure [voice]`] : []),
        ...(hasFolder('[assets]') ? [`ensure [assets]`] : []),
        ...(hasFolder('[npwd-apps]') ? [`ensure [npwd-apps]`] : []),
        ...(hasRes('qbx_npwd') ? [`ensure qbx_npwd`] : []),
        ...(hasRes('npwd') ? [`ensure npwd`] : []),
        ``,
        `## Permissions`,
        `exec permissions.cfg`,
        ``,
      );
    } else if (config.framework === 'esx') {
      // ESX Legacy recipe boot order: database first, then es_extended,
      // then the [esx] resource folders.
      const esxDb = hasRes('oxmysql') ? 'oxmysql' : (hasRes('mysql-async') ? 'mysql-async' : 'oxmysql');
      lines.push(
        `# ESX config`,
        `set es_enableCustomData 1`,
        `set mysql_slow_query_warning 150`,
        ``,
        `# Resources — ESX Legacy boot order`,
        `ensure ${esxDb}`,
        ...(hasRes('ox_lib') ? [`ensure ox_lib`] : []),
        `ensure es_extended`,
        `ensure [esx]`,
        ...(hasFolder('[esx_addons]') ? [`ensure [esx_addons]`] : []),
        ...(hasFolder('[hud]') ? [`ensure [hud]`] : []),
        ...(hasFolder('[standalone]') ? [`ensure [standalone]`] : []),
        ...(hasFolder('[voice]') ? [`ensure [voice]`] : []),
        ``,
      );
    } else if (config.framework === 'qbcore') {
      // Official QBCore recipe boot order — oxmysql auto-starts as a
      // qb-core manifest dependency.
      lines.push(
        `# QB-Core config`,
        `setr qb_locale "en"`,
        ``,
        `# Resources — official QBCore boot order`,
        `ensure qb-core`,
        `ensure [qb]`,
        `ensure [standalone]`,
        ...(hasFolder('[voice]') ? [`ensure [voice]`] : []),
        ...(hasFolder('[defaultmaps]') ? [`ensure [defaultmaps]`] : []),
        ``,
      );
    }

    // Tags based on framework
    const tags = config.framework !== 'custom' && config.framework !== 'blank'
      ? `default, ${config.framework}`
      : 'default';
    lines.push(`sets tags "${tags}"`, ``);

    return lines.join('\n');
  }

  private bufferConsoleLine(serverId: string, line: string) {
    let buf = this.consoleLogs.get(serverId);
    if (!buf) { buf = []; this.consoleLogs.set(serverId, buf); }
    buf.push(line);
    if (buf.length > 2000) buf.splice(0, buf.length - 1500);
  }

  getConsoleLogs(serverId: string): string[] {
    return this.consoleLogs.get(serverId) || [];
  }

  private async downloadGithubResource(
    repoUrl: string, destination: string, ref: string, subpath?: string
  ): Promise<void> {
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/\s]+)/);
    if (!match) throw new Error(`Invalid GitHub URL: ${repoUrl}`);
    const [, owner, repo] = match;
    const repoName = repo.replace(/\.git$/, '');

    console.log(`[Recipe] download_github: ${owner}/${repoName} ref=${ref} subpath=${subpath || 'root'} → ${destination}`);

    // Download ZIP for the specific ref
    const zipUrl = `https://github.com/${owner}/${repoName}/archive/refs/heads/${ref}.zip`;
    let response;
    try {
      response = await axios.get(zipUrl, { responseType: 'arraybuffer', timeout: 120000 });
    } catch {
      // ref might be a commit hash, try that
      const commitUrl = `https://github.com/${owner}/${repoName}/archive/${ref}.zip`;
      response = await axios.get(commitUrl, { responseType: 'arraybuffer', timeout: 120000 });
    }

    const tempDir = os.tmpdir();
    const zipPath = path.join(tempDir, `${repoName}-${Date.now()}.zip`);
    fs.writeFileSync(zipPath, Buffer.from(response.data));

    const extractDir = path.join(tempDir, `${repoName}-extract-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(zipPath, { dir: extractDir });

    // GitHub ZIPs have a single subfolder like "repo-main/"
    const extracted = fs.readdirSync(extractDir);
    let innerDir = extracted.length === 1
      ? path.join(extractDir, extracted[0])
      : extractDir;

    // If subpath specified, only copy that subdirectory
    if (subpath) {
      innerDir = path.join(innerDir, subpath);
      if (!fs.existsSync(innerDir)) {
        console.warn(`[Recipe] subpath "${subpath}" not found in ${repoName}, copying root`);
        innerDir = extracted.length === 1 ? path.join(extractDir, extracted[0]) : extractDir;
      }
    }

    if (!fs.existsSync(destination)) {
      fs.mkdirSync(destination, { recursive: true });
    }
    this.copyDirRecursive(innerDir, destination);

    // Save source URL for future updates
    try {
      fs.writeFileSync(path.join(destination, '.fivem-builder-source'), repoUrl);
    } catch {}

    // Cleanup
    try {
      fs.unlinkSync(zipPath);
      fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {}
  }

  async updateServer(id: string, data: Partial<Server>): Promise<Server | null> {
    const server = this.servers.get(id);
    if (!server) return null;

    const updated = { ...server, ...data, updatedAt: new Date().toISOString() };
    this.servers.set(id, updated);
    this.saveServers();
    return updated;
  }

  /**
   * Import an existing FiveM server from a folder on disk.
   * Auto-detects framework, artifact version, resources, etc.
   */
  async importExistingServer(serverPath: string, name?: string): Promise<{
    success: boolean;
    server?: Server;
    error?: string;
    detected?: {
      framework: string;
      artifactVersion: string;
      resourceCount: number;
      hasServerCfg: boolean;
      hasFXServer: boolean;
    };
  }> {
    try {
      if (!fs.existsSync(serverPath)) {
        return { success: false, error: 'Directory does not exist' };
      }

      // Check if this server is already imported
      for (const [, existing] of this.servers) {
        const existingNorm = path.resolve(existing.installPath).toLowerCase();
        const newNorm = path.resolve(serverPath).toLowerCase();
        if (existingNorm === newNorm) {
          return { success: false, error: `This server is already imported as "${existing.name}"` };
        }
      }

      // ── Detect FXServer.exe ──
      const hasFXServer = fs.existsSync(path.join(serverPath, 'FXServer.exe'))
        || fs.existsSync(path.join(serverPath, 'run.sh'));

      // ── Detect server.cfg ──
      const hasServerCfg = fs.existsSync(path.join(serverPath, 'server.cfg'));

      // ── Detect artifact version ──
      let artifactVersion = 'unknown';
      const versionMarker = path.join(serverPath, '.artifact-version');
      if (fs.existsSync(versionMarker)) {
        artifactVersion = fs.readFileSync(versionMarker, 'utf-8').trim();
      }

      // ── Detect framework from resources ──
      let framework = 'custom';
      const resourcesDir = path.join(serverPath, 'resources');
      if (fs.existsSync(resourcesDir)) {
        // Check for QBCore
        if (this.findResourceRecursive(resourcesDir, 'qb-core')) {
          framework = 'qbcore';
        } else if (this.findResourceRecursive(resourcesDir, 'es_extended')) {
          framework = 'esx';
        }
      }

      // ── Detect server name from server.cfg ──
      let detectedName = name || path.basename(serverPath);
      if (hasServerCfg && !name) {
        try {
          const cfg = fs.readFileSync(path.join(serverPath, 'server.cfg'), 'utf-8');
          const hostnameMatch = cfg.match(/sv_hostname\s+"([^"]+)"/);
          if (hostnameMatch && !hostnameMatch[1].includes('{{')) {
            detectedName = hostnameMatch[1];
          }
        } catch {}
      }

      // ── Count resources ──
      let resourceCount = 0;
      if (fs.existsSync(resourcesDir)) {
        resourceCount = this.countResources(resourcesDir);
      }

      // ── Detect OS ──
      const detectedOS = fs.existsSync(path.join(serverPath, 'FXServer.exe')) ? 'windows' : 'linux';

      // ── Create server entry ──
      const id = this.generateId();
      const server: Server = {
        id,
        name: detectedName,
        framework,
        os: detectedOS,
        database: 'mysql',
        artifactVersion,
        installPath: serverPath,
        resourceCount,
        status: 'stopped',
        lastBackup: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      this.servers.set(id, server);
      this.saveServers();

      return {
        success: true,
        server,
        detected: {
          framework,
          artifactVersion,
          resourceCount,
          hasServerCfg,
          hasFXServer,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Scan an existing server folder WITHOUT importing — just detect what's there.
   */
  async scanExistingServer(serverPath: string): Promise<{
    framework: string;
    artifactVersion: string;
    resourceCount: number;
    hasServerCfg: boolean;
    hasFXServer: boolean;
    serverName: string;
  }> {
    const hasFXServer = fs.existsSync(path.join(serverPath, 'FXServer.exe'))
      || fs.existsSync(path.join(serverPath, 'run.sh'));

    const hasServerCfg = fs.existsSync(path.join(serverPath, 'server.cfg'));

    let artifactVersion = 'unknown';
    const versionMarker = path.join(serverPath, '.artifact-version');
    if (fs.existsSync(versionMarker)) {
      artifactVersion = fs.readFileSync(versionMarker, 'utf-8').trim();
    }

    let framework = 'custom';
    const resourcesDir = path.join(serverPath, 'resources');
    if (fs.existsSync(resourcesDir)) {
      if (this.findResourceRecursive(resourcesDir, 'qb-core')) {
        framework = 'qbcore';
      } else if (this.findResourceRecursive(resourcesDir, 'es_extended')) {
        framework = 'esx';
      }
    }

    let serverName = path.basename(serverPath);
    if (hasServerCfg) {
      try {
        const cfg = fs.readFileSync(path.join(serverPath, 'server.cfg'), 'utf-8');
        const hostnameMatch = cfg.match(/sv_hostname\s+"([^"]+)"/);
        if (hostnameMatch && !hostnameMatch[1].includes('{{')) serverName = hostnameMatch[1];
      } catch {}
    }

    let resourceCount = 0;
    if (fs.existsSync(resourcesDir)) {
      resourceCount = this.countResources(resourcesDir);
    }

    return { framework, artifactVersion, resourceCount, hasServerCfg, hasFXServer, serverName };
  }

  /**
   * Recursively search for a resource directory by name.
   */
  private findResourceRecursive(dir: string, resourceName: string, depth = 0): boolean {
    if (depth > 4) return false;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === resourceName) {
          const manifestPath = path.join(dir, entry.name, 'fxmanifest.lua');
          const resourcePath = path.join(dir, entry.name, '__resource.lua');
          if (fs.existsSync(manifestPath) || fs.existsSync(resourcePath)) {
            return true;
          }
        }
        if (this.findResourceRecursive(path.join(dir, entry.name), resourceName, depth + 1)) {
          return true;
        }
      }
    } catch {}
    return false;
  }

  async deleteServer(id: string): Promise<boolean> {
    const deleted = this.servers.delete(id);
    if (deleted) this.saveServers();
    return deleted;
  }

  /**
   * Start FXServer after initial build for txAdmin first-time setup.
   * Uses server.cfg which has the license key from the wizard.
   */
  private async startServerRaw(id: string): Promise<{ success: boolean; error?: string }> {
    const server = this.servers.get(id);
    if (!server) return { success: false, error: 'Server not found' };

    if (this.processes.has(id)) {
      try { this.processes.get(id)!.kill(); } catch {}
      this.processes.delete(id);
    }

    const executable = server.os === 'windows'
      ? path.join(server.installPath, 'FXServer.exe')
      : path.join(server.installPath, 'run.sh');

    if (!fs.existsSync(executable)) {
      return { success: false, error: `FXServer.exe not found at: ${executable}` };
    }

    // Start without +exec so txAdmin boots as the server manager (web panel on port 40120).
    // txAdmin will handle server.cfg once the user configures it through the web panel.
    const args: string[] = [];

    console.log(`[StartServerRaw] Launching for txAdmin setup: ${executable}`);

    try {
      const proc = spawn(executable, args, {
        cwd: server.installPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
      });

      if (!proc || !proc.pid) {
        return { success: false, error: 'Failed to launch FXServer process.' };
      }

      this.processes.set(id, proc);
      this.consoleLogs.set(id, []);
      server.status = 'running';
      this.saveServers();

      const mainWin = BrowserWindow.getAllWindows()[0];

      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          const line = data.toString();
          this.bufferConsoleLine(id, line);
          if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send('server:console', { serverId: id, line });
          }
        });
      }
      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          const line = data.toString();
          this.bufferConsoleLine(id, `[ERROR] ${line}`);
          if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send('server:console', { serverId: id, line: `[ERROR] ${line}` });
          }
        });
      }

      proc.on('error', (err) => {
        server.status = 'error';
        this.processes.delete(id);
        this.saveServers();
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('server:statusChange', { serverId: id, status: 'error' });
        }
      });

      proc.on('exit', (code, signal) => {
        server.status = 'stopped';
        this.processes.delete(id);
        this.saveServers();
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('server:statusChange', { serverId: id, status: 'stopped' });
        }
      });

      return { success: true };
    } catch (err: any) {
      server.status = 'error';
      this.saveServers();
      return { success: false, error: err.message };
    }
  }

  async startServer(id: string): Promise<{ success: boolean; error?: string }> {
    const server = this.servers.get(id);
    if (!server) {
      console.error(`[StartServer] No server found with id: ${id}`);
      return { success: false, error: `Server not found (id: ${id}). Try removing and re-importing it.` };
    }

    console.log(`[StartServer] Starting "${server.name}" at ${server.installPath}`);

    // Kill existing process if any
    if (this.processes.has(id)) {
      try { this.processes.get(id)!.kill(); } catch {}
      this.processes.delete(id);
    }

    const executable = server.os === 'windows'
      ? path.join(server.installPath, 'FXServer.exe')
      : path.join(server.installPath, 'run.sh');

    if (!fs.existsSync(executable)) {
      console.error(`[StartServer] FXServer.exe not found at: ${executable}`);
      server.status = 'error';
      this.saveServers();
      return { success: false, error: `FXServer.exe not found at:\n${executable}\n\nUse the Resource Updater to download artifacts first.` };
    }

    // Start FXServer WITHOUT +exec so txAdmin boots up as the server manager.
    // txAdmin will read server.cfg on its own once it's been configured.
    // Passing +exec server.cfg bypasses txAdmin entirely (no web panel).
    const args: string[] = [];

    console.log(`[StartServer] Launching (txAdmin mode): ${executable}`);

    try {
      const proc = spawn(executable, args, {
        cwd: server.installPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
      });

      // Check if process spawned successfully
      if (!proc || !proc.pid) {
        console.error('[StartServer] Failed to spawn process — no PID');
        server.status = 'error';
        this.saveServers();
        return { success: false, error: 'Failed to launch FXServer process.' };
      }

      console.log(`[StartServer] FXServer launched with PID: ${proc.pid}`);

      this.processes.set(id, proc);
      this.consoleLogs.set(id, []);
      // Process is up but the server isn't ready yet — txAdmin-style yellow.
      server.status = 'starting';
      this.saveServers();

      const mainWin = BrowserWindow.getAllWindows()[0];
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('server:statusChange', { serverId: id, status: 'starting' });
      }

      // Promote starting → running once console output shows the server is
      // actually up (resources booting / license authenticated / txAdmin ready).
      const READY_RE = /Started resource |All Ready|authentication succeeded|Authenticated with cfx\.re/i;

      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          const line = data.toString();
          this.bufferConsoleLine(id, line);
          if (server.status === 'starting' && READY_RE.test(line)) {
            server.status = 'running';
            this.saveServers();
            if (mainWin && !mainWin.isDestroyed()) {
              mainWin.webContents.send('server:statusChange', { serverId: id, status: 'running' });
            }
          }
          if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send('server:console', { serverId: id, line });
          }
        });
      }
      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          const line = data.toString();
          this.bufferConsoleLine(id, `[ERROR] ${line}`);
          if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send('server:console', { serverId: id, line: `[ERROR] ${line}` });
          }
        });
      }

      proc.on('error', (err) => {
        console.error(`FXServer process error for ${server.name}:`, err);
        server.status = 'error';
        this.processes.delete(id);
        this.saveServers();
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('server:statusChange', { serverId: id, status: 'error' });
        }
      });

      proc.on('exit', (code, signal) => {
        console.log(`FXServer exited for ${server.name}: code=${code}, signal=${signal}`);
        server.status = 'stopped';
        this.processes.delete(id);
        this.saveServers();
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('server:statusChange', { serverId: id, status: 'stopped' });
        }
      });

      return { success: true };
    } catch (err: any) {
      console.error('Failed to start FXServer:', err);
      server.status = 'error';
      this.saveServers();
      return { success: false, error: `Launch error: ${err.message}` };
    }
  }

  async stopServer(id: string): Promise<boolean> {
    const proc = this.processes.get(id);
    const server = this.servers.get(id);

    if (proc) {
      try {
        // On Windows, use taskkill to properly terminate the process tree
        if (process.platform === 'win32' && proc.pid) {
          spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { stdio: 'ignore' });
        } else {
          proc.kill('SIGTERM');
        }
      } catch {}
      this.processes.delete(id);
    }

    if (server) {
      server.status = 'stopped';
      this.saveServers();
    }
    this.consoleLogs.delete(id);
    return true;
  }

  /**
   * Auto-apply known config fixes to an existing server. Runs at app startup
   * for every server and when a server panel opens, so fixes that ship with an
   * app update land on ALREADY-BUILT servers too — no reinstall needed.
   * Every rule is idempotent: once applied, it never matches again.
   * Returns human-readable descriptions of what was changed.
   */
  applyMaintenanceFixes(id: string): string[] {
    const server = this.servers.get(id);
    if (!server || !fs.existsSync(server.installPath)) return [];
    const fixes: string[] = [];

    // Rule 1 — empty "" values in set/sets/setr lines. FXServer's cfg parser
    // drops the empty argument → "[cmd] Argument count mismatch (passed 1,
    // wanted 2)" at every boot. Comment those lines out.
    const cfgFiles = ['server.cfg', 'ox.cfg', 'voice.cfg', 'misc.cfg', 'permissions.cfg'];
    for (const f of cfgFiles) {
      const p = path.join(server.installPath, f);
      if (!fs.existsSync(p)) continue;
      try {
        const lines = fs.readFileSync(p, 'utf-8').split(/\r?\n/);
        let changed = false;
        for (let i = 0; i < lines.length; i++) {
          const t = lines[i].trim();
          if (/^(set|sets|setr)\s+\S+\s+""\s*$/.test(t)) {
            lines[i] = `# ${t}  # auto-fixed by Mercy Launcher — empty "" value causes "Argument count mismatch"`;
            fixes.push(`${f}: commented out "${t}" (empty value breaks the cfg parser)`);
            changed = true;
          }
        }
        if (changed) fs.writeFileSync(p, lines.join('\n'), 'utf-8');
      } catch { /* unreadable cfg — skip */ }
    }

    // Rule 2 — missing sv_projectName/sv_projectDesc (server name gets cut off
    // in the server list; FXServer prints a notice every boot).
    const cfgPath = path.join(server.installPath, 'server.cfg');
    if (fs.existsSync(cfgPath)) {
      try {
        let c = fs.readFileSync(cfgPath, 'utf-8');
        if (!/^\s*sets\s+sv_projectName/m.test(c) && /^\s*sv_hostname\s/m.test(c)) {
          c = c.replace(
            /^(\s*sv_hostname[^\n]*\n)/m,
            `$1sets sv_projectName "${server.name}"\nsets sv_projectDesc "Powered by Mercy Launcher"\n`
          );
          fs.writeFileSync(cfgPath, c, 'utf-8');
          fixes.push('server.cfg: added sv_projectName / sv_projectDesc (server-list name fix)');
        }
      } catch { /* skip */ }
    }

    if (fixes.length > 0) {
      console.log(`[Maintenance] ${server.name}: applied ${fixes.length} fix(es):\n  - ${fixes.join('\n  - ')}`);
    }
    return fixes;
  }

  /** Run maintenance for every registered server (called once at app startup). */
  applyMaintenanceToAll(): Record<string, string[]> {
    const results: Record<string, string[]> = {};
    for (const [id] of this.servers) {
      const fixes = this.applyMaintenanceFixes(id);
      if (fixes.length > 0) results[id] = fixes;
    }
    return results;
  }

  sendCommand(id: string, command: string): boolean {
    const proc = this.processes.get(id);
    if (!proc || !proc.stdin || proc.stdin.destroyed) return false;
    try {
      const cmd = command.trim();
      if (!cmd) return false;
      proc.stdin.write(cmd + '\n');
      // Echo the command into the console stream so the UI shows what ran.
      const echo = `> ${cmd}\n`;
      this.bufferConsoleLine(id, echo);
      const mainWin = BrowserWindow.getAllWindows()[0];
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('server:console', { serverId: id, line: echo });
      }
      return true;
    } catch {
      return false;
    }
  }

  getServerId(serverPath: string): string | null {
    for (const [id, server] of this.servers) {
      if (server.installPath === serverPath) return id;
    }
    return null;
  }

  isRunning(id: string): boolean {
    return this.processes.has(id);
  }
}
