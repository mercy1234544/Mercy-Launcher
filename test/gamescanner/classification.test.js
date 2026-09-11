// Game classification tests — proves the Library's "Games on this PC" list
// excludes real tools/SDKs/redistributables/workshop content a generic
// Steam/Epic/GOG scan would otherwise report as if they were playable
// games, while never hiding a real, legitimate, unsupported game. All
// against disposable fixtures — never the real machine's real installs.
const fs = require('fs'), path = require('path'), os = require('os');
const { GameScanner, KNOWN_GAMES } = require(path.resolve(__dirname, '../../dist/main/services/GameScanner.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-gamescanner-classify-test-')); }

function mkSteamLibrary(libRoot) {
  fs.mkdirSync(path.join(libRoot, 'steamapps', 'common'), { recursive: true });
  fs.writeFileSync(path.join(libRoot, 'steamapps', 'libraryfolders.vdf'), '"libraryfolders"\n{\n}');
}
function mkSteamApp(libRoot, { appId, name, installDir }) {
  const appDir = path.join(libRoot, 'steamapps', 'common', installDir);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'marker.txt'), 'real install marker');
  fs.writeFileSync(path.join(libRoot, 'steamapps', `appmanifest_${appId}.acf`), [
    '"AppState"', '{', `  "appid"    "${appId}"`, `  "name"    "${name}"`, `  "installdir"    "${installDir}"`, '}',
  ].join('\n'));
}
function mkEpicManifest(dir, { displayName, installLocation, appName }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(installLocation, { recursive: true });
  fs.writeFileSync(path.join(installLocation, 'Game.exe'), 'fake');
  fs.writeFileSync(path.join(dir, `${appName}.item`), JSON.stringify({ DisplayName: displayName, InstallLocation: installLocation, AppName: appName }));
}

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();

  try {
    const steamRoot = path.join(base, 'steam');
    mkSteamLibrary(steamRoot);
    mkSteamApp(steamRoot, { appId: 250820, name: 'SteamVR', installDir: 'SteamVR' });
    mkSteamApp(steamRoot, { appId: 228980, name: 'Steamworks Common Redistributables', installDir: 'Steamworks Shared' });
    mkSteamApp(steamRoot, { appId: 431960, name: 'Wallpaper Engine', installDir: 'wallpaper_engine' });
    mkSteamApp(steamRoot, { appId: 555001, name: 'Random Game SDK', installDir: 'Random Game SDK' });
    mkSteamApp(steamRoot, { appId: 555002, name: 'Cool Dedicated Server Tool', installDir: 'Cool Dedicated Server Tool' });
    mkSteamApp(steamRoot, { appId: 555003, name: 'Some Modding Tool', installDir: 'Some Modding Tool' });
    mkSteamApp(steamRoot, { appId: 555004, name: 'DirectX Runtime', installDir: 'DirectX Runtime' });
    // A real, legitimate, Mercy-unsupported game with no special name pattern.
    mkSteamApp(steamRoot, { appId: 620, name: 'Portal 2', installDir: 'Portal 2' });

    const epicDir = path.join(base, 'epic-manifests');
    mkEpicManifest(epicDir, { displayName: 'Unreal Engine', installLocation: path.join(base, 'epic-ue'), appName: 'ue-id' });
    mkEpicManifest(epicDir, { displayName: 'A Real Epic Game', installLocation: path.join(base, 'epic-real-game'), appName: 'real-game-id' });

    const scanner = new GameScanner(userDataRoot, {
      steamPathOverride: steamRoot, knownGames: KNOWN_GAMES, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: epicDir, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
    });
    const results = await scanner.scan();

    ok('SteamVR (known non-game appid) is excluded from the Library', !results.some((g) => g.name === 'SteamVR'));
    ok('Steamworks Common Redistributables (known non-game appid) is excluded', !results.some((g) => g.name === 'Steamworks Common Redistributables'));
    ok('Wallpaper Engine (known non-game appid) is excluded', !results.some((g) => g.name === 'Wallpaper Engine'));
    ok('a generic Steam app with "SDK" in its real name is excluded (name-pattern classification)', !results.some((g) => g.name === 'Random Game SDK'));
    ok('a generic Steam app naming itself a dedicated-server tool is excluded', !results.some((g) => g.name === 'Cool Dedicated Server Tool'));
    ok('a generic Steam app naming itself a modding tool is excluded', !results.some((g) => g.name === 'Some Modding Tool'));
    ok('a generic Steam app naming itself a runtime package is excluded', !results.some((g) => g.name === 'DirectX Runtime'));
    ok('Unreal Engine (Epic, real dev tooling) is excluded', !results.some((g) => g.name === 'Unreal Engine'));

    ok('a real, legitimate, Mercy-UNSUPPORTED game (Portal 2) is still shown — exclusion never hides a real game', results.some((g) => g.name === 'Portal 2' && g.mercyStatus === 'unsupported'));
    ok('a real, legitimate Epic-only game with no special name pattern is still shown', results.some((g) => g.name === 'A Real Epic Game'));

    // ── Content Manager — a real, legitimate AC launcher, never treated as
    //    dev tooling despite being a third-party application ────────────────
    const cmDir = path.join(base, 'AcTools Content Manager');
    fs.mkdirSync(cmDir, { recursive: true });
    fs.writeFileSync(path.join(cmDir, 'Content Manager.exe'), 'fake');
    const fixtureWithRealPath = KNOWN_GAMES.map((g) => (g.id === 'content-manager' ? { ...g, directPaths: [cmDir] } : g));
    const scannerCm = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: fixtureWithRealPath, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
    });
    const cmResults = await scannerCm.scan();
    const cm = cmResults.find((g) => g.name === 'Content Manager');
    ok('Content Manager is detected as a real, legitimate application when actually installed', !!cm && cm.platform === 'direct');
    ok('Content Manager is never misclassified as a dev tool/plugin by the non-game name filter', !!cm);

    console.log(`\nGAME CLASSIFICATION TESTS: ${pass} passed, ${fail} failed`);
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
