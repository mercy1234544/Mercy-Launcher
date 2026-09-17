import fs from 'fs';
import path from 'path';
import net from 'net';
import axios from 'axios';
import extractZip from 'extract-zip';
import os from 'os';
import { DatabaseManager } from './DatabaseManager';
import { BrowserWindow } from 'electron';

export interface HealthIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  resource?: string;
  file?: string;
  suggestion?: string;
  autoFixable: boolean;
  fixAction?: string;
}

export interface HealthReport {
  serverId?: string;
  timestamp: string;
  issues: HealthIssue[];
  score: number;
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
}

export class HealthScanner {
  private dbManager: DatabaseManager | null = null;
  private fixError = '';
  // Runtime issue ids that were successfully fixed this session — the console
  // buffer still contains the old lines, so scans must not re-report them.
  private resolvedRuntimeIds = new Set<string>();

  setDatabaseManager(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /** Send live fix progress to the renderer (shown in the Health Scanner UI). */
  private sendFixProgress(message: string) {
    console.log(`[HealthFix] ${message}`);
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send('health:fixProgress', { message });
      }
    } catch {}
  }

  // ─── Folder-aware ensure order helpers ─────────────────────────────────
  // Resources often live inside bracket folders (ensure [ox] loads ox_lib,
  // oxmysql, etc). To reason about load order we expand folders to the
  // resources they physically contain on disk.

  /** List all resource names physically inside a bracket folder on disk. */
  private resourcesInFolder(resourcesDir: string, folderName: string): string[] {
    const names: string[] = [];
    const findFolder = (dir: string): string | null => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const full = path.join(dir, entry.name);
          if (entry.name === folderName) return full;
          const found = findFolder(full);
          if (found) return found;
        }
      } catch {}
      return null;
    };
    const folderPath = findFolder(resourcesDir);
    if (!folderPath) return names;

    const collect = (dir: string) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const full = path.join(dir, entry.name);
          if (fs.existsSync(path.join(full, 'fxmanifest.lua')) ||
              fs.existsSync(path.join(full, '__resource.lua'))) {
            names.push(entry.name);
          } else {
            collect(full);
          }
        }
      } catch {}
    };
    collect(folderPath);
    return names;
  }

  /** Read a resource's fxmanifest.lua content ('' if not found). */
  private readResourceManifest(resourcesDir: string, resourceName: string): string {
    if (!resourceName || !fs.existsSync(resourcesDir)) return '';
    const search = (dir: string, depth: number): string | null => {
      if (depth > 4) return null;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const full = path.join(dir, entry.name);
          if (entry.name === resourceName) {
            const manifest = path.join(full, 'fxmanifest.lua');
            if (fs.existsSync(manifest)) return fs.readFileSync(manifest, 'utf-8');
            return null;
          }
          const found = search(full, depth + 1);
          if (found !== null) return found;
        }
      } catch {}
      return null;
    };
    return search(resourcesDir, 0) || '';
  }

  /** Parse ensure/start lines from server.cfg with their line numbers. */
  private parseEnsureLines(lines: string[]): { name: string; lineIdx: number }[] {
    const out: { name: string; lineIdx: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
      const m = trimmed.match(/^(?:ensure|start)\s+(\S+)/);
      if (m) out.push({ name: m[1], lineIdx: i });
    }
    return out;
  }

  /**
   * Effective position of a resource in the load order: its explicit
   * ensure line, or the line of the bracket folder that contains it.
   * Explicit lines win (later explicit ensure re-starts the resource).
   */
  private effectiveLineIdx(
    ensures: { name: string; lineIdx: number }[],
    resourcesDir: string,
    resource: string,
    folderCache: Map<string, string[]>
  ): number {
    // Last explicit ensure wins — a re-ensure later in the file restarts it
    let explicit = -1;
    for (const e of ensures) {
      if (e.name === resource) explicit = e.lineIdx;
    }
    if (explicit > -1) return explicit;

    for (const e of ensures) {
      if (!e.name.startsWith('[')) continue;
      let contents = folderCache.get(e.name);
      if (!contents) {
        contents = this.resourcesInFolder(resourcesDir, e.name);
        folderCache.set(e.name, contents);
      }
      if (contents.includes(resource)) return e.lineIdx;
    }
    return -1;
  }

  async scanServer(serverPath: string, consoleLogs?: string[]): Promise<HealthReport> {
    const issues: HealthIssue[] = [];

    await this.checkServerCfg(serverPath, issues);
    await this.checkBaseResources(serverPath, issues);
    await this.checkResources(serverPath, issues);
    await this.checkDependencies(serverPath, issues);
    await this.checkDuplicates(serverPath, issues);
    await this.checkStartupOrder(serverPath, issues);
    await this.checkDatabase(serverPath, issues);

    if (consoleLogs && consoleLogs.length > 0) {
      this.checkConsoleLogs(consoleLogs, issues);
    }

    // Runtime issues come from the buffered console log — once one is FIXED,
    // the old lines are still in the buffer, so without this filter a rescan
    // would re-report the exact issue the user just fixed ("fix does nothing").
    if (this.resolvedRuntimeIds.size > 0) {
      const filtered = issues.filter((i) => !this.resolvedRuntimeIds.has(i.id));
      issues.length = 0;
      issues.push(...filtered);
    }

    // Deduplicate — if same category+resource appears multiple times, keep the most severe
    const deduped = new Map<string, HealthIssue>();
    for (const issue of issues) {
      const key = `${issue.category}:${issue.resource || issue.id}`;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, issue);
      } else {
        const sevOrder = { error: 0, warning: 1, info: 2 };
        if (sevOrder[issue.severity] < sevOrder[existing.severity]) {
          deduped.set(key, issue);
        }
      }
    }
    issues.length = 0;
    issues.push(...deduped.values());

    const summary = {
      errors: issues.filter(i => i.severity === 'error').length,
      warnings: issues.filter(i => i.severity === 'warning').length,
      info: issues.filter(i => i.severity === 'info').length,
    };

    const maxScore = 100;
    const deductions = summary.errors * 15 + summary.warnings * 5 + summary.info * 1;
    const score = Math.max(0, maxScore - deductions);

    return {
      timestamp: new Date().toISOString(),
      issues,
      score,
      summary,
    };
  }

  private async checkServerCfg(serverPath: string, issues: HealthIssue[]) {
    const cfgPath = path.join(serverPath, 'server.cfg');

    if (!fs.existsSync(cfgPath)) {
      issues.push({
        id: 'missing-server-cfg',
        severity: 'error',
        category: 'Configuration',
        message: 'server.cfg not found',
        suggestion: 'Create a server.cfg file in the server root directory',
        autoFixable: false,
      });
      return;
    }

    const content = fs.readFileSync(cfgPath, 'utf-8');

    // Check for uncommented changeme license key (commented out is fine — txAdmin handles it)
    const hasUncommentedChangeme = content.split('\n').some(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('//')) return false;
      return trimmed.includes('sv_licenseKey') && (trimmed.includes('changeme') || trimmed.includes('change_me'));
    });
    if (hasUncommentedChangeme) {
      issues.push({
        id: 'default-license-key',
        severity: 'error',
        category: 'Configuration',
        message: 'License key has not been set',
        file: cfgPath,
        suggestion: 'Set your FiveM license key from keymaster.fivem.net or use txAdmin to configure it',
        autoFixable: true,
      });
    }

    if (!content.includes('endpoint_add_tcp') && !content.includes('endpoint_add_udp')) {
      issues.push({
        id: 'missing-endpoints',
        severity: 'error',
        category: 'Configuration',
        message: 'No network endpoints configured',
        file: cfgPath,
        suggestion: 'Add endpoint_add_tcp and endpoint_add_udp directives',
        autoFixable: true,
      });
    }

    if (!content.includes('onesync')) {
      issues.push({
        id: 'onesync-not-set',
        severity: 'warning',
        category: 'Configuration',
        message: 'OneSync is not explicitly configured',
        file: cfgPath,
        suggestion: 'Add "set onesync on" to enable OneSync',
        autoFixable: true,
      });
    }
  }

  private async checkBaseResources(serverPath: string, issues: HealthIssue[]) {
    const resourcesPath = path.join(serverPath, 'resources');
    if (!fs.existsSync(resourcesPath)) return;

    const baseResources = [
      'mapmanager', 'chat', 'spawnmanager', 'sessionmanager',
      'basic-gamemode', 'hardcap', 'baseevents',
    ];

    const missing: string[] = [];
    for (const name of baseResources) {
      if (!this.resourceExists(resourcesPath, name)) {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      issues.push({
        id: 'missing-base-resources',
        severity: 'error',
        category: 'Base Resources',
        message: `Missing ${missing.length} base FiveM resources: ${missing.join(', ')}`,
        suggestion: 'Download cfx-server-data base resources (mapmanager, chat, spawnmanager, etc.)',
        autoFixable: true,
      });
    }
  }

  private async checkResources(serverPath: string, issues: HealthIssue[]) {
    const resourcesPath = path.join(serverPath, 'resources');
    if (!fs.existsSync(resourcesPath)) {
      issues.push({
        id: 'missing-resources-dir',
        severity: 'error',
        category: 'Resources',
        message: 'Resources directory not found',
        suggestion: 'Create a resources directory',
        autoFixable: true,
      });
      return;
    }

    await this.scanResourceDir(resourcesPath, issues);
  }

  private async scanResourceDir(dir: string, issues: HealthIssue[]) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const fullPath = path.join(dir, entry.name);
      const fxManifest = path.join(fullPath, 'fxmanifest.lua');
      const oldManifest = path.join(fullPath, '__resource.lua');

      if (fs.existsSync(fxManifest)) {
        await this.checkManifest(fullPath, fxManifest, entry.name, issues);
      } else if (fs.existsSync(oldManifest)) {
        issues.push({
          id: `deprecated-manifest-${entry.name}`,
          severity: 'warning',
          category: 'Resources',
          message: `${entry.name} uses deprecated __resource.lua`,
          resource: entry.name,
          file: oldManifest,
          suggestion: 'Will migrate to fxmanifest.lua (rename + add fx_version/game headers)',
          autoFixable: true,
        });
      } else {
        const hasSubResources = fs.readdirSync(fullPath, { withFileTypes: true })
          .some(e => e.isDirectory());
        if (hasSubResources) {
          await this.scanResourceDir(fullPath, issues);
        }
      }
    }
  }

  private async checkManifest(resourcePath: string, manifestPath: string, name: string, issues: HealthIssue[]) {
    const content = fs.readFileSync(manifestPath, 'utf-8');

    if (!content.includes('fx_version')) {
      issues.push({
        id: `no-fx-version-${name}`,
        severity: 'error',
        category: 'Resources',
        message: `${name}: Missing fx_version directive`,
        resource: name,
        file: manifestPath,
        suggestion: 'Add fx_version \'cerulean\' to the manifest',
        autoFixable: true,
      });
    }

    if (!content.includes('game')) {
      issues.push({
        id: `no-game-${name}`,
        severity: 'error',
        category: 'Resources',
        message: `${name}: Missing game directive`,
        resource: name,
        file: manifestPath,
        suggestion: 'Add game \'gta5\' to the manifest',
        autoFixable: true,
      });
    }

    // Check for referenced files that don't exist
    const clientScripts = this.extractScriptPaths(content, 'client_script');
    const serverScripts = this.extractScriptPaths(content, 'server_script');
    const sharedScripts = this.extractScriptPaths(content, 'shared_script');

    for (const script of [...clientScripts, ...serverScripts, ...sharedScripts]) {
      if (script.includes('*') || script.includes('@')) continue;
      const scriptPath = path.join(resourcePath, script);
      if (!fs.existsSync(scriptPath)) {
        issues.push({
          id: `missing-script-${name}-${script}`,
          severity: 'error',
          category: 'Resources',
          message: `${name}: Referenced script not found: ${script}`,
          resource: name,
          file: manifestPath,
          suggestion: `Create the file ${script} or remove it from the manifest`,
          autoFixable: false,
        });
      }
    }
  }

  private extractScriptPaths(content: string, directive: string): string[] {
    const paths: string[] = [];

    // Strip Lua line comments (-- ...) before parsing to avoid false positives
    const stripped = content.split('\n').map(line => {
      // Remove inline comments: everything after -- that's not inside a string
      // Simple approach: remove lines that are purely comments, and strip trailing comments
      const trimmed = line.trim();
      if (trimmed.startsWith('--')) return ''; // full-line comment
      // For inline comments, be conservative — just return the line as-is
      return line;
    }).join('\n');

    const singlePattern = new RegExp(`${directive}s?\\s+['"]([^'"]+)['"]`, 'g');
    const blockPattern = new RegExp(`${directive}s?\\s*\\{([^}]+)\\}`, 'gs');

    let match;
    while ((match = singlePattern.exec(stripped)) !== null) {
      const p = match[1].trim();
      if (p && !p.startsWith('--') && p.length > 1) {
        paths.push(p);
      }
    }
    while ((match = blockPattern.exec(stripped)) !== null) {
      const blockContent = match[1];
      // Extract quoted strings from the block
      const items = blockContent.matchAll(/['"]([^'"]+)['"]/g);
      for (const item of items) {
        const p = item[1].trim();
        // Skip empty, comment-like, or garbage entries
        if (!p || p.length <= 1) continue;
        if (p.startsWith('--')) continue;
        if (p === ',' || p === ' ') continue;
        // Must look like a file path (has an extension or is a glob)
        if (!p.includes('.') && !p.includes('*') && !p.includes('@')) continue;
        paths.push(p);
      }
    }
    return paths;
  }

  private async checkDependencies(serverPath: string, issues: HealthIssue[]) {
    const cfgPath = path.join(serverPath, 'server.cfg');
    if (!fs.existsSync(cfgPath)) return;

    // Also check additional .cfg files referenced by exec directives
    const cfgFiles = [cfgPath];
    const mainCfg = fs.readFileSync(cfgPath, 'utf-8');
    const execPattern = /^\s*exec\s+["']?(\S+?)["']?\s*$/gm;
    let execMatch;
    while ((execMatch = execPattern.exec(mainCfg)) !== null) {
      const extraCfg = path.join(serverPath, execMatch[1]);
      if (fs.existsSync(extraCfg)) cfgFiles.push(extraCfg);
    }

    const ensuredResources = new Set<string>();

    // Resources truly built into FXServer binary — not in resources/
    const builtinResources = new Set([
      'fivem', 'monitor', 'webpack', 'yarn',
    ]);

    for (const cfgFile of cfgFiles) {
      const cfg = fs.readFileSync(cfgFile, 'utf-8');
      for (const line of cfg.split('\n')) {
        const trimmed = line.trim();
        // Skip comments and empty lines
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
        const match = trimmed.match(/^(?:ensure|start)\s+(\S+)/);
        if (match) ensuredResources.add(match[1]);
      }
    }

    const resourcesPath = path.join(serverPath, 'resources');
    if (!fs.existsSync(resourcesPath)) return;

    for (const resourceName of ensuredResources) {
      // Skip builtin CFX resources
      if (builtinResources.has(resourceName)) continue;

      // Folder-based ensures like [ox], [qbx] — check if the folder exists
      if (resourceName.startsWith('[') && resourceName.endsWith(']')) {
        if (this.folderExists(resourcesPath, resourceName)) continue;
        issues.push({
          id: `missing-resource-folder-${resourceName}`,
          severity: 'warning',
          category: 'Dependencies',
          message: `Resource folder "${resourceName}" is ensured but not found`,
          suggestion: `Will comment out "ensure ${resourceName}" in server.cfg`,
          autoFixable: true,
        });
        continue;
      }

      if (!this.resourceExists(resourcesPath, resourceName)) {
        issues.push({
          id: `missing-resource-${resourceName}`,
          severity: 'error',
          category: 'Dependencies',
          message: `Resource "${resourceName}" is ensured but not found in resources directory`,
          suggestion: `Will comment out "ensure ${resourceName}" in server.cfg (install the resource and re-enable it later)`,
          autoFixable: true,
        });
      }
    }
  }

  private folderExists(resourcesDir: string, folderName: string): boolean {
    // Check direct child
    if (fs.existsSync(path.join(resourcesDir, folderName))) return true;
    // Check nested (e.g. resources/[something]/[folderName])
    try {
      for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (fs.existsSync(path.join(resourcesDir, entry.name, folderName))) return true;
      }
    } catch {}
    return false;
  }

  private resourceExists(resourcesDir: string, name: string): boolean {
    const search = (dir: string): boolean => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === name) {
          const fullPath = path.join(dir, entry.name);
          return fs.existsSync(path.join(fullPath, 'fxmanifest.lua')) ||
                 fs.existsSync(path.join(fullPath, '__resource.lua'));
        }
        const found = search(path.join(dir, entry.name));
        if (found) return true;
      }
      return false;
    };
    return search(resourcesDir);
  }

  private async checkDuplicates(serverPath: string, issues: HealthIssue[]) {
    const resourcesPath = path.join(serverPath, 'resources');
    if (!fs.existsSync(resourcesPath)) return;

    const resourceNames = new Map<string, string[]>();
    this.collectResourceNames(resourcesPath, resourceNames);

    for (const [name, paths] of resourceNames) {
      if (paths.length > 1) {
        issues.push({
          id: `duplicate-${name}`,
          severity: 'warning',
          category: 'Duplicates',
          message: `Resource "${name}" found in multiple locations`,
          resource: name,
          suggestion: `Remove duplicate copies. Found in: ${paths.join(', ')}`,
          autoFixable: false,
        });
      }
    }
  }

  private collectResourceNames(dir: string, map: Map<string, string[]>) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      if (fs.existsSync(path.join(fullPath, 'fxmanifest.lua')) ||
          fs.existsSync(path.join(fullPath, '__resource.lua'))) {
        const existing = map.get(entry.name) || [];
        existing.push(fullPath);
        map.set(entry.name, existing);
      } else {
        this.collectResourceNames(fullPath, map);
      }
    }
  }

  private async checkStartupOrder(serverPath: string, issues: HealthIssue[]) {
    const cfgPath = path.join(serverPath, 'server.cfg');
    if (!fs.existsSync(cfgPath)) return;

    const content = fs.readFileSync(cfgPath, 'utf-8');
    const lines = content.split('\n');
    const ensures = this.parseEnsureLines(lines);
    const resourcesDir = path.join(serverPath, 'resources');
    const folderCache = new Map<string, string[]>();

    const effIdx = (name: string) =>
      this.effectiveLineIdx(ensures, resourcesDir, name, folderCache);

    const frameworks = ['es_extended', 'qb-core', 'qbx_core'];
    const frameworkIdx = Math.max(...frameworks.map(f => effIdx(f)));
    if (frameworkIdx === -1) return; // no framework — nothing to order

    // FXServer auto-starts resources listed as `dependency` in a manifest
    // BEFORE the resource that needs them. qbx_core/qb-core/es_extended all
    // declare oxmysql (and usually ox_lib) — in that case load position in
    // server.cfg doesn't matter and we must not flag it.
    const frameworkName = frameworks.find(f => effIdx(f) === frameworkIdx) || '';
    const fwManifest = this.readResourceManifest(resourcesDir, frameworkName);
    const fwAutoStarts = (dep: string) => fwManifest.includes(dep);

    // oxmysql must load before framework (folder-aware: being inside an
    // [ox] folder that loads before the framework is perfectly fine)
    const oxmysqlIdx = effIdx('oxmysql');
    if (oxmysqlIdx > -1 && oxmysqlIdx > frameworkIdx && !fwAutoStarts('oxmysql')) {
      issues.push({
        id: 'startup-order-mysql',
        severity: 'error',
        category: 'Startup Order',
        message: 'Database (oxmysql) must start before framework',
        suggestion: 'Will move oxmysql above your framework in server.cfg',
        autoFixable: true,
      });
    }

    // ox_lib should load before framework
    const oxlibIdx = effIdx('ox_lib');
    if (oxlibIdx > -1 && oxlibIdx > frameworkIdx && !fwAutoStarts('ox_lib')) {
      issues.push({
        id: 'startup-order-oxlib',
        severity: 'warning',
        category: 'Startup Order',
        message: 'ox_lib should start before framework',
        suggestion: 'Will move ox_lib above your framework in server.cfg',
        autoFixable: true,
      });
    }

    // ox_target must load before ox_inventory (inventory only warns, but
    // targeting silently breaks). When both sit in the same [ox] folder
    // they start alphabetically — inventory first — so this needs an
    // explicit "ensure ox_target" earlier, exactly like the official
    // Qbox cfg does.
    const oxTargetIdx = effIdx('ox_target');
    const oxInvIdx = effIdx('ox_inventory');
    if (oxTargetIdx > -1 && oxInvIdx > -1 && oxTargetIdx >= oxInvIdx) {
      issues.push({
        id: 'startup-order-target-before-inventory',
        severity: 'warning',
        category: 'Startup Order',
        message: 'ox_target must start before ox_inventory',
        resource: 'ox_target',
        suggestion: 'Will add "ensure ox_target" before ox_inventory in server.cfg (official Qbox order)',
        autoFixable: true,
      });
    }

    // Framework resource folders ([qbx]/[qb]/[esx]) must load after framework
    for (const folder of ['[qbx]', '[qb]', '[esx]']) {
      const folderEntry = ensures.find(e => e.name === folder);
      if (folderEntry && folderEntry.lineIdx < frameworkIdx) {
        issues.push({
          id: `startup-order-${folder}`,
          severity: 'error',
          category: 'Startup Order',
          message: `${folder} resources load before framework — move below framework`,
          suggestion: `Will move ensure ${folder} below your framework in server.cfg`,
          autoFixable: true,
        });
      }
    }

    // Framework-dependent ox resources loading before the framework
    // (e.g. ox_doorlock inside [ox] which loads first). The fix is NOT to
    // move [ox] (it holds oxmysql/ox_lib) — it's to add an explicit
    // re-ensure after the framework so they restart once it's up.
    for (const res of ['ox_inventory', 'ox_doorlock']) {
      const idx = effIdx(res);
      if (idx > -1 && idx < frameworkIdx) {
        issues.push({
          id: `startup-order-reensure-${res}`,
          severity: 'warning',
          category: 'Startup Order',
          message: `${res} loads before the framework and will warn "no compatible framework"`,
          resource: res,
          suggestion: `Will add "ensure ${res}" after the framework so it restarts once the framework is loaded`,
          autoFixable: true,
        });
      }
    }
  }

  private async checkDatabase(serverPath: string, issues: HealthIssue[]) {
    const cfgPath = path.join(serverPath, 'server.cfg');
    if (!fs.existsSync(cfgPath)) return;

    const content = fs.readFileSync(cfgPath, 'utf-8');

    // Check if any resource needs a database (oxmysql, mysql-async, etc.)
    const needsDb = content.includes('oxmysql') || content.includes('mysql-async') || content.includes('ghmattimysql');
    if (!needsDb) return;

    // Find mysql_connection_string — check all cfg files including exec'd ones
    let connString = '';
    const allCfgContent = this.getAllCfgContent(serverPath);

    const connMatch = allCfgContent.match(/set\s+mysql_connection_string\s+["']([^"']+)["']/);
    if (connMatch) {
      connString = connMatch[1];
    }

    if (!connString) {
      issues.push({
        id: 'db-no-connection-string',
        severity: 'error',
        category: 'Database',
        message: 'mysql_connection_string is missing from server.cfg',
        suggestion: 'Will set up a local database and add the connection string to server.cfg automatically',
        autoFixable: true,
        fixAction: 'db:connstring',
      });
      return;
    }

    // Parse the connection string
    let host = '127.0.0.1';
    let port = 3306;

    try {
      // Handle mysql:// URI format
      const uriMatch = connString.match(/mysql:\/\/[^@]*@([^/:]+)(?::(\d+))?/);
      if (uriMatch) {
        host = uriMatch[1];
        if (uriMatch[2]) port = parseInt(uriMatch[2]);
      } else {
        // Handle key=value format: host=x;port=y;user=z;password=w;database=d
        const hostMatch = connString.match(/host=([^;]+)/i);
        const portMatch = connString.match(/port=(\d+)/i);
        if (hostMatch) host = hostMatch[1];
        if (portMatch) port = parseInt(portMatch[1]);
      }
    } catch {}

    // TCP ping the database host
    const reachable = await this.tcpPing(host, port, 3000);

    const isLocal = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host.toLowerCase());

    if (!reachable) {
      issues.push({
        id: 'db-unreachable',
        severity: 'error',
        category: 'Database',
        message: `MySQL is not reachable at ${host}:${port}`,
        suggestion: isLocal
          ? 'Will start MySQL/MariaDB automatically — installs a portable MariaDB if none is on this PC'
          : `Make sure MySQL/MariaDB is running on ${host}:${port} — remote databases can't be started from this PC.`,
        autoFixable: isLocal,
        fixAction: isLocal ? 'db:setup' : undefined,
      });
      return;
    }

    // Reachable — also verify the credentials actually work
    if (this.dbManager) {
      const creds = this.dbManager.parseConnectionString(connString);
      const verify = await this.dbManager.verifyCredentials(creds);
      if (!verify.ok) {
        issues.push({
          id: 'db-bad-credentials',
          severity: 'error',
          category: 'Database',
          message: `MySQL is running but the connection failed: ${verify.error}`,
          suggestion: isLocal
            ? 'Will create the database and fix the connection string in server.cfg'
            : 'Check the user, password, and database name in mysql_connection_string',
          autoFixable: isLocal,
          fixAction: isLocal ? 'db:connstring' : undefined,
        });
        return;
      }
    }

    issues.push({
      id: 'db-reachable',
      severity: 'info',
      category: 'Database',
      message: `MySQL is connected and working at ${host}:${port}`,
      autoFixable: false,
    });
  }

  private getAllCfgContent(serverPath: string): string {
    const cfgPath = path.join(serverPath, 'server.cfg');
    if (!fs.existsSync(cfgPath)) return '';

    let content = fs.readFileSync(cfgPath, 'utf-8');

    // Also read exec'd cfg files
    const execPattern = /^\s*exec\s+["']?(\S+?)["']?\s*$/gm;
    let m;
    while ((m = execPattern.exec(content)) !== null) {
      const extraPath = path.join(serverPath, m[1]);
      if (fs.existsSync(extraPath)) {
        try { content += '\n' + fs.readFileSync(extraPath, 'utf-8'); } catch {}
      }
    }
    return content;
  }

  private tcpPing(host: string, port: number, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeout);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, host);
    });
  }

  private checkConsoleLogs(logs: string[], issues: HealthIssue[]) {
    const failedResources: string[] = [];
    const buildPending: string[] = [];
    const scriptErrors: { resource: string; error: string; dep?: string }[] = [];
    let dbConnectionFailed = false;
    let dbConnectionString = '';
    const orderWarnings: { resource: string; needsBefore: string }[] = [];
    const frameworkWarnings: string[] = [];
    const configWarnings: { resource: string; message: string; raw: string }[] = [];
    const seenIds = new Set<string>();

    for (const raw of logs) {
      const line = raw.trim();

      // Failed to start resource
      const failMatch = line.match(/Couldn't start resource (\S+)/i);
      if (failMatch) {
        const name = failMatch[1].replace(/\.$/, '');
        if (!failedResources.includes(name)) failedResources.push(name);
      }

      // Dependency failure
      const depMatch = line.match(/Could not start dependency (\S+) for resource (\S+)/i);
      if (depMatch) {
        const dep = depMatch[1];
        const res = depMatch[2].replace(/\.$/, '');
        if (!failedResources.includes(res)) failedResources.push(res);
        scriptErrors.push({ resource: res, error: `Dependency ${dep} not available`, dep });
      }

      // Build tasks
      const buildMatch = line.match(/Running build tasks on resource (\S+)/);
      if (buildMatch) buildPending.push(buildMatch[1]);
      const buildDone = line.match(/Build tasks completed.*resource (\S+)/);
      if (buildDone) {
        const idx = buildPending.indexOf(buildDone[1]);
        if (idx > -1) buildPending.splice(idx, 1);
      }

      // Script errors
      const scriptErrMatch = line.match(/SCRIPT ERROR: @([^/]+)\/.+?: (.+)/);
      if (scriptErrMatch) {
        const existing = scriptErrors.find(e => e.resource === scriptErrMatch[1]);
        if (!existing) scriptErrors.push({ resource: scriptErrMatch[1], error: scriptErrMatch[2] });
      }

      // Database connection failure
      if (line.includes('ECONNREFUSED') || line.includes('Unable to establish a connection to the database')) {
        dbConnectionFailed = true;
      }
      const connMatch = line.match(/connect ECONNREFUSED ([\d.]+:\d+)/);
      if (connMatch) dbConnectionString = connMatch[1];

      // "Warning: X is not loaded - it should start before Y"
      const orderMatch = line.match(/Warning: (\S+) is not loaded.*should start before (\S+)/);
      if (orderMatch) {
        orderWarnings.push({
          resource: orderMatch[1].replace(/[.,!:;]+$/, ''),
          needsBefore: orderMatch[2].replace(/[.,!:;]+$/, ''),
        });
      }

      // "Warning: no compatible framework was loaded"
      if (line.includes('no compatible framework was loaded')) {
        const bracketMatch = raw.match(/^\[([^\]]+)\]/);
        const src = bracketMatch ? bracketMatch[1].trim().replace(/^script:/, '') : 'unknown';
        if (!frameworkWarnings.includes(src)) frameworkWarnings.push(src);
      }

      // Catch ALL other warnings from scripts — [WARN], Warning:, etc.
      const bracketMatch = raw.match(/^\[([^\]]+)\]/);
      const src = bracketMatch ? bracketMatch[1].trim().replace(/^script:/, '') : '';
      if (src && (
        line.includes('[WARN]') ||
        line.includes('Warning:') ||
        line.includes('warning:')
      )) {
        // Skip ones we already handle specifically
        if (!line.includes('is not loaded') &&
            !line.includes('no compatible framework') &&
            !line.includes('fsevents') &&
            !line.includes('yarn') &&
            !line.includes('uuid@')) {
          configWarnings.push({ resource: src, message: line, raw });
        }
      }

      // Catch "No such export X in resource Y"
      const exportMatch = line.match(/No such export (\S+) in resource (\S+)/);
      if (exportMatch) {
        scriptErrors.push({
          resource: src || 'unknown',
          error: `Missing export "${exportMatch[1]}" from ${exportMatch[2]}`,
          dep: exportMatch[2],
        });
      }
    }

    // Failed resources — auto-fix by restarting
    for (const name of failedResources) {
      const id = `runtime-failed-${name}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      issues.push({
        id,
        severity: 'error',
        category: 'Runtime',
        message: `Resource "${name}" failed to start`,
        resource: name,
        suggestion: `Will restart ${name} on the running server`,
        autoFixable: true,
        fixAction: `restart:${name}`,
      });
    }

    // Script errors
    for (const { resource, error, dep } of scriptErrors) {
      if (failedResources.includes(resource)) continue;
      const id = `runtime-script-error-${resource}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      issues.push({
        id,
        severity: 'error',
        category: 'Runtime',
        message: `Script error in ${resource}: ${error}`,
        resource,
        suggestion: dep ? `Will restart ${resource} after ensuring ${dep} is loaded` : `Will restart ${resource}`,
        autoFixable: true,
        fixAction: dep ? `restart:${dep},${resource}` : `restart:${resource}`,
      });
    }

    // Database — skip if file-based check caught it
    if (dbConnectionFailed) {
      const alreadyCaught = issues.some(i => i.id === 'db-unreachable' || i.id === 'db-no-connection-string');
      if (!alreadyCaught) {
        issues.push({
          id: 'runtime-db-connection',
          severity: 'error',
          category: 'Database',
          message: `Database connection failed${dbConnectionString ? ` (${dbConnectionString})` : ''}`,
          suggestion: 'Will start MySQL/MariaDB automatically — installs a portable MariaDB if none is on this PC',
          autoFixable: true,
          fixAction: 'db:setup',
        });
      }
    }

    // Resource order warnings
    for (const w of orderWarnings) {
      const id = `runtime-order-${w.resource}-before-${w.needsBefore}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      issues.push({
        id,
        severity: 'warning',
        category: 'Startup Order',
        message: `${w.resource} should start before ${w.needsBefore}`,
        resource: w.resource,
        suggestion: `Will reorder server.cfg and restart ${w.needsBefore}`,
        autoFixable: true,
      });
    }

    // Framework warnings
    for (const resource of frameworkWarnings) {
      const id = `runtime-no-framework-${resource}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      issues.push({
        id,
        severity: 'error',
        category: 'Startup Order',
        message: `${resource} loaded before framework — no compatible framework available`,
        resource,
        suggestion: `Will move ${resource} after framework in server.cfg`,
        autoFixable: true,
      });
    }

    // Config/script warnings — auto-fix by finding and editing config or restarting
    for (const w of configWarnings) {
      const id = `runtime-warn-${w.resource}-${w.message.slice(0, 40)}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const cleanMessage = w.message.replace(/^\[([^\]]+)\]\s*/, '').replace(/\[WARN\]\s*/i, '').replace(/Warning:\s*/i, '').trim();

      // Entity blacklist notice: intentional QBox behaviour, and the config is
      // a table of entity names (no enable flag) — nothing to auto-fix. The old
      // "config:" fix always failed, so report it honestly as informational.
      if (w.message.includes('entity blacklist') || w.message.includes('entitiesblacklist')) {
        issues.push({
          id,
          severity: 'info',
          category: 'Runtime',
          message: cleanMessage,
          resource: w.resource,
          suggestion: 'Intentional QBox behaviour — edit resources/[qbx]/qbx_smallresources/qbx_entitiesblacklist/config.lua to change which entities are blocked.',
          autoFixable: false,
        });
        continue;
      }

      issues.push({
        id,
        severity: 'warning',
        category: 'Runtime',
        message: cleanMessage,
        resource: w.resource,
        suggestion: `Will restart ${w.resource}`,
        autoFixable: true,
        fixAction: `restart:${w.resource}`,
      });
    }
  }

  private copyDirRecursive(src: string, dest: string) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Fix an issue and report honestly whether it worked. Returns
   * { success, error } — the renderer must NOT pretend a failed fix
   * succeeded.
   */
  async fixIssue(serverPath: string, issue: HealthIssue, serverManager?: any): Promise<{ success: boolean; error?: string }> {
    this.fixError = '';
    try {
      const ok = await this.doFix(serverPath, issue, serverManager);
      // Fixed runtime issues must not be re-reported from the stale console buffer.
      if (ok && issue.id.startsWith('runtime-')) this.resolvedRuntimeIds.add(issue.id);
      return {
        success: ok,
        error: ok ? undefined : (this.fixError || `No fix could be applied for "${issue.message}" — ${issue.suggestion || 'manual fix needed'}`),
      };
    } catch (err: any) {
      console.error(`[HealthFix] Fix threw for ${issue.id}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  private async doFix(serverPath: string, issue: HealthIssue, serverManager?: any): Promise<boolean> {
    if (!issue.autoFixable) {
      this.fixError = 'This issue is not auto-fixable';
      return false;
    }

    const cfgPath = path.join(serverPath, 'server.cfg');

    // Handle fixAction-based fixes (restart, config edit)
    if (issue.fixAction) {
      return this.executeFixAction(serverPath, issue.fixAction, serverManager);
    }

    // Fix missing endpoints — prepend to start of file (txAdmin requires them at top)
    if (issue.id === 'missing-endpoints') {
      let content = fs.readFileSync(cfgPath, 'utf-8');
      content = `endpoint_add_tcp "0.0.0.0:30120"\nendpoint_add_udp "0.0.0.0:30120"\n\n${content}`;
      fs.writeFileSync(cfgPath, content);
      return true;
    }

    // Fix missing onesync
    if (issue.id === 'onesync-not-set') {
      let content = fs.readFileSync(cfgPath, 'utf-8');
      content += '\nset onesync on\n';
      fs.writeFileSync(cfgPath, content);
      return true;
    }

    // Fix missing resources dir
    if (issue.id === 'missing-resources-dir') {
      fs.mkdirSync(path.join(serverPath, 'resources'), { recursive: true });
      return true;
    }

    // Migrate deprecated __resource.lua to fxmanifest.lua
    if (issue.id.startsWith('deprecated-manifest-') && issue.file) {
      if (!fs.existsSync(issue.file)) {
        this.fixError = `__resource.lua not found at ${issue.file}`;
        return false;
      }
      const dir = path.dirname(issue.file);
      const fxPath = path.join(dir, 'fxmanifest.lua');
      let content = fs.readFileSync(issue.file, 'utf-8');
      // resource_manifest_version is replaced by fx_version
      content = content.split('\n')
        .filter(l => !l.trim().startsWith('resource_manifest_version'))
        .join('\n');
      let header = '';
      if (!/fx_version/.test(content)) header += `fx_version 'cerulean'\n`;
      if (!/^\s*games?\s/m.test(content)) header += `game 'gta5'\n`;
      fs.writeFileSync(fxPath, header + (header ? '\n' : '') + content, 'utf-8');
      fs.unlinkSync(issue.file);
      this.sendFixProgress(`Migrated ${issue.resource || path.basename(dir)} to fxmanifest.lua`);
      return true;
    }

    // Missing resource that's still ensured — comment out the ensure line
    if (issue.id.startsWith('missing-resource-')) {
      const resName = issue.id
        .replace('missing-resource-folder-', '')
        .replace('missing-resource-', '');
      // server.cfg + any exec'd cfg files
      const cfgFiles = [cfgPath];
      if (fs.existsSync(cfgPath)) {
        const mainCfg = fs.readFileSync(cfgPath, 'utf-8');
        const execPattern = /^\s*exec\s+["']?(\S+?)["']?\s*$/gm;
        let m;
        while ((m = execPattern.exec(mainCfg)) !== null) {
          const extra = path.join(serverPath, m[1]);
          if (fs.existsSync(extra)) cfgFiles.push(extra);
        }
      }
      let commented = false;
      for (const file of cfgFiles) {
        if (!fs.existsSync(file)) continue;
        const lines = fs.readFileSync(file, 'utf-8').split('\n');
        let changed = false;
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].trim().match(/^(?:ensure|start)\s+(\S+)/);
          if (m && m[1] === resName) {
            lines[i] = `# ${lines[i].trim()}  # disabled by Health Scanner — resource not installed`;
            changed = true;
            commented = true;
          }
        }
        if (changed) fs.writeFileSync(file, lines.join('\n'), 'utf-8');
      }
      if (!commented) {
        this.fixError = `Could not find an "ensure ${resName}" line to disable`;
        return false;
      }
      this.sendFixProgress(`Disabled "ensure ${resName}" — resource is not installed`);
      return true;
    }

    // Fix missing fx_version in manifest
    if (issue.id.startsWith('no-fx-version-') && issue.file) {
      let content = fs.readFileSync(issue.file, 'utf-8');
      content = `fx_version 'cerulean'\n${content}`;
      fs.writeFileSync(issue.file, content);
      return true;
    }

    // Fix missing game directive in manifest
    if (issue.id.startsWith('no-game-') && issue.file) {
      let content = fs.readFileSync(issue.file, 'utf-8');
      if (content.includes('fx_version')) {
        content = content.replace(/(fx_version\s+['"][^'"]+['"])\n?/, `$1\ngame 'gta5'\n`);
      } else {
        content = `game 'gta5'\n${content}`;
      }
      fs.writeFileSync(issue.file, content);
      return true;
    }

    // Fix startup order — move resource before/after framework in server.cfg
    if (issue.id.startsWith('startup-order-')) {
      if (!fs.existsSync(cfgPath)) return false;
      return this.fixStartupOrder(cfgPath, issue);
    }

    // Fix runtime resource order issues detected from console.
    // Fix the cfg for next boot AND apply live to the running server.
    if (issue.id.startsWith('runtime-order-') || issue.id.startsWith('runtime-no-framework-')) {
      if (!fs.existsSync(cfgPath)) return false;
      const fixed = this.fixRuntimeOrder(cfgPath, issue);
      if (fixed && serverManager) {
        const serverId = serverManager.getServerId(serverPath);
        if (serverId && serverManager.isRunning(serverId)) {
          const orderMatch = issue.id.match(/^runtime-order-(.+)-before-(.+)$/);
          const toRestart = orderMatch ? [orderMatch[1], orderMatch[2]]
            : issue.resource ? [issue.resource] : [];
          for (const res of toRestart) {
            console.log(`[HealthFix] Live-restarting ${res} in correct order`);
            serverManager.sendCommand(serverId, `ensure ${res}`);
          }
        }
      }
      return fixed;
    }

    // Fix failed resources — add comment with restart hint
    if (issue.id.startsWith('runtime-failed-')) {
      // Nothing to change in files — this is a restart-needed situation
      console.log(`[HealthFix] Resource ${issue.resource} failed at runtime — restart server to retry`);
      return true;
    }

    // Fix script errors from load order
    if (issue.id.startsWith('runtime-script-error-') && issue.resource) {
      if (!fs.existsSync(cfgPath)) return false;
      return this.fixRuntimeOrder(cfgPath, issue);
    }

    // Fix missing base resources — download cfx-server-data
    if (issue.id === 'missing-base-resources') {
      const resourcesDir = path.join(serverPath, 'resources');
      const cfxDefaultDir = path.join(resourcesDir, '[cfx-default]');
      try {
        const zipUrl = 'https://github.com/citizenfx/cfx-server-data/archive/refs/heads/master.zip';
        const response = await axios.get(zipUrl, { responseType: 'arraybuffer', timeout: 120000 });
        const tempDir = os.tmpdir();
        const zipPath = path.join(tempDir, `cfx-server-data-${Date.now()}.zip`);
        fs.writeFileSync(zipPath, Buffer.from(response.data));

        const extractDir = path.join(tempDir, `cfx-data-extract-${Date.now()}`);
        fs.mkdirSync(extractDir, { recursive: true });
        await extractZip(zipPath, { dir: extractDir });

        const extracted = fs.readdirSync(extractDir);
        let innerDir = extracted.length === 1
          ? path.join(extractDir, extracted[0], 'resources')
          : path.join(extractDir, 'resources');

        if (fs.existsSync(innerDir)) {
          if (!fs.existsSync(cfxDefaultDir)) fs.mkdirSync(cfxDefaultDir, { recursive: true });
          this.copyDirRecursive(innerDir, cfxDefaultDir);
          console.log('[HealthFix] Downloaded cfx-server-data base resources');
        }

        try { fs.unlinkSync(zipPath); } catch {}
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
        return true;
      } catch (err: any) {
        console.error('[HealthFix] Failed to download cfx-server-data:', err.message);
        return false;
      }
    }

    // Fix default license key
    if (issue.id === 'default-license-key') {
      if (!fs.existsSync(cfgPath)) return false;
      let content = fs.readFileSync(cfgPath, 'utf-8');
      content = content.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || trimmed.startsWith('//')) return line;
        if (trimmed.includes('sv_licenseKey') && (trimmed.includes('changeme') || trimmed.includes('change_me'))) {
          return `# ${line.trimStart()} # Removed by Health Scanner — set via txAdmin`;
        }
        return line;
      }).join('\n');
      fs.writeFileSync(cfgPath, content, 'utf-8');
      return true;
    }

    return false;
  }

  /**
   * Get the database running (start service / portable MariaDB, installing
   * it if needed), secure root, create the server's database, create a
   * DEDICATED least-privilege user for it, and rewrite server.cfg's
   * connection string to those real credentials.
   *
   * REAL PRODUCTION BUG THIS FIXES: this used to call createDatabase(dbName)
   * and buildConnectionString(dbName) with no credentials at all, which
   * default to root with a BLANK password — writing exactly the
   * "root@localhost with no password" connection string the task's own
   * bug report names, from the Health Scanner's own "auto-fix" action (the
   * very thing every other message in this file tells the user to run).
   * Now routed through the same setupDatabaseForServer() orchestration
   * ServerManager.createServer() uses, so there is exactly one place that
   * knows how to provision a database safely.
   */
  private async fixDatabase(serverPath: string, rewriteConnString: boolean): Promise<boolean> {
    if (!this.dbManager) {
      this.fixError = 'Database manager is not available';
      return false;
    }

    // Work out the database name — from the existing connection string,
    // falling back to the server folder name
    const allCfg = this.getAllCfgContent(serverPath);
    const connMatch = allCfg.match(/set\s+mysql_connection_string\s+["']([^"']+)["']/);
    let dbName = '';
    if (connMatch) {
      const creds = this.dbManager.parseConnectionString(connMatch[1]);
      if (creds.database) dbName = creds.database.split('?')[0];
    }
    if (!dbName) {
      dbName = path.basename(serverPath).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60) || 'fivem';
    }

    this.sendFixProgress('Checking for MySQL/MariaDB...');
    const setup = await this.dbManager.setupDatabaseForServer(dbName, (msg) => this.sendFixProgress(msg));
    if (!setup.success || !setup.serverCreds) {
      this.fixError = `Database setup failed: ${setup.error}`;
      console.error('[HealthFix] Database setup failed:', setup.error);
      return false;
    }
    this.sendFixProgress(`Database "${dbName}" ready with a dedicated user (${setup.method})`);

    if (rewriteConnString || !connMatch) {
      const cfgPath = path.join(serverPath, 'server.cfg');
      if (!fs.existsSync(cfgPath)) return false;
      let content = fs.readFileSync(cfgPath, 'utf-8');
      const newLine = `set mysql_connection_string "${this.dbManager.buildConnectionString(dbName, setup.serverCreds)}"`;
      if (/^\s*set\s+mysql_connection_string\s+.*$/m.test(content)) {
        content = content.replace(/^\s*set\s+mysql_connection_string\s+.*$/m, newLine);
      } else {
        content = `# Database (added by Health Scanner)\n${newLine}\n\n${content}`;
      }
      fs.writeFileSync(cfgPath, content, 'utf-8');
      console.log(`[HealthFix] Wrote connection string for database "${dbName}" to server.cfg`);
    }
    return true;
  }

  private async executeFixAction(serverPath: string, fixAction: string, serverManager?: any): Promise<boolean> {
    // Database fixes — start/install MySQL, create DB, fix connection string
    if (fixAction === 'db:setup') return this.fixDatabase(serverPath, false);
    if (fixAction === 'db:connstring') return this.fixDatabase(serverPath, true);

    // "restart:resource1,resource2" — restart resources on the running server
    if (fixAction.startsWith('restart:')) {
      const resources = fixAction.slice(8).split(',');
      if (!serverManager) {
        this.fixError = 'Cannot restart resources — server manager unavailable';
        return false;
      }
      const serverId = serverManager.getServerId(serverPath);
      if (!serverId || !serverManager.isRunning(serverId)) {
        console.log('[HealthFix] Server not running — restart resources will apply on next boot');
        return true;
      }
      for (const res of resources) {
        console.log(`[HealthFix] Restarting resource: ${res}`);
        serverManager.sendCommand(serverId, `ensure ${res}`);
      }
      return true;
    }

    // "config:resource:key:value" — edit a Lua config file
    if (fixAction.startsWith('config:')) {
      const parts = fixAction.split(':');
      if (parts.length < 4) return false;
      const [, resource, key, value] = parts;
      return this.fixLuaConfig(serverPath, resource, key, value);
    }

    return false;
  }

  private fixLuaConfig(serverPath: string, resource: string, key: string, value: string): boolean {
    const resourcesDir = path.join(serverPath, 'resources');
    const configPath = this.findConfigFile(resourcesDir, resource, key);
    if (!configPath) {
      this.fixError = `Could not find a config file in ${resource} containing "${key}"`;
      console.log(`[HealthFix] Could not find config for ${resource} with key ${key}`);
      return false;
    }

    try {
      let content = fs.readFileSync(configPath, 'utf-8');

      // Try to find the key in various Lua config patterns:
      // Config.key = value / Config['key'] = value / key = value
      const patterns = [
        new RegExp(`(Config\\.${this.escapeRegex(key)}\\s*=\\s*)([^,\\n]+)`, 'i'),
        new RegExp(`(Config\\['${this.escapeRegex(key)}'\\]\\s*=\\s*)([^,\\n]+)`, 'i'),
        new RegExp(`(Config\\["${this.escapeRegex(key)}"\\]\\s*=\\s*)([^,\\n]+)`, 'i'),
        new RegExp(`(\\b${this.escapeRegex(key)}\\s*=\\s*)([^,\\n]+)`, 'i'),
        new RegExp(`(EnableBlacklist\\s*=\\s*)([^,\\n]+)`, 'i'),
      ];

      let replaced = false;
      for (const pat of patterns) {
        if (pat.test(content)) {
          content = content.replace(pat, `$1${value}`);
          replaced = true;
          break;
        }
      }

      if (replaced) {
        fs.writeFileSync(configPath, content, 'utf-8');
        console.log(`[HealthFix] Updated ${configPath}: ${key} = ${value}`);
        return true;
      }

      console.log(`[HealthFix] Key "${key}" not found in ${configPath}`);
      return false;
    } catch (err: any) {
      console.error(`[HealthFix] Failed to edit config: ${err.message}`);
      return false;
    }
  }

  private findConfigFile(resourcesDir: string, resource: string, key: string): string | null {
    const search = (dir: string): string | null => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const fullPath = path.join(dir, entry.name);

          if (entry.name === resource) {
            // Found the resource — look for config files
            for (const cfgFile of ['config.lua', 'shared/config.lua', 'config/config.lua', 'shared.lua']) {
              const cfgPath = path.join(fullPath, cfgFile);
              if (fs.existsSync(cfgPath)) {
                const content = fs.readFileSync(cfgPath, 'utf-8');
                if (content.toLowerCase().includes(key.toLowerCase())) {
                  return cfgPath;
                }
              }
            }
            // Also check all .lua files in the resource root
            try {
              for (const f of fs.readdirSync(fullPath)) {
                if (!f.endsWith('.lua')) continue;
                const fPath = path.join(fullPath, f);
                if (fs.statSync(fPath).isFile()) {
                  const content = fs.readFileSync(fPath, 'utf-8');
                  if (content.toLowerCase().includes(key.toLowerCase())) {
                    return fPath;
                  }
                }
              }
            } catch {}
            return null;
          }

          // Check subdirectory resources (inside [folders])
          const found = search(fullPath);
          if (found) return found;
        }
      } catch {}
      return null;
    };
    return search(resourcesDir);
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Line index of the last framework-block ensure (framework itself plus
   *  its resource folders) — re-ensures go after this point. */
  private frameworkBlockEnd(lines: string[]): number {
    const frameworks = ['es_extended', 'qb-core', 'qbx_core'];
    const frameworkFolders = ['[qbx]', '[qb]', '[esx]', '[standalone]'];
    let end = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(/^(?:ensure|start)\s+(\S+)/);
      if (m && (frameworks.includes(m[1]) || frameworkFolders.includes(m[1]))) {
        end = i;
      }
    }
    return end;
  }

  private findFrameworkLine(lines: string[]): number {
    const frameworks = ['es_extended', 'qb-core', 'qbx_core'];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(/^(?:ensure|start)\s+(\S+)/);
      if (m && frameworks.includes(m[1])) return i;
    }
    return -1;
  }

  /**
   * Guarantee `resource` loads before/after the given anchor line.
   * If the resource has an explicit ensure line, move it. If it only loads
   * via a bracket folder (or isn't ensured at all), INSERT an explicit
   * ensure line — for "after", a later re-ensure restarts the resource at
   * the right time, which is the only way to reorder a folder resource
   * without breaking its siblings.
   */
  private placeResource(cfgPath: string, lines: string[], resource: string, direction: 'before' | 'after', anchorIdx: number): boolean {
    if (anchorIdx < 0 || anchorIdx >= lines.length) return false;

    // Find resource's explicit ensure line (last occurrence wins)
    let sourceIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(/^(?:ensure|start)\s+(\S+)/);
      if (m && m[1] === resource) sourceIdx = i;
    }

    if (sourceIdx > -1) {
      // Already in the right place?
      if (direction === 'before' && sourceIdx < anchorIdx) return true;
      if (direction === 'after' && sourceIdx > anchorIdx) return true;
      const sourceLine = lines[sourceIdx];
      lines.splice(sourceIdx, 1);
      if (sourceIdx < anchorIdx) anchorIdx--;
      const insertIdx = direction === 'before' ? anchorIdx : anchorIdx + 1;
      lines.splice(insertIdx, 0, sourceLine);
      fs.writeFileSync(cfgPath, lines.join('\n'), 'utf-8');
      console.log(`[HealthFix] Moved "ensure ${resource}" ${direction} line ${anchorIdx + 1} in server.cfg`);
      return true;
    }

    // No explicit line — insert one (resource loads via a bracket folder)
    const insertIdx = direction === 'before' ? anchorIdx : anchorIdx + 1;
    lines.splice(insertIdx, 0, `# load order fix (Health Scanner)`, `ensure ${resource}`);
    fs.writeFileSync(cfgPath, lines.join('\n'), 'utf-8');
    console.log(`[HealthFix] Inserted "ensure ${resource}" ${direction} line ${anchorIdx + 1} in server.cfg`);
    return true;
  }

  private fixStartupOrder(cfgPath: string, issue: HealthIssue): boolean {
    const lines = fs.readFileSync(cfgPath, 'utf-8').split('\n');
    const frameworkIdx = this.findFrameworkLine(lines);
    if (frameworkIdx === -1) return false;

    // "[qbx]"/"[qb]"/"[esx]" folder before framework — move it after
    if (issue.id.startsWith('startup-order-[')) {
      const folder = issue.id.replace('startup-order-', '');
      return this.placeResource(cfgPath, lines, folder, 'after', frameworkIdx);
    }

    // oxmysql / ox_lib after framework — move (or insert) before it
    if (issue.id === 'startup-order-mysql') {
      return this.placeResource(cfgPath, lines, 'oxmysql', 'before', frameworkIdx);
    }
    if (issue.id === 'startup-order-oxlib') {
      return this.placeResource(cfgPath, lines, 'ox_lib', 'before', frameworkIdx);
    }

    // Framework-dependent ox resources — re-ensure after the framework block
    if (issue.id.startsWith('startup-order-reensure-') && issue.resource) {
      const blockEnd = this.frameworkBlockEnd(lines);
      return this.placeResource(cfgPath, lines, issue.resource, 'after', blockEnd > -1 ? blockEnd : frameworkIdx);
    }

    // ox_target must be ensured before ox_inventory loads
    if (issue.id === 'startup-order-target-before-inventory') {
      const serverPath = path.dirname(cfgPath);
      const resourcesDir = path.join(serverPath, 'resources');
      const ensures = this.parseEnsureLines(lines);
      const folderCache = new Map<string, string[]>();
      const invIdx = this.effectiveLineIdx(ensures, resourcesDir, 'ox_inventory', folderCache);
      if (invIdx === -1) return false;
      return this.placeResource(cfgPath, lines, 'ox_target', 'before', invIdx);
    }

    return false;
  }

  private fixRuntimeOrder(cfgPath: string, issue: HealthIssue): boolean {
    const lines = fs.readFileSync(cfgPath, 'utf-8').split('\n');
    const serverPath = path.dirname(cfgPath);
    const resourcesDir = path.join(serverPath, 'resources');
    const ensures = this.parseEnsureLines(lines);
    const folderCache = new Map<string, string[]>();

    const effIdx = (name: string) =>
      this.effectiveLineIdx(ensures, resourcesDir, name, folderCache);

    // "runtime-order-X-before-Y" — make X load before Y.
    // Y's anchor is its explicit line OR the folder line that loads it.
    const orderMatch = issue.id.match(/^runtime-order-(.+)-before-(.+)$/);
    if (orderMatch) {
      const [, resourceA, resourceB] = orderMatch;
      const aIdx = effIdx(resourceA);
      const bIdx = effIdx(resourceB);
      // Already ordered correctly (e.g. via a folder ensure)? The warning
      // came from a boot where A failed to start — nothing to reorder.
      if (aIdx > -1 && bIdx > -1 && aIdx < bIdx) return true;
      if (bIdx > -1) {
        return this.placeResource(cfgPath, lines, resourceA, 'before', bIdx);
      }
      return false;
    }

    // "runtime-no-framework-X" — X started before the framework was up.
    // Re-ensure it after the framework block. Never move whole folders —
    // that's what kept breaking [ox] (it holds oxmysql/ox_lib too).
    if (issue.id.startsWith('runtime-no-framework-') && issue.resource) {
      const frameworkIdx = this.findFrameworkLine(lines);
      if (frameworkIdx === -1) return false;
      const blockEnd = this.frameworkBlockEnd(lines);
      return this.placeResource(cfgPath, lines, issue.resource, 'after', blockEnd > -1 ? blockEnd : frameworkIdx);
    }

    return false;
  }
}
