// Assetto Corsa dedicated-server RUNTIME tests (Part 9/10) — deterministic,
// no real acServer.exe (see service.test.js's own header for why). Uses a
// real, genuinely-spawnable stand-in executable (a copy of the test
// runner's own Node binary) to prove the real runtime-copy + pre-start
// checklist + port-free check actually work, never a mock of Mercy's own
// logic.
const fs = require('fs'), path = require('path'), os = require('os'), dgram = require('dgram');
const { execFile } = require('child_process');
const { AssettoCorsaManager } = require(path.resolve(__dirname, '../../dist/main/services/AssettoCorsaManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-ac-runtime-test-')); }
function mkContentRoot(base) {
  const root = path.join(base, 'content-root');
  fs.mkdirSync(path.join(root, 'cars'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tracks'), { recursive: true });
  return root;
}
function mkCarFixture(dir) {
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ui', 'ui_car.json'), JSON.stringify({ name: 'Test Car', brand: 'T', tags: [], class: 'GT3' }));
  fs.writeFileSync(path.join(dir, 'data', 'car.ini'), '[HEADER]\nVERSION=3\n');
}
function mkTrackFixture(dir) {
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ui', 'ui_track.json'), JSON.stringify({ name: 'Test Track', tags: [] }));
}
function isUdpPortFree(port) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.bind(port);
  });
}
async function findFreeUdpPort(start) {
  for (let p = start; p < start + 400; p++) if (await isUdpPortFree(p)) return p;
  throw new Error('No free UDP port found for test');
}

