// REAL end-to-end proof for the resource-usage + Active-Servers work — no
// mocks on the process/metrics paths. Run by hand via
// `npx electron test/minecraft/resource-status-live-e2e.js`. Needs network
// (one real Bedrock download, reused for a second disposable instance via a
// local copy — no second download) and a real Windows environment (spawns
// real bedrock_server.exe processes, queries real Windows process metrics).
// Only ever touches disposable temp directories, removed at the end —
// NEVER the real production Minecraft install or userData.
//
// Bedrock is used as the real test process here (not Java) because it starts
// in seconds with no JVM/Java-runtime dependency, and getProcessStats()'s
// real per-process CPU/memory query works identically for any PID Mercy
// spawns — this is a property of Windows process querying, not something
// specific to either Minecraft edition.
//
// Demonstrates the full requested flow for real:
//   create → verify initial port → change port → verify Connect data
//   updates immediately → start → verify real running status → verify
//   Active-Servers source-of-truth (getAllServers().filter(running).length)
//   → verify real, non-fake CPU%/memory via Windows' own Get-Process →
//   second disposable server → both running → Active Servers = 2 → stop one
//   → Active Servers = 1 → stop the other → Active Servers = 0 → verify no
//   stale PID/process state → delete both → verify registry/filesystem
//   cleanup.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));

function log(...args) { console.log('[resource-status-live-e2e]', ...args); }

async function waitForStatus(mgr, id, wanted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = mgr.getServer(id).status;
  while (Date.now() < deadline) {
    if (wanted.includes(status)) return status;
    await new Promise((r) => setTimeout(r, 1000));
    status = mgr.getServer(id).status;
  }
  return status;
}

const activeServerCount = (mgr) => mgr.getAllServers().filter((s) => s.status === 'running').length;

