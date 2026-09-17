import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import crypto from 'crypto';
import { spawn, ChildProcess, execFile } from 'child_process';
import { app } from 'electron';
import axios from 'axios';
import extractZip from 'extract-zip';

const MARIADB_VERSION = '11.4.5';
const MARIADB_ZIP_URL = `https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/winx64-packages/mariadb-${MARIADB_VERSION}-winx64.zip`;

// Common Windows service names for MySQL/MariaDB installs
const SERVICE_NAMES = ['MariaDB', 'MySQL', 'MySQL80', 'MySQL57', 'MySQL84', 'mysql', 'mariadb'];

export interface DbSetupResult {
  success: boolean;
  method?: 'already-running' | 'service-started' | 'portable-started' | 'portable-installed';
  error?: string;
  connectionString?: string;
}

export interface DbCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
}

/**
 * Manages a local MySQL/MariaDB database for FiveM servers.
 * Can start existing Windows services, or download and run a fully
 * portable MariaDB so the user never has to install anything manually.
 */
export class DatabaseManager {
  private baseDir: string;
  private mysqldProc: ChildProcess | null = null;
  private secretsFile: string;

  constructor() {
    this.baseDir = path.join(app.getPath('userData'), 'mariadb');
    // Plain JSON under userData/data, same convention as PresenceManager's
    // own generated secret (presence-secret.json) — never electron-store,
    // never committed anywhere, generated once on first use and reused.
    this.secretsFile = path.join(app.getPath('userData'), 'data', 'db-credentials.json');
  }

  // ─── Local credential storage ──────────────────────────────────────────

  private loadSecrets(): Record<string, { user: string; password: string }> {
    try {
      if (fs.existsSync(this.secretsFile)) {
        return JSON.parse(fs.readFileSync(this.secretsFile, 'utf-8'));
      }
    } catch {}
    return {};
  }

  private saveSecret(key: string, creds: { user: string; password: string }) {
    const all = this.loadSecrets();
    all[key] = creds;
    try {
      fs.mkdirSync(path.dirname(this.secretsFile), { recursive: true });
      fs.writeFileSync(this.secretsFile, JSON.stringify(all, null, 2));
    } catch (err: any) {
      console.error('[Database] Failed to persist credentials:', err.message);
    }
  }

  private generatePassword(): string {
    // 24 random bytes -> 32-char base64url, no shell/URI-hostile characters
    // (base64url is already safe for both a mysql:// URI and a raw CLI arg).
    return crypto.randomBytes(24).toString('base64url');
  }

  /** MySQL/MariaDB user identifiers may only be up to 32 characters and
   *  need not clash with any real system account name. */
  private deriveUsername(dbName: string): string {
    return `mercy_${dbName}`.slice(0, 32);
  }

  // ─── Connection helpers ────────────────────────────────────────────────

