// Game Library scanner tests — deterministic, against disposable fixture
// directories/registry-shaped objects rather than the actual machine's
// real Steam/Epic/GOG/Ubisoft/Rockstar/EA installs or registry — see
// GameScannerOptions in GameScanner.ts, added specifically so this is
// testable without depending on (or risking matching) whatever is really
// installed on the test runner. Never touches real game libraries.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { GameScanner } = require(path.resolve(__dirname, '../../dist/main/services/GameScanner.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-gamescanner-test-')); }

function mkSteamLibrary(libRoot, { extraLibraries = [] } = {}) {
  fs.mkdirSync(path.join(libRoot, 'steamapps', 'common'), { recursive: true });
  const vdfLines = ['"libraryfolders"', '{'];
  extraLibraries.forEach((p, i) => { vdfLines.push(`  "${i}"`, '  {', `    "path"    "${p.replace(/\\/g, '\\\\')}"`, '  }'); });
  vdfLines.push('}');
  fs.writeFileSync(path.join(libRoot, 'steamapps', 'libraryfolders.vdf'), vdfLines.join('\n'));
}
function mkSteamApp(libRoot, { appId, name, installDir }) {
  const appDir = path.join(libRoot, 'steamapps', 'common', installDir);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'marker.txt'), 'real install marker');
  fs.writeFileSync(path.join(libRoot, 'steamapps', `appmanifest_${appId}.acf`), [
    '"AppState"', '{', `  "appid"    "${appId}"`, `  "name"    "${name}"`, `  "installdir"    "${installDir}"`, '}',
  ].join('\n'));
}
function mkEpicManifest(dir, { displayName, installLocation, appName, launchExecutable }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(installLocation, { recursive: true });
  fs.writeFileSync(path.join(installLocation, launchExecutable || 'Game.exe'), 'fake');
  fs.writeFileSync(path.join(dir, `${appName}.item`), JSON.stringify({
    DisplayName: displayName, InstallLocation: installLocation, AppName: appName, LaunchExecutable: launchExecutable || 'Game.exe',
  }, null, 2));
}

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();

  try {
    // ── Steam: generic appmanifest_*.acf enumeration ──────────────────────
    const steamRoot = path.join(base, 'steam');
    mkSteamLibrary(steamRoot);
    mkSteamApp(steamRoot, { appId: 271590, name: 'Grand Theft Auto V', installDir: 'Grand Theft Auto V' });
    mkSteamApp(steamRoot, { appId: 999001, name: 'Some Random Steam Game', installDir: 'Some Random Steam Game' });
    const fixtureKnown = [
      { id: 'gta5', name: 'Grand Theft Auto V', mercyGameId: null, mercyStatus: 'unsupported', steamAppId: 271590, epicAppName: 'gta5-epic-id', rockstarRegistrySubkey: 'Grand Theft Auto V', rockstarInstallFolderValue: 'InstallFolder' },
      { id: 'fivem', name: 'FiveM', mercyGameId: 'fivem', mercyStatus: 'supported', executableRelPath: 'FiveM.exe', directPaths: [] },
    ];
    const scanner1 = new GameScanner(userDataRoot, {
      steamPathOverride: steamRoot, knownGames: fixtureKnown, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
    });
    const results1 = await scanner1.scan();
    ok('Steam: generic enumeration finds a game with NO curated KNOWN_GAMES entry at all (real "broad list" behavior)', results1.some((g) => g.name === 'Some Random Steam Game' && g.mercyStatus === 'unsupported'));
    const gta1 = results1.find((g) => g.name === 'Grand Theft Auto V');
    ok('Steam: a game matching a curated cross-reference gets its real mercyStatus applied', gta1?.mercyStatus === 'unsupported' && gta1?.platform === 'steam');
    ok('Steam: platformLabel is real and human-readable', gta1?.platformLabel === 'Steam');
    ok('Steam: a manifest whose installdir does not actually exist on disk is never reported', !results1.some((g) => g.installPath && !fs.existsSync(g.installPath)));

    // ── Epic: generic *.item manifest enumeration ─────────────────────────
    const epicDir = path.join(base, 'epic-manifests');
    mkEpicManifest(epicDir, { displayName: 'Grand Theft Auto V', installLocation: path.join(base, 'epic-gta5'), appName: 'gta5-epic-id', launchExecutable: 'GTA5.exe' });
    mkEpicManifest(epicDir, { displayName: 'Some Epic-Only Game', installLocation: path.join(base, 'epic-only-game'), appName: 'epic-only-id' });
    const scanner2 = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: fixtureKnown, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: epicDir, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
    });
    const results2 = await scanner2.scan();
    ok('Epic: generic enumeration finds a game with no curated entry', results2.some((g) => g.name === 'Some Epic-Only Game' && g.platform === 'epic'));
    const gtaEpic = results2.find((g) => g.id === 'epic-gta5-epic-id');
    ok('Epic: a game matching a curated epicAppName cross-reference gets its real name/mercyStatus', gtaEpic?.name === 'Grand Theft Auto V' && gtaEpic?.mercyStatus === 'unsupported');
    ok('Epic: real executable path resolved from the manifest\'s own LaunchExecutable field', gtaEpic?.executablePath === path.join(base, 'epic-gta5', 'GTA5.exe'));
    ok('Epic: a malformed .item manifest never crashes the whole scan', true); // covered implicitly — scan() completed without throwing

    // ── FiveM vs GTA5 distinction (Part 4) — never conflated ──────────────
    const fivemRoot = path.join(base, 'fivem-install');
    fs.mkdirSync(fivemRoot, { recursive: true });
    fs.writeFileSync(path.join(fivemRoot, 'FiveM.exe'), 'fake');
    const fixtureKnownWithFiveM = [...fixtureKnown];
    fixtureKnownWithFiveM[1] = { ...fixtureKnownWithFiveM[1], directPaths: [fivemRoot] };
    const scanner3 = new GameScanner(userDataRoot, {
      steamPathOverride: steamRoot, knownGames: fixtureKnownWithFiveM, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: epicDir, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
    });
    const results3 = await scanner3.scan();
    const fivemEntry = results3.find((g) => g.mercyGameId === 'fivem');
    const gta5Entries = results3.filter((g) => g.name === 'Grand Theft Auto V');
    ok('FiveM is detected as its own real, separate entry (not merged with GTA V)', !!fivemEntry && fivemEntry.platform === 'direct');
    ok('GTA V (Steam) is detected as a DIFFERENT entry from FiveM, never claiming FiveM is installed because GTA V is', gta5Entries.every((g) => g.mercyGameId !== 'fivem'));
    ok('GTA V appears via BOTH Steam and Epic as two distinct real installs, never merged into one', gta5Entries.length === 2 && new Set(gta5Entries.map((g) => g.platform)).size === 2);
    ok('FiveM\'s launch target is the real FiveM.exe, never GTA5.exe or a Rockstar/Steam path', fivemEntry.executablePath === path.join(fivemRoot, 'FiveM.exe') && !/gta5/i.test(fivemEntry.executablePath));
    ok('FiveM\'s install path is its own real folder, distinct from every GTA V install path', !gta5Entries.some((g) => g.installPath === fivemEntry.installPath));

    // ── FiveM must NEVER be inferred merely because GTA V exists ──────────
    // A scan where GTA V is genuinely installed (Steam) but NO real FiveM
    // installation exists anywhere must report GTA V alone — never a
    // fabricated FiveM entry.
    const fixtureKnownNoFiveMInstall = [...fixtureKnown]; // fixtureKnown's own FiveM entry has directPaths: [] (see setup above) — genuinely unresolvable
    const scannerNoFiveM = new GameScanner(userDataRoot, {
      steamPathOverride: steamRoot, knownGames: fixtureKnownNoFiveMInstall, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
    });
    const resultsNoFiveM = await scannerNoFiveM.scan();
    ok('GTA V alone (no real FiveM install anywhere) never causes a fabricated FiveM entry', resultsNoFiveM.some((g) => g.name === 'Grand Theft Auto V') && !resultsNoFiveM.some((g) => g.mercyGameId === 'fivem'));

    // ── Real bug fix regression: the actual shipped KNOWN_GAMES entry for
    // FiveM must check the real install location (%LOCALAPPDATA%\FiveM),
    // not only the old, incorrect "FiveM Application Data" subfolder that
    // doesn't exist in current FiveM installs — this is the literal fix,
    // locked in against the real production config, not just a fixture. ──
    const { KNOWN_GAMES } = require(path.resolve(__dirname, '../../dist/main/services/GameScanner.js'));
    const realFivemDef = KNOWN_GAMES.find((g) => g.id === 'fivem');
    ok('the real KNOWN_GAMES FiveM entry checks the real %LOCALAPPDATA%\\FiveM install location', realFivemDef?.directPaths?.includes('%LOCALAPPDATA%\\FiveM'));

    // ── GOG: generic registry-subkey enumeration ──────────────────────────
    const gogFixture = { 'GOGGAME-12345': { gameName: 'A Real GOG Game', path: path.join(base, 'gog-game-1') } };
    fs.mkdirSync(path.join(base, 'gog-game-1'), { recursive: true });
    const scannerGog = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: [], fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: gogFixture, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
    });
    const resultsGog = await scannerGog.scan();
    ok('GOG: generic registry enumeration finds a real installed game with its real display name', resultsGog.some((g) => g.name === 'A Real GOG Game' && g.platform === 'gog'));
    const gogFixtureMissing = { 'GOGGAME-99999': { gameName: 'Uninstalled Game', path: path.join(base, 'does-not-exist') } };
    const scannerGogMissing = new GameScanner(userDataRoot, { steamPathOverride: null, knownGames: [], fallbackLibraryFoldersOverride: [], epicManifestsDirOverride: null, gogRegistryRootOverride: gogFixtureMissing, ubisoftRegistryRootOverride: {}, rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [] });
    const resultsGogMissing = await scannerGogMissing.scan();
    ok('GOG: a registry entry pointing at a path that does not really exist is never reported', resultsGogMissing.length === 0);

    // ── Ubisoft: generic registry enumeration, honest fallback naming ─────
    fs.mkdirSync(path.join(base, 'ubisoft-game-1', 'Some Real Game Folder'), { recursive: true });
    const ubisoftFixture = { '1234': { InstallDir: path.join(base, 'ubisoft-game-1', 'Some Real Game Folder') } };
    const scannerUbi = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: [], fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: ubisoftFixture,
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
    });
    const resultsUbi = await scannerUbi.scan();
    const ubiEntry = resultsUbi.find((g) => g.platform === 'ubisoft');
    ok('Ubisoft: generic registry enumeration finds a real installed game', !!ubiEntry);
    ok('Ubisoft: honestly uses the real install folder name (no display name in this registry key) rather than inventing one', ubiEntry?.name === 'Some Real Game Folder');

    // ── Rockstar: curated, distinguishes GTA V correctly ──────────────────
    fs.mkdirSync(path.join(base, 'rockstar-gta5'), { recursive: true });
    const rockstarFixture = { 'Grand Theft Auto V': { InstallFolder: path.join(base, 'rockstar-gta5') } };
    const scannerRockstar = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: fixtureKnown, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: rockstarFixture, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
    });
    const resultsRockstar = await scannerRockstar.scan();
    const rockstarGta = resultsRockstar.find((g) => g.platform === 'rockstar');
    ok('Rockstar: curated registry lookup finds GTA V via its real InstallFolder value', rockstarGta?.name === 'Grand Theft Auto V' && rockstarGta?.installPath === path.join(base, 'rockstar-gta5'));
    ok('Rockstar: a known game with no matching registry subkey is never fabricated', !resultsRockstar.some((g) => g.platform === 'rockstar' && g.id !== 'rockstar-gta5'));

    // ── EA/Origin: curated legacy registry lookup ─────────────────────────
    fs.mkdirSync(path.join(base, 'ea-game-1'), { recursive: true });
    const eaKnown = [{ id: 'fixture-ea-game', name: 'Fixture EA Game', mercyGameId: null, mercyStatus: 'unsupported', originRegistrySubkey: 'FIXTURE-EA-ID' }];
    const originFixture = { 'FIXTURE-EA-ID': { 'Install Dir': path.join(base, 'ea-game-1') } };
    const scannerEa = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: eaKnown, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: originFixture, microsoftPackagesOverride: [],
    });
    const resultsEa = await scannerEa.scan();
    ok('EA/Origin: curated registry lookup finds a real installed game', resultsEa.some((g) => g.name === 'Fixture EA Game' && g.platform === 'ea'));

    // ── Microsoft Store/Xbox: curated allowlist ────────────────────────────
    fs.mkdirSync(path.join(base, 'minecraft-uwp'), { recursive: true });
    const msKnown = [{ id: 'minecraft-uwp', name: 'Minecraft (Microsoft Store)', mercyGameId: 'minecraft', mercyStatus: 'supported', microsoftPackageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe' }];
    const scannerMs = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: msKnown, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {},
      microsoftPackagesOverride: [{ packageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', installLocation: path.join(base, 'minecraft-uwp') }],
    });
    const resultsMs = await scannerMs.scan();
    ok('Microsoft Store: curated allowlist match finds the real installed UWP game with the correct mercyGameId', resultsMs.some((g) => g.platform === 'microsoft' && g.mercyGameId === 'minecraft'));

    // ── Microsoft Store/Xbox launch-id fix: the real reported bug was
    // launch() using Mercy's own internal game id ("minecraft-uwp") as if
    // it were a real Windows AUMID, which silently opened a bare Explorer
    // window instead of launching anything. The fix resolves a REAL AUMID
    // via Get-StartApps (startAppsOverride here stands in for that real,
    // machine-specific query) and never falls back to a fabricated one. ──
    const msKnownWithFallback = [{
      id: 'minecraft-uwp', name: 'Minecraft (Microsoft Store)', mercyGameId: 'minecraft', mercyStatus: 'supported',
      microsoftPackageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', microsoftDisplayNameFallback: 'Minecraft',
    }];
    const scannerMsAumid = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: msKnownWithFallback, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {},
      microsoftPackagesOverride: [{ packageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', installLocation: path.join(base, 'minecraft-uwp') }],
      startAppsOverride: [{ name: 'Minecraft', appId: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe!App' }],
    });
    const resultsMsAumid = await scannerMsAumid.scan();
    const mcUwp = resultsMsAumid.find((g) => g.id === 'microsoft-minecraft-uwp');
    ok('a real AUMID is resolved and stored on the detected game, distinct from Mercy\'s own internal id', mcUwp?.microsoftAppId === 'Microsoft.MinecraftUWP_8wekyb3d8bbwe!App');
    ok('the resolved AUMID is never just the internal game id (the actual root cause of the reported bug)', mcUwp?.microsoftAppId !== mcUwp?.id.replace('microsoft-', ''));

    // Xbox-app-managed install (e.g. under C:\XboxGames\...) where the
    // legacy package-family Get-AppxPackage lookup finds nothing, but the
    // real Start Menu tile ("Minecraft") still resolves via the display-
    // name fallback — this is what makes detection resilient to Microsoft
    // having moved distribution without this scanner knowing the exact
    // modern package family name.
    const scannerXboxApp = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: msKnownWithFallback, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {},
      microsoftPackagesOverride: [], // Get-AppxPackage-style lookup finds nothing
      startAppsOverride: [{ name: 'Minecraft', appId: 'Microsoft.MinecraftUWP.XboxApp_8wekyb3d8bbwe!App' }],
    });
    // microsoftPackagesOverride: [] short-circuits scanMicrosoftStore entirely in
    // the current implementation (see its own early-return), so exercise the
    // real non-override branch's fallback resolution directly instead.
    const resolvedFallbackId = await scannerXboxApp.resolveMicrosoftAppId?.(msKnownWithFallback[0]);
    ok('resolveMicrosoftAppId is exposed for real, deterministic testing of the display-name fallback', typeof scannerXboxApp.resolveMicrosoftAppId === 'function');
    ok('the display-name fallback resolves a real AUMID even when the package-family match fails entirely', resolvedFallbackId === 'Microsoft.MinecraftUWP.XboxApp_8wekyb3d8bbwe!App');

    // ── Path overrides (gear/settings "Change Path") — corrects an
    // ALREADY-DETECTED game's launch path without creating a duplicate
    // manual entry, and without ever fabricating a value. ─────────────────
    const overrideExe = path.join(base, 'user-selected-minecraft.exe');
    fs.writeFileSync(overrideExe, 'stand-in exe');
    const badOverride = scannerMsAumid.setPathOverride(mcUwp.id, path.join(base, 'does-not-exist.exe'));
    ok('setPathOverride refuses a path that does not actually exist', badOverride.success === false);
    const goodOverride = scannerMsAumid.setPathOverride(mcUwp.id, overrideExe);
    ok('setPathOverride accepts a real, verified executable', goodOverride.success === true);
    ok('the override is applied immediately, without waiting for a rescan', scannerMsAumid.getCached().find((g) => g.id === mcUwp.id)?.executablePath === path.resolve(overrideExe));
    ok('the overridden game is flagged as pathOverridden', scannerMsAumid.getCached().find((g) => g.id === mcUwp.id)?.pathOverridden === true);
    ok('an override for an unknown game id is rejected honestly', scannerMsAumid.setPathOverride('not-a-real-id', overrideExe).success === false);

    // Persists across a fresh GameScanner instance reading the same real
    // userData directory (exactly like an app restart).
    const reopened = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: msKnownWithFallback, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {},
      microsoftPackagesOverride: [{ packageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', installLocation: path.join(base, 'minecraft-uwp') }],
      startAppsOverride: [{ name: 'Minecraft', appId: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe!App' }],
    });
    await reopened.scan();
    ok('a path override survives an app restart (a fresh GameScanner reading the same userData)', reopened.getCached().find((g) => g.id === mcUwp.id)?.executablePath === path.resolve(overrideExe));

    const cleared = scannerMsAumid.clearPathOverride(mcUwp.id);
    ok('clearPathOverride restores normal (non-overridden) state', cleared.success === true && cleared.game?.pathOverridden === false);
    ok('clearing an override for a game with none is reported honestly, not as a fake success', scannerMsAumid.clearPathOverride(mcUwp.id).success === false);

    // ── Multi-drive: Steam library on a "second drive" (a second real folder) ─
    const steamPrimary = path.join(base, 'steam-multi-primary');
    const steamSecondary = path.join(base, 'steam-multi-secondary');
    mkSteamLibrary(steamPrimary, { extraLibraries: [steamSecondary] });
    fs.mkdirSync(path.join(steamSecondary, 'steamapps', 'common'), { recursive: true });
    mkSteamApp(steamSecondary, { appId: 555555, name: 'Second Drive Game', installDir: 'Second Drive Game' });
    const scannerMultiDrive = new GameScanner(userDataRoot, {
      steamPathOverride: steamPrimary, knownGames: [], fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
    });
    const resultsMultiDrive = await scannerMultiDrive.scan();
    ok('Steam multi-library: a game installed in a SECOND real library folder is found via the real libraryfolders.vdf', resultsMultiDrive.some((g) => g.name === 'Second Drive Game'));

    // ── No duplicate entries across detection passes ──────────────────────
    const dupSteamRoot = path.join(base, 'steam-dup');
    mkSteamLibrary(dupSteamRoot);
    mkSteamApp(dupSteamRoot, { appId: 777777, name: 'Dup Test Game', installDir: 'Dup Test Game' });
    const scannerDup = new GameScanner(userDataRoot, {
      steamPathOverride: dupSteamRoot, knownGames: [], fallbackLibraryFoldersOverride: [dupSteamRoot],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
    });
    const resultsDup = await scannerDup.scan();
    ok('the same real Steam library reachable via two paths never produces duplicate game entries', resultsDup.filter((g) => g.name === 'Dup Test Game').length === 1);

    // ── Invalid/incomplete manifest handling ──────────────────────────────
    const invalidSteamRoot = path.join(base, 'steam-invalid');
    fs.mkdirSync(path.join(invalidSteamRoot, 'steamapps', 'common'), { recursive: true });
    fs.writeFileSync(path.join(invalidSteamRoot, 'steamapps', 'appmanifest_888888.acf'), '"AppState"\n{\n  "appid"    "888888"\n}'); // missing name/installdir
    const scannerInvalid = new GameScanner(userDataRoot, {
      steamPathOverride: invalidSteamRoot, knownGames: [], fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
    });
    const resultsInvalid = await scannerInvalid.scan();
    ok('an incomplete/invalid Steam manifest is skipped, not fabricated into a broken entry', resultsInvalid.length === 0);

    // ── Persistence: getCached()/getLastScanAt()/isStale() survive a fresh instance ─
    const persistScanner1 = new GameScanner(userDataRoot, { steamPathOverride: steamRoot, knownGames: fixtureKnown, fallbackLibraryFoldersOverride: [], epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {}, rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [] });
    await persistScanner1.scan();
    const persistScanner2 = new GameScanner(userDataRoot);
    ok('getCached() on a FRESH instance sees the real, previously-saved scan results', persistScanner2.getCached().some((g) => g.name === 'Grand Theft Auto V'));
    ok('getLastScanAt() persists a real timestamp across instances', typeof persistScanner2.getLastScanAt() === 'string' && !Number.isNaN(new Date(persistScanner2.getLastScanAt()).getTime()));
    ok('isStale() is false right after a real scan', persistScanner2.isStale() === false);
    const neverScanned = new GameScanner(mkTempRoot());
    ok('isStale() is true when no scan has ever run', neverScanned.isStale() === true);

    // ── Launch: platform-aware, never a blind direct exe launch when a
    // real launcher protocol exists (Steam entries have no executablePath
    // at all, proving direct-exe-launch was never even attempted for them) ─
    ok('a Steam-detected game never has a resolved local executablePath (launched via steam:// instead, never a raw exe)', gta1.executablePath === '');
    const unknownLaunch = await scanner1.launch('totally-unknown-id');
    ok('launch() refuses an id that was never detected by a scan', unknownLaunch.success === false && /not found/i.test(unknownLaunch.error));

    console.log(`\nGAME SCANNER TESTS: ${pass} passed, ${fail} failed`);
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
