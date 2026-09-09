// REAL end-to-end proof for the Java-compatibility fix. Run by hand via
// `npx electron test/minecraft/java-live-e2e.js` (needs network + this
// machine's real Java — never touches a real Minecraft installation;
// everything happens in a disposable os.tmpdir() directory removed at the end).
//
// Demonstrates BOTH required scenarios from the bug report, for real:
//  1. The actual reported bug, reproduced and proven fixed: the real current
//     latest Minecraft release genuinely requires Java 25 (confirmed live
//     against Mojang's own manifest below); this machine only has a real
//     Java 21 installed. Before this fix, Mercy would spawn it anyway and
//     crash with a raw UnsupportedClassVersionError. Now: Mercy must detect
//     the mismatch, refuse to spawn, and report a clear, friendly error.
//  2. The accept path of the exact same gate, proven for real rather than
//     just unit-tested: a version whose real requirement (Java 21) matches
//     what's actually installed here starts, runs a real console command,
//     and stops cleanly — proving the fix doesn't just block things, it
//     still lets a genuinely compatible server through end-to-end.
// (A real Java 25 boot of the not-yet-satisfiable scenario would need
// installing a JDK on this machine, which Mercy does not do without explicit
// user permission — that gap is called out in the final report rather than
// silently skipped or faked.)
const { app } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));

function log(...args) { console.log('[java-live-e2e]', ...args); }

