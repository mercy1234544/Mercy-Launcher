// ServerManager <-> DatabaseManager wiring tests — the FiveM database
// provisioning fixes plumbed through server creation/startup/join info.
// Uses a real ServerManager (real filesystem, same convention as
// marketplace.test.js) with a small fake DatabaseManager (duck-typed to
// just the methods ServerManager actually calls) so these run fast and
// deterministic, with no real MariaDB/network involved — the real
// DatabaseManager behavior itself is covered by database.test.js.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { ServerManager } = require(path.resolve(__dirname, '../../dist/main/services/ServerManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-servermgr-db-test-')); }

(async () => {
  const userDataRoot = mkTempRoot();
  const mgr = new ServerManager(userDataRoot);

  // ── computeDbName: deterministic, filesystem/SQL-safe, same every time ──
  ok('computeDbName lowercases and sanitizes special characters', mgr.computeDbName('My Cool Server!') === 'my_cool_server');
  ok('computeDbName is deterministic — the exact same input always produces the exact same output (needed so a restart resolves to the same database without persisting it separately)', mgr.computeDbName('My Cool Server!') === mgr.computeDbName('My Cool Server!'));
  ok('computeDbName strips leading/trailing underscores', mgr.computeDbName('__test__') === 'test');
  ok('computeDbName falls back to "fivem" for a name with no safe characters at all', mgr.computeDbName('!!!') === 'fivem');

  // ── generateServerCfg: the actual connection-string bug fix ─────────────
  // generateServerCfg only calls databaseManager.buildConnectionString(),
  // which is a pure function of its arguments — a minimal fake reproducing
  // the real implementation is enough here (the real implementation itself
  // is exercised directly in database.test.js).
  mgr.setDatabaseManager({
    buildConnectionString: (dbName, creds) => {
      const auth = creds?.password ? `${creds.user}:${encodeURIComponent(creds.password)}` : (creds?.user || 'root');
      return `mysql://${auth}@${creds?.host || 'localhost'}:${creds?.port || 3306}/${dbName}?charset=utf8mb4`;
    },
  });
  const cfgWithCreds = mgr.generateServerCfg(
    { name: 'Test Server', framework: 'qbcore' },
    'test_server',
    { host: '127.0.0.1', port: 3306, user: 'mercy_test_server', password: 'S3cr3tPass' }
  );
  ok('REPRODUCED THE FIX: server.cfg uses the dedicated user, never root', /mysql_connection_string "mysql:\/\/mercy_test_server:/.test(cfgWithCreds));
  ok('REPRODUCED THE FIX: server.cfg carries a real, non-empty password', !cfgWithCreds.includes('mysql://mercy_test_server@')); // no "@" immediately after the user with no ":password"
  ok('the generated connection string never reads root@localhost with no password', !cfgWithCreds.includes('mysql://root@localhost'));

  const cfgWithoutCreds = mgr.generateServerCfg({ name: 'Test Server', framework: 'qbcore' }, 'test_server');
  ok('falls back to the old root@localhost form ONLY when credential setup genuinely failed (never silently drops the line)', cfgWithoutCreds.includes('mysql_connection_string "mysql://root@localhost:3306/test_server'));

  const blankCfg = mgr.generateServerCfg({ name: 'Blank Server', framework: 'blank' }, 'blank_server', { host: '127.0.0.1', port: 3306, user: 'x', password: 'y' });
  ok('a "blank" framework server never gets a database connection string at all — it does not need one', !blankCfg.includes('mysql_connection_string'));

  // ── getConnectionInfo: never advertises localhost, reports DB health ────
  const serverDir = mkTempRoot();
  fs.writeFileSync(path.join(serverDir, 'FXServer.exe'), 'placeholder');
  fs.writeFileSync(path.join(serverDir, 'server.cfg'), [
    'endpoint_add_tcp "0.0.0.0:30121"',
    'endpoint_add_udp "0.0.0.0:30121"',
    'ensure oxmysql',
    'set mysql_connection_string "mysql://mercy_x:pw@127.0.0.1:3306/x?charset=utf8mb4"',
  ].join('\n'));
  const imp = await mgr.importExistingServer(serverDir, 'Connect Info Test');
  ok('test server imported for connection-info checks', imp.success === true);
  const serverId = imp.server.id;

  const fakeDbManager = {
    needsDatabase: (cfg) => cfg.includes('oxmysql'),
    verifyServerDatabase: async () => ({ ok: true, needsDb: true }),
  };
  mgr.setDatabaseManager(fakeDbManager);

  const info = await mgr.getConnectionInfo(serverId);
  ok('getConnectionInfo picks up the real custom port from server.cfg (never hardcodes 30120 blindly)', info.port === 30121);
  ok('REPRODUCED THE FIX: getConnectionInfo NEVER returns 127.0.0.1/localhost as the address to advertise — lanAddress is either a real non-internal interface or null, never a loopback placeholder', info.lanAddress === null || (info.lanAddress !== '127.0.0.1' && info.lanAddress !== 'localhost'));
  ok('a stopped server reports portListening as null (not checked), never a fabricated true/false', info.portListening === null);
  ok('database.needed reflects the real server.cfg content (oxmysql present)', info.database.needed === true);
  ok('database.healthy reflects the fake manager\'s real (mocked) verification result', info.database.healthy === true);

  const fakeDbManagerBroken = {
    needsDatabase: (cfg) => cfg.includes('oxmysql'),
    verifyServerDatabase: async () => ({ ok: false, needsDb: true, error: 'Access denied for user' }),
  };
  mgr.setDatabaseManager(fakeDbManagerBroken);
  const infoBroken = await mgr.getConnectionInfo(serverId);
  ok('REPRODUCED THE FIX: getConnectionInfo surfaces a broken database as unhealthy with a real error, not silently "ok"', infoBroken.database.healthy === false && /Access denied/.test(infoBroken.database.error));

  // ── startServer(): the actual startup gate — refuses to launch FXServer
  //    when the database check fails, exactly per the task's required
  //    startup order (DB checked and working BEFORE FiveM starts). ────────
  mgr.setDatabaseManager({
    needsDatabase: () => true,
    verifyServerDatabase: async () => ({ ok: false, needsDb: true, error: "Access denied for user 'root'@'localhost' (using password: NO)" }),
  });
  const blockedStart = await mgr.startServer(serverId);
  ok('REPRODUCED THE FIX: startServer() refuses to launch when the database check fails', blockedStart.success === false);
  ok('the surfaced error names the real underlying database failure, not a generic message', /Access denied/.test(blockedStart.error));
  ok('a server whose startup was blocked by a bad database is marked "error", never left looking like it might be running', mgr.getServer(serverId).status === 'error');

  mgr.setDatabaseManager({
    needsDatabase: () => true,
    verifyServerDatabase: async () => ({ ok: true, needsDb: true }),
  });
  const allowedStart = await mgr.startServer(serverId);
  // FXServer.exe here is just a placeholder text file — spawning it will
  // fail or exit immediately, but the important, deterministic assertion is
  // that the DATABASE gate did not block it (it got past that check and
  // attempted to actually launch, unlike the blocked case above).
  ok('when the database check passes, startServer() proceeds past the database gate (no "Database not ready" error)', !(allowedStart.error || '').includes('Database not ready'));

  console.log(`\nSERVER MANAGER <-> DATABASE MANAGER TESTS: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
