// Minecraft service tests — deterministic logic only, no network/Java
// required, so this runs safely in any environment. Every test uses a fresh
// temp directory as the "userData" root (cleaned up at the end) and NEVER
// touches a real Minecraft installation. Live download/start/stop against
// the real Mojang/PaperMC APIs was verified separately by hand (see the
// final report) since that needs real network + a real JRE.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-test-'));
}

function mkFakeServer(dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, opts.jarName || 'server.jar'), 'fake jar bytes');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dir, 'server.properties'), [
    '#Minecraft server properties',
    `server-port=${opts.port ?? 25565}`,
    'motd=Test Server',
    'gamemode=survival',
    'some-unknown-future-property=42',
  ].join('\n'));
}

(async () => {
  const userDataRoot = mkTempRoot();
  const mgr = new MinecraftManager(userDataRoot);

  // 1. Fresh registry starts empty; the data file itself is written lazily
  // on the first real mutation (checked again after step 4 below), but the
  // directories it and backups live in — both under userData, never inside
  // the packaged app directory an update would replace — exist immediately.
  ok('fresh registry is empty', mgr.getAllServers().length === 0);
  ok('data dir created under userData (not packaged app dir)', fs.existsSync(path.join(userDataRoot, 'data')));
  ok('backups dir created under userData (not packaged app dir)', fs.existsSync(path.join(userDataRoot, 'minecraft-backups')));

  // 2. createServer validation guards — all deterministic, no network hit.
  const base = mkTempRoot();
  const r1 = await mgr.createServer({ name: 'x', installPath: path.join(base, 'a'), version: '1.21.1', serverType: 'vanilla', ramMB: 1024, port: 25565, acceptedEula: false });
  ok('createServer rejects without EULA acceptance', !r1.success && /EULA/i.test(r1.error || ''));

  const r2 = await mgr.createServer({ name: 'x', installPath: path.join(base, 'b'), version: '1.21.1', serverType: 'vanilla', ramMB: 1024, port: 999999, acceptedEula: true });
  ok('createServer rejects an out-of-range port', !r2.success && /port/i.test(r2.error || ''));

  const r3 = await mgr.createServer({ name: 'x', installPath: path.join(base, 'c'), version: '1.21.1', serverType: 'vanilla', ramMB: 128, port: 25565, acceptedEula: true });
  ok('createServer rejects RAM below 512MB', !r3.success && /RAM/i.test(r3.error || ''));

  const nonEmptyDir = path.join(base, 'd');
  fs.mkdirSync(nonEmptyDir, { recursive: true });
  fs.writeFileSync(path.join(nonEmptyDir, 'something.txt'), 'pre-existing file');
  const r4 = await mgr.createServer({ name: 'x', installPath: nonEmptyDir, version: '1.21.1', serverType: 'vanilla', ramMB: 1024, port: 25565, acceptedEula: true });
  ok('createServer refuses to overwrite a non-empty directory', !r4.success && /empty/i.test(r4.error || ''));
  ok('createServer did NOT touch the pre-existing file', fs.existsSync(path.join(nonEmptyDir, 'something.txt')));

  // 3. detectExistingServer — real validation against real fake-but-shaped directories.
  const emptyDir = path.join(base, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  const notMc = await mgr.detectExistingServer(emptyDir);
  ok('detectExistingServer rejects a folder with no Minecraft files', !notMc.valid);

  const missingDir = path.join(base, 'does-not-exist');
  const missing = await mgr.detectExistingServer(missingDir);
  ok('detectExistingServer rejects a nonexistent path', !missing.valid);

  const vanillaDir = path.join(base, 'vanilla-server');
  mkFakeServer(vanillaDir, { jarName: 'server.jar', port: 25566 });
  const detectedVanilla = await mgr.detectExistingServer(vanillaDir);
  ok('detectExistingServer accepts a real-shaped vanilla server', detectedVanilla.valid);
  ok('detectExistingServer identifies serverType=vanilla from jar name', detectedVanilla.serverType === 'vanilla');
  ok('detectExistingServer reads the real port from server.properties', detectedVanilla.port === 25566);

  const paperDir = path.join(base, 'paper-server');
  mkFakeServer(paperDir, { jarName: 'paper-1.21.1-133.jar', port: 25567 });
  const detectedPaper = await mgr.detectExistingServer(paperDir);
  ok('detectExistingServer identifies serverType=paper from jar name', detectedPaper.serverType === 'paper');

  // 4. importServer — registers a real detected server, refuses duplicates.
  const imp1 = await mgr.importServer(vanillaDir, 'My Imported Server', 2048);
  ok('importServer succeeds for a valid detected server', imp1.success && !!imp1.server);
  ok('importServer records the real jar filename', imp1.server.jarFile === 'server.jar');
  ok('imported server IS NOT the real production Minecraft server (temp dir)', imp1.server.installPath.includes(os.tmpdir()) || imp1.server.installPath.startsWith(base));

  ok('data file persisted to userData after the first real registration', fs.existsSync(path.join(userDataRoot, 'data', 'minecraft-servers.json')));

  const imp2 = await mgr.importServer(vanillaDir, 'Duplicate', 2048);
  ok('importServer refuses to double-register the same directory', !imp2.success && /already registered/i.test(imp2.error || ''));

  const impInvalid = await mgr.importServer(emptyDir, 'Bad', 2048);
  ok('importServer refuses a folder with no server files', !impInvalid.success);

  // 5. server.properties — read parses correctly, write preserves unknown keys.
  const registeredId = imp1.server.id;
  const props = mgr.readProperties(registeredId);
  ok('readProperties parses known keys', props.some((p) => p.key === 'motd' && p.value === 'Test Server'));
  ok('readProperties parses the deliberately-unknown key too', props.some((p) => p.key === 'some-unknown-future-property'));
  ok('readProperties flags comment lines separately', props.some((p) => p.isComment));

  const writeResult = mgr.writeProperties(registeredId, { motd: 'Changed via Mercy', gamemode: 'creative' });
  ok('writeProperties reports success', writeResult.success);
  const rawAfter = fs.readFileSync(path.join(vanillaDir, 'server.properties'), 'utf-8');
  ok('writeProperties applied the changed value', /motd=Changed via Mercy/.test(rawAfter));
  ok('writeProperties applied the second changed value', /gamemode=creative/.test(rawAfter));
  ok('writeProperties PRESERVED the unknown property untouched', /some-unknown-future-property=42/.test(rawAfter));
  ok('writeProperties preserved server-port untouched', /server-port=25566/.test(rawAfter));
  ok('writeProperties created a .bak backup before overwriting', fs.existsSync(path.join(vanillaDir, 'server.properties.bak')));

  // 6. File access is strictly scoped to the server's own directory — path traversal must fail.
  const okList = mgr.listFiles(registeredId, '');
  ok('listFiles works for the real server root', Array.isArray(okList) && okList.some((f) => f.name === 'server.properties'));

  const traversalList = mgr.listFiles(registeredId, '../../../../Windows');
  ok('listFiles REJECTS a path-traversal attempt', traversalList === null);

  const traversalRead = mgr.readServerFile(registeredId, '..\\..\\..\\Windows\\win.ini');
  ok('readServerFile REJECTS a Windows-style traversal attempt', traversalRead === null);

  const traversalWrite = mgr.writeServerFile(registeredId, '../outside.txt', 'malicious');
  ok('writeServerFile REJECTS writing outside the server directory', traversalWrite === false);
  ok('no file was actually written outside the server directory', !fs.existsSync(path.join(base, 'outside.txt')));

  const legitRead = mgr.readServerFile(registeredId, 'server.properties');
  ok('readServerFile allows a real in-bounds file', legitRead !== null && legitRead.includes('motd'));

  const legitWrite = mgr.writeServerFile(registeredId, 'a-real-config.txt', 'hello mercy');
  ok('writeServerFile allows writing a real in-bounds file', legitWrite === true && fs.existsSync(path.join(vanillaDir, 'a-real-config.txt')));

  // 7. Java requirement matrix — real, well-known version boundaries.
  ok('Java requirement for 1.21 is 21', mgr.javaRequirementFor('1.21') === 21);
  ok('Java requirement for 1.20.4 is 17', mgr.javaRequirementFor('1.20.4') === 17);
  ok('Java requirement for 1.18 is 17', mgr.javaRequirementFor('1.18') === 17);
  ok('Java requirement for 1.16.5 is 8', mgr.javaRequirementFor('1.16.5') === 8);

  // 8. Java detection actually runs a real `java -version` on this machine (no network needed).
  const javaInfo = await mgr.detectJava();
  ok('detectJava returns a shape with found/version/major', typeof javaInfo.found === 'boolean');

  // 9. Backups — a REAL zip via archiver, on a small fake directory (no network/Java needed).
  const backupResult = await mgr.createBackup(registeredId);
  ok('createBackup succeeds', backupResult.success && !!backupResult.backup);
  ok('createBackup produces a real non-empty zip file', backupResult.success && fs.existsSync(backupResult.backup.path) && fs.statSync(backupResult.backup.path).size > 0);
  const backups = mgr.listBackups(registeredId);
  ok('listBackups returns the created backup', backups.length === 1 && backups[0].id === backupResult.backup.id);
  const deleted = mgr.deleteBackup(backupResult.backup.id);
  ok('deleteBackup succeeds', deleted === true);
  ok('deleteBackup actually removes the zip file', !fs.existsSync(backupResult.backup.path));
  ok('listBackups is empty after delete', mgr.listBackups(registeredId).length === 0);

  // 10. deleteServer — removes from registry; with deleteFiles=false, leaves real files untouched
  //     (this is the "never delete the user's real Minecraft world" guarantee, exercised for real).
  const beforeDeleteFilesExist = fs.existsSync(vanillaDir);
  const delResult = await mgr.deleteServer(registeredId, false);
  ok('deleteServer (registry only) succeeds', delResult.success === true);
  ok('deleteServer(deleteFiles=false) did NOT touch the real directory', beforeDeleteFilesExist && fs.existsSync(vanillaDir));
  ok('server is gone from the registry', mgr.getServer(registeredId) === undefined);

  // Cleanup — this test's own disposable temp dirs only.
  try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}

  console.log(`\nMINECRAFT SERVICE TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
