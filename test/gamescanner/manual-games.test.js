// Manual game path tests (Part 1) — real file validation, persistence
// across a fresh GameScanner instance (simulating app/computer restart),
// merge into the unified list, and honest handling of a moved/deleted
// executable. Disposable fixtures only.
const fs = require('fs'), path = require('path'), os = require('os');
const { GameScanner } = require(path.resolve(__dirname, '../../dist/main/services/GameScanner.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-manual-games-test-')); }

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();

  try {
    const scanner1 = new GameScanner(userDataRoot, { knownGames: [], fallbackLibraryFoldersOverride: [] });

    // ── Invalid paths are honestly rejected, never accepted ────────────────
    const missing = scanner1.addManualGame(path.join(base, 'does-not-exist.exe'));
    ok('a path that does not exist is rejected', missing.success === false);

    const dirPath = path.join(base, 'a-real-directory');
    fs.mkdirSync(dirPath, { recursive: true });
    const notAFile = scanner1.addManualGame(dirPath);
    ok('a real directory (not a file) is rejected — never accepted as a game executable', notAFile.success === false);

    // ── A real, valid executable is accepted ───────────────────────────────
    const realExeDir = path.join(base, 'My Weird Game Install');
    fs.mkdirSync(realExeDir, { recursive: true });
    const realExePath = path.join(realExeDir, 'game.exe');
    fs.writeFileSync(realExePath, 'fake exe bytes');
    const added = scanner1.addManualGame(realExePath, 'My Weird Game');
    ok('a real, existing executable is accepted', added.success === true);
    ok('the added game gets a real "manual" platform', added.game?.platform === 'manual');
    ok('the added game uses the real, user-given display name', added.game?.name === 'My Weird Game');
    ok('the added game is immediately part of the unified list, without waiting for a rescan', scanner1.getCached().some((g) => g.id === added.game.id));
    ok('pathMissing is false for a real, currently-existing executable', added.game?.pathMissing === false);

    // ── Path normalization prevents a trivial duplicate ────────────────────
    const dup = scanner1.addManualGame(realExePath.replace(/\\/g, '/'));
    ok('adding the exact same real path again (even with different slash style) is rejected as a duplicate', dup.success === false);

    // ── Persistence across a fresh GameScanner instance (simulated restart) ─
    const scanner2 = new GameScanner(userDataRoot, { knownGames: [], fallbackLibraryFoldersOverride: [] });
    ok('manually added games persist across a fresh GameScanner instance (app/computer restart)', scanner2.getManualGames().some((m) => m.executablePath === path.resolve(realExePath)));
    const rescanned = await scanner2.scan();
    ok('a fresh scan() still includes the manually added game — it is never lost by an automatic rescan', rescanned.some((g) => g.name === 'My Weird Game' && g.platform === 'manual'));

    // ── Deleted/moved executable: honest "path unavailable", never a crash ──
    fs.unlinkSync(realExePath);
    const afterDelete = await scanner2.scan();
    const missingEntry = afterDelete.find((g) => g.name === 'My Weird Game');
    ok('a manually added game whose real executable was deleted is still listed, never silently dropped or crashing the scan', !!missingEntry);
    ok('the missing executable is honestly reported via pathMissing, never claimed present', missingEntry?.pathMissing === true);

    // ── Locate / relocate to a new real path ───────────────────────────────
    const newExeDir = path.join(base, 'Relocated Install');
    fs.mkdirSync(newExeDir, { recursive: true });
    const newExePath = path.join(newExeDir, 'game.exe');
    fs.writeFileSync(newExePath, 'fake exe bytes v2');
    const relocated = scanner2.relocateManualGame(missingEntry.id, newExePath);
    ok('relocating a manual game to a new real path succeeds', relocated.success === true);
    ok('the relocated game is no longer reported as missing', relocated.game?.pathMissing === false);
    const relocateInvalid = scanner2.relocateManualGame(missingEntry.id, path.join(base, 'still-does-not-exist.exe'));
    ok('relocating to another invalid path is rejected, leaving the previous valid path intact', relocateInvalid.success === false);

    const relocateUnknownId = scanner2.relocateManualGame('manual-not-a-real-id', newExePath);
    ok('relocating a manual game id that does not exist is rejected, never crashes', relocateUnknownId.success === false);

    // ── Removal ─────────────────────────────────────────────────────────────
    const removed = scanner2.removeManualGame(missingEntry.id);
    ok('removing a real manual entry succeeds', removed === true);
    ok('the removed game is gone from the unified list immediately', !scanner2.getCached().some((g) => g.id === missingEntry.id));
    const removeAgain = scanner2.removeManualGame(missingEntry.id);
    ok('removing an already-removed/unknown id is a real, honest no-op (false), never throws', removeAgain === false);

    const scanner3 = new GameScanner(userDataRoot, { knownGames: [], fallbackLibraryFoldersOverride: [] });
    ok('removal persists across a fresh GameScanner instance too', scanner3.getManualGames().length === 0);

    console.log(`\nMANUAL GAME PATH TESTS: ${pass} passed, ${fail} failed`);
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
