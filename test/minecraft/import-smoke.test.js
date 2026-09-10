// Tiny Minecraft Java import smoke test — deterministic, no network, no real
// jar bytes, no Electron required (matches service.test.js's own convention).
// Exercises the REAL importer functions the UI's Import dialog calls via IPC
// (minecraft:detectExisting -> detectExistingServer, minecraft:import ->
// importServer, minecraft:delete -> deleteServer) — never writes to the
// registry file by hand. Only ever touches disposable temp directories,
// removed at the end; never the real production Minecraft install/userData.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

(async () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-import-smoke-userdata-'));
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-import-smoke-fixture-'));

  try {
    ok('disposable fixture dir is under the OS temp dir, never a real install location', fixtureDir.startsWith(os.tmpdir()));
    ok('disposable userData root is under the OS temp dir, never the real production userData', userDataRoot.startsWith(os.tmpdir()));

    // ── Build the tiny fixture — the MINIMUM files the real importer needs
    // to recognize a valid Java server: a .jar (name only matters, content
    // doesn't — detection checks the filename, not jar validity) plus a
    // real server.properties with a real port line. No world, no real jar
    // bytes, no download — intentionally tiny.
    fs.writeFileSync(path.join(fixtureDir, 'server.jar'), 'not a real jar — fixture only');
    fs.writeFileSync(path.join(fixtureDir, 'eula.txt'), 'eula=true\n');
    fs.writeFileSync(path.join(fixtureDir, 'server.properties'), [
      '#Minecraft server properties',
      'server-port=25601',
      'motd=Tiny Import Smoke Test',
    ].join('\n'));
    const fixtureFileCount = fs.readdirSync(fixtureDir).length;
    ok('fixture is genuinely tiny (exactly 3 files, no world/jar bytes/download)', fixtureFileCount === 3);

    const mgr = new MinecraftManager(userDataRoot);

    // ── 1-3. Same call the Import dialog's folder-browse makes ──────────
    const detected = await mgr.detectExistingServer(fixtureDir);
    ok('1. detectExistingServer recognizes the tiny fixture as valid', detected.valid === true);
    ok('2. Mercy correctly identifies it as Java (not Bedrock)', detected.edition === 'java');
    ok('3. Mercy correctly identifies it as Vanilla (no "paper" in the jar name)', detected.serverType === 'vanilla');
    ok('detectExistingServer reads the real port from server.properties', detected.port === 25601);
    ok('detectExistingServer sees the real jar filename', detected.jarFile === 'server.jar');

    // ── 4. Import completes — same call the dialog's "Import Server" button makes.
    const importResult = await mgr.importServer(fixtureDir, 'Tiny Import Smoke Test', 512);
    ok('4. importServer succeeds', importResult.success === true && !!importResult.server);
    const serverId = importResult.server.id;

    // ── 5. Imported server appears in the Minecraft server list ─────────
    // (getAllServers() is exactly what minecraft:getAll / the Hub's list
    // renders from — no separate/parallel list to go stale.)
    const allServers = mgr.getAllServers();
    ok('5. Imported server appears in getAllServers() (the real server list)', allServers.some((s) => s.id === serverId));

    // ── 6. Metadata is correct ───────────────────────────────────────────
    const imported = mgr.getServer(serverId);
    ok('6a. name matches what was given at import time', imported.name === 'Tiny Import Smoke Test');
    ok('6b. edition is java', imported.edition === 'java');
    ok('6c. serverType is vanilla', imported.serverType === 'vanilla');
    ok('6d. port matches the real detected port', imported.port === 25601);
    ok('6e. installPath points at the real fixture directory', path.resolve(imported.installPath) === path.resolve(fixtureDir));
    ok('6f. jarFile matches the real detected jar', imported.jarFile === 'server.jar');
    ok('6g. status starts stopped (never auto-started by import)', imported.status === 'stopped');
    ok('6h. ramMB matches what was given at import time', imported.ramMB === 512);

    // ── 7. No unrelated production server was touched ────────────────────
    // (Nothing above ever referenced any path outside fixtureDir/userDataRoot
    // — both disposable temp dirs — so there is nothing else to check here
    // beyond confirming those really are the only paths the registry knows
    // about.)
    ok('7. the registry contains ONLY this one disposable test server — nothing pre-existing/production got pulled in', allServers.length === 1);

    // ── 8. Delete the disposable imported server + verify cleanup ────────
    const delResult = await mgr.deleteServer(serverId, true);
    ok('8a. deleteServer succeeds', delResult.success === true);
    ok('8b. the disposable fixture directory is genuinely removed from disk', !fs.existsSync(fixtureDir));
    ok('8c. the server is gone from the registry', mgr.getServer(serverId) === undefined);
    ok('8d. getAllServers() is empty again', mgr.getAllServers().length === 0);

    console.log(`\nMINECRAFT IMPORT SMOKE TEST: ${pass} passed, ${fail} failed`);
  } finally {
    // Cleanup — this test's own disposable temp dirs only. fixtureDir was
    // already removed by the real deleteServer() call above (step 8b); this
    // just catches userDataRoot (and fixtureDir again, harmlessly, in case
    // an assertion failed before reaching the delete step).
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
