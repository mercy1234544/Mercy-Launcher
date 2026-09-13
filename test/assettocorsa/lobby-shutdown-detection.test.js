// Regression tests for BUG 2 — a real Assetto Corsa server report: the
// server process starts, then shuts itself down.
//
// Reproduced directly against this exact server's real config, running the
// REAL acServer.exe standalone (outside Mercy) with registerToLobby
// enabled on a network with no port forwarding: it retries public-lobby
// registration 5 times, then prints "LOBBY COULD NOT BE RACHED, SHUTTING
// SERVER DOWN" (the binary's own real typo) and exits cleanly (code 0) —
// this is the REAL acServer.exe's own built-in behavior, not Mercy killing
// anything. Mercy's exit handler already correctly classified this as a
// non-crash ("stopped", not "error"), but never explained WHY — lastError
// was never populated with anything, so the "Last Error" panel in the UI
// never appeared even though this is a real, actionable failure.
//
// Same real-process-lifecycle technique as runtime.test.js (a genuinely
// spawnable stand-in executable — a copy of the test runner's own node.exe
// — rather than a mock of Mercy's own process-handling logic). What
// differs here is CONTROLLING what that stand-in prints/how it exits,
// via NODE_OPTIONS=--require, so each scenario is deterministic.
const fs = require('fs'), path = require('path'), os = require('os'), dgram = require('dgram');
const { AssettoCorsaManager } = require(path.resolve(__dirname, '../../dist/main/services/AssettoCorsaManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-ac-lobby-test-')); }
function mkContentRoot(base) {
  const root = path.join(base, 'content-root');
  fs.mkdirSync(path.join(root, 'cars'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tracks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cars', 'test_gt3', 'ui'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cars', 'test_gt3', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cars', 'test_gt3', 'ui', 'ui_car.json'), JSON.stringify({ name: 'Test Car', brand: 'T', tags: [], class: 'GT3' }));
  fs.writeFileSync(path.join(root, 'cars', 'test_gt3', 'data', 'car.ini'), '[HEADER]\nVERSION=3\n');
  fs.mkdirSync(path.join(root, 'tracks', 'test_circuit', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tracks', 'test_circuit', 'ui', 'ui_track.json'), JSON.stringify({ name: 'Test Track', tags: [] }));
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
async function findFreeUdpPort(start) {
  for (let p = start; p < start + 400; p++) if (await isUdpPortFree(p)) return p;
  throw new Error('No free UDP port found for test');
}
const EXE_NAME = process.platform === 'win32' ? 'acServer.exe' : 'acServer';

// Writes a small script that, when auto-required by the stand-in node.exe
// process (via NODE_OPTIONS), prints exactly `lines` then exits with `code`.
function mkBehaviorScript(dir, lines, code) {
  const p = path.join(dir, `behavior-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  const body = lines.map((l) => `console.log(${JSON.stringify(l)});`).join('\n');
  fs.writeFileSync(p, `${body}\nprocess.exit(${code});\n`);
  return p;
}

async function withBehavior(behaviorScriptPath, fn) {
  const prev = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(behaviorScriptPath)}`;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prev;
  }
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();
  const scriptsDir = mkTempRoot();

  try {
    const mgr = new AssettoCorsaManager(userDataRoot);
    const contentRoot = mkContentRoot(base);

    const realRuntimeDir = path.join(base, 'real-runtime');
    fs.mkdirSync(realRuntimeDir, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(realRuntimeDir, EXE_NAME));
    mgr.setRuntimePath(realRuntimeDir);

    async function makeServer(name, port) {
      const installPath = path.join(base, name);
      const created = await mgr.createServer({
        name, installPath, contentRoot, track: 'test_circuit',
        cars: [{ model: 'test_gt3', skin: '', ballastKg: 0, restrictor: 0, spectatorMode: false }],
        udpPort: port, httpPort: port + 500,
      });
      return created.server;
    }

    // ── 1. The real lobby-self-shutdown pattern: server starts, prints the
    //    real acServer.exe line (including its own "RACHED" typo), exits
    //    cleanly. Mercy must set a real, specific, actionable lastError. ───
    {
      const port = await findFreeUdpPort(19950);
      const server = await makeServer('lobby-shutdown-server', port);
      const script = mkBehaviorScript(scriptsDir, [
        'Server started',
        'Registering to AC central server',
        'RESPONSE: ERROR,INVALID SERVER,CHECK YOUR PORT FORWARDING SETTINGS',
        'CONNECTION TO LOBBY FAILED, ATTEMPT NUMBER  5',
        'LOBBY COULD NOT BE RACHED, SHUTTING SERVER DOWN',
      ], 0);
      const result = await withBehavior(script, () => mgr.startServer(server.id));
      ok('startServer accepts the real config and spawns', result.success === true);
      const exited = await waitUntil(() => !mgr.isRunning(server.id));
      ok('the fake acServer.exe process genuinely exited on its own', exited);
      const after = mgr.getServer(server.id);
      ok('REPRODUCED THE FIX: status is "stopped" (a clean exit, not a crash) — never "error" for this specific, identified cause', after.status === 'stopped');
      ok('REPRODUCED THE FIX: lastError is now populated with a real, specific, actionable explanation (previously always null)', typeof after.lastError === 'string' && after.lastError.length > 0);
      ok('lastError specifically names the real cause (lobby registration failure), not a generic message', /lobby/i.test(after.lastError) && /port/i.test(after.lastError));
      ok('lastError tells the user the real fix (turn off Register to Public Lobby, or set up port forwarding)', /Register to Public Lobby/i.test(after.lastError));
    }

    // ── 2. A genuinely healthy, still-running server must NOT be touched —
    //    proves this fix only reacts to the real shutdown line, never a
    //    slow/failed readiness check on its own. ─────────────────────────
    {
      const port = await findFreeUdpPort(19970);
      const server = await makeServer('healthy-server', port);
      // No special behavior script — the stand-in just runs as a bare node
      // REPL (stdin is a pipe, never closes) and stays alive indefinitely,
      // exactly like a real, successfully-running acServer.exe with no
      // client connected yet.
      const result = await mgr.startServer(server.id);
      ok('a normal start succeeds', result.success === true);
      // Give the readiness check + a moment for any (incorrect) premature
      // kill logic to fire, then confirm the server is still genuinely running.
      await new Promise((r) => setTimeout(r, 1500));
      ok('REPRODUCED THE FIX (regression guard): a server with no readiness signal yet and no failure output is left running, never killed just because a client hasn\'t connected', mgr.isRunning(server.id));
      const stillServer = mgr.getServer(server.id);
      ok('no lastError was fabricated for a server that never printed any failure', !stillServer.lastError);
      mgr.stopServer(server.id, true);
      await waitUntil(() => !mgr.isRunning(server.id));
    }

    // ── 3. A genuine crash (non-zero exit, no lobby-shutdown line) is still
    //    correctly detected as a real failure — this fix must not mask
    //    actual crashes as clean stops. ──────────────────────────────────
    {
      const port = await findFreeUdpPort(19990);
      const server = await makeServer('crash-server', port);
      const script = mkBehaviorScript(scriptsDir, ['Server started', 'FATAL: something genuinely went wrong'], 1);
      await withBehavior(script, () => mgr.startServer(server.id));
      const exited = await waitUntil(() => !mgr.isRunning(server.id));
      ok('the fake crashing process genuinely exited', exited);
      const after = mgr.getServer(server.id);
      ok('a genuine non-zero-exit failure is still reported as "error", not silently reclassified by this fix', after.status === 'error');
    }

    console.log(`\nAC LOBBY SELF-SHUTDOWN DETECTION TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(scriptsDir, { recursive: true, force: true }); } catch {}
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
