// Game Library scanner tests — deterministic, against disposable fixture
// directories shaped like a real Steam install (real libraryfolders.vdf/
// appmanifest_<id>.acf text, real fake executables) rather than the actual
// machine's real Steam install or registry — see GameScannerOptions in
// GameScanner.ts, added specifically so this is testable without depending
// on (or risking matching) whatever is really installed on the test runner.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { GameScanner } = require(path.resolve(__dirname, '../../dist/main/services/GameScanner.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-gamescanner-test-')); }

function mkSteamLibrary(libRoot, { extraLibraries = [] } = {}) {
  fs.mkdirSync(path.join(libRoot, 'steamapps', 'common'), { recursive: true });
  const vdfLines = ['"libraryfolders"', '{'];
  extraLibraries.forEach((p, i) => {
    vdfLines.push(`  "${i}"`, '  {', `    "path"    "${p.replace(/\\/g, '\\\\')}"`, '  }');
  });
  vdfLines.push('}');
  fs.writeFileSync(path.join(libRoot, 'steamapps', 'libraryfolders.vdf'), vdfLines.join('\n'));
}

function mkSteamApp(libRoot, { appId, installDir, exeRelPath }) {
  const appDir = path.join(libRoot, 'steamapps', 'common', installDir);
  fs.mkdirSync(path.dirname(path.join(appDir, exeRelPath)), { recursive: true });
  fs.writeFileSync(path.join(appDir, exeRelPath), 'fake exe bytes');
  fs.writeFileSync(path.join(libRoot, 'steamapps', `appmanifest_${appId}.acf`), [
    '"AppState"', '{', `  "appid"    "${appId}"`, `  "installdir"    "${installDir}"`, '}',
  ].join('\n'));
}

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();

  try {
    // ── Steam detection: real appmanifest installdir resolution ──────────
    const steamRoot = path.join(base, 'steam');
    mkSteamLibrary(steamRoot);
    mkSteamApp(steamRoot, { appId: 111111, installDir: 'Real Game Folder Name', exeRelPath: 'game.exe' });

    const fixtureGames1 = [
      { id: 'fixture-steam-game', name: 'Fixture Steam Game', mercyGameId: null, steamAppId: 111111, steamFolderFallback: 'wrong-fallback-name', executableRelPath: 'game.exe' },
      { id: 'fixture-not-installed', name: 'Not Installed Game', mercyGameId: null, steamAppId: 999999, steamFolderFallback: 'nope', executableRelPath: 'nope.exe' },
    ];
    const scanner1 = new GameScanner(userDataRoot, { steamPathOverride: steamRoot, knownGames: fixtureGames1, fallbackLibraryFoldersOverride: [] });
    const results1 = await scanner1.scan();
    ok('scan() finds the real Steam game via its real appmanifest installdir (not the wrong fallback name)', results1.some((g) => g.id === 'fixture-steam-game' && g.installPath.endsWith('Real Game Folder Name')));
    ok('scan() does NOT report a game with no real appmanifest/folder as installed', !results1.some((g) => g.id === 'fixture-not-installed'));
    ok('a real Steam-resolved game is tagged source: "steam"', results1.find((g) => g.id === 'fixture-steam-game').source === 'steam');
    ok('the real executable path is genuinely correct and exists on disk', fs.existsSync(results1.find((g) => g.id === 'fixture-steam-game').executablePath));

    // ── Steam fallback-folder-name resolution (no appmanifest present) ────
    const steamRoot2 = path.join(base, 'steam2');
    mkSteamLibrary(steamRoot2);
    fs.mkdirSync(path.join(steamRoot2, 'steamapps', 'common', 'FallbackFolder'), { recursive: true });
    fs.writeFileSync(path.join(steamRoot2, 'steamapps', 'common', 'FallbackFolder', 'app.exe'), 'fake');
    const fixtureGames2 = [{ id: 'fixture-fallback-game', name: 'Fallback Game', mercyGameId: null, steamAppId: 222222, steamFolderFallback: 'FallbackFolder', executableRelPath: 'app.exe' }];
    const scanner2 = new GameScanner(userDataRoot, { steamPathOverride: steamRoot2, knownGames: fixtureGames2, fallbackLibraryFoldersOverride: [] });
    const results2 = await scanner2.scan();
    ok('scan() falls back to the known folder name when no appmanifest exists, and still finds the real game', results2.some((g) => g.id === 'fixture-fallback-game'));

    // ── Multi-library Steam install (a second drive/library folder) ──────
    const steamRoot3 = path.join(base, 'steam3-primary');
    const secondLibrary = path.join(base, 'steam3-secondary-library');
    mkSteamLibrary(steamRoot3, { extraLibraries: [secondLibrary] });
    fs.mkdirSync(path.join(secondLibrary, 'steamapps', 'common'), { recursive: true });
    mkSteamApp(secondLibrary, { appId: 333333, installDir: 'SecondLibraryGame', exeRelPath: 'second.exe' });
    const fixtureGames3 = [{ id: 'fixture-second-library-game', name: 'Second Library Game', mercyGameId: null, steamAppId: 333333, steamFolderFallback: 'x', executableRelPath: 'second.exe' }];
    const scanner3 = new GameScanner(userDataRoot, { steamPathOverride: steamRoot3, knownGames: fixtureGames3, fallbackLibraryFoldersOverride: [] });
    const results3 = await scanner3.scan();
    ok('scan() reads real libraryfolders.vdf and finds a game installed in a SECOND real library folder, not just the primary one', results3.some((g) => g.id === 'fixture-second-library-game'));

    // ── Direct (non-Steam) install detection with real env-var resolution ─
    const directRoot = path.join(base, 'direct-install');
    fs.mkdirSync(directRoot, { recursive: true });
    fs.writeFileSync(path.join(directRoot, 'DirectGame.exe'), 'fake');
    const fakeEnvVar = 'MERCY_TEST_GAME_ROOT_' + Date.now();
    process.env[fakeEnvVar] = directRoot;
    try {
      const fixtureGames4 = [{ id: 'fixture-direct-game', name: 'Direct Game', mercyGameId: 'fivem', executableRelPath: 'DirectGame.exe', directPaths: [`%${fakeEnvVar}%`] }];
      const scanner4 = new GameScanner(userDataRoot, { steamPathOverride: null, knownGames: fixtureGames4, fallbackLibraryFoldersOverride: [] });
      const results4 = await scanner4.scan();
      const found4 = results4.find((g) => g.id === 'fixture-direct-game');
      ok('scan() resolves a real %ENVVAR% placeholder and finds a real direct (non-Steam) install', !!found4);
      ok('a direct-install game is tagged source: "direct"', found4?.source === 'direct');
      ok('mercyGameId is carried through honestly for a Mercy-supported game', found4?.mercyGameId === 'fivem');
    } finally { delete process.env[fakeEnvVar]; }

    // ── Never fabricated: an entry with no real match anywhere is never reported ─
    const fixtureGamesNone = [{ id: 'fixture-nowhere', name: 'Nowhere Game', mercyGameId: null, steamAppId: 555555, steamFolderFallback: 'nowhere', executableRelPath: 'nowhere.exe' }];
    const scannerNone = new GameScanner(userDataRoot, { steamPathOverride: null, knownGames: fixtureGamesNone, fallbackLibraryFoldersOverride: [] });
    const resultsNone = await scannerNone.scan();
    ok('a known game with no real install anywhere is never fabricated into the results', resultsNone.length === 0);

    // ── No duplicate entries for the same known game id ───────────────────
    const dupSteamRoot = path.join(base, 'steam-dup');
    mkSteamLibrary(dupSteamRoot);
    mkSteamApp(dupSteamRoot, { appId: 444444, installDir: 'DupGame', exeRelPath: 'dup.exe' });
    const fixtureGamesDup = [
      { id: 'fixture-dup', name: 'Dup Game', mercyGameId: null, steamAppId: 444444, steamFolderFallback: 'DupGame', executableRelPath: 'dup.exe' },
      { id: 'fixture-dup', name: 'Dup Game (duplicate definition)', mercyGameId: null, steamAppId: 444444, steamFolderFallback: 'DupGame', executableRelPath: 'dup.exe' },
    ];
    const scannerDup = new GameScanner(userDataRoot, { steamPathOverride: dupSteamRoot, knownGames: fixtureGamesDup, fallbackLibraryFoldersOverride: [] });
    const resultsDup = await scannerDup.scan();
    ok('scan() never reports two entries for the same known-game id even if defined twice', resultsDup.filter((g) => g.id === 'fixture-dup').length === 1);

    // ── Persistence: getCached() survives a fresh instance (registry file) ─
    const persistScanner1 = new GameScanner(userDataRoot, { steamPathOverride: steamRoot, knownGames: fixtureGames1, fallbackLibraryFoldersOverride: [] });
    await persistScanner1.scan();
    const persistScanner2 = new GameScanner(userDataRoot);
    ok('getCached() on a FRESH GameScanner instance sees the real, previously-saved scan results (real registry persistence)', persistScanner2.getCached().some((g) => g.id === 'fixture-steam-game'));

    // ── launch(): only ever a real, already-detected, still-existing executable ─
    const launchScanner = new GameScanner(userDataRoot, { steamPathOverride: steamRoot, knownGames: fixtureGames1, fallbackLibraryFoldersOverride: [] });
    await launchScanner.scan();
    const unknownLaunch = await launchScanner.launch('totally-unknown-id');
    ok('launch() refuses an id that was never detected by a scan', unknownLaunch.success === false && /not found/i.test(unknownLaunch.error));

    const foundGame = launchScanner.getCached().find((g) => g.id === 'fixture-steam-game');
    fs.unlinkSync(foundGame.executablePath); // simulate the game being uninstalled after the scan
    const staleLaunch = await launchScanner.launch('fixture-steam-game');
    ok('launch() refuses to launch a previously-detected executable that no longer exists on disk', staleLaunch.success === false && /no longer exists/i.test(staleLaunch.error));

    console.log(`\nGAME SCANNER TESTS: ${pass} passed, ${fail} failed`);
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
