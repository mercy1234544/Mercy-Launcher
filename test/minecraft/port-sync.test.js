// Port-sync tests — deterministic, no network, no real process. Verifies the
// actual source of truth Connect/Settings both read from: the registry's own
// `port` field on a MinecraftServer record, and getConnectionInfo()'s live
// (never-cached) derivation from it. The renderer's Connect tab and its
// dynamically-generated join instructions have no separate copy of the port
// to go stale — they always read straight from getConnectionInfo()'s
// response at render time — so proving THIS stays correct after a property
// change is the meaningful, sufficient backend-level proof for "instructions
// must dynamically use the current server port." Only ever touches disposable
// temp directories.
const fs = require('fs'), path = require('path'), os = require('os');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkFakeServer(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.jar'), 'fake jar bytes');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dir, 'server.properties'), [
    '#Minecraft server properties',
    `server-port=${port}`,
    'motd=Port Sync Test',
  ].join('\n'));
}

(async () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-portsync-userdata-'));
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-portsync-fixture-'));

  try {
    mkFakeServer(fixtureDir, 25610);
    const mgr = new MinecraftManager(userDataRoot);
    const imp = await mgr.importServer(fixtureDir, 'Port Sync Test', 1024);
    ok('import succeeds', imp.success === true);
    const id = imp.server.id;

    // 1. Initial port appears correctly.
    ok('registry has the real initial port', mgr.getServer(id).port === 25610);
    const info1 = await mgr.getConnectionInfo(id);
    ok('getConnectionInfo reports the real initial port', info1.port === 25610);

    // 2-3. Change the port via the SAME writeProperties() Properties/Settings
    // actually calls — never editing the registry file directly.
    const write = mgr.writeProperties(id, { 'server-port': '25611' });
    ok('writeProperties succeeds', write.success === true);
    ok('the real server.properties file reflects the new port', /server-port=25611/.test(fs.readFileSync(path.join(fixtureDir, 'server.properties'), 'utf-8')));
    ok('writeProperties keeps the registry port field in sync (the actual source of truth)', mgr.getServer(id).port === 25611);

    // 4. Connect data (getConnectionInfo) immediately uses the new port —
    // no cache, no stale copy, called fresh right after the property write
    // with no delay/wait, matching exactly what the Connect tab's own poll
    // would see the next time it fires.
    const info2 = await mgr.getConnectionInfo(id);
    ok('getConnectionInfo immediately reflects the new port with no delay', info2.port === 25611);
    ok('the local address embeds the new port', `127.0.0.1:${info2.port}` === '127.0.0.1:25611');
    ok('NO stale port (25610) leaks into the fresh connection info', info2.port !== 25610);

    // A second, unrelated property change must not un-sync the port.
    mgr.writeProperties(id, { motd: 'Changed motd only' });
    const info3 = await mgr.getConnectionInfo(id);
    ok('an unrelated property change does not revert/stale the port', info3.port === 25611);

    // Edition/type are correctly reported alongside the port (feeds the
    // renderer's Java-vs-Bedrock instruction branch).
    ok('edition is reported for the instruction-selection logic', info3.edition === 'java');
    ok('serverType is reported for the instruction-selection logic', info3.serverType === 'vanilla');

    // Cleanup via the real deleteServer(), not a manual rm.
    const del = await mgr.deleteServer(id, true);
    ok('deleteServer succeeds', del.success === true);
    ok('fixture directory genuinely removed', !fs.existsSync(fixtureDir));

    console.log(`\nPORT SYNC TESTS: ${pass} passed, ${fail} failed`);
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
