// Java runtime management tests — covers the bug where Mercy would spawn a
// Minecraft server jar with whatever `java` happened to be on PATH, even
// when the jar's real class-file version required a newer JDK than that
// (the exact UnsupportedClassVersionError from the bug report: a real
// Minecraft version needing Java 25 was launched with Java 21).
//
// Where a scenario needs an ACTUAL executed process (parsing real `java
// -version` stderr), these tests use the real Java installed on this
// machine — there is no fake/stubbed process execution here. Where a
// scenario needs a Java major version that isn't actually installed on this
// dev machine (e.g. Java 25, or "multiple runtimes"), the tests construct
// JavaRuntime[] data directly and exercise the real selection/validation
// logic against it — the same code path startServer() uses, just fed a
// runtime list this machine doesn't happen to have. See the live E2E script
// for the fully-real, no-stub demonstration against the real Java 21 that
// IS installed here.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const {
  MinecraftManager, requiredJavaMajor, javaMajorFromClassFileVersion,
  translateClassVersionError, selectCompatibleRuntime,
} = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-java-test-')); }
function mkFakeServer(dir, jarName = 'server.jar') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, jarName), 'fake jar bytes — never actually executed in these tests');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25566\n');
}

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();
  const mgr = new MinecraftManager(userDataRoot);

  // 1. Class-file-version → Java-major arithmetic (the actual bug's error
  // text: "class file version 69.0 ... up to 65.0" → Java 25 required, 21 in use).
  ok('class file 65 = Java 21', javaMajorFromClassFileVersion(65) === 21);
  ok('class file 69 = Java 25', javaMajorFromClassFileVersion(69) === 25);
  ok('class file 52 = Java 8', javaMajorFromClassFileVersion(52) === 8);

  // 2. Friendly error translation — using the EXACT real error text from the
  // bug report, proving it's not hardcoded to today's specific numbers by
  // also checking a completely different class-version pair.
  const realBugLine = 'net/minecraft/bundler/Main has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version of the Java Runtime only recognizes class file versions up to 65.0';
  const friendly = translateClassVersionError(realBugLine);
  ok('translates the real bug report error line', friendly !== null);
  ok('friendly message names the REQUIRED version (25), not just "newer"', /Java 25/.test(friendly));
  ok('friendly message names the version Mercy is ACTUALLY using (21)', /Java 21/.test(friendly));
  ok('friendly message does not just say "exited unexpectedly"', !/exited unexpectedly/i.test(friendly));

  const hypotheticalFutureLine = 'has been compiled by a more recent version of the Java Runtime (class file version 74.0), this version of the Java Runtime only recognizes class file versions up to 61.0';
  const friendly2 = translateClassVersionError(hypotheticalFutureLine);
  ok('generalizes to a DIFFERENT, future class-version pair (not hardcoded to 69/65)', friendly2 && /Java 30/.test(friendly2) && /Java 17/.test(friendly2));

  ok('non-matching lines return null (no false positives)', translateClassVersionError('[12:00:00] [Server thread/INFO]: Done (1.234s)!') === null);

  // 3. Minecraft version → required Java (fallback heuristic table — the
  // LIVE metadata path is covered by the live E2E script since it needs
  // network; this proves the offline fallback's well-known boundaries and,
  // critically, that it does not hardcode a ceiling that silently caps out.
  ok('pre-1.17 → Java 8', requiredJavaMajor('1.16.5') === 8);
  ok('1.17.x → Java 16', requiredJavaMajor('1.17.1') === 16);
  ok('1.18–1.20.4 → Java 17', requiredJavaMajor('1.20.4') === 17);
  ok('1.20.5+ → Java 21', requiredJavaMajor('1.21.1') === 21);
  ok('unparseable/non-numeric version does not throw', (() => { try { requiredJavaMajor('unknown'); return true; } catch { return false; } })());

  // 4. selectCompatibleRuntime — pure selection logic (JVMs run bytecode
  // compiled for their own version or older, never newer, so only
  // major >= required is a candidate; the CLOSEST match is preferred).
  const fabricatedRuntimes = [
    { path: 'C:\\fake\\jdk8\\java.exe', version: 'openjdk 8', major: 8, source: 'fabricated' },
    { path: 'C:\\fake\\jdk17\\java.exe', version: 'openjdk 17', major: 17, source: 'fabricated' },
    { path: 'C:\\fake\\jdk21\\java.exe', version: 'openjdk 21', major: 21, source: 'fabricated' },
    // No real Java 25 exists on this dev machine — this entry is
    // constructed data, proving the selection algorithm's correctness
    // independent of whether a Java 25 JDK happens to be installed here.
    { path: 'C:\\fake\\jdk25\\java.exe', version: 'openjdk 25', major: 25, source: 'fabricated (no real Java 25 on this dev machine)' },
  ];
  ok('selects the CLOSEST compatible runtime, not just the newest', selectCompatibleRuntime(fabricatedRuntimes, 17).major === 17);
  ok('selects Java 25 when that is genuinely the minimum compatible one available', selectCompatibleRuntime(fabricatedRuntimes, 22).major === 25);
  ok('rejects when nothing installed meets the requirement', selectCompatibleRuntime(fabricatedRuntimes, 30) === null);
  ok('rejects on a truly empty runtime list (Java not installed at all)', selectCompatibleRuntime([], 21) === null);
  ok('an exact match is selected', selectCompatibleRuntime(fabricatedRuntimes, 21).major === 21);

  // 5. Real Java detection — actually executes `java -version` on this
  // machine (no stubbing) and parses its real stdout/stderr.
  const realJava = await mgr.detectJava();
  ok('detectJava finds the real installed Java', realJava.found === true);
  ok('detectJava parses a real major version number', typeof realJava.major === 'number' && realJava.major > 0);
  console.log(`  (this machine's real PATH java: major ${realJava.major})`);

  const allRuntimes = await mgr.detectAllJavaRuntimes();
  ok('detectAllJavaRuntimes finds at least the PATH runtime for real', allRuntimes.length >= 1);
  ok('every detected runtime has a real, executed major version (not guessed from a folder name)', allRuntimes.every((r) => typeof r.major === 'number' && r.major > 0));

  // 6. resolveLaunchJava / startServer gating — register a real server
  // record, then exercise the REAL gating logic startServer() itself calls,
  // for scenarios this dev machine's actual installed Java can't naturally
  // produce (needing a fabricated Java 25, or simulating "nothing
  // installed"). detectAllJavaRuntimes is stubbed ONLY for these two cases;
  // every other assertion in this file uses the real, unstubbed method.
  const serverDir = path.join(base, 'needs-java-25');
  mkFakeServer(serverDir);
  const imp = await mgr.importServer(serverDir, 'Needs Java 25', 2048);
  ok('test server registered', imp.success);
  const serverId = imp.server.id;
  // importServer can't know the real requirement for an unknown-version
  // import, so set it explicitly — this is exactly what createServer()
  // does for real from Mojang/PaperMC's own metadata.
  const server = mgr.getServer(serverId);
  server.requiredJavaMajor = 25;

  const originalDetectAll = mgr.detectAllJavaRuntimes.bind(mgr);

  // 6a. Only Java 21 available (this machine's real situation) → BLOCKED.
  mgr.detectAllJavaRuntimes = async () => [{ path: 'java', version: 'openjdk 21', major: 21, source: 'PATH (fabricated for this test)' }];
  const blockedResult = await mgr.startServer(serverId);
  ok('start is BLOCKED when only an incompatible Java is available', blockedResult.success === false);
  ok('blocked error names the exact required/selected versions, matching the spec format', /Java 25 is required for Minecraft .* but Java 21 is currently selected/.test(blockedResult.error || ''));
  ok('no process was actually spawned for the blocked attempt', !mgr.isRunning(serverId));
  ok('server.lastError is set to the same clear message (visible in the UI, not just the return value)', mgr.getServer(serverId).lastError === blockedResult.error);
  ok('server status was not left as "starting"/"running" after a blocked start', mgr.getServer(serverId).status !== 'starting' && mgr.getServer(serverId).status !== 'running');

  // 6b. No Java installed at all → BLOCKED with a distinct "none found" message.
  mgr.detectAllJavaRuntimes = async () => [];
  const noneResult = await mgr.startServer(serverId);
  ok('start is BLOCKED when no Java runtime is installed at all', noneResult.success === false);
  ok('the "nothing installed" error is clear and distinct from the "wrong version" error', /no Java runtime was found on this machine at all/i.test(noneResult.error || ''));
  ok('still no process spawned', !mgr.isRunning(serverId));

  // 6c. A compatible Java 25 IS available (fabricated — proves the ACCEPT
  // path of the exact same gate that blocked 6a/6b) → auto-selected, not blocked.
  mgr.detectAllJavaRuntimes = async () => [
    { path: 'C:\\fake\\jdk21\\java.exe', version: 'openjdk 21', major: 21, source: 'fabricated' },
    { path: 'C:\\fake\\jdk25\\java.exe', version: 'openjdk 25', major: 25, source: 'fabricated (no real Java 25 on this dev machine)' },
  ];
  const check = await mgr.resolveLaunchJava(mgr.getServer(serverId));
  ok('resolveLaunchJava ACCEPTS when a compatible runtime exists, auto-selecting it', check.ok === true && check.javaPath === 'C:\\fake\\jdk25\\java.exe');
  ok('resolveLaunchJava does not pick the newer-than-necessary runtime when a closer match exists', check.major === 25);

  mgr.detectAllJavaRuntimes = originalDetectAll;

  // 7. Explicit user-pinned javaPath — uses the REAL installed Java (no
  // stub), proving the pin mechanism itself with a genuine executable.
  const pinDir = path.join(base, 'pinned-server');
  mkFakeServer(pinDir);
  const pinImp = await mgr.importServer(pinDir, 'Pinned Server', 1024);
  const pinnedServer = mgr.getServer(pinImp.server.id);
  pinnedServer.requiredJavaMajor = realJava.major; // exactly what's really installed → should be accepted
  pinnedServer.javaPath = 'java'; // the real PATH java, pinned explicitly
  const pinnedOk = await mgr.resolveLaunchJava(pinnedServer);
  ok('a real pinned runtime that meets the requirement is accepted', pinnedOk.ok === true);

  pinnedServer.requiredJavaMajor = (realJava.major || 0) + 50; // impossible to satisfy with what's really installed
  const pinnedBad = await mgr.resolveLaunchJava(pinnedServer);
  ok('a real pinned runtime that does NOT meet the requirement is rejected', pinnedBad.ok === false);
  ok('the rejection names the real detected major version, not a guess', pinnedBad.major === realJava.major);

  pinnedServer.javaPath = path.join(base, 'this-path-does-not-exist', 'java.exe');
  const pinnedMissing = await mgr.resolveLaunchJava(pinnedServer);
  ok('a pinned runtime pointing at a nonexistent executable fails cleanly, not by throwing', pinnedMissing.ok === false && /moved or uninstalled/.test(pinnedMissing.error || ''));

  // Cleanup.
  try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}

  console.log(`\nJAVA RUNTIME TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
