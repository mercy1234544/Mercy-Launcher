// Regression test for a real, reproduced production installer failure:
// updating Mercy Launcher through its own updater showed the real NSIS
// installer, which then failed with "Failed to uninstall old application
// files. Please try running the installer again: 2".
//
// Root cause #1, confirmed by reading electron-updater's own real source
// (node_modules/electron-updater/out/BaseUpdater.js): quitAndInstall()
// spawns the NEW installer process SYNCHRONOUSLY, immediately — this app's
// own app.quit() is only called afterward, inside a setImmediate callback
// deep inside electron-updater itself. That means the new installer can
// start trying to close/replace this app's own files WHILE this process
// (including every open BrowserWindow, which holds real OS file/DLL
// handles) is still fully alive — NSIS can't delete a file a live process
// still holds open.
//
// The naive fix (destroy every window, THEN wait a short delay, THEN call
// quitAndInstall) turned out to be a SECOND, separate real bug, caught only
// by testing this against a REAL Electron process: destroying the last
// window synchronously fires this app's own real 'window-all-closed'
// handler (main.ts: `if (process.platform !== 'darwin') app.quit();`).
// app.quit() runs 'before-quit'/'will-quit' INLINE and the process can
// exit as soon as the current synchronous call stack unwinds — a
// setTimeout scheduled after window-destroy may simply NEVER FIRE, because
// the process is already gone by the time it would run. That would have
// silently skipped installing the update entirely — arguably worse than
// the original bug. The actual fix: destroy every window AND call
// quitAndInstall() in the SAME synchronous tick, with no delay — proven
// below to reliably still reach the real installer spawn call even with
// this app's real window-all-closed/app.quit() handler wired up exactly
// as it is in main.ts.
//
// This is a REAL Electron process (real BrowserWindow, real
// window-all-closed -> app.quit() cascade) with the REAL electron-updater
// library — only the actual OS process spawn boundary (spawnLog) is
// intercepted, exactly like quit-and-install-guard.test.js's own
// established technique, so this never executes a real installer or
// touches the real production install.
// Run via `npx electron test/updater/quit-and-install-window-teardown.test.js`.
const { app, BrowserWindow } = require('electron');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// Mirrors main.ts's own real 'window-all-closed' handler verbatim — the
// exact real behavior that made the naive setTimeout-based fix silently
// skip installing the update entirely (see this file's own header).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const { autoUpdater } = require(require.resolve('electron-updater', { paths: [process.cwd()] }));

    const win = new BrowserWindow({ show: false });
    ok('a real BrowserWindow was created and is not destroyed yet', win.isDestroyed() === false);

    autoUpdater.downloadedUpdateHelper = {
      file: 'C:\\fake\\Mercy-Launcher-Setup-9.9.9.exe',
      packageFile: null,
      downloadedFileInfo: { isAdminRightsRequired: false },
    };
    autoUpdater.quitAndInstallCalled = false;

    // Captures the exact moment electron-updater actually tries to spawn
    // the real installer process — the same real internal call site the
    // real NSIS installer is launched from in production.
    let windowWasDestroyedWhenSpawnHappened = null;
    let spawnCount = 0;
    autoUpdater.spawnLog = async () => {
      spawnCount++;
      windowWasDestroyedWhenSpawnHappened = win.isDestroyed();
      return true;
    };
    autoUpdater.spawnSyncLog = () => { spawnCount++; return ''; };

    // Reimplements main.ts's actual fix verbatim (see triggerQuitAndInstall
    // in src/main/main.ts) — window teardown and quitAndInstall() in the
    // SAME synchronous tick, no delay in between.
    let updateInstallTriggered = false;
    function triggerQuitAndInstall() {
      if (updateInstallTriggered) return;
      updateInstallTriggered = true;
      for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch {} }
      autoUpdater.quitAndInstall(false, true);
    }

    triggerQuitAndInstall();

    // No async wait needed — everything above is synchronous by design,
    // which is the entire point of this fix (see this file's header on why
    // a setTimeout-based version was a real, separate bug).
    ok('the window is destroyed', win.isDestroyed() === true);
    ok(
      'REPRODUCED THE FIX: the real installer spawn call was genuinely reached SYNCHRONOUSLY, even with this app\'s real window-all-closed -> app.quit() handler firing in between — the naive setTimeout-delayed version failed this exact assertion (spawnCount stayed 0 forever)',
      spawnCount === 1
    );
    ok(
      'REPRODUCED THE FIX: by the real moment electron-updater actually spawned the installer, the window was ALREADY destroyed — this app had already released its own file handles, instead of racing the installer for them',
      windowWasDestroyedWhenSpawnHappened === true
    );

    // A second, racing call must still be a genuine no-op — the existing
    // single-flight guard (proven in quit-and-install-guard.test.js) must
    // not be weakened by this change.
    const spawnCountBefore = spawnCount;
    triggerQuitAndInstall();
    ok('a second, racing triggerQuitAndInstall() call is still correctly ignored — the single-flight guard is unchanged', spawnCount === spawnCountBefore);

    console.log(`\nQUIT-AND-INSTALL WINDOW TEARDOWN TESTS: ${pass} passed, ${fail} failed`);
    exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('\n❌ TEST FAILED:', e);
    exitCode = 1;
  } finally {
    app.exit(exitCode);
  }
});