  tcpPing(host: string, port: number, timeout = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeout);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, host);
    });
  }

  /** Parse a mysql_connection_string (URI or key=value) into credentials. */
  parseConnectionString(connString: string): DbCredentials {
    const creds: DbCredentials = { host: '127.0.0.1', port: 3306, user: 'root', password: '' };
    if (!connString) return creds;

    const uriMatch = connString.match(/mysql:\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^/:?]+)(?::(\d+))?(?:\/([^?]+))?/);
    if (uriMatch) {
      if (uriMatch[1]) creds.user = decodeURIComponent(uriMatch[1]);
      if (uriMatch[2]) creds.password = decodeURIComponent(uriMatch[2]);
      if (uriMatch[3]) creds.host = uriMatch[3];
      if (uriMatch[4]) creds.port = parseInt(uriMatch[4]);
      if (uriMatch[5]) creds.database = uriMatch[5];
      return creds;
    }

    const kv = (key: string) => {
      const m = connString.match(new RegExp(`${key}=([^;]+)`, 'i'));
      return m ? m[1].trim() : undefined;
    };
    creds.host = kv('host') || kv('server') || creds.host;
    creds.port = parseInt(kv('port') || '3306');
    creds.user = kv('user') || kv('userid') || kv('uid') || creds.user;
    creds.password = kv('password') || kv('pwd') || creds.password;
    creds.database = kv('database') || creds.database;
    return creds;
  }

  isLocalHost(host: string): boolean {
    return ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host.toLowerCase());
  }

  buildConnectionString(dbName: string, creds?: Partial<DbCredentials>): string {
    const user = creds?.user || 'root';
    const password = creds?.password || '';
    const host = creds?.host || 'localhost';
    const port = creds?.port || 3306;
    const auth = password ? `${user}:${encodeURIComponent(password)}` : user;
    return `mysql://${auth}@${host}:${port}/${dbName}?charset=utf8mb4`;
  }

  // ─── Service management ────────────────────────────────────────────────

  /** Try to start an already-installed MySQL/MariaDB Windows service. */
  private async tryStartService(): Promise<boolean> {
    for (const name of SERVICE_NAMES) {
      const exists = await new Promise<boolean>((resolve) => {
        execFile('sc', ['query', name], (err, stdout) => {
          resolve(!err && stdout.includes('SERVICE_NAME'));
        });
      });
      if (!exists) continue;

      console.log(`[Database] Found service "${name}" — attempting to start`);
      let started = await new Promise<boolean>((resolve) => {
        execFile('net', ['start', name], (err, stdout, stderr) => {
          // "already been started" also counts as success
          const out = `${stdout}${stderr}`;
          resolve(!err || out.includes('already been started'));
        });
      });

      // Starting services needs admin — retry elevated (shows a UAC prompt)
      if (!started) {
        console.log(`[Database] Plain start failed — retrying "${name}" elevated (UAC)`);
        started = await new Promise<boolean>((resolve) => {
          execFile('powershell', [
            '-NoProfile', '-Command',
            `Start-Process -FilePath net -ArgumentList 'start','${name}' -Verb RunAs -Wait`,
          ], { timeout: 60000 }, (err) => resolve(!err));
        });
      }

      if (started && await this.waitForDb(15000)) return true;
    }
    return false;
  }

  // ─── Portable MariaDB ──────────────────────────────────────────────────

  /** Locate an already-installed portable MariaDB under userData. */
  private findPortable(): { binDir: string; dataDir: string } | null {
    if (!fs.existsSync(this.baseDir)) return null;
    try {
      for (const entry of fs.readdirSync(this.baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const binDir = path.join(this.baseDir, entry.name, 'bin');
        if (fs.existsSync(path.join(binDir, 'mysqld.exe'))) {
          return { binDir, dataDir: path.join(this.baseDir, 'data') };
        }
      }
    } catch {}
    return null;
  }

  private async startPortable(): Promise<boolean> {
    const portable = this.findPortable();
    if (!portable) return false;
    if (this.mysqldProc && !this.mysqldProc.killed) {
      return this.waitForDb(5000);
    }

    // Initialize data directory if it doesn't exist yet
    if (!fs.existsSync(path.join(portable.dataDir, 'mysql'))) {
      console.log('[Database] Initializing MariaDB data directory...');
      const installDb = path.join(portable.binDir, 'mariadb-install-db.exe');
      // REAL PRODUCTION BUG THIS FIXES: mariadb-install-db.exe's default
      // root account (10.4+) authenticates via the "unix_socket"/named-pipe
      // plugin, not a password — a normal TCP client library (mysql2, which
      // oxmysql and this whole manager use) can NEVER satisfy that, so every
      // connection as root failed with exactly "Access denied for user
      // 'root'@'localhost' (using password: NO)" regardless of what password
      // was supplied. --auth-root-authentication-method=normal makes root a
      // real password-authenticated account from the moment the data
      // directory is created, which is what makes ensureRootSecured() below
      // able to actually set and use a real root password at all.
      const initOk = await new Promise<boolean>((resolve) => {
        execFile(installDb, [
          `--datadir=${portable.dataDir}`,
          '--auth-root-authentication-method=normal',
        ], { timeout: 120000 }, (err) => {
          resolve(!err);
        });
      });
      if (!initOk || !fs.existsSync(path.join(portable.dataDir, 'mysql'))) {
        console.error('[Database] mariadb-install-db failed');
        return false;
      }
    }

    console.log('[Database] Starting portable MariaDB (mysqld)...');
    try {
      const proc = spawn(path.join(portable.binDir, 'mysqld.exe'), [
        `--datadir=${portable.dataDir}`,
        '--port=3306',
        '--bind-address=127.0.0.1',
        '--console',
      ], {
        cwd: portable.binDir,
        stdio: 'ignore',
        detached: false,
        windowsHide: true,
      });
      if (!proc.pid) return false;
      this.mysqldProc = proc;
      proc.on('exit', () => { this.mysqldProc = null; });
    } catch (err: any) {
      console.error('[Database] Failed to spawn mysqld:', err.message);
      return false;
    }

    return this.waitForDb(30000);
  }

  /** Download and extract portable MariaDB into userData. */
  private async installPortable(onProgress?: (msg: string, pct: number) => void): Promise<boolean> {
    try {
      onProgress?.('Downloading MariaDB (~90 MB)...', 0);
      console.log(`[Database] Downloading ${MARIADB_ZIP_URL}`);

      const response = await axios.get(MARIADB_ZIP_URL, {
        responseType: 'arraybuffer',
        timeout: 600000,
        maxRedirects: 5,
        onDownloadProgress: (e) => {
          if (e.total) {
            const pct = Math.round((e.loaded / e.total) * 100);
            onProgress?.(`Downloading MariaDB: ${pct}%`, pct);
          }
        },
      });

      const zipPath = path.join(os.tmpdir(), `mariadb-${Date.now()}.zip`);
      fs.writeFileSync(zipPath, Buffer.from(response.data));

      onProgress?.('Extracting MariaDB...', 100);
      if (!fs.existsSync(this.baseDir)) fs.mkdirSync(this.baseDir, { recursive: true });
      await extractZip(zipPath, { dir: this.baseDir });
      try { fs.unlinkSync(zipPath); } catch {}

      return this.findPortable() !== null;
    } catch (err: any) {
      console.error('[Database] Portable install failed:', err.message);
      return false;
    }
  }

  private async waitForDb(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.tcpPing('127.0.0.1', 3306, 1500)) return true;
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }

  // ─── Main entry points ─────────────────────────────────────────────────

  /**
   * Make sure a MySQL-compatible database is running on localhost:3306.
   * Tries (in order): already running → existing Windows service →
   * portable MariaDB we manage → download + install portable MariaDB.
   */
  async ensureRunning(allowInstall: boolean, onProgress?: (msg: string, pct: number) => void): Promise<DbSetupResult> {
    if (await this.tcpPing('127.0.0.1', 3306)) {
      return { success: true, method: 'already-running' };
    }

    onProgress?.('Checking for an installed MySQL/MariaDB service...', 0);
    if (await this.tryStartService()) {
      return { success: true, method: 'service-started' };
    }

    if (this.findPortable()) {
      onProgress?.('Starting bundled MariaDB...', 0);
      if (await this.startPortable()) {
        return { success: true, method: 'portable-started' };
      }
    }

    if (!allowInstall) {
      return { success: false, error: 'MySQL is not running and no installed database was found' };
    }

    if (!(await this.installPortable(onProgress))) {
      return { success: false, error: 'Failed to download portable MariaDB' };
    }

    onProgress?.('Initializing and starting MariaDB...', 100);
    if (await this.startPortable()) {
      return { success: true, method: 'portable-installed' };
    }
    return { success: false, error: 'MariaDB installed but failed to start' };
  }

  /** Create the database if it doesn't exist. Returns true on success. */
  async createDatabase(dbName: string, creds?: Partial<DbCredentials>): Promise<boolean> {
    try {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({
        host: creds?.host || '127.0.0.1',
        port: creds?.port || 3306,
        user: creds?.user || 'root',
        password: creds?.password || '',
        connectTimeout: 10000,
      });
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName.replace(/[^a-zA-Z0-9_]/g, '_')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await conn.end();
      console.log(`[Database] Database "${dbName}" ready`);
      return true;
    } catch (err: any) {
      console.error('[Database] createDatabase failed:', err.message);
      return false;
    }
  }

  /** Run a .sql file (framework schema) against a database. */
  async importSqlFile(dbName: string, sqlPath: string, creds?: Partial<DbCredentials>): Promise<boolean> {
    try {
      if (!fs.existsSync(sqlPath)) {
        console.error(`[Database] SQL file not found: ${sqlPath}`);
        return false;
      }
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      return this.importSql(dbName, sql, creds);
    } catch (err: any) {
      console.error('[Database] importSqlFile failed:', err.message);
      return false;
    }
  }

  /** Run raw SQL (possibly many statements) against a database. */
  async importSql(dbName: string, sql: string, creds?: Partial<DbCredentials>): Promise<boolean> {
    try {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({
        host: creds?.host || '127.0.0.1',
        port: creds?.port || 3306,
        user: creds?.user || 'root',
        password: creds?.password || '',
        database: dbName,
        multipleStatements: true,
        connectTimeout: 10000,
      });
      await conn.query(sql);
      await conn.end();
      console.log(`[Database] Imported SQL into "${dbName}" (${sql.length} chars)`);
      return true;
    } catch (err: any) {
      console.error('[Database] importSql failed:', err.message);
      return false;
    }
  }

  /** Verify credentials actually work (not just TCP reachable). */
  async verifyCredentials(creds: DbCredentials): Promise<{ ok: boolean; error?: string }> {
    try {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({
        host: creds.host,
        port: creds.port,
        user: creds.user,
        password: creds.password,
        database: creds.database,
        connectTimeout: 8000,
      });
      await conn.query('SELECT 1');
      await conn.end();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // ─── Credential security (never root@localhost with no password) ───────

  /**
   * Make sure root has a REAL password instead of the fresh-install default
   * of "no password" (or, before the auth-method fix above, an unusable
   * unix_socket-only account). Idempotent: once secured, the generated
   * password is persisted and reused on every later call instead of being
   * rotated, so it never invalidates credentials already handed out.
   */
  async ensureRootSecured(): Promise<{ success: boolean; creds?: DbCredentials; error?: string }> {
    const stored = this.loadSecrets().__root__;
    if (stored) {
      const creds: DbCredentials = { host: '127.0.0.1', port: 3306, user: stored.user, password: stored.password };
      const verify = await this.verifyCredentials(creds);
      if (verify.ok) return { success: true, creds };
      // Stored password no longer works (e.g. a different MySQL/MariaDB
      // install now owns this port) — fall through and try to re-secure.
    }

    // A fresh portable install has root@localhost with a blank password
    // (now via normal auth, not unix_socket — see the install-db fix
    // above). Use that one-time window to set a real password.
    const blankRootCreds: DbCredentials = { host: '127.0.0.1', port: 3306, user: 'root', password: '' };
    const blankWorks = await this.verifyCredentials(blankRootCreds);
    if (!blankWorks.ok) {
      // Not a fresh install we control (e.g. a pre-existing Windows
      // MySQL/MariaDB service with its own real root password) — never
      // guess or brute-force it. Report honestly so the caller can surface
      // a real "can't secure this database automatically" message.
      return { success: false, error: `Could not authenticate as root to secure this database: ${blankWorks.error}` };
    }

    const password = this.generatePassword();
    try {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: '', connectTimeout: 8000 });
      await conn.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY ?`, [password]);
      await conn.query('FLUSH PRIVILEGES');
      await conn.end();
    } catch (err: any) {
      return { success: false, error: `Failed to set a root password: ${err.message}` };
    }

    const creds: DbCredentials = { host: '127.0.0.1', port: 3306, user: 'root', password };
    this.saveSecret('__root__', { user: 'root', password });
    return { success: true, creds };
  }

  /**
   * Create (or reuse) a dedicated, least-privilege database user for ONE
   * specific server's database — never root, never a shared account.
   * Idempotent: a previously-created user for the same dbName is reused
   * (verified, not blindly trusted) rather than rotated on every rebuild.
   */
  async createServerCredentials(dbName: string, adminCreds: DbCredentials): Promise<{ success: boolean; creds?: DbCredentials; error?: string }> {
    const safeDbName = dbName.replace(/[^a-zA-Z0-9_]/g, '_');
    const existing = this.loadSecrets()[safeDbName];
    if (existing) {
      const creds: DbCredentials = { host: '127.0.0.1', port: 3306, user: existing.user, password: existing.password, database: safeDbName };
      const verify = await this.verifyCredentials(creds);
      if (verify.ok) return { success: true, creds };
      // Fall through and re-create — e.g. the database was wiped/recreated.
    }

    const user = this.deriveUsername(safeDbName);
    const password = this.generatePassword();
    try {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({
        host: adminCreds.host, port: adminCreds.port, user: adminCreds.user, password: adminCreds.password,
        connectTimeout: 10000,
      });
      // Least privilege: only this one database, never GRANT ALL globally
      // and never the root account itself for the server's own connection.
      await conn.query(`CREATE USER IF NOT EXISTS ?@'localhost' IDENTIFIED BY ?`, [user, password]);
      await conn.query(`ALTER USER ?@'localhost' IDENTIFIED BY ?`, [user, password]);
      await conn.query(`GRANT ALL PRIVILEGES ON \`${safeDbName}\`.* TO ?@'localhost'`, [user]);
      await conn.query('FLUSH PRIVILEGES');
      await conn.end();
    } catch (err: any) {
      return { success: false, error: `Failed to create a dedicated database user: ${err.message}` };
    }

    const creds: DbCredentials = { host: '127.0.0.1', port: 3306, user, password, database: safeDbName };
    this.saveSecret(safeDbName, { user, password });
    return { success: true, creds };
  }

  /**
   * The single high-level entry point a server build/health-fix should
   * call: get a real database running, secure root, create the server's
   * own database, create a dedicated least-privilege user for it, and
   * prove the connection actually works BEFORE reporting success — this is
   * what makes "database connection tested before FiveM starts" possible
   * upstream. Returns adminCreds (root, for schema imports) and serverCreds
   * (the dedicated user — the ONLY credential that belongs in server.cfg).
   */
  async setupDatabaseForServer(dbName: string, onProgress?: (msg: string, pct: number) => void): Promise<{
    success: boolean; adminCreds?: DbCredentials; serverCreds?: DbCredentials; method?: string; error?: string;
  }> {
    const runResult = await this.ensureRunning(true, onProgress);
    if (!runResult.success) return { success: false, error: runResult.error };

    onProgress?.('Securing database root account...', 100);
    const rootResult = await this.ensureRootSecured();
    if (!rootResult.success || !rootResult.creds) {
      return { success: false, error: rootResult.error || 'Could not secure the database root account' };
    }

    const dbCreated = await this.createDatabase(dbName, rootResult.creds);
    if (!dbCreated) {
      return { success: false, error: `Failed to create database "${dbName}"` };
    }

    onProgress?.('Creating a dedicated database user...', 100);
    const userResult = await this.createServerCredentials(dbName, rootResult.creds);
    if (!userResult.success || !userResult.creds) {
      return { success: false, error: userResult.error || 'Could not create a dedicated database user' };
    }

    onProgress?.('Testing database connection...', 100);
    const verify = await this.verifyCredentials(userResult.creds);
    if (!verify.ok) {
      return { success: false, error: `Database connection test failed: ${verify.error}` };
    }

    return { success: true, adminCreds: rootResult.creds, serverCreds: userResult.creds, method: runResult.method };
  }

  /** Does this server's resource set actually need a database at all? Same
   *  definition HealthScanner.checkDatabase uses, kept in one place so a
   *  startup gate and a diagnostic scan can never disagree about it. */
  needsDatabase(cfgContent: string): boolean {
    return cfgContent.includes('oxmysql') || cfgContent.includes('mysql-async') || cfgContent.includes('ghmattimysql');
  }

  /** Extract the mysql_connection_string convar's value from aggregated
   *  server.cfg (+ exec'd file) content, if present. */
  extractConnectionString(cfgContent: string): string | null {
    const m = cfgContent.match(/set\s+mysql_connection_string\s+["']([^"']+)["']/);
    return m ? m[1] : null;
  }

  /**
   * Gate for actually starting a FiveM server: if the server's resources
   * need a database, make sure it's running and the configured credentials
   * really work — auto-provisioning/starting it if allowed — BEFORE the
   * caller spawns FXServer.exe. Never silently lets a server start that is
   * guaranteed to fail its own database connection.
   */
  async verifyServerDatabase(cfgContent: string, allowInstall: boolean, onProgress?: (msg: string, pct: number) => void): Promise<{ ok: boolean; needsDb: boolean; error?: string }> {
    if (!this.needsDatabase(cfgContent)) return { ok: true, needsDb: false };

    const connString = this.extractConnectionString(cfgContent);
    if (!connString) {
      return { ok: false, needsDb: true, error: 'server.cfg has no mysql_connection_string set — run the Health Scanner to fix it.' };
    }

    const creds = this.parseConnectionString(connString);
    const running = await this.tcpPing(creds.host, creds.port);
    if (!running) {
      if (!this.isLocalHost(creds.host)) {
        return { ok: false, needsDb: true, error: `MySQL is not reachable at ${creds.host}:${creds.port} (a remote database can't be started from this PC).` };
      }
      const started = await this.ensureRunning(allowInstall, onProgress);
      if (!started.success) {
        return { ok: false, needsDb: true, error: started.error || 'The local database is not running and could not be started.' };
      }
    }

    const verify = await this.verifyCredentials(creds);
    if (!verify.ok) {
      return { ok: false, needsDb: true, error: `Database connection failed: ${verify.error}` };
    }
    return { ok: true, needsDb: true };
  }

  /** Stop the portable mysqld if we started it. */
  shutdown() {
    if (this.mysqldProc && !this.mysqldProc.killed) {
      try { this.mysqldProc.kill(); } catch {}
      this.mysqldProc = null;
    }
  }
}
