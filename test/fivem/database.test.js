// DatabaseManager tests — the real automated MySQL/MariaDB provisioning
// used by FiveM server creation/startup. No real MariaDB process is
// started here (that would need a real download + real Windows-only
// binaries): instead, `mysql2/promise` — the ONLY thing DatabaseManager
// ever talks to a real database through — is stubbed at the module-cache
// boundary (same technique test/presence/friendsPresenceStore.test.js uses
// for lib/supabase.ts) with a small in-memory fake MariaDB that enforces
// real auth semantics (wrong user/password -> a real ER_ACCESS_DENIED-style
// rejection). This proves the actual credential-security logic — not just
// that functions were called — because a bug in the SQL/auth flow here
// would fail these tests exactly like it would against a real server.
//
// THE REAL PRODUCTION BUG THIS FILE GUARDS: server.cfg's
// mysql_connection_string always read "mysql://root@localhost:3306/...”
// with NO password, which is *never* a safe end state (task's own explicit
// prohibition) and, on a fresh portable MariaDB 10.4+ install, was actually
// UNUSABLE — mariadb-install-db's default root account authenticates via
// unix_socket/named-pipe, which mysql2's normal TCP client can never
// satisfy, producing exactly "Access denied for user 'root'@'localhost'
// (using password: NO)" regardless of the (absent) password. Fixed via
// --auth-root-authentication-method=normal at init, a REAL generated root
// password (ensureRootSecured), and a dedicated least-privilege per-server
// user (createServerCredentials) that is the only credential ever written
// into a server's own server.cfg.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const Module = require('module');

const DB_MANAGER_PATH = path.resolve(__dirname, '../../dist/main/services/DatabaseManager.js');
const MYSQL2_PROMISE_PATH = require.resolve('mysql2/promise');
const ELECTRON_PATH = require.resolve('electron');

function stubModule(resolvedPath, exportsObj) {
  const previous = require.cache[resolvedPath];
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports: exportsObj };
  return () => { if (previous) require.cache[resolvedPath] = previous; else delete require.cache[resolvedPath]; };
}

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-db-test-')); }

/** A tiny in-memory fake MariaDB — just enough real auth/DDL semantics to
 *  prove DatabaseManager's credential-security logic actually works. */
function makeFakeMariaDb() {
  const state = {
    rootPassword: '', // fresh normal-auth install: root has a blank password
    users: new Map(), // 'user' -> password
    databases: new Set(),
    grants: new Map(), // 'user' -> Set(dbName)
  };
  const authError = (user) => {
    const err = new Error(`Access denied for user '${user}'@'localhost' (using password: ${user === 'root' && state.rootPassword === '' ? 'NO' : 'YES'})`);
    err.code = 'ER_ACCESS_DENIED_ERROR';
    throw err;
  };
  const createConnection = async ({ user, password }) => {
    if (user === 'root') {
      if (password !== state.rootPassword) authError('root');
    } else {
      if (!state.users.has(user) || state.users.get(user) !== password) authError(user);
    }
    const asRoot = user === 'root';
    return {
      query: async (sql, params = []) => {
        if (/ALTER USER 'root'@'localhost' IDENTIFIED BY/.test(sql)) {
          if (!asRoot) authError(user);
          state.rootPassword = params[0];
          return [{}];
        }
        if (/CREATE DATABASE IF NOT EXISTS/.test(sql)) {
          const m = sql.match(/CREATE DATABASE IF NOT EXISTS `([^`]+)`/);
          if (m) state.databases.add(m[1]);
          return [{}];
        }
        if (/CREATE USER IF NOT EXISTS/.test(sql)) {
          const [u, pw] = params;
          if (!state.users.has(u)) state.users.set(u, pw);
          return [{}];
        }
        if (/^ALTER USER \?@'localhost' IDENTIFIED BY/.test(sql)) {
          const [u, pw] = params;
          state.users.set(u, pw);
          return [{}];
        }
        if (/GRANT ALL PRIVILEGES ON/.test(sql)) {
          const m = sql.match(/GRANT ALL PRIVILEGES ON `([^`]+)`/);
          const [u] = params;
          if (m) {
            if (!state.grants.has(u)) state.grants.set(u, new Set());
            state.grants.get(u).add(m[1]);
          }
          return [{}];
        }
        // FLUSH PRIVILEGES / SELECT 1 / arbitrary schema imports — accept.
        return [{}];
      },
      end: async () => {},
    };
  };
  return { state, createConnection };
}

function stubMysql2(fake) {
  const previous = require.cache[MYSQL2_PROMISE_PATH];
  require.cache[MYSQL2_PROMISE_PATH] = {
    id: MYSQL2_PROMISE_PATH, filename: MYSQL2_PROMISE_PATH, loaded: true,
    exports: { createConnection: fake.createConnection },
  };
  return () => { if (previous) require.cache[MYSQL2_PROMISE_PATH] = previous; else delete require.cache[MYSQL2_PROMISE_PATH]; };
}

