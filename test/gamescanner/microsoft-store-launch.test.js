// Regression test for a real production false-error report: clicking
// "Launch" for Minecraft (Bedrock/Microsoft Store) actually opened
// Minecraft successfully every time, but Mercy Launcher still displayed
// "Could not launch this Microsoft Store app."
//
// Root cause: launch()'s 'microsoft' branch starts the app via
// `execFile('explorer.exe', ['shell:AppsFolder\\<AUMID>'], cb)`. explorer.exe
// is always already running as the desktop shell, so invoking it again just
// hands the request off to that existing process via DDE — the new,
// short-lived process Node actually spawned routinely exits with a non-zero
// code (commonly 1) REGARDLESS of whether the shell namespace navigation
// (and the real app launch) succeeded. The old code treated ANY execFile
// callback error as a launch failure, so this benign, well-documented
// Windows quirk was being reported as a genuine error every time.
//
// The fix distinguishes a real spawn failure (Node reports a STRING
// err.code, e.g. 'ENOENT') from the routine non-zero-exit false negative
// (a NUMERIC err.code) — only the former is a genuine failure.
//
// This never touches a real installed game or the real Get-AppxPackage/
// Get-StartApps PowerShell calls — microsoftPackagesOverride is the
// existing test seam (see GameScannerOptions) built for exactly this.
const path = require('path');
const child_process = require('child_process');
const { GameScanner } = require(path.resolve(__dirname, '../../dist/main/services/GameScanner.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function withMockedExecFile(mockImpl, fn) {
  const real = child_process.execFile;
  child_process.execFile = mockImpl;
  return fn().finally(() => { child_process.execFile = real; });
}

(async () => {
  try {
    const scanner = new GameScanner(require('os').tmpdir(), {
      steamPathOverride: null, fallbackLibraryFoldersOverride: [],
      epicManifestsDirOverride: null, gogRegistryRootOverride: {}, ubisoftRegistryRootOverride: {},
      rockstarRegistryRootOverride: {}, originRegistryRootOverride: {},
      // A real, curated KNOWN_GAMES entry (minecraft-uwp) resolved via the
      // real detection path, just with its PowerShell dependency replaced
      // by this fixture — never the real machine's real Get-AppxPackage.
      microsoftPackagesOverride: [
        { packageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', installLocation: 'C:\\fake\\MinecraftUWP', appId: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe!App' },
      ],
    });
    const results = await scanner.scan();
    const mc = results.find((g) => g.id === 'microsoft-minecraft-uwp');
    ok('the fixture Minecraft (Microsoft Store) entry was detected via the real code path', !!mc);
    ok('it resolved a real microsoftAppId (required for launch to even attempt the shell:AppsFolder path)', mc?.microsoftAppId === 'Microsoft.MinecraftUWP_8wekyb3d8bbwe!App');

    // ── The actual bug: explorer.exe hands off and exits non-zero, but the
    // app genuinely launched. Node surfaces this as an Error with a NUMERIC
    // err.code (the exit code) — this must NOT be reported as a failure.
    await withMockedExecFile((_cmd, _args, cb) => {
      const err = new Error('Command failed: explorer.exe shell:AppsFolder\\...');
      err.code = 1; // numeric exit code, exactly like the real quirk
      cb(err);
    }, async () => {
      const result = await scanner.launch('microsoft-minecraft-uwp');
      ok('REPRODUCED THE FIX: explorer.exe\'s routine non-zero exit code is no longer reported as a launch failure', result.success === true);
    });

    // ── A clean, unambiguous success (err === null) must also still work.
    await withMockedExecFile((_cmd, _args, cb) => cb(null), async () => {
      const result = await scanner.launch('microsoft-minecraft-uwp');
      ok('a clean explorer.exe success (no error at all) still reports success', result.success === true);
    });

    // ── A genuine spawn failure (explorer.exe itself missing/unusable) must
    // still be reported honestly — this fix must not hide real failures.
    await withMockedExecFile((_cmd, _args, cb) => {
      const err = new Error('spawn explorer.exe ENOENT');
      err.code = 'ENOENT'; // STRING code — a real spawn failure, not an exit code
      cb(err);
    }, async () => {
      const result = await scanner.launch('microsoft-minecraft-uwp');
      ok('a genuine spawn failure (string err.code) is still reported as a real, honest error', result.success === false && result.error === 'Could not launch this Microsoft Store app.');
    });

    console.log(`\nMICROSOFT STORE LAUNCH FALSE-ERROR TESTS: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
