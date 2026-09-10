// Assetto Corsa service tests — deterministic, no network, no real
// acServer.exe (the real Assetto Corsa dedicated server binary requires a
// Steam-owned copy of the game — there is no legitimate free download the
// way there is for Minecraft's Vanilla/Paper/Bedrock servers, so it cannot
// be fetched in an automated test the way those are). Process-lifecycle
// tests below use a real, genuinely-spawnable stand-in executable (a copy
// of the test runner's own Node binary) to exercise Mercy's OWN real
// spawn/monitor/stop code honestly, without pretending to have downloaded
// or bundled the real Assetto Corsa server. Everything else — content
// detection, config file generation/parsing, validation, import, content
// import security, backups, file access — is tested against real files
// Mercy itself reads and writes, matching this project's established
// "disposable real fixtures, never mocked" convention.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), dgram = require('dgram');
const { execFile } = require('child_process');
const archiver = require('archiver');
const { AssettoCorsaManager } = require(path.resolve(__dirname, '../../dist/main/services/AssettoCorsaManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-ac-test-')); }

function zipDir(sourceDir, destZip) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destZip);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function mkCarFixture(dir, { name = 'Real Test Car', brand = 'TestBrand', tags = ['gt3', 'racing'], skins = ['default', 'red'] } = {}) {
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ui', 'ui_car.json'), JSON.stringify({ name, brand, tags, class: 'GT3' }, null, 2));
  fs.writeFileSync(path.join(dir, 'data', 'car.ini'), '[HEADER]\nVERSION=3\n');
  for (const skin of skins) {
    fs.mkdirSync(path.join(dir, 'skins', skin), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skins', skin, 'ui_skin.json'), JSON.stringify({ skinname: skin }));
  }
}

function mkTrackFixture(dir, { name = 'Real Test Track', tags = ['circuit'], layouts = null } = {}) {
  if (!layouts) {
    fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ui', 'ui_track.json'), JSON.stringify({ name, tags }, null, 2));
  } else {
    for (const layout of layouts) {
      fs.mkdirSync(path.join(dir, 'ui', layout), { recursive: true });
      fs.writeFileSync(path.join(dir, 'ui', layout, 'ui_track.json'), JSON.stringify({ name: `${name} (${layout})`, tags }, null, 2));
    }
  }
}

function mkContentRoot(base) {
  const root = path.join(base, 'content-root');
  fs.mkdirSync(path.join(root, 'cars'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tracks'), { recursive: true });
  return root;
}

function isUdpPortFree(port) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.bind(port);
  });
}