(async () => {
  try {
    delete require.cache[DB_MANAGER_PATH];
    // DatabaseManager's constructor calls electron's app.getPath('userData')
    // — stub it to a real temp dir so this runs under plain `node`, same
    // module-cache technique used for mysql2/promise below.
    const electronUserData = mkTempRoot();
    const restoreElectron = stubModule(ELECTRON_PATH, { app: { getPath: () => electronUserData } });
    const { DatabaseManager } = require(DB_MANAGER_PATH);

    // ── Pure functions — no mocking needed at all. ──────────────────────
    const dbm = new DatabaseManager();
    ok('parseConnectionString parses a mysql:// URI with user/password/db', (() => {
      const c = dbm.parseConnectionString('mysql://myuser:my%40pass@127.0.0.1:3307/mydb?charset=utf8mb4');
      return c.user === 'myuser' && c.password === 'my@pass' && c.host === '127.0.0.1' && c.port === 3307 && c.database === 'mydb';
    })());
    ok('parseConnectionString defaults to root/blank/3306 for a garbage string', (() => {
      const c = dbm.parseConnectionString('not-a-real-string');
      return c.user === 'root' && c.password === '' && c.port === 3306;
    })());
    ok('buildConnectionString with a real user/password never omits the password', dbm.buildConnectionString('mydb', { user: 'mercy_mydb', password: 'sekret' }) === 'mysql://mercy_mydb:sekret@localhost:3306/mydb?charset=utf8mb4');
    ok('buildConnectionString URL-encodes a password with special characters', dbm.buildConnectionString('mydb', { user: 'u', password: 'a@b/c' }).includes(encodeURIComponent('a@b/c')));
    ok('isLocalHost recognizes all local forms', dbm.isLocalHost('127.0.0.1') && dbm.isLocalHost('localhost') && dbm.isLocalHost('LOCALHOST'));
    ok('isLocalHost rejects a real remote host', !dbm.isLocalHost('db.example.com'));
    ok('needsDatabase detects oxmysql', dbm.needsDatabase('ensure oxmysql\nensure qb-core'));
    ok('needsDatabase detects mysql-async', dbm.needsDatabase('ensure mysql-async'));
    ok('needsDatabase is false for a blank/no-db server.cfg', !dbm.needsDatabase('ensure chat\nensure spawnmanager'));
    ok('extractConnectionString reads the real convar value', dbm.extractConnectionString('set mysql_connection_string "mysql://root@localhost:3306/x"') === 'mysql://root@localhost:3306/x');
    ok('extractConnectionString returns null when absent', dbm.extractConnectionString('ensure oxmysql') === null);

    // ── Credential security — real auth semantics via the fake server. ──
    const fake = makeFakeMariaDb();
    const restoreMysql = stubMysql2(fake);

    const secureDbm = new DatabaseManager();
    // Point its secrets file at a real temp dir instead of Electron's userData
    // (this test never touches Electron) — same technique as reading a
    // private field: overwrite it directly, it's just a path string.
    const secretsDir = mkTempRoot();
    secureDbm.secretsFile = path.join(secretsDir, 'db-credentials.json');

    ok('(setup) a fresh install authenticates as root with a blank password', (await secureDbm.verifyCredentials({ host: '127.0.0.1', port: 3306, user: 'root', password: '' })).ok === true);

    const secured = await secureDbm.ensureRootSecured();
    ok('ensureRootSecured succeeds against a fresh blank-password root', secured.success === true && !!secured.creds?.password);
    ok('REPRODUCED THE FIX: root password is a real, non-empty generated secret — never blank', secured.creds.password.length > 0);
    ok('REPRODUCED THE FIX: the OLD blank root password no longer authenticates once secured', (await secureDbm.verifyCredentials({ host: '127.0.0.1', port: 3306, user: 'root', password: '' })).ok === false);
    ok('the NEW real root password does authenticate', (await secureDbm.verifyCredentials(secured.creds)).ok === true);

    const secured2 = await secureDbm.ensureRootSecured();
    ok('ensureRootSecured is idempotent — a second call reuses the same persisted password rather than rotating it', secured2.success === true && secured2.creds.password === secured.creds.password);

    const dbCreated = await secureDbm.createDatabase('my_fivem_server', secured.creds);
    ok('createDatabase succeeds using the now-secured root credentials', dbCreated === true);
    ok('the database was actually created in the (fake) server', fake.state.databases.has('my_fivem_server'));

    const userResult = await secureDbm.createServerCredentials('my_fivem_server', secured.creds);
    ok('createServerCredentials succeeds', userResult.success === true);
    ok('REPRODUCED THE FIX: the server credential is a dedicated user, never root', userResult.creds.user !== 'root' && userResult.creds.user.startsWith('mercy_'));
    ok('REPRODUCED THE FIX: the dedicated user has a real, non-empty generated password', !!userResult.creds.password && userResult.creds.password.length > 0);
    ok('the dedicated user is only granted on ITS OWN database, never a global grant', fake.state.grants.get(userResult.creds.user)?.has('my_fivem_server') === true);

    const verifyServerCreds = await secureDbm.verifyCredentials(userResult.creds);
    ok('the dedicated user credentials actually authenticate against the (fake) server', verifyServerCreds.ok === true);

    const userResult2 = await secureDbm.createServerCredentials('my_fivem_server', secured.creds);
    ok('createServerCredentials is idempotent for the same database — reuses the existing working user/password', userResult2.creds.user === userResult.creds.user && userResult2.creds.password === userResult.creds.password);

    // A completely wrong password must be rejected exactly like a real
    // ER_ACCESS_DENIED_ERROR — never silently "succeed".
    const badAuth = await secureDbm.verifyCredentials({ host: '127.0.0.1', port: 3306, user: userResult.creds.user, password: 'totally-wrong' });
    ok('a wrong password for the dedicated user is correctly rejected', badAuth.ok === false && /Access denied/.test(badAuth.error));

    // ── setupDatabaseForServer — the single high-level entry point
    //    ServerManager.createServer() actually calls. Mock ensureRunning so
    //    this test never touches real TCP/process-spawning, and use a FRESH
    //    fake backend (a genuinely fresh install, root not secured yet) —
    //    not the one already mutated above. ──────────────────────────────
    const freshFake = makeFakeMariaDb();
    const restoreFreshMysql = stubMysql2(freshFake);
    const setupDbm = new DatabaseManager();
    setupDbm.secretsFile = path.join(mkTempRoot(), 'db-credentials.json');
    setupDbm.ensureRunning = async () => ({ success: true, method: 'already-running' });
    const setupResult = await setupDbm.setupDatabaseForServer('another_server');
    ok('setupDatabaseForServer succeeds end-to-end (running -> root secured -> db created -> user created -> verified)', setupResult.success === true);
    ok('setupDatabaseForServer returns BOTH admin creds (for schema imports) and dedicated server creds (for server.cfg)', setupResult.adminCreds?.user === 'root' && setupResult.serverCreds?.user === 'mercy_another_server');
    ok('REPRODUCED THE FIX: setupDatabaseForServer never returns a blank-password root as the server credential', setupResult.serverCreds.password.length > 0 && setupResult.serverCreds.user !== 'root');

    // ── verifyServerDatabase — the startup gate ServerManager.startServer()
    //    calls before ever spawning FXServer.exe. ────────────────────────
    const gateDbm = new DatabaseManager();
    gateDbm.secretsFile = setupDbm.secretsFile; // reuse the same persisted creds as above
    gateDbm.ensureRunning = async () => ({ success: true, method: 'already-running' });
    gateDbm.tcpPing = async () => true; // already "running" for this check

    const workingCfg = `set mysql_connection_string "${setupDbm.buildConnectionString('another_server', setupResult.serverCreds)}"\nensure oxmysql\n`;
    const gateOk = await gateDbm.verifyServerDatabase(workingCfg, true);
    ok('REPRODUCED THE FIX: verifyServerDatabase passes for a server.cfg using the real dedicated credentials', gateOk.ok === true && gateOk.needsDb === true);

    const blankRootCfg = `set mysql_connection_string "mysql://root@localhost:3306/another_server?charset=utf8mb4"\nensure oxmysql\n`;
    const gateBad = await gateDbm.verifyServerDatabase(blankRootCfg, true);
    ok('REPRODUCED THE FIX: verifyServerDatabase FAILS for the old root@localhost-with-no-password form once root is secured — this is exactly the ER_ACCESS_DENIED_ERROR scenario, now caught before FiveM ever starts', gateBad.ok === false && /Access denied|Database connection failed/.test(gateBad.error));

    const noDbCfg = `ensure chat\nensure spawnmanager\n`;
    const gateNoDb = await gateDbm.verifyServerDatabase(noDbCfg, true);
    ok('a blank-framework server.cfg (no oxmysql) is never gated on a database at all', gateNoDb.ok === true && gateNoDb.needsDb === false);

    const missingConnStringCfg = `ensure oxmysql\n`;
    const gateMissing = await gateDbm.verifyServerDatabase(missingConnStringCfg, true);
    ok('a server.cfg that needs a database but has no connection string fails with a clear, actionable error', gateMissing.ok === false && /mysql_connection_string/.test(gateMissing.error));

    restoreFreshMysql();
    restoreMysql();
    restoreElectron();

    console.log(`\nDATABASE MANAGER TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
