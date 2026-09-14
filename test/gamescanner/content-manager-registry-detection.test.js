// Regression test for a real gap: automatic Content Manager detection
// failed on a real machine even though Content Manager was genuinely
// installed, because the only two checks (the curated %LOCALAPPDATA%\
// AcTools Content Manager\ path, and "next to wherever Assetto Corsa
// itself was found") both miss a real, common case: a portable Content
// Manager.exe dropped into a completely custom folder (e.g. the user's own
// Desktop) that has no relationship to either location.
//
// The fix: Content Manager registers a real Windows URL protocol handler
// (`acmanager://`, used for the AC community's real "join via link"
// feature) the first time it runs, no matter where the user put it —
// confirmed via `Get-ChildItem HKCU:\Software\Classes` on a real machine,
// which showed a real `acmanager` key (plus acmanager.acreplay/cmpreset/
// kn5 file-type handlers) with a registered open command naming the real,
// current executable path. GameScanner now reads that registered command
// as a last-resort fallback — real OS/launcher metadata, never a guessed
// folder, exactly like this file's existing Microsoft Store detection.
const fs = require('fs'), path = require('path'), os = require('os');
const { GameScanner } = require(path.resolve(__dirname, '../../dist/main/services/GameScanner.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-cm-registry-test-')); }

// A minimal knownGames fixture with just the real content-manager
// definition (category: 'launcher') — not the full real KNOWN_GAMES list,
// which would risk this test's other assertions depending on whatever
// happens to actually be installed on the machine running it (e.g. a real
// FiveM/Minecraft Launcher curated directPaths match).
const KNOWN_GAMES_FIXTURE = [
  { id: 'content-manager', name: 'Content Manager', mercyGameId: null, mercyStatus: 'unsupported', category: 'launcher' },
];

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();

  try {
    // ── The real reported scenario: Content Manager lives in a completely
    //    custom folder unrelated to Assetto Corsa's own install or the
    //    curated AcTools Content Manager data folder. ──────────────────────
    const customDir = path.join(base, 'some-random-custom-folder');
    fs.mkdirSync(customDir, { recursive: true });
    const exePath = path.join(customDir, 'Content Manager.exe');
    fs.writeFileSync(exePath, 'fake');

    const scanner = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: KNOWN_GAMES_FIXTURE, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
      // The real registered command shape Windows stores for a URL
      // protocol handler: a quoted exe path, optionally followed by an
      // argument placeholder.
      contentManagerProtocolCommandOverride: `"${exePath}" "%1"`,
    });
    const results = await scanner.scan();
    const cm = results.find((g) => g.name === 'Content Manager');
    ok('REPRODUCED THE FIX: Content Manager in a completely custom, unguessable folder is still detected via its real registered protocol handler', !!cm);
    ok('the detected executable path is the real one from the registered command, not a guess', cm?.executablePath === exePath);
    ok('the detected install path is the real containing folder', cm?.installPath === customDir);
    ok('it is still correctly categorized as a launcher, not a game', cm?.category === 'launcher');
    ok('platform is "direct" (a real, resolved executable path), same as every other curated direct-detection entry', cm?.platform === 'direct');

    // ── No registered protocol handler at all (Content Manager never run,
    //    or genuinely not installed) — must not fabricate an entry. ────────
    const scannerNone = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: KNOWN_GAMES_FIXTURE, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
      contentManagerProtocolCommandOverride: null,
    });
    const resultsNone = await scannerNone.scan();
    ok('no registered protocol handler at all means Content Manager is honestly not reported, never fabricated', !resultsNone.some((g) => g.name === 'Content Manager'));

    // ── A registered command whose target no longer exists on disk (the
    //    user moved/deleted it after it last ran) must not be trusted. ─────
    const scannerStale = new GameScanner(userDataRoot, {
      steamPathOverride: null, knownGames: KNOWN_GAMES_FIXTURE, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {}, microsoftPackagesOverride: [],
      contentManagerProtocolCommandOverride: `"${path.join(base, 'moved-away', 'Content Manager.exe')}" "%1"`,
    });
    const resultsStale = await scannerStale.scan();
    ok('a stale registered command pointing at a real path that no longer exists is never reported as detected', !resultsStale.some((g) => g.name === 'Content Manager'));

    console.log(`\nCONTENT MANAGER REGISTRY DETECTION TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
