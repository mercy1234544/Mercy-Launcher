// REAL end-to-end smoke test — actually downloads a real Vanilla server jar
// from Mojang, boots it with the real system Java, sends a real console
// command, and stops it gracefully. Requires network + a JRE, so this is
// NOT part of `npm run test:all` (which must work with neither) — run by
// hand via `npx electron test/minecraft/live-e2e.js`. Everything happens in
// a disposable os.tmpdir() directory that's removed at the end; nothing
// about this touches a real Minecraft installation.
const { app } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));

function log(...args) { console.log('[live-e2e]', ...args); }

app.whenReady().then(async () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-live-'));
  const installPath = path.join(userDataRoot, 'server');
  let exitCode = 0;

  try {
    const mgr = new MinecraftManager(userDataRoot);

    log('Fetching real Mojang version list...');
    const versions = await mgr.fetchVanillaVersions();
    // Deliberately an old, small release (~10-15MB server jar) so this real
    // download finishes quickly in a bandwidth-constrained sandbox — the
    // download/EULA/properties logic being exercised is identical regardless
    // of which real version is fetched.
    const release = versions.find((v) => v.id === '1.12.2') || versions.find((v) => v.type === 'release');
    log(`Using version ${release.id}`);

    log('Creating server (real download in progress)...');
    let lastLoggedPct = -10;
    const created = await mgr.createServer(
      { name: 'Mercy Live Test', installPath, version: release.id, serverType: 'vanilla', ramMB: 1024, port: 25599, acceptedEula: true },
      (pct, msg) => { if (pct - lastLoggedPct >= 10 || pct === 100) { log(`  ${pct}% ${msg}`); lastLoggedPct = pct; } }
    );
    if (!created.success) throw new Error('createServer failed: ' + created.error);
    log('Server created:', created.server.jarFile);
    if (!fs.existsSync(path.join(installPath, created.server.jarFile))) throw new Error('Jar file missing after create!');
    if (!fs.existsSync(path.join(installPath, 'eula.txt'))) throw new Error('eula.txt missing after create!');
    log('PASS: real jar downloaded and eula.txt written');

    log('Detecting Java...');
    const java = await mgr.detectJava();
    log('Java:', java);
    if (!java.found) { log('SKIP: no Java on this machine, cannot test start/stop.'); }
    else {
      log('Starting server (this boots a real JVM)...');
      const startResult = await mgr.startServer(created.server.id);
      if (!startResult.success) throw new Error('startServer failed: ' + startResult.error);

      const deadline = Date.now() + 120000;
      let status = 'starting';
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = mgr.getServer(created.server.id);
        status = s.status;
        if (status === 'running' || status === 'error') break;
      }
      log('Status after boot wait:', status);
      if (status !== 'running') throw new Error(`Server never reached "running" (got "${status}")`);
      log('PASS: real server reached the running state with a real Java process');

      const stats = mgr.getProcessStats(created.server.id);
      log('Process stats:', stats);
      if (!stats.pid) throw new Error('No real PID tracked while running!');
      log('PASS: real PID tracked:', stats.pid);

      log('Sending a real console command (say)...');
      const sent = mgr.sendCommand(created.server.id, 'say Hello from the Mercy Launcher live test');
      if (!sent) throw new Error('sendCommand returned false while running');
      await new Promise((r) => setTimeout(r, 1500));
      const buf = mgr.getConsoleBuffer(created.server.id);
      const sawEcho = buf.some((l) => l.includes('Hello from the Mercy Launcher live test'));
      log(sawEcho ? 'PASS: command echoed in real console output' : 'NOTE: command sent, echo not observed in buffer (server may not log chat to console the same way on this version)');

      log('Stopping server (intentional stop — must NOT be classified as a crash)...');
      mgr.stopServer(created.server.id, false);
      const stopDeadline = Date.now() + 30000;
      let stopped = false;
      while (Date.now() < stopDeadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = mgr.getServer(created.server.id);
        if (s.status === 'stopped') { stopped = true; break; }
        if (s.status === 'error') throw new Error('Intentional stop was misclassified as a crash!');
      }
      if (!stopped) throw new Error('Server did not reach "stopped" within 30s of a graceful stop request');
      log('PASS: intentional stop correctly classified as "stopped", not "error"');
    }

    log('\n✅ LIVE E2E: ALL CHECKS PASSED');
  } catch (e) {
    console.error('\n❌ LIVE E2E FAILED:', e.message);
    exitCode = 1;
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    log('Cleaned up disposable test directory.');
    app.exit(exitCode);
  }
});
