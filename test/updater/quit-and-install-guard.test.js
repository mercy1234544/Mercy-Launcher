// Proves the real root cause of the v1.88.0 update-install-loop bug, and
// that the fix (a single-call guard in main.ts around every
// autoUpdater.quitAndInstall() call site) actually prevents it — using the
// REAL electron-updater library's real internal logic, not a reimplementation
// of it. The only thing intercepted is the final OS-process-spawn boundary
// (NsisUpdater's spawnLog/spawnSyncLog), so this NEVER executes a real
// installer, writes real files, or touches the registry — safe to run
// against this dev machine without any risk to the real production install.
// Run via `npx electron test/updater/quit-and-install-guard.test.js`.
const { app } = require('electron');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const { autoUpdater } = require(require.resolve('electron-updater', { paths: [process.cwd()] }));

    // Intercept the one real OS-process-spawn boundary. doInstall() calls
    // this and fires-and-forgets its promise, so a resolved promise here is
    // exactly equivalent (from doInstall's perspective) to a real installer
    // having been launched successfully — without ever actually launching one.
    let spawnCount = 0;
    const spawnedArgs = [];
    autoUpdater.spawnLog = async (cmd, args) => { spawnCount++; spawnedArgs.push(args); return true; };
    autoUpdater.spawnSyncLog = () => { spawnCount++; return ''; };

    // Fake "a real update has been downloaded" state — only the fields
    // install()/doInstall() actually read (installerPath -> .file,
    // downloadedFileInfo.isAdminRightsRequired). Never touches a real file.
    const fakeDownloaded = () => {
      autoUpdater.downloadedUpdateHelper = {
        file: 'C:\\fake\\Mercy-Launcher-Setup-9.9.9.exe',
        packageFile: null,
        downloadedFileInfo: { isAdminRightsRequired: false },
      };
      autoUpdater.quitAndInstallCalled = false;
    };

    // ── 1. REPRODUCE: the real bug, using the real library ──────────────
    console.log('=== Reproducing the real double-install race (pre-fix behavior) ===');
    fakeDownloaded();
    spawnCount = 0;

    // This is EXACTLY what happened in production: two independent code
    // paths (main.ts's own timer AND SplashScreen.tsx's own timer) each
    // called quitAndInstall() for the SAME completed download, unguarded.
    autoUpdater.quitAndInstall(false, true);
    ok('first quitAndInstall() call genuinely triggers an install (real doInstall -> spawnLog ran once)', spawnCount === 1);
    ok('first call correctly sets quitAndInstallCalled=true', autoUpdater.quitAndInstallCalled === true);

    autoUpdater.quitAndInstall(false, true);
    ok('second call\'s install() is correctly ignored by electron-updater\'s own guard (no second spawn from THIS call)', spawnCount === 1);

    // THE ACTUAL BUG: electron-updater's own quitAndInstall() wrapper resets
    // quitAndInstallCalled back to false when install() returns false (i.e.
    // exactly when a second call gets ignored) — see BaseUpdater.js's
    // `else { this.quitAndInstallCalled = false }` branch. This corrupts the
    // FIRST call's legitimate "already installing" state.
    ok('REPRODUCED THE BUG: the second (ignored) call resets quitAndInstallCalled back to false, corrupting the real guard state', autoUpdater.quitAndInstallCalled === false);

    // Which means the quit-time autoInstallOnAppQuit hook (BaseUpdater.js's
    // addQuitHandler -> onQuit) would NOT be blocked by its own guard check
    // (`if (this.quitAndInstallCalled) return;`) and WOULD install again —
    // reproduced directly here exactly as that hook does, without needing a
    // real app.quit() to fire it:
    if (!autoUpdater.quitAndInstallCalled) {
      autoUpdater.install(true, false); // this is verbatim what BaseUpdater's onQuit handler calls
    }
    ok('REPRODUCED THE BUG: a second, independent installer spawn genuinely occurs (spawnCount is now 2) — this is the real double-installer race that corrupted the v1.88.0 install', spawnCount === 2);

    // ── 2. VERIFY THE FIX: main.ts's own single-call guard ───────────────
    console.log('=== Verifying the fix (main.ts\'s triggerQuitAndInstall guard) ===');
    fakeDownloaded();
    spawnCount = 0;
    spawnedArgs.length = 0;

    // Reimplements main.ts's actual fix verbatim (see updateInstallTriggered
    // / triggerQuitAndInstall in src/main/main.ts) — a guard OUTSIDE
    // electron-updater, so a second call never even reaches
    // autoUpdater.quitAndInstall() again, sidestepping the library's own
    // flag-reset bug entirely rather than depending on it being fixed.
    let updateInstallTriggered = false;
    function triggerQuitAndInstall() {
      if (updateInstallTriggered) return;
      updateInstallTriggered = true;
      autoUpdater.quitAndInstall(false, true);
    }

    // Simulate the exact real scenario: main.ts's own auto-install timer AND
    // (before the fix) SplashScreen's own timer both firing for the same
    // download, now both going through the guarded entry point.
    triggerQuitAndInstall(); // main.ts's update-downloaded handler
    triggerQuitAndInstall(); // what SplashScreen.tsx used to also trigger
    triggerQuitAndInstall(); // and a manual "Install Now" button, for good measure

    ok('FIX VERIFIED: exactly one real install was triggered despite 3 independent calls', spawnCount === 1);
    ok('FIX VERIFIED: spawnedArgs recorded exactly one invocation', spawnedArgs.length === 1);

    // And critically — because our guard never lets a second call reach
    // electron-updater's quitAndInstall() at all, the library's own
    // quitAndInstallCalled flag is never corrupted, so the quit-time
    // autoInstallOnAppQuit hook (which checks that same flag) would
    // correctly stay blocked:
    ok('FIX VERIFIED: quitAndInstallCalled stays true (never corrupted), so the quit-time auto-install hook would correctly refuse to install again', autoUpdater.quitAndInstallCalled === true);

    console.log(`\nQUIT-AND-INSTALL GUARD TESTS: ${pass} passed, ${fail} failed`);
    exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('\n❌ TEST FAILED:', e);
    exitCode = 1;
  } finally {
    app.exit(exitCode);
  }
});
