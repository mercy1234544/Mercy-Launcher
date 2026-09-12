// Proves the REAL bug found by inspecting this exact installation's own
// main.log: every release published this session showed "New version X
// has been downloaded" followed ~1-2 seconds later by "Install on explicit
// quitAndInstall" with ZERO user action in between — main.ts's
// update-downloaded handler was unconditionally auto-restarting the whole
// app 3 seconds after any background download finished (autoDownload
// defaults to true, plus a 15-minute re-check timer, so this fired often
// and could happen while the user was actively using the app on any page).
//
// main.ts isn't unit-testable in isolation (it wires the whole Electron app
// at import time — see test/library/ui-structure.test.js's own header for
// why source-text assertion is this codebase's established fallback here).
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const mainSrc = fs.readFileSync(path.resolve(__dirname, '../../src/main/main.ts'), 'utf-8');

function handlerBody(marker) {
  const start = mainSrc.indexOf(marker);
  if (start === -1) return null;
  return mainSrc.slice(start, start + 1200);
}

const downloadedHandler = handlerBody("autoUpdater.on('update-downloaded'");
const installIpcHandler = handlerBody("ipcMain.handle('updater:install'");

ok('update-downloaded handler exists', !!downloadedHandler);
ok(
  'update-downloaded NEVER auto-installs — no setTimeout(triggerQuitAndInstall,...) and no direct triggerQuitAndInstall() call in its body',
  !!downloadedHandler &&
  !/setTimeout\(\s*triggerQuitAndInstall/.test(downloadedHandler) &&
  !/(?<!function )triggerQuitAndInstall\(\)/.test(downloadedHandler.replace(/\/\/.*$/gm, ''))
);
ok('update-downloaded still tells the renderer the update is ready (status: \'ready\')', !!downloadedHandler && /status:\s*'ready'/.test(downloadedHandler));

ok('updater:install IPC handler exists (the user\'s own explicit "Restart Now" action)', !!installIpcHandler);
ok('updater:install still genuinely triggers the real install', !!installIpcHandler && /triggerQuitAndInstall/.test(installIpcHandler));

ok(
  'autoInstallOnAppQuit is still enabled, so a downloaded update still installs the next time the user quits normally (electron-updater\'s own safe default), even if they never click Restart',
  /autoUpdater\.autoInstallOnAppQuit\s*=\s*true/.test(mainSrc)
);

// The single-flight guard (a real, separate, already-fixed bug — see
// test/updater/quit-and-install-guard.test.js) must still exist regardless,
// since updater:install remains a real trigger path.
ok('the single-flight quitAndInstall guard is still present', /function triggerQuitAndInstall/.test(mainSrc) && /updateInstallTriggered/.test(mainSrc));

console.log(`\nNO-AUTO-RESTART TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
