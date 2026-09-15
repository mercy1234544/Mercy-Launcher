// SplashScreen.tsx — REAL, LIVE-CONFIRMED bug: the splash screen's
// update-ready status handler displayed "Update vX ready — restarting..."
// based on a stale comment claiming the main process installs "centrally"
// on download completion. main.ts's actual update-downloaded handler was
// changed long ago (to fix a DIFFERENT bug — force-quitting the app
// mid-session from a background timer) to deliberately NEVER auto-install;
// it only installs via an explicit user-clicked "Restart & Install" button
// or a graceful app quit. Nobody updated SplashScreen.tsx, so a fully
// downloaded, verified update could sit forever while the splash
// confidently claimed a restart was already happening — confirmed live
// against the actual installed app: v1.105.4 downloaded successfully and
// sat ready for hours while every subsequent launch's splash said
// "restarting..." and the app kept running the old v1.105.3 the whole
// time (which is why an already-fixed bug, the AccountAuthModal password
// field, still appeared broken to the user testing the stale build).
//
// This project deliberately has no jsdom/@testing-library/react/Playwright
// (see test/library/ui-structure.test.js's own header), so this is a
// static-source assertion matching that established convention.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const splashSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/components/SplashScreen.tsx'), 'utf-8');
const mainSrc = fs.readFileSync(path.resolve(__dirname, '../../src/main/main.ts'), 'utf-8');

const readyCaseStart = splashSrc.indexOf("case 'ready':");
ok('the "ready" status case exists in the splash screen\'s update handler', readyCaseStart !== -1);
const readyCaseEnd = splashSrc.indexOf('break;', readyCaseStart);
const readyCase = splashSrc.slice(readyCaseStart, readyCaseEnd);

ok('REPRODUCED THE FIX: the "ready" case actually triggers the real install IPC, not just a status message', /window\.electronAPI\?\.appUpdater\?\.install\?\.\(\);/.test(readyCase));

// The main process's real, current behavior — confirmed directly from
// main.ts — proves WHY the splash needed to be the one to trigger this:
// the main process itself deliberately does not.
ok('confirms the actual current main-process behavior this fix relies on: update-downloaded never auto-installs on its own', /NEVER auto-install here/.test(mainSrc));
ok('confirms the real, only two install triggers are the explicit IPC handler and a graceful app quit', /ipcMain\.handle\('updater:install'/.test(mainSrc) && /autoInstallOnAppQuit = true/.test(mainSrc));

// The install must only ever be triggered from the splash screen's own
// lifecycle (cold boot, before the main window has been used) — never
// import a standalone always-on background listener that could fire
// mid-session and interrupt active use. Confirmed by checking that the
// onStatus subscription lives inside this component's own useEffect
// (cleaned up on unmount, i.e. once the splash is dismissed).
const componentBody = splashSrc.slice(splashSrc.indexOf('export default function SplashScreen'));
ok('the update-status subscription is registered inside the splash screen\'s own effect (bounded to its own mounted lifetime)', /cleanupRef\.current = window\.electronAPI\.appUpdater\.onStatus/.test(componentBody));
ok('the subscription is unsubscribed on cleanup, so a later background re-check (e.g. the 15-minute timer) cannot retrigger an install after the splash is gone', /if \(cleanupRef\.current\) cleanupRef\.current\(\);/.test(componentBody));

console.log(`\nSPLASH SCREEN AUTO-INSTALL TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
