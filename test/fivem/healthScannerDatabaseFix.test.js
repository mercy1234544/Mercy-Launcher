// HealthScanner's database auto-fix ("db:setup" / "db:connstring") — the
// exact code path a user hits when a Health Scanner issue tells them to
// "run the Health Scanner to fix it" (a message this codebase shows in
// several other places whenever database setup fails during server
// creation). Real production bug: this used to call
// dbManager.createDatabase(dbName) / buildConnectionString(dbName) with NO
// credentials at all, which default to root with a BLANK password —
// writing exactly "root@localhost with no password" into server.cfg from
// the auto-fix button itself. Now routed through the same
// setupDatabaseForServer() orchestration used at server-creation time.
//
// Same fake-MariaDB-over-mysql2/promise technique as database.test.js.
const fs = require('fs'), path = require('path'), os = require('os');

const HEALTH_SCANNER_PATH = path.resolve(__dirname, '../../dist/main/services/HealthScanner.js');
const DB_MANAGER_PATH = path.resolve(__dirname, '../../dist/main/services/DatabaseManager.js');
const MYSQL2_PROMISE_PATH = require.resolve('mysql2/promise');
const ELECTRON_PATH = require.resolve('electron');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-healthfix-db-test-')); }

function stubModule(resolvedPath, exportsObj) {
  const previous = require.cache[resolvedPath];
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports: exportsObj };
  return () => { if (previous) require.cache[resolvedPath] = previous; else delete require.cache[resolvedPath]; };
}

function makeFakeMariaDb() {
  const state = { rootPassword: '', users: new Map(), databases: new Set(), grants: new Map() };
  const authError = (user) => {
    const err = new Error(`Access denied for user '${user}'@'localhost' (using password: ${user === 'root' && state.rootPassword === '' ? 'NO' : 'YES'})`);
    err.code = 'ER_ACCESS_DENIED_ERROR';
    throw err;
  };
  const createConnection = async ({ user, password }) => {
    if (user === 'root') { if (password !== state.rootPassword) authError('root'); }
    else if (!state.users.has(user) || state.users.get(user) !== password) authError(user);
    const asRoot = user === 'root';
    return {
      query: async (sql, params = []) => {
        if (/ALTER USER 'root'@'localhost' IDENTIFIED BY/.test(sql)) { if (!asRoot) authError(user); state.rootPassword = params[0]; return [{}]; }
        if (/CREATE DATABASE IF NOT EXISTS/.test(sql)) { const m = sql.match(/CREATE DATABASE IF NOT EXISTS `([^`]+)`/); if (m) state.databases.add(m[1]); return [{}]; }
        if (/CREATE USER IF NOT EXISTS/.test(sql)) { const [u, pw] = params; if (!state.users.has(u)) state.users.set(u, pw); return [{}]; }
        if (/^ALTER USER \?@'localhost' IDENTIFIED BY/.test(sql)) { const [u, pw] = params; state.users.set(u, pw); return [{}]; }
        if (/GRANT ALL PRIVILEGES ON/.test(sql)) { const m = sql.match(/GRANT ALL PRIVILEGES ON `([^`]+)`/); const [u] = params; if (m) { if (!state.grants.has(u)) state.grants.set(u, new Set()); state.grants.get(u).add(m[1]); } return [{}]; }
        return [{}];
      },
      end: async () => {},
    };
  };
  return { state, createConnection };
}

(async () => {
  try {
    const electronUserData = mkTempRoot();
    const restoreElectron = stubModule(ELECTRON_PATH, { app: { getPath: () => electronUserData }, BrowserWindow: { getAllWindows: () => [] } });
    const fake = makeFakeMariaDb();
    const restoreMysql = stubModule(MYSQL2_PROMISE_PATH, { createConnection: fake.createConnection });

    delete require.cache[DB_MANAGER_PATH];
    delete require.cache[HEALTH_SCANNER_PATH];
    const { DatabaseManager } = require(DB_MANAGER_PATH);
    const { HealthScanner } = require(HEALTH_SCANNER_PATH);

    const dbManager = new DatabaseManager();
    dbManager.secretsFile = path.join(mkTempRoot(), 'db-credentials.json');
    dbManager.ensureRunning = async () => ({ success: true, method: 'already-running' });

    const scanner = new HealthScanner();
    scanner.setDatabaseManager(dbManager);

    const serverDir = mkTempRoot();
    fs.writeFileSync(path.join(serverDir, 'server.cfg'), [
      'ensure oxmysql',
      'set mysql_connection_string "mysql://root@localhost:3306/broken_server?charset=utf8mb4"',
    ].join('\n'));

    const issue = { id: 'db-bad-credentials', severity: 'error', category: 'Database', message: 'broken', autoFixable: true, fixAction: 'db:connstring' };
    const result = await scanner.fixIssue(serverDir, issue);
    ok('the Health Scanner auto-fix reports success', result.success === true);

    const rewritten = fs.readFileSync(path.join(serverDir, 'server.cfg'), 'utf-8');
    const connLine = rewritten.match(/set mysql_connection_string "([^"]+)"/);
    ok('a connection string is present after the fix', !!connLine);
    ok('REPRODUCED THE FIX: the Health Scanner auto-fix no longer writes root@localhost with no password', !connLine[1].startsWith('mysql://root@'));
    ok('REPRODUCED THE FIX: the Health Scanner auto-fix writes a dedicated, non-root user', /mysql:\/\/mercy_broken_server:/.test(connLine[1]));

    const parsed = dbManager.parseConnectionString(connLine[1]);
    const verify = await dbManager.verifyCredentials(parsed);
    ok('the credentials the Health Scanner actually wrote really authenticate against the database', verify.ok === true);

    restoreMysql();
    restoreElectron();

    console.log(`\nHEALTH SCANNER DATABASE FIX TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