const EXE_NAME = process.platform === 'win32' ? 'acServer.exe' : 'acServer';

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();

  try {
    const mgr = new AssettoCorsaManager(userDataRoot);
    const contentRoot = mkContentRoot(base);
    mkCarFixture(path.join(contentRoot, 'cars', 'test_gt3'));
    mkTrackFixture(path.join(contentRoot, 'tracks', 'test_circuit'));

    // ── No runtime configured at all ────────────────────────────────────
    ok('getRuntimePath() is honestly null before anything is configured', mgr.getRuntimePath() === null);

    const port1 = await findFreeUdpPort(19910);
    const serverPath1 = path.join(base, 'server-1');
    const created1 = await mgr.createServer({
      name: 'Server One', installPath: serverPath1, contentRoot, track: 'test_circuit',
      cars: [{ model: 'test_gt3', skin: '', ballastKg: 0, restrictor: 0, spectatorMode: false }],
      udpPort: port1, httpPort: port1 + 500,
    });
    ok('server creation itself succeeds even with no runtime configured — config and runtime are separate concerns', created1.success === true);

    const readiness1 = await mgr.getServerReadiness(created1.server.id);
    ok('getServerReadiness reports the real, honest state: no runtime, no executable, but config/content ARE present', readiness1.runtimeConfigured === false && readiness1.executablePresent === false && readiness1.configPresent === true && readiness1.contentValid === true && readiness1.ready === false);

    // ── Validating a runtime folder ──────────────────────────────────────
    const fakeRuntimeDir = path.join(base, 'not-a-runtime');
    fs.mkdirSync(fakeRuntimeDir, { recursive: true });
    const invalidRuntime = mgr.validateRuntimeFolder(fakeRuntimeDir);
    ok('a real folder with no real acServer.exe in it is honestly rejected as a runtime', invalidRuntime.valid === false && /was not found/i.test(invalidRuntime.error));

    const missingDirRuntime = mgr.validateRuntimeFolder(path.join(base, 'does-not-exist-at-all'));
    ok('a folder that does not exist at all is honestly rejected, never crashes', missingDirRuntime.valid === false);

    const setInvalid = mgr.setRuntimePath(fakeRuntimeDir);
    ok('setRuntimePath refuses an invalid folder — never silently accepts a fake runtime', setInvalid.success === false);
    ok('getRuntimePath is still null after a rejected setRuntimePath call', mgr.getRuntimePath() === null);

    // ── A real, valid runtime folder (real stand-in executable + a
    //    companion file, real "content" dir that must NEVER be copied) ────
    const realRuntimeDir = path.join(base, 'real-runtime');
    fs.mkdirSync(path.join(realRuntimeDir, 'content', 'cars'), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(realRuntimeDir, EXE_NAME));
    fs.writeFileSync(path.join(realRuntimeDir, 'steam_appid.txt'), '302550');
    fs.writeFileSync(path.join(realRuntimeDir, 'content', 'cars', 'should-never-be-copied.txt'), 'huge shared content, never duplicate per server');

    const setValid = mgr.setRuntimePath(realRuntimeDir);
    ok('setRuntimePath accepts a real, valid runtime folder', setValid.success === true);
    ok('getRuntimePath now returns the real configured path', mgr.getRuntimePath() === realRuntimeDir);

    // ── Copying the runtime into a server that doesn't have it yet ──────
    const copyResult = mgr.ensureRuntimeFilesPresent(created1.server.id);
    ok('ensureRuntimeFilesPresent succeeds once a real runtime is configured', copyResult.success === true);
    ok('the real executable now genuinely exists in the server\'s own folder', fs.existsSync(path.join(serverPath1, EXE_NAME)));
    ok('the real companion file (steam_appid.txt) was copied too — not just the executable', fs.existsSync(path.join(serverPath1, 'steam_appid.txt')));
    // The server's own content/ is a real LINK to contentRoot (see
    // linkServerContent(), created automatically by createServer() above)
    // — never a copy of the RUNTIME's own separate content folder. Proven
    // by the runtime's stub file genuinely being absent even though
    // content/ itself now (correctly) exists.
    ok('the server\'s content/ is linked to contentRoot, not copied from the runtime\'s own separate content folder', !fs.existsSync(path.join(serverPath1, 'content', 'cars', 'should-never-be-copied.txt')));
    ok('content/ is a real symlink/junction, never a real duplicated directory', fs.lstatSync(path.join(serverPath1, 'content')).isSymbolicLink());
    ok('the real linked content/cars/test_gt3 (from contentRoot) is genuinely visible at the server\'s own path — this is the actual Part 7 fix', fs.existsSync(path.join(serverPath1, 'content', 'cars', 'test_gt3', 'ui', 'ui_car.json')));

    const readiness2 = await mgr.getServerReadiness(created1.server.id);
    ok('after copying the runtime, getServerReadiness now reports a real, ready server', readiness2.runtimeConfigured === true && readiness2.executablePresent === true && readiness2.ready === true);

    // ── ensureRuntimeFilesPresent never overwrites a file already there ──
    fs.writeFileSync(path.join(serverPath1, 'steam_appid.txt'), 'a real, different, already-existing value');
    mgr.ensureRuntimeFilesPresent(created1.server.id);
    ok('ensureRuntimeFilesPresent never overwrites a file that already genuinely exists in the server folder', fs.readFileSync(path.join(serverPath1, 'steam_appid.txt'), 'utf-8') === 'a real, different, already-existing value');

    // ── A second, freshly-created server automatically gets the runtime
    //    files on its first real start attempt (startServer calls
    //    ensureRuntimeFilesPresent internally) — the "Copy files yourself"
    //    UX is gone. ──────────────────────────────────────────────────────
    const port2 = await findFreeUdpPort(port1 + 20);
    const serverPath2 = path.join(base, 'server-2');
    const created2 = await mgr.createServer({
      name: 'Server Two', installPath: serverPath2, contentRoot, track: 'test_circuit',
      cars: [{ model: 'test_gt3', skin: '', ballastKg: 0, restrictor: 0, spectatorMode: false }],
      udpPort: port2, httpPort: port2 + 500,
    });
    const start2 = await mgr.startServer(created2.server.id);
    ok('a brand-new server with a real runtime already configured starts successfully without any manual file copying', start2.success === true);
    ok('the real process is genuinely running immediately after a successful start', mgr.isRunning(created2.server.id));
    mgr.stopServer(created2.server.id, true);
    await new Promise((resolve) => { const check = () => (!mgr.isRunning(created2.server.id) ? resolve() : setTimeout(check, 100)); check(); });

    // ── Real port-in-use check BEFORE spawn (Part 9 item 5) ─────────────
    const occupiedSocket = dgram.createSocket('udp4');
    const port3 = await findFreeUdpPort(port2 + 20);
    await new Promise((resolve) => occupiedSocket.bind(port3, resolve));
    const serverPath3 = path.join(base, 'server-3');
    const created3 = await mgr.createServer({
      name: 'Server Three', installPath: serverPath3, contentRoot, track: 'test_circuit',
      cars: [{ model: 'test_gt3', skin: '', ballastKg: 0, restrictor: 0, spectatorMode: false }],
      udpPort: port3, httpPort: port3 + 500,
    });
    mgr.ensureRuntimeFilesPresent(created3.server.id);
    const readiness3 = await mgr.getServerReadiness(created3.server.id);
    ok('getServerReadiness detects a REAL port collision with an unrelated process before starting', readiness3.portAvailable === false && /already in use/i.test(readiness3.portError));
    const startBlocked = await mgr.startServer(created3.server.id);
    ok('startServer itself refuses to start when the configured port is genuinely already bound by something else', startBlocked.success === false && /already in use/i.test(startBlocked.error));
    occupiedSocket.close();

    // ── Missing config files are checked explicitly, not just the exe ──
    fs.rmSync(path.join(serverPath1, 'cfg', 'entry_list.ini'));
    const readinessNoConfig = await mgr.getServerReadiness(created1.server.id);
    ok('getServerReadiness detects genuinely missing configuration files as its own real check', readinessNoConfig.configPresent === false);
    const startNoConfig = await mgr.startServer(created1.server.id);
    ok('startServer refuses to start with real configuration files missing, with a real, specific reason', startNoConfig.success === false && /configuration files/i.test(startNoConfig.error));

    // ── linkServerContent(): a stale link (pointing at an old/removed
    //    contentRoot) is replaced, never left dangling ───────────────────
    const staleTargetDir = path.join(base, 'old-content-root-no-longer-used');
    fs.mkdirSync(staleTargetDir, { recursive: true });
    const contentLinkPath = path.join(serverPath1, 'content');
    fs.rmSync(contentLinkPath, { recursive: true, force: true });
    fs.symlinkSync(staleTargetDir, contentLinkPath, 'junction');
    const relinked = mgr.linkServerContent(created1.server.id);
    ok('linkServerContent replaces a stale link pointing at the wrong target', relinked.success === true);
    ok('the link now genuinely resolves to the server\'s real, current contentRoot', path.resolve(fs.realpathSync(contentLinkPath)) === path.resolve(contentRoot));

    // ── linkServerContent(): a REAL directory at content/ (e.g. an older
    //    full-copy install) is never touched or deleted ──────────────────
    const serverPath4 = path.join(base, 'server-4-real-content-dir');
    const port4 = await findFreeUdpPort(port3 + 20);
    const created4 = await mgr.createServer({
      name: 'Server Four', installPath: serverPath4, contentRoot, track: 'test_circuit',
      cars: [{ model: 'test_gt3', skin: '', ballastKg: 0, restrictor: 0, spectatorMode: false }],
      udpPort: port4, httpPort: port4 + 500,
    });
    ok('creating a server (into an empty folder) succeeds', created4.success === true);
    // Replace the real link createServer() just made with a REAL directory,
    // simulating an older full-copy install / manually-placed content —
    // linkServerContent() must never delete real content sitting there.
    fs.rmSync(path.join(serverPath4, 'content'), { recursive: true, force: true });
    fs.mkdirSync(path.join(serverPath4, 'content'), { recursive: true });
    fs.writeFileSync(path.join(serverPath4, 'content', 'real-file-must-survive.txt'), 'genuine pre-existing content');
    const relink4 = mgr.linkServerContent(created4.server.id);
    ok('linkServerContent succeeds (as a no-op) when a real content/ directory already exists', relink4.success === true);
    ok('a real, pre-existing content/ directory is left completely untouched, never replaced with a link', fs.existsSync(path.join(serverPath4, 'content', 'real-file-must-survive.txt')) && !fs.lstatSync(path.join(serverPath4, 'content')).isSymbolicLink());

    // ── The real, PID-scoped UDP readiness check (the actual root-cause
    //    fix): a genuine child process that really binds a UDP socket is
    //    correctly detected by PID — never by racing to bind the port
    //    ourselves, which is what silently misreported the real bug. ─────
    const udpServerScript = path.join(base, 'fake-udp-server.js');
    const readyPort = await findFreeUdpPort(port4 + 20);
    fs.writeFileSync(udpServerScript, `
      const dgram = require('dgram');
      const s = dgram.createSocket('udp4');
      s.bind(${readyPort}, () => { process.stdout.write('bound\\n'); });
      setInterval(() => {}, 60000); // stay alive
    `);
    const udpProc = require('child_process').spawn(process.execPath, [udpServerScript]);
    try {
      await new Promise((resolve) => udpProc.stdout.once('data', resolve));
      const detected = await mgr.isProcessListeningOnUdpPort(udpProc.pid, readyPort);
      ok('a real process that genuinely bound a UDP port is correctly detected as listening, by its real PID', detected === true);
      const wrongPid = await mgr.isProcessListeningOnUdpPort(udpProc.pid, readyPort + 1);
      ok('the same real process is correctly reported as NOT listening on a DIFFERENT port it never bound', wrongPid === false);
      const randomPort = await findFreeUdpPort(readyPort + 50);
      const nobodyListening = await mgr.isProcessListeningOnUdpPort(udpProc.pid, randomPort);
      ok('a genuinely free port with no real listener at all is correctly reported as not bound', nobodyListening === false);
    } finally {
      udpProc.kill('SIGKILL');
    }

    console.log(`\nASSETTO CORSA RUNTIME TESTS: ${pass} passed, ${fail} failed`);
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
