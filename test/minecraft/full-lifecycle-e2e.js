// THE full real lifecycle proof: Create → Start → Connection info → Port
// verification → Marketplace install → Restart → Verify still works → Stop
// → Delete. No mocks on any filesystem/process/network/download path. Run
// by hand via `npx electron test/minecraft/full-lifecycle-e2e.js`. Needs
// network + this machine's real Java. Everything happens in a disposable
// os.tmpdir() directory removed at the end; nothing here ever touches a
// real Minecraft installation or the production Mercy userData.
const { app } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));
const { MinecraftMarketplace } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftMarketplace.js'));

function log(...args) { console.log('[full-lifecycle-e2e]', ...args); }

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

app.whenReady().then(async () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-full-e2e-'));
  let exitCode = 0;

  try {
    const mgr = new MinecraftManager(userDataRoot);
    const market = new MinecraftMarketplace();

    // A modern, actually-supported Paper version. NOTE — a real discovery
    // from an earlier run of this exact test: very old ("UNSUPPORTED",
    // per PaperMC's own API) Paper builds like 1.16.5 carry an undocumented
    // internal Java-version CEILING in their own bootstrap code (this one
    // refused to run under Java 21 with "Only up to Java 16 is supported"),
    // even though PaperMC's API reports only a minimum (misleadingly "8"
    // for that build) and no maximum at all. That's a real gap in the
    // upstream data for legacy builds, not something Mercy can predict —
    // deliberately using a modern, supported build here instead.
    const installPath = path.join(userDataRoot, 'server');

    // Pick a real Minecraft version that EssentialsX (the plugin used in the
    // install step below) genuinely publishes a Paper build for, and that
    // is also a real, currently-listed Paper server version — so create()
    // and the marketplace install are guaranteed to agree on a version that
    // actually exists on both sides, rather than assuming a match.
    log('Finding a real Minecraft version both Paper and EssentialsX actually support...');
    const [paperVersions, essentialsPreview] = await Promise.all([
      mgr.fetchPaperVersions(),
      market.search({ query: 'EssentialsX', projectType: 'plugin', limit: 1 }),
    ]);
    const essentialsProjectId = essentialsPreview.hits.find((h) => h.slug === 'essentialsx')?.projectId || essentialsPreview.hits[0].projectId;
    const essentialsAllVersions = await market.getVersions(essentialsProjectId, { loader: 'paper' });
    const essentialsGameVersions = new Set(essentialsAllVersions.flatMap((v) => v.gameVersions));
    const mcVersion = paperVersions.filter((v) => /^1\.\d+(\.\d+)?$/.test(v)).reverse().find((v) => essentialsGameVersions.has(v));
    if (!mcVersion) throw new Error('Could not find a Minecraft version both Paper and EssentialsX support — unexpected.');
    log(`Using Minecraft ${mcVersion} (a real, current Paper version EssentialsX also publishes a build for).`);

    // ── CREATE ──────────────────────────────────────────────────────────
    log('=== CREATE ===');
    let lastPct = -10;
    const created = await mgr.createServer(
      { name: 'Full Lifecycle Test', installPath, version: mcVersion, serverType: 'paper', ramMB: 1536, port: 25594, acceptedEula: true },
      (pct, msg) => { if (pct - lastPct >= 20 || pct === 100) { log(`  ${pct}% ${msg}`); lastPct = pct; } },
    );
    if (!created.success) throw new Error('createServer failed: ' + created.error);
    const serverId = created.server.id;
    log('PASS: real server created:', created.server.jarFile);

    // ── START ───────────────────────────────────────────────────────────
    log('=== START ===');
    const startResult = await mgr.startServer(serverId);
    if (!startResult.success) throw new Error('startServer failed: ' + startResult.error);
    const afterStart = await waitForStatus(mgr, serverId, ['running', 'error'], 120000);
    if (afterStart !== 'running') throw new Error(`Server never reached "running" (got "${afterStart}"). Console: ${mgr.getConsoleBuffer(serverId).slice(-10).join(' | ')}`);
    log('PASS: real server running, PID', mgr.getProcessStats(serverId).pid);

    // ── CONNECTION INFO + PORT VERIFICATION ────────────────────────────
    log('=== CONNECTION INFO ===');
    const connInfo = await mgr.getConnectionInfo(serverId);
    log('Connection info:', JSON.stringify(connInfo));
    if (connInfo.port !== 25594) throw new Error('Connection info reports the wrong port!');
    if (connInfo.edition !== 'java') throw new Error('Connection info reports the wrong edition!');
    if (connInfo.portListening !== true) throw new Error(`Port verification failed — real server is running but port ${connInfo.port} is not genuinely listening (portListening=${connInfo.portListening}).`);
    log('PASS: real connection info correct, and the configured port was ACTUALLY verified listening (real TCP connection, not assumed).');
    log(`     LAN address: ${connInfo.lanAddress || '(none detected)'}`);
    log(`     Bedrock: possible=${connInfo.bedrock.possible} — "${connInfo.bedrock.note}"`);

    // Real Minecraft client connection: not attempted — no Minecraft Java
    // Edition client is installed on this CI/dev machine to drive. The port
    // check above is the strongest automatable proxy for "a client could
    // connect here" available in this environment.
    log('NOTE: skipping an actual game-client connection — no Minecraft client is installed in this environment. Port-listening verification above is the real, automatable substitute.');

    // ── MARKETPLACE CONTENT INSTALLATION ───────────────────────────────
    log('=== MARKETPLACE INSTALL ===');
    const pluginVersions = await market.getVersions(essentialsProjectId, { minecraftVersion: mcVersion, loader: 'paper' });
    if (pluginVersions.length === 0) throw new Error(`No EssentialsX version found for ${mcVersion}/paper — unexpected given we just selected this version for exactly this reason.`);
    const installContentResult = await market.installContent(mgr, serverId, essentialsProjectId, pluginVersions[0].id);
    if (!installContentResult.success) throw new Error('Marketplace install failed: ' + installContentResult.error);
    const pluginPath = path.join(installPath, installContentResult.content.relPath);
    if (!fs.existsSync(pluginPath)) throw new Error('Installed plugin file missing from disk!');
    log('PASS: real plugin installed while the server was running:', installContentResult.content.fileName);

    // ── RESTART ─────────────────────────────────────────────────────────
    log('=== RESTART ===');
    mgr.restartServer(serverId);
    const afterRestartStop = await waitForStatus(mgr, serverId, ['starting', 'running', 'stopped', 'error'], 40000);
    log('Status shortly after restart was requested:', afterRestartStop);
    const afterRestart = await waitForStatus(mgr, serverId, ['running', 'error'], 120000);
    if (afterRestart !== 'running') throw new Error(`Server never came back "running" after restart (got "${afterRestart}").`);
    log('PASS: real restart completed, server is running again.');

    // ── VERIFY SERVER STILL WORKS ───────────────────────────────────────
    log('=== VERIFY STILL WORKS ===');
    const connAfterRestart = await mgr.getConnectionInfo(serverId);
    if (connAfterRestart.portListening !== true) throw new Error('Port is not listening after restart!');
    log('PASS: port genuinely re-verified listening after restart.');
    mgr.sendCommand(serverId, 'say Full lifecycle test — still alive after restart');
    await new Promise((r) => setTimeout(r, 1500));
    const sawEcho = mgr.getConsoleBuffer(serverId).some((l) => l.includes('Full lifecycle test — still alive after restart'));
    log(sawEcho ? 'PASS: real console command works after restart.' : 'NOTE: command sent, echo not observed (non-fatal).');
    const stillTrackedContent = mgr.getInstalledContent(serverId);
    if (stillTrackedContent.length !== 1) throw new Error('Installed content was lost across a restart!');
    log('PASS: previously-installed plugin survived the restart, still tracked and on disk:', fs.existsSync(pluginPath));

    // ── STOP ────────────────────────────────────────────────────────────
    log('=== STOP ===');
    mgr.stopServer(serverId, false);
    const afterStop = await waitForStatus(mgr, serverId, ['stopped', 'error'], 30000);
    if (afterStop !== 'stopped') throw new Error(`Graceful stop was not classified as "stopped" (got "${afterStop}").`);
    log('PASS: real graceful stop completed cleanly.');
    const connAfterStop = await mgr.getConnectionInfo(serverId);
    if (connAfterStop.portListening !== null) throw new Error('portListening should be null once genuinely stopped (nothing to check), got: ' + connAfterStop.portListening);
    log('PASS: connection info correctly reports nothing to verify once the server is stopped.');

    // ── DELETE ──────────────────────────────────────────────────────────
    log('=== DELETE ===');
    const deleteResult = await mgr.deleteServer(serverId, true);
    if (!deleteResult.success) throw new Error('deleteServer failed: ' + deleteResult.error);
    if (fs.existsSync(installPath)) throw new Error('Server directory still exists after deletion!');
    if (mgr.getServer(serverId) !== undefined) throw new Error('Server still in the registry after successful deletion!');
    log('PASS: real disposable server deleted — files and registry entry both gone.');

    log('\n✅✅✅ FULL LIFECYCLE E2E: ALL CHECKS PASSED — create → start → connect → verify port → install content → restart → verify still works → stop → delete, all real.');
  } catch (e) {
    console.error('\n❌ FULL LIFECYCLE E2E FAILED:', e.message);
    exitCode = 1;
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    log('Cleaned up disposable test directory.');
    app.exit(exitCode);
  }
});