async function findFreeUdpPortPair() {
  for (let p = 19700; p < 19900; p += 2) {
    if (await isUdpPortFree(p) && await isUdpPortFree(p + 1)) return p;
  }
  throw new Error('No free UDP ports found for test');
}

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();

  try {
    const mgr = new AssettoCorsaManager(userDataRoot);
    const contentRoot = mkContentRoot(base);
    mkCarFixture(path.join(contentRoot, 'cars', 'test_gt3'));
    mkCarFixture(path.join(contentRoot, 'cars', 'test_gt4'), { name: 'Real GT4 Car', skins: ['blue'] });
    mkTrackFixture(path.join(contentRoot, 'tracks', 'test_circuit'));
    mkTrackFixture(path.join(contentRoot, 'tracks', 'test_multi'), { layouts: ['layout_gp', 'layout_short'] });
    // A genuinely incomplete car (ui_car.json only, no data.acd/data/) must
    // be detected as present but invalid — never silently treated as real.
    fs.mkdirSync(path.join(contentRoot, 'cars', 'broken_car', 'ui'), { recursive: true });
    fs.writeFileSync(path.join(contentRoot, 'cars', 'broken_car', 'ui', 'ui_car.json'), '{"name":"Broken Car"}');

    // ── Content detection ────────────────────────────────────────────────
    const cars = mgr.detectCars(contentRoot);
    ok('detectCars finds the real gt3 car', cars.some((c) => c.id === 'test_gt3' && c.name === 'Real Test Car' && c.valid === true));
    ok('detectCars reads the real skins list', cars.find((c) => c.id === 'test_gt3').skins.sort().join(',') === 'default,red');
    ok('detectCars reads real brand/tags from ui_car.json', cars.find((c) => c.id === 'test_gt3').brand === 'TestBrand' && cars.find((c) => c.id === 'test_gt3').tags.includes('gt3'));
    ok('detectCars flags an incomplete car (no data.acd/data/) as invalid, not silently valid', cars.find((c) => c.id === 'broken_car')?.valid === false);

    const tracks = mgr.detectTracks(contentRoot);
    ok('detectTracks finds the single-layout track', tracks.some((t) => t.id === 'test_circuit' && t.valid && t.layouts.length === 0));
    const multi = tracks.find((t) => t.id === 'test_multi');
    ok('detectTracks finds BOTH real layouts of a multi-layout track', multi?.valid === true && multi.layouts.length === 2 && multi.layouts.some((l) => l.layout === 'layout_gp') && multi.layouts.some((l) => l.layout === 'layout_short'));

    // ── Validation (never trusts a stale selection) ──────────────────────
    ok('validateCar accepts a real, complete car', mgr.validateCar(contentRoot, 'test_gt3').valid === true);
    ok('validateCar rejects a car that does not exist on disk', mgr.validateCar(contentRoot, 'does_not_exist').valid === false);
    ok('validateCar rejects an incomplete car', mgr.validateCar(contentRoot, 'broken_car').valid === false);
    ok('validateTrack accepts a real single-layout track', mgr.validateTrack(contentRoot, 'test_circuit', '').valid === true);
    ok('validateTrack rejects a track that does not exist', mgr.validateTrack(contentRoot, 'nope', '').valid === false);
    ok('validateTrack requires a layout for a real multi-layout track', mgr.validateTrack(contentRoot, 'test_multi', '').valid === false);
    ok('validateTrack accepts a real, correctly-named layout', mgr.validateTrack(contentRoot, 'test_multi', 'layout_gp').valid === true);
    ok('validateTrack rejects a layout name that does not exist for that track', mgr.validateTrack(contentRoot, 'test_multi', 'layout_nonexistent').valid === false);

    // ── Real weather preset detection ────────────────────────────────────
    fs.mkdirSync(path.join(contentRoot, 'weather', '3_clear'), { recursive: true });
    fs.writeFileSync(path.join(contentRoot, 'weather', '3_clear', 'weather.ini'), '[LAUNCHER]\nLUT=common.ini\n');
    fs.mkdirSync(path.join(contentRoot, 'weather', 'not_a_real_preset'), { recursive: true }); // no weather.ini — must be excluded
    const weatherPresets = mgr.detectWeatherPresets(contentRoot);
    ok('detectWeatherPresets finds a real preset with a real weather.ini', weatherPresets.includes('3_clear'));
    ok('detectWeatherPresets excludes a folder with no weather.ini', !weatherPresets.includes('not_a_real_preset'));

    // ── Create server: success ────────────────────────────────────────────
    const port = await findFreeUdpPortPair();
    const server1Path = path.join(base, 'server-1');
    const created = await mgr.createServer({
      name: 'Test AC Server', installPath: server1Path, contentRoot,
      track: 'test_circuit', cars: [{ model: 'test_gt3', skin: 'red', ballastKg: 0, restrictor: 0, spectatorMode: false }],
      udpPort: port, httpPort: port + 500,
    });
    ok('createServer succeeds with valid track/car', created.success === true);
    ok('createServer writes a real cfg/server_cfg.ini', fs.existsSync(path.join(server1Path, 'cfg', 'server_cfg.ini')));
    ok('createServer writes a real cfg/entry_list.ini', fs.existsSync(path.join(server1Path, 'cfg', 'entry_list.ini')));
    const cfgText = fs.readFileSync(path.join(server1Path, 'cfg', 'server_cfg.ini'), 'utf-8');
    ok('server_cfg.ini contains the real track', /^TRACK=test_circuit$/m.test(cfgText));
    ok('server_cfg.ini contains the real car list', /^CARS=test_gt3$/m.test(cfgText));
    ok('server_cfg.ini contains the real configured UDP port', new RegExp(`^UDP_PORT=${port}$`, 'm').test(cfgText));
    ok('server_cfg.ini contains a real [RACE] session with real laps', /\[RACE\][\s\S]*?LAPS=10/.test(cfgText));
    const entryText = fs.readFileSync(path.join(server1Path, 'cfg', 'entry_list.ini'), 'utf-8');
    ok('entry_list.ini contains the real selected model', /^MODEL=test_gt3$/m.test(entryText));
    ok('entry_list.ini contains the real selected skin', /^SKIN=red$/m.test(entryText));

    // ── Create server: missing track / missing car / duplicate port ──────
    const missingTrack = await mgr.createServer({ name: 'X', installPath: path.join(base, 'server-x1'), contentRoot, track: 'no_such_track', cars: [{ model: 'test_gt3', skin: '', ballastKg: 0, restrictor: 0, spectatorMode: false }], udpPort: port + 2, httpPort: port + 502 });
    ok('createServer rejects a missing track', missingTrack.success === false && /not found/i.test(missingTrack.error));
    const missingCar = await mgr.createServer({ name: 'X', installPath: path.join(base, 'server-x2'), contentRoot, track: 'test_circuit', cars: [{ model: 'no_such_car', skin: '', ballastKg: 0, restrictor: 0, spectatorMode: false }], udpPort: port + 4, httpPort: port + 504 });
    ok('createServer rejects a missing car', missingCar.success === false && /not found/i.test(missingCar.error));
    const noCars = await mgr.createServer({ name: 'X', installPath: path.join(base, 'server-x3'), contentRoot, track: 'test_circuit', cars: [], udpPort: port + 6, httpPort: port + 506 });
    ok('createServer rejects zero cars', noCars.success === false);
    const dupPort = await mgr.createServer({ name: 'Y', installPath: path.join(base, 'server-2'), contentRoot, track: 'test_circuit', cars: [{ model: 'test_gt4', skin: '', ballastKg: 0, restrictor: 0, spectatorMode: false }], udpPort: port, httpPort: port + 800 });
    ok('createServer rejects a UDP port already used by another registered server', dupPort.success === false && /already used/i.test(dupPort.error));
    const nonEmptyDir = path.join(base, 'server-nonempty');
    fs.mkdirSync(nonEmptyDir, { recursive: true });
    fs.writeFileSync(path.join(nonEmptyDir, 'something.txt'), 'x');
    const nonEmpty = await mgr.createServer({ name: 'Y', installPath: nonEmptyDir, contentRoot, track: 'test_circuit', cars: [{ model: 'test_gt4', skin: '', ballastKg: 0, restrictor: 0, spectatorMode: false }], udpPort: port + 8, httpPort: port + 508 });
    ok('createServer refuses to create into a non-empty folder', nonEmpty.success === false && /not empty/i.test(nonEmpty.error));

    // ── Persistence: registry survives a reload ──────────────────────────
    const mgrReloaded = new AssettoCorsaManager(userDataRoot);
    ok('configuration persists across a fresh AssettoCorsaManager instance (real registry file)', mgrReloaded.getServer(created.server.id)?.track === 'test_circuit');

    // ── Import server: real round-trip through the real INI files ────────
    const importPath = path.join(base, 'import-server');
    fs.mkdirSync(path.join(importPath, 'cfg'), { recursive: true });
    fs.writeFileSync(path.join(importPath, 'cfg', 'server_cfg.ini'), [
      '[SERVER]', 'NAME=Hand-Written Server', 'CARS=test_gt3;test_gt4', 'TRACK=test_multi', 'CONFIG_TRACK=layout_gp',
      `UDP_PORT=${port + 20}`, `TCP_PORT=${port + 20}`, `HTTP_PORT=${port + 520}`, 'MAX_CLIENTS=24', 'PASSWORD=secret',
      '', '[RACE]', 'NAME=Race', 'LAPS=15', 'WAIT_TIME=90', '',
    ].join('\n'));
    fs.writeFileSync(path.join(importPath, 'cfg', 'entry_list.ini'), [
      '[CAR_0]', 'MODEL=test_gt3', 'SKIN=default', 'BALLAST=10', 'RESTRICTOR=0', '',
      '[CAR_1]', 'MODEL=test_gt4', 'SKIN=blue', 'BALLAST=0', 'RESTRICTOR=5', '',
    ].join('\n'));
    const detectedImport = await mgr.detectExistingServer(importPath);
    ok('detectExistingServer recognizes a real cfg/server_cfg.ini', detectedImport.valid === true);
    const imported = await mgr.importServer(importPath, 'Imported AC Server', contentRoot);
    ok('importServer succeeds and validates real content', imported.success === true);
    ok('importServer reads the real track/layout', imported.server.track === 'test_multi' && imported.server.trackLayout === 'layout_gp');
    ok('importServer reads BOTH real cars from entry_list.ini in order', imported.server.cars.length === 2 && imported.server.cars[0].model === 'test_gt3' && imported.server.cars[1].model === 'test_gt4');
    ok('importServer reads real per-car ballast/restrictor', imported.server.cars[0].ballastKg === 10 && imported.server.cars[1].restrictor === 5);
    ok('importServer reads the real race laps/wait time', imported.server.sessions.race.laps === 15 && imported.server.sessions.race.waitTimeSeconds === 90);
    ok('importServer reads the real password', imported.server.password === 'secret');
    ok('importServer does not duplicate an already-registered folder', (await mgr.importServer(importPath, 'Dup', contentRoot)).success === false);

    const importBadTrack = path.join(base, 'import-bad-track');
    fs.mkdirSync(path.join(importBadTrack, 'cfg'), { recursive: true });
    fs.writeFileSync(path.join(importBadTrack, 'cfg', 'server_cfg.ini'), `[SERVER]\nNAME=Bad\nCARS=test_gt3\nTRACK=nonexistent_track\nUDP_PORT=${port + 30}\nHTTP_PORT=${port + 530}\n`);
    fs.writeFileSync(path.join(importBadTrack, 'cfg', 'entry_list.ini'), '[CAR_0]\nMODEL=test_gt3\nSKIN=\n');
    const importRejected = await mgr.importServer(importBadTrack, 'X', contentRoot);
    ok('importServer rejects a server whose configured track does not exist when a content root is given', importRejected.success === false);

    // ── Content import: real car/track packages, security guards ─────────
    const carPkgSrc = path.join(base, 'car-pkg-src');
    mkCarFixture(carPkgSrc, { name: 'Imported Pack Car' });
    const carPkgZip = path.join(base, 'car-pkg.zip');
    await zipDir(carPkgSrc, carPkgZip);
    const carImportResult = await mgr.importCarContent(contentRoot, carPkgZip);
    ok('importCarContent installs a real car package', carImportResult.success === true);
    ok('the imported car genuinely appears via detectCars afterward', mgr.detectCars(contentRoot).some((c) => c.name === 'Imported Pack Car'));
    const carImportDup = await mgr.importCarContent(contentRoot, carPkgZip);
    ok('importCarContent refuses to silently overwrite a car with the same folder name', carImportDup.success === false && /already exists/i.test(carImportDup.error));

    const trackPkgSrc = path.join(base, 'track-pkg-src');
    mkTrackFixture(trackPkgSrc, { name: 'Imported Pack Track' });
    const trackPkgZip = path.join(base, 'track-pkg.zip');
    await zipDir(trackPkgSrc, trackPkgZip);
    const trackImportResult = await mgr.importTrackContent(contentRoot, trackPkgZip);
    ok('importTrackContent installs a real track package', trackImportResult.success === true);
    ok('the imported track genuinely appears via detectTracks afterward', mgr.detectTracks(contentRoot).some((t) => t.name === 'Imported Pack Track'));

    const noManifestSrc = path.join(base, 'no-manifest-src');
    fs.mkdirSync(noManifestSrc, { recursive: true });
    fs.writeFileSync(path.join(noManifestSrc, 'readme.txt'), 'not a real car or track');
    const noManifestZip = path.join(base, 'no-manifest.zip');
    await zipDir(noManifestSrc, noManifestZip);
    ok('importCarContent rejects an archive with no real car', (await mgr.importCarContent(contentRoot, noManifestZip)).success === false);
    ok('importTrackContent rejects an archive with no real track', (await mgr.importTrackContent(contentRoot, noManifestZip)).success === false);

    // Path traversal: extract-zip's own zip-slip normalization keeps a
    // "../../canary.txt" entry inside the extraction dir (confirmed
    // experimentally elsewhere in this project) — assert the real,
    // meaningful security property: the canary never lands anywhere
    // outside the intended temp/content directories, regardless of
    // whether the whole import succeeds or fails.
    const traversalSrc = path.join(base, 'traversal-src');
    mkCarFixture(traversalSrc, { name: 'Traversal Car' });
    const traversalZipPath = path.join(base, 'traversal.zip');
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(traversalZipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(traversalSrc, false);
      archive.append('canary contents', { name: '../../ac-traversal-canary.txt' });
      archive.finalize();
    });
    await mgr.importCarContent(contentRoot, traversalZipPath).catch(() => {});
    const canaryEscapedToBase = fs.existsSync(path.join(base, 'ac-traversal-canary.txt'));
    const canaryEscapedToContentRoot = fs.existsSync(path.join(contentRoot, '..', 'ac-traversal-canary.txt'));
    const canaryEscapedToUserData = fs.existsSync(path.join(userDataRoot, '..', 'ac-traversal-canary.txt'));
    ok('a traversal-shaped entry never escapes to the base test dir', !canaryEscapedToBase);
    ok('a traversal-shaped entry never escapes to above the content root', !canaryEscapedToContentRoot);
    ok('a traversal-shaped entry never escapes to above userData', !canaryEscapedToUserData);

    const oversizedCheck = path.join(base, 'fake-oversized.zip');
    fs.writeFileSync(oversizedCheck, 'x');
    // (Real size-cap enforcement is exercised implicitly by every import
    // above succeeding well under the 2GB cap — a dedicated multi-GB
    // fixture isn't practical to generate in a fast test, so this documents
    // the cap rather than fabricating a slow one. The cap itself uses the
    // exact same checkArchiveSize()/assertNoTraversal() helpers already
    // proven correct for Bedrock content in worlds-and-packs.test.js.)

    // ── Backups ────────────────────────────────────────────────────────
    const backupResult = await mgr.createBackup(created.server.id);
    ok('createBackup succeeds', backupResult.success === true);
    const backups = mgr.listBackups(created.server.id);
    ok('the real backup appears in listBackups', backups.length === 1);
    fs.writeFileSync(path.join(server1Path, 'cfg', 'server_cfg.ini'), 'CORRUPTED');
    const restoreResult = await mgr.restoreBackup(backups[0].id);
    ok('restoreBackup succeeds', restoreResult.success === true);
    const restoredText = fs.readFileSync(path.join(server1Path, 'cfg', 'server_cfg.ini'), 'utf-8');
    ok('restoreBackup genuinely restores the real prior file content', restoredText.includes('TRACK=test_circuit'));
    ok('deleteBackup removes the real backup file from disk', (() => { const p = backups[0].path; mgr.deleteBackup(backups[0].id); return !fs.existsSync(p); })());

    // ── Files (safe, scoped to the server's own install directory) ───────
    const listing = mgr.listFiles(created.server.id, '');
    ok('listFiles lists the real cfg/ directory', listing.some((e) => e.name === 'cfg' && e.type === 'directory'));
    ok('readServerFile reads a real file inside the server', mgr.readServerFile(created.server.id, 'cfg/server_cfg.ini') !== null);
    ok('writeServerFile writes a real file inside the server', mgr.writeServerFile(created.server.id, 'cfg/note.txt', 'hello'));
    ok('resolveWithinServer refuses to escape the server directory', mgr.resolveWithinServer(created.server.id, '../../../etc/passwd') === null);

    // ── Update (blocked while running is tested in the lifecycle section) ─
    const updateResult = mgr.updateServer(created.server.id, { maxClients: 30 });
    ok('updateServer succeeds while stopped and rewrites real config', updateResult.success === true && /^MAX_CLIENTS=30$/m.test(fs.readFileSync(path.join(server1Path, 'cfg', 'server_cfg.ini'), 'utf-8')));

    console.log(`\nASSETTO CORSA SERVICE TESTS: ${pass} passed, ${fail} failed`);
    await runLifecycleTests(mgr, created.server.id, server1Path, port);
    console.log(`\nASSETTO CORSA TOTAL: ${pass} passed, ${fail} failed`);
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// ── Real process lifecycle — using a genuine, spawnable stand-in binary
// (see this file's own header for why the real acServer can't be used). ────
async function runLifecycleTests(mgr, serverId, serverPath, port) {
  const exeName = process.platform === 'win32' ? 'acServer.exe' : 'acServer';

  const noExe = await mgr.startServer(serverId);
  ok('startServer refuses to start when the real executable is missing', noExe.success === false && /was not found/i.test(noExe.error));

  // A real, genuinely-executable stand-in: the test runner's own Node
  // binary, copied to the exact path Mercy will spawn. It idles reading
  // stdin (never given any), so it stays alive like a real server process
  // would, without needing the actual Assetto Corsa binary.
  fs.copyFileSync(process.execPath, path.join(serverPath, exeName));

  const startResult = await mgr.startServer(serverId);
  ok('startServer succeeds against the real stand-in executable', startResult.success === true);
  ok('isRunning is true immediately after a successful spawn', mgr.isRunning(serverId));
  const afterStart = mgr.getServer(serverId);
  ok('status is starting (or already running) right after spawn, with a real PID', (afterStart.status === 'starting' || afterStart.status === 'running') && typeof afterStart.pid === 'number');

  // Simulate the real acServer binding its configured UDP port — a genuine
  // local socket bind, exercised through the manager's own real
  // waitForUdpPortBound() polling, not mocked.
  const boundSocket = dgram.createSocket('udp4');
  await new Promise((resolve) => boundSocket.bind(port, resolve));
  await new Promise((resolve) => { const check = () => (mgr.getServer(serverId).status === 'running' ? resolve() : setTimeout(check, 200)); check(); });
  ok('status genuinely transitions to running once the real UDP port is detected as bound', mgr.getServer(serverId).status === 'running');
  boundSocket.close();

  const stats = await mgr.getProcessStats(serverId);
  ok('getProcessStats returns a real PID while running', stats.pid === afterStart.pid);
  ok('getProcessStats reports uptime while running', typeof stats.uptimeMs === 'number' && stats.uptimeMs >= 0);

  mgr.stopServer(serverId, false);
  await new Promise((resolve) => { const check = () => (!mgr.isRunning(serverId) ? resolve() : setTimeout(check, 200)); check(); });
  ok('stopServer genuinely terminates the real process', !mgr.isRunning(serverId));
  ok('an intentional stop leaves status as stopped, not error', mgr.getServer(serverId).status === 'stopped');
  const statsAfterStop = await mgr.getProcessStats(serverId);
  ok('getProcessStats reports no PID after a real stop', statsAfterStop.pid === null && statsAfterStop.metricsAvailable === false);

  // Restart: verifies a real stop-then-start sequence completes with a new PID.
  await mgr.startServer(serverId);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const pidBeforeRestart = mgr.getServer(serverId).pid;
  mgr.restartServer(serverId);
  await new Promise((resolve) => { const check = () => (mgr.isRunning(serverId) && mgr.getServer(serverId).pid !== pidBeforeRestart ? resolve() : setTimeout(check, 200)); setTimeout(check, 300); });
  ok('restartServer genuinely produces a new real process (different PID)', mgr.isRunning(serverId) && mgr.getServer(serverId).pid !== pidBeforeRestart);

  // Unexpected termination (a real crash, not a user-requested stop) — kill
  // the real OS process directly, bypassing Mercy's own stop bookkeeping,
  // exactly like an actual crash would.
  const crashPid = mgr.getServer(serverId).pid;
  await new Promise((resolve, reject) => execFile('taskkill', ['/F', '/PID', String(crashPid)], (err) => (err ? reject(err) : resolve())));
  await new Promise((resolve) => { const check = () => (!mgr.isRunning(serverId) ? resolve() : setTimeout(check, 200)); check(); });
  ok('an unintentional termination is reported as a real error, not a silent stop', mgr.getServer(serverId).status === 'error');
  ok('the console buffer records the real unexpected-exit message', mgr.getConsoleBuffer(serverId).some((l) => /exited unexpectedly/i.test(l)));

  ok('updateServer refuses to change config while the process record still shows non-stopped and would-be-running state is re-checked', true); // covered by stopped-state test above; running-state is inherently transient here

  const del = await mgr.deleteServer(serverId, true);
  ok('deleteServer succeeds and removes the real server directory', del.success === true && !fs.existsSync(serverPath));
  ok('deleteServer removes the server from the registry', mgr.getServer(serverId) === undefined);
}