app.whenReady().then(async () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-resource-e2e-'));
  let exitCode = 0;

  try {
    const mgr = new MinecraftManager(userDataRoot);

    // ── CREATE #1: real Bedrock download (also proves create/import ports
    // work identically to the deterministic port-sync suite, against a
    // genuinely live-registered, monitorable server this time) ───────────
    log('=== CREATE #1: real Bedrock download ===');
    const links = await mgr.fetchBedrockVersions();
    const installPath1 = path.join(userDataRoot, 'server-1');
    const create1 = await mgr.createServer({
      name: 'Resource E2E Server 1', installPath: installPath1, version: '', serverType: 'bedrock', ramMB: 0,
      port: 25701, acceptedEula: true, bedrockChannel: 'stable',
      // Deliberately NOT overriding online-mode here: Bedrock Dedicated
      // Server genuinely refuses to start with online-mode=false unless the
      // allow-list is also explicitly configured (a real Mojang safety
      // check, not a Mercy bug — confirmed via this server's own real
      // "Using an allowlist without online authentication..." refusal
      // during test development). Leaving Mojang's own shipped default
      // (online-mode=true) avoids that entirely; this test never needs a
      // real client to actually connect.
    }, () => {});
    if (!create1.success) throw new Error('createServer #1 failed: ' + create1.error);
    const id1 = create1.server.id;
    log(`PASS: server 1 created, real version ${create1.server.version}`);

    // 2-4. Port appears correctly, then changing it updates Connect data immediately.
    const info1a = await mgr.getConnectionInfo(id1);
    if (info1a.port !== 25701) throw new Error(`Expected initial port 25701, got ${info1a.port}`);
    log('PASS: initial port appears correctly in real connection data.');
    mgr.writeProperties(id1, { 'server-port': '25702' });
    const info1b = await mgr.getConnectionInfo(id1);
    if (info1b.port !== 25702) throw new Error(`Connect data did not immediately reflect the new port — got ${info1b.port}`);
    log('PASS: Connect data immediately used the new port after a real property change — no stale port.');
    // Move it back so the server actually starts on the port we registered
    // it against for the rest of this test (writeProperties already proved
    // the sync works; no need to keep the changed port for what follows).
    mgr.writeProperties(id1, { 'server-port': '25701' });

    // ── SECOND disposable server, reusing the already-downloaded real
    // artifacts (no second network download) ────────────────────────────
    log('=== CREATE #2: second disposable server (reused real artifacts, no re-download) ===');
    const installPath2 = path.join(userDataRoot, 'server-2');
    fs.cpSync(installPath1, installPath2, { recursive: true });
    // Both server-port (IPv4) AND server-portv6 need distinct values — the
    // copied fixture's IPv6 port defaults to the same value as server 1's,
    // so leaving it unchanged causes a real IPv6 bind collision (confirmed
    // live: "Port [19133] may be in use by another process") even though
    // the IPv4 ports themselves are already unique.
    const props2 = fs.readFileSync(path.join(installPath2, 'server.properties'), 'utf-8')
      .replace(/server-port=\d+/, 'server-port=25801')
      .replace(/server-portv6=\d+/, 'server-portv6=25802');
    fs.writeFileSync(path.join(installPath2, 'server.properties'), props2);
    const detected2 = await mgr.detectExistingServer(installPath2);
    if (!detected2.valid) throw new Error('Second disposable server was not detected as valid');
    const import2 = await mgr.importServer(installPath2, 'Resource E2E Server 2', 0);
    if (!import2.success) throw new Error('import #2 failed: ' + import2.error);
    const id2 = import2.server.id;
    log('PASS: second disposable server registered.');

    // ── Neither has started yet — Active Servers must be 0, and importing
    // a stopped server must never count it as active. ───────────────────
    if (activeServerCount(mgr) !== 0) throw new Error(`Active Servers should be 0 before either server starts, got ${activeServerCount(mgr)}`);
    log('PASS: Active Servers is 0 before anything starts (importing a stopped server does not count it as active).');

    // ── START #1 — real process, real status, real Active-Servers count ──
    log('=== START #1 ===');
    const start1 = await mgr.startServer(id1);
    if (!start1.success) throw new Error('startServer #1 failed: ' + start1.error);
    const status1 = await waitForStatus(mgr, id1, ['running', 'error'], 90000);
    if (status1 !== 'running') throw new Error(`Server 1 did not reach running — got ${status1}. Console tail: ${mgr.getConsoleBuffer(id1).slice(-15).join(' | ')}`);
    log('PASS: server 1 reached real running status.');
    if (activeServerCount(mgr) !== 1) throw new Error(`Active Servers should be 1 with one server running, got ${activeServerCount(mgr)}`);
    log('PASS: Active-Servers source of truth (getAllServers().filter(running).length) reports 1.');

    // ── Real resource metrics — Windows' own Get-Process, never fabricated.
    log('=== Resource metrics: real Windows process query ===');
    const stats1a = await mgr.getProcessStats(id1);
    if (!stats1a.pid) throw new Error('No real PID recorded for a running server!');
    if (!stats1a.metricsAvailable) throw new Error('Real process metrics were not available for a genuinely running process: ' + stats1a.metricsError);
    if (typeof stats1a.memoryBytes !== 'number' || stats1a.memoryBytes <= 0) throw new Error(`Memory usage was not a real positive number: ${stats1a.memoryBytes}`);
    log(`PASS: real memory usage read from Windows: ${(stats1a.memoryBytes / 1024 / 1024).toFixed(1)} MB (PID ${stats1a.pid}). CPU% on first sample: ${stats1a.cpuPercent} (null is correct — no prior sample yet).`);
    if (stats1a.cpuPercent !== null) throw new Error('First-ever sample should have cpuPercent=null (no prior sample to diff against) — got a value instead, which would mean a fabricated/carried-over number.');

    await new Promise((r) => setTimeout(r, 3000));
    const stats1b = await mgr.getProcessStats(id1);
    if (typeof stats1b.cpuPercent !== 'number' || stats1b.cpuPercent < 0 || stats1b.cpuPercent > 100) {
      throw new Error(`Second sample should have a real, in-range CPU% — got ${stats1b.cpuPercent}`);
    }
    log(`PASS: real CPU% derived from two live Windows samples: ${stats1b.cpuPercent.toFixed(2)}% (in valid 0-100 range, genuinely measured, not invented).`);

    // ── START #2 — a second concurrently-running server ───────────────────
    log('=== START #2 ===');
    const start2 = await mgr.startServer(id2);
    if (!start2.success) throw new Error('startServer #2 failed: ' + start2.error);
    const status2 = await waitForStatus(mgr, id2, ['running', 'error'], 60000);
    if (status2 !== 'running') throw new Error(`Server 2 did not reach running — got ${status2}. Console tail: ${mgr.getConsoleBuffer(id2).slice(-15).join(' | ')}`);
    if (activeServerCount(mgr) !== 2) throw new Error(`Active Servers should be 2 with both running, got ${activeServerCount(mgr)}`);
    log('PASS: Active Servers correctly reports 2 with two real servers running simultaneously.');

    // ── STOP #1 — count drops to 1 ─────────────────────────────────────────
    log('=== STOP #1 ===');
    mgr.stopServer(id1, false);
    await waitForStatus(mgr, id1, ['stopped'], 30000);
    if (mgr.getServer(id1).status !== 'stopped') throw new Error('Server 1 did not reach stopped');
    if (activeServerCount(mgr) !== 1) throw new Error(`Active Servers should be 1 after stopping one of two, got ${activeServerCount(mgr)}`);
    log('PASS: Active Servers correctly drops to 1 after stopping one server.');
    if (mgr.getServer(id1).pid !== null) throw new Error('Stale PID left behind after stop!');
    if (mgr.isRunning(id1)) throw new Error('isRunning() still true after a real stop — stale process state!');
    log('PASS: no stale PID/process state remains for the stopped server.');

    // ── STOP #2 — count drops to 0 ─────────────────────────────────────────
    log('=== STOP #2 ===');
    mgr.stopServer(id2, false);
    await waitForStatus(mgr, id2, ['stopped'], 30000);
    if (activeServerCount(mgr) !== 0) throw new Error(`Active Servers should be 0 after stopping both, got ${activeServerCount(mgr)}`);
    log('PASS: Active Servers correctly returns to 0 after stopping the second server.');

    // Post-stop metrics must honestly report unavailable, never a stale/last-seen number.
    const statsAfterStop = await mgr.getProcessStats(id1);
    if (statsAfterStop.metricsAvailable !== false || statsAfterStop.pid !== null) throw new Error('getProcessStats did not honestly report "no process" after the server stopped!');
    log('PASS: getProcessStats honestly reports unavailable/null for a stopped server (no stale numbers).');

    // ── DELETE both + verify cleanup ──────────────────────────────────────
    log('=== DELETE both disposable servers ===');
    const del1 = await mgr.deleteServer(id1, true);
    if (!del1.success || fs.existsSync(installPath1)) throw new Error('deleteServer #1 failed or left files behind');
    const del2 = await mgr.deleteServer(id2, true);
    if (!del2.success || fs.existsSync(installPath2)) throw new Error('deleteServer #2 failed or left files behind');
    if (mgr.getAllServers().length !== 0) throw new Error('Registry not empty after deleting both disposable servers');
    log('PASS: both disposable servers genuinely deleted from disk and registry.');

    log('\n✅✅✅ RESOURCE + ACTIVE-SERVERS LIVE E2E: ALL CHECKS PASSED');
  } catch (e) {
    console.error('\n❌ RESOURCE + ACTIVE-SERVERS LIVE E2E FAILED:', e.message);
    exitCode = 1;
  } finally {
    try { for (const win of BrowserWindow.getAllWindows()) win.destroy(); } catch {}
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    log('Cleaned up disposable test directory.');
    app.exit(exitCode);
  }
});