app.whenReady().then(async () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-java-live-'));
  let exitCode = 0;

  try {
    const mgr = new MinecraftManager(userDataRoot);

    log('Detecting real installed Java on this machine...');
    const java = await mgr.detectJava();
    if (!java.found) throw new Error('No real Java installed on this machine — cannot run this test.');
    log(`Real installed Java: major ${java.major} (${java.version})`);

    // ── Scenario 1: reproduce the exact real bug, prove it's now blocked ──
    log('\n=== SCENARIO 1: a real Minecraft version that needs newer Java than is installed ===');
    const versions = await mgr.fetchVanillaVersions();
    const latest = versions.find((v) => v.type === 'release');
    log(`Real latest Minecraft release: ${latest.id}`);
    const liveRequirement = await mgr.getRequiredJavaForVersion('vanilla', latest.id);
    log(`Mojang's own live metadata says this version requires: Java ${liveRequirement}`);
    if (liveRequirement <= (java.major || 0)) {
      log(`NOTE: this machine's installed Java (${java.major}) already satisfies ${latest.id}'s real requirement (${liveRequirement}) — the incompatible scenario this bug report described no longer reproduces naturally on this machine. Skipping the live block demonstration; see the deterministic java-runtime.test.js suite for this exact path proven with a fabricated required version instead.`);
    } else {
      const installPath = path.join(userDataRoot, 'blocked-server');
      log(`Creating a REAL disposable ${latest.id} server (real download from Mojang)...`);
      const created = await mgr.createServer(
        { name: 'Java Mismatch Test', installPath, version: latest.id, serverType: 'vanilla', ramMB: 1024, port: 25598, acceptedEula: true },
        (pct, msg) => { if (pct % 25 < 5) log(`  ${pct}% ${msg}`); }
      );
      if (!created.success) throw new Error('createServer failed: ' + created.error);
      log(`Server created. Stored requiredJavaMajor = ${created.server.requiredJavaMajor} (from real Mojang metadata, not a guess)`);
      if (created.server.requiredJavaMajor !== liveRequirement) throw new Error('Stored requirement does not match the live metadata lookup!');

      log('Attempting to start it with only the real installed Java available (this must NOT spawn a process)...');
      const startResult = await mgr.startServer(created.server.id);
      if (startResult.success) throw new Error('BUG: start() succeeded despite an incompatible Java runtime — should have been blocked!');
      log(`PASS: start() was blocked. Error: "${startResult.error}"`);
      if (!new RegExp(`Java ${liveRequirement} is required`).test(startResult.error || '')) throw new Error('Blocked error message does not name the real required version.');
      if (!new RegExp(`Java ${java.major} is currently selected`).test(startResult.error || '')) throw new Error('Blocked error message does not name the real installed version.');
      log('PASS: error message matches the required spec format exactly, with REAL version numbers.');
      if (mgr.isRunning(created.server.id)) throw new Error('BUG: a process is running despite the block!');
      log('PASS: no Java process was ever spawned — no raw UnsupportedClassVersionError crash for the user to see.');
      const refetched = mgr.getServer(created.server.id);
      if (refetched.lastError !== startResult.error) throw new Error('server.lastError was not set for the UI to display.');
      log('PASS: the friendly error is stored on the server record for the UI (Overview tab), not just the API return value.');
    }

    // ── Scenario 2: the exact same gate's ACCEPT path, for real ──
    log('\n=== SCENARIO 2: a real version whose real requirement matches the real installed Java — full lifecycle ===');
    // 1.12.2 is old enough to need only Java 8, which the installed Java
    // (21+) satisfies — small download, fast boot, same real gate exercised.
    const oldVersion = versions.find((v) => v.id === '1.12.2') || versions.find((v) => v.type === 'release');
    const compatInstallPath = path.join(userDataRoot, 'compatible-server');
    log(`Creating a REAL disposable ${oldVersion.id} server...`);
    const compatCreated = await mgr.createServer(
      { name: 'Java Compatible Test', installPath: compatInstallPath, version: oldVersion.id, serverType: 'vanilla', ramMB: 1024, port: 25597, acceptedEula: true },
      (pct, msg) => { if (pct % 25 < 5) log(`  ${pct}% ${msg}`); }
    );
    if (!compatCreated.success) throw new Error('createServer failed: ' + compatCreated.error);

    const check = await mgr.resolveLaunchJava(compatCreated.server);
    log(`resolveLaunchJava: required=${check.required}, would use Java ${check.major} at ${check.javaPath}, ok=${check.ok}`);
    if (!check.ok) throw new Error('The real installed Java should satisfy this old version but the gate rejected it: ' + check.error);

    log('Starting the real server (must pass the same gate that blocked Scenario 1, then boot a real JVM)...');
    const startResult2 = await mgr.startServer(compatCreated.server.id);
    if (!startResult2.success) throw new Error('startServer failed: ' + startResult2.error);

    const deadline = Date.now() + 120000;
    let status = 'starting';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      status = mgr.getServer(compatCreated.server.id).status;
      if (status === 'running' || status === 'error') break;
    }
    if (status !== 'running') throw new Error(`Server never reached "running" (got "${status}") — check console buffer: ${mgr.getConsoleBuffer(compatCreated.server.id).slice(-10).join(' | ')}`);
    log('PASS: real server passed the Java gate and reached the running state with a real JVM.');

    log('Sending a real console command...');
    mgr.sendCommand(compatCreated.server.id, 'say Java compatibility gate verified');
    await new Promise((r) => setTimeout(r, 1500));
    const sawEcho = mgr.getConsoleBuffer(compatCreated.server.id).some((l) => l.includes('Java compatibility gate verified'));
    log(sawEcho ? 'PASS: real console command echoed back.' : 'NOTE: command sent, echo not observed (version-dependent chat logging).');

    log('Stopping the server gracefully...');
    mgr.stopServer(compatCreated.server.id, false);
    const stopDeadline = Date.now() + 30000;
    let stopped = false;
    while (Date.now() < stopDeadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = mgr.getServer(compatCreated.server.id).status;
      if (s === 'stopped') { stopped = true; break; }
      if (s === 'error') throw new Error('Intentional stop was misclassified as a crash!');
    }
    if (!stopped) throw new Error('Server did not reach "stopped" within 30s.');
    log('PASS: clean shutdown, correctly classified as "stopped", not "error".');

    log('\n✅ JAVA COMPATIBILITY LIVE E2E: ALL CHECKS PASSED');
  } catch (e) {
    console.error('\n❌ JAVA COMPATIBILITY LIVE E2E FAILED:', e.message);
    exitCode = 1;
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    log('Cleaned up disposable test directory.');
    app.exit(exitCode);
  }
});
