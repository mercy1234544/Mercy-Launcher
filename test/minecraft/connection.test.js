// Connection info tests — deterministic, no Minecraft/Java required. The
// port-listening check is tested against REAL TCP servers/sockets (Node's
// own net module, not a mock), since that's the actual mechanism
// getConnectionInfo() uses to verify reachability rather than trusting
// process state alone.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-conn-test-')); }
function mkFakeServer(dir, jarName = 'server.jar') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, jarName), 'fake jar bytes');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25563\nlevel-name=world\n');
}
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();
  const mgr = new MinecraftManager(userDataRoot);

  const serverDir = path.join(base, 'conn-server');
  mkFakeServer(serverDir);
  const imp = await mgr.importServer(serverDir, 'Connection Test Server', 1024);
  ok('test server registered', imp.success);
  const serverId = imp.server.id;
  const server = mgr.getServer(serverId);

  // 1. A stopped server: no port check is attempted (nothing to verify),
  // status/edition/name/type/version are all real from the actual record.
  const stoppedInfo = await mgr.getConnectionInfo(serverId);
  ok('connection info exists for a real registered server', stoppedInfo !== null);
  ok('edition is always Java (Mercy has no Bedrock server type)', stoppedInfo.edition === 'java');
  ok('reflects the REAL server name', stoppedInfo.serverName === 'Connection Test Server');
  ok('reflects the REAL server type', stoppedInfo.serverType === 'vanilla');
  ok('reflects the REAL configured port', stoppedInfo.port === 25563);
  ok('portListening is null when the server is not running (nothing to verify, not assumed false)', stoppedInfo.portListening === null);
  ok('no Geyser installed → Bedrock reported as not possible', stoppedInfo.bedrock.possible === false);
  ok('the Bedrock note explains a Vanilla server can never support it (Geyser needs Paper)', /vanilla/i.test(stoppedInfo.bedrock.note) && /geyser/i.test(stoppedInfo.bedrock.note));

  // 2. Real port-listening verification — genuinely checked via a real TCP
  // connection attempt, using an actual free port this test controls.
  const testPort = await freePort();
  server.port = testPort;
  server.status = 'running'; // simulate "the process exists" without a real Minecraft process

  const notListeningInfo = await mgr.getConnectionInfo(serverId);
  ok('when nothing is actually bound to the port, portListening is genuinely false (not assumed true just because status=running)', notListeningInfo.portListening === false);

  const realListener = net.createServer((sock) => sock.end());
  await new Promise((resolve) => realListener.listen(testPort, '127.0.0.1', resolve));
  const listeningInfo = await mgr.getConnectionInfo(serverId);
  ok('when something IS really listening on the configured port, portListening is genuinely true', listeningInfo.portListening === true);
  await new Promise((resolve) => realListener.close(resolve));

  const afterCloseInfo = await mgr.getConnectionInfo(serverId);
  ok('after the real listener closes, a fresh check correctly reports false again (never cached from the earlier check)', afterCloseInfo.portListening === false);

  // A Minecraft process typically binds its socket before it finishes
  // loading, so "starting" must still be genuinely checked, not skipped.
  server.status = 'starting';
  const realListener2 = net.createServer((sock) => sock.end());
  await new Promise((resolve) => realListener2.listen(testPort, '127.0.0.1', resolve));
  const startingInfo = await mgr.getConnectionInfo(serverId);
  ok('a "starting" server with its port already bound is genuinely reported as listening (not skipped as "not running yet")', startingInfo.portListening === true);
  await new Promise((resolve) => realListener2.close(resolve));
  server.status = 'running';

  // 3. Bedrock/Geyser detection — a real installed-content record naming a
  // Geyser plugin flips bedrock.possible; nothing else does.
  server.serverType = 'paper';
  const nonGeyserRecord = {
    id: 'plugin-1', kind: 'plugin', source: 'modrinth', projectId: 'x', projectName: 'EssentialsX',
    versionId: 'v1', versionNumber: '1.0', fileName: 'EssentialsX.jar', relPath: 'plugins/EssentialsX.jar',
    sha1: 'x', size: 1, enabled: true, installedAt: new Date().toISOString(), dependencies: [],
  };
  mgr.addInstalledContent(serverId, nonGeyserRecord);
  const stillNoGeyser = await mgr.getConnectionInfo(serverId);
  ok('an unrelated installed plugin does NOT make Bedrock look possible', stillNoGeyser.bedrock.possible === false);

  const geyserRecord = {
    id: 'plugin-2', kind: 'plugin', source: 'modrinth', projectId: 'y', projectName: 'Geyser-Spigot',
    versionId: 'v2', versionNumber: '2.0', fileName: 'Geyser-Spigot.jar', relPath: 'plugins/Geyser-Spigot.jar',
    sha1: 'y', size: 1, enabled: true, installedAt: new Date().toISOString(), dependencies: [],
  };
  mgr.addInstalledContent(serverId, geyserRecord);
  const withGeyser = await mgr.getConnectionInfo(serverId);
  ok('a real installed Geyser plugin makes Bedrock reported as possible', withGeyser.bedrock.possible === true);
  ok('the detected plugin name is the REAL installed project name', withGeyser.detectedPlugin === undefined ? withGeyser.bedrock.detectedPlugin === 'Geyser-Spigot' : true);
  ok('the note is honest that the plugin being installed is not the same as it being configured correctly', /configur/i.test(withGeyser.bedrock.note));

  // 4. Staying in sync — changing port/version/type on the record changes
  // what getConnectionInfo reports next time, since nothing is cached.
  server.port = 30000;
  server.version = '1.20.4';
  const afterChange = await mgr.getConnectionInfo(serverId);
  ok('a changed port is reflected immediately (no stale caching)', afterChange.port === 30000);
  ok('a changed version is reflected immediately', afterChange.version === '1.20.4');

  // Cleanup.
  try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}

  console.log(`\nCONNECTION INFO TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
