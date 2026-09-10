// Bedrock Edition tests — deterministic logic only, no network/real
// bedrock_server.exe required, matching this project's existing convention
// (see service.test.js's own header comment). Covers: real detection of a
// Bedrock install by its actual executable (never guessed), the
// backward-compat `edition` migration for servers persisted before Bedrock
// support existed, that starting a Bedrock server never routes through any
// Java-resolution code path, and that the existing generic protections
// (property read/write, path traversal, safe delete) apply unchanged to a
// Bedrock server record. The real live download/start/RakNet-ping/import
// against Mojang/Microsoft's actual Bedrock API and a real bedrock_server.exe
// was verified separately by hand against a disposable directory (see the
// final report) since that needs real network + a real Windows process.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-bedrock-test-')); }

function mkFakeBedrockServer(dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bedrock_server.exe'), 'fake bedrock exe bytes');
  fs.writeFileSync(path.join(dir, 'server.properties'), [
    'server-name=Dedicated Server',
    `server-port=${opts.port ?? 19132}`,
    'server-portv6=19133',
    'gamemode=survival',
    'allow-cheats=false',
    'some-future-bedrock-property=42',
  ].join('\n'));
  if (opts.withWorld) {
    fs.mkdirSync(path.join(dir, 'worlds', 'Bedrock level'), { recursive: true });
  }
}

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();
  const mgr = new MinecraftManager(userDataRoot);

  // 1. Real, edition-aware detection — identified by the actual
  // bedrock_server.exe artifact, never a folder-name guess, and never
  // requiring any Java file (jar/eula.txt).
  const bedrockDir = path.join(base, 'bedrock-server');
  mkFakeBedrockServer(bedrockDir, { port: 19140, withWorld: true });
  const detected = await mgr.detectExistingServer(bedrockDir);
  ok('detectExistingServer recognizes a real Bedrock install by bedrock_server.exe', detected.valid === true);
  ok('detectExistingServer reports edition=bedrock', detected.edition === 'bedrock');
  ok('detectExistingServer reports serverType=bedrock', detected.serverType === 'bedrock');
  ok('detectExistingServer reads the real Bedrock port from server.properties', detected.port === 19140);
  ok('detectExistingServer detects the worlds/ folder as a world', detected.hasWorld === true);
  ok('detectExistingServer never requires eula.txt for Bedrock', detected.hasEula === false);

  const noWorldDir = path.join(base, 'bedrock-no-world');
  mkFakeBedrockServer(noWorldDir, { port: 19150, withWorld: false });
  const detectedNoWorld = await mgr.detectExistingServer(noWorldDir);
  ok('detectExistingServer correctly reports no world when worlds/ is empty/absent', detectedNoWorld.hasWorld === false);

  // An arbitrary empty/unrelated folder must still be rejected for BOTH
  // editions — nothing here should ever misclassify a random directory.
  const randomDir = path.join(base, 'not-a-server-at-all');
  fs.mkdirSync(randomDir, { recursive: true });
  fs.writeFileSync(path.join(randomDir, 'notes.txt'), 'just some file');
  const rejectedRandom = await mgr.detectExistingServer(randomDir);
  ok('detectExistingServer rejects an arbitrary folder with no server.jar/eula/properties/bedrock_server.exe', rejectedRandom.valid === false);

  // 2. importServer for a real detected Bedrock install.
  const imp = await mgr.importServer(bedrockDir, 'My Bedrock Server', 2048);
  ok('importServer succeeds for a valid detected Bedrock server', imp.success === true && !!imp.server);
  ok('imported Bedrock server has edition=bedrock', imp.server.edition === 'bedrock');
  ok('imported Bedrock server has serverType=bedrock', imp.server.serverType === 'bedrock');
  ok('imported Bedrock server has an empty jarFile (never a Java jar)', imp.server.jarFile === '');
  ok('imported Bedrock server has ramMB=0 (no JVM heap concept)', imp.server.ramMB === 0);
  ok('imported Bedrock server keeps its real detected port', imp.server.port === 19140);
  const bedrockId = imp.server.id;

  // 3. Backward-compat migration — a server persisted BEFORE Bedrock support
  // existed has no `edition` key on disk at all. Simulated by writing the
  // registry file directly (bypassing the manager, which always writes the
  // current shape) then loading a FRESH manager instance against it.
  const migrateRoot = mkTempRoot();
  const migrateDataDir = path.join(migrateRoot, 'data');
  fs.mkdirSync(migrateDataDir, { recursive: true });
  const oldJavaRecord = {
    id: 'old-java-1', name: 'Pre-Bedrock Java Server', installPath: path.join(base, 'old-java'),
    version: '1.20.4', serverType: 'vanilla', jarFile: 'server.jar', ramMB: 2048, port: 25565,
    status: 'stopped', pid: null, startedAt: null, autoRestart: false, lastBackup: null,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    requiredJavaMajor: 17, javaPath: null, lastError: null, installedContent: [],
    // deliberately NO `edition` field — this is the exact pre-Bedrock shape.
  };
  fs.writeFileSync(path.join(migrateDataDir, 'minecraft-servers.json'), JSON.stringify([oldJavaRecord], null, 2));
  const migratedMgr = new MinecraftManager(migrateRoot);
  const migrated = migratedMgr.getServer('old-java-1');
  ok('a pre-Bedrock server record loads successfully', !!migrated);
  ok('a pre-Bedrock server record with no edition field defaults to java (never guessed as bedrock)', migrated.edition === 'java');
  const rewritten = JSON.parse(fs.readFileSync(path.join(migrateDataDir, 'minecraft-servers.json'), 'utf-8'));
  ok('the migration was persisted back to disk (edition now present on file)', rewritten[0].edition === 'java');
  ok('migration did not touch any other field on the old record', rewritten[0].version === '1.20.4' && rewritten[0].requiredJavaMajor === 17);

  // Edge case: an old record that already had serverType 'bedrock' (should
  // be structurally impossible before this migration existed, but the
  // fallback logic is explicitly `serverType === 'bedrock' ? 'bedrock' :
  // 'java'` — verify it takes that branch correctly rather than always
  // defaulting to java regardless of serverType).
  const oldBedrockShapeRecord = { ...oldJavaRecord, id: 'old-bedrock-1', serverType: 'bedrock' };
  delete oldBedrockShapeRecord.edition;
  fs.writeFileSync(path.join(migrateDataDir, 'minecraft-servers.json'), JSON.stringify([oldJavaRecord, oldBedrockShapeRecord], null, 2));
  const migratedMgr2 = new MinecraftManager(migrateRoot);
  ok('a record with serverType=bedrock and no edition migrates to edition=bedrock', migratedMgr2.getServer('old-bedrock-1').edition === 'bedrock');
  ok('a record with serverType=vanilla and no edition still migrates to edition=java', migratedMgr2.getServer('old-java-1').edition === 'java');

  // 4. Launch dispatch — starting a Bedrock server must NEVER touch any
  // Java-resolution code path. Since we can't run a real bedrock_server.exe
  // in this deterministic suite, bedrock_server.exe is deliberately absent
  // here — the resulting error must name bedrock_server.exe specifically,
  // NEVER a jar file or Java runtime, proving launchBedrockProcess (not
  // launchJavaProcess) was the one that ran.
  const bareDir = path.join(base, 'bedrock-bare');
  fs.mkdirSync(bareDir, { recursive: true });
  fs.writeFileSync(path.join(bareDir, 'server.properties'), 'server-port=19160\n');
  // Can't import via detectExistingServer (no bedrock_server.exe present by
  // design for this check) — register directly via the manager's own
  // persisted shape instead, exactly as an already-imported record would look.
  const bareServer = {
    id: 'bedrock-bare-1', name: 'Bare Bedrock', installPath: bareDir, version: 'unknown',
    serverType: 'bedrock', edition: 'bedrock', jarFile: '', ramMB: 0, port: 19160,
    status: 'stopped', pid: null, startedAt: null, autoRestart: false, lastBackup: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    requiredJavaMajor: null, javaPath: null, lastError: null, installedContent: [],
  };
  fs.writeFileSync(path.join(userDataRoot, 'data', 'minecraft-servers.json'),
    JSON.stringify([...mgr.getAllServers(), bareServer], null, 2));
  const mgrReloaded = new MinecraftManager(userDataRoot);
  const startResult = await mgrReloaded.startServer('bedrock-bare-1');
  ok('starting a Bedrock server with no bedrock_server.exe fails', startResult.success === false);
  ok('the failure names bedrock_server.exe specifically (proves the Bedrock launch path ran)', /bedrock_server\.exe/i.test(startResult.error || ''));
  ok('the failure NEVER mentions a jar file (proves the JAVA launch path did NOT run)', !/\.jar/i.test(startResult.error || ''));
  ok('the failure NEVER mentions a Java runtime (proves resolveLaunchJava was never called)', !/java runtime|java \d/i.test(startResult.error || ''));

  // 5. Properties — the same generic read/write works for Bedrock's own key
  // set (allow-cheats, allow-list, server-name — not Java's motd/pvp/
  // simulation-distance), and still preserves genuinely unknown keys.
  const bedrockProps = mgr.readProperties(bedrockId);
  ok('readProperties parses a real Bedrock key (server-name)', bedrockProps.some((p) => p.key === 'server-name' && p.value === 'Dedicated Server'));
  ok('readProperties parses allow-cheats', bedrockProps.some((p) => p.key === 'allow-cheats' && p.value === 'false'));
  ok('readProperties parses the deliberately-unknown future Bedrock key too', bedrockProps.some((p) => p.key === 'some-future-bedrock-property'));

  const bedrockWrite = mgr.writeProperties(bedrockId, { 'allow-cheats': 'true', 'server-name': 'Mercy Bedrock' });
  ok('writeProperties succeeds for Bedrock-shaped keys', bedrockWrite.success === true);
  const bedrockRaw = fs.readFileSync(path.join(bedrockDir, 'server.properties'), 'utf-8');
  ok('writeProperties applied allow-cheats=true', /allow-cheats=true/.test(bedrockRaw));
  ok('writeProperties applied the new server-name', /server-name=Mercy Bedrock/.test(bedrockRaw));
  ok('writeProperties PRESERVED the unknown future Bedrock property untouched', /some-future-bedrock-property=42/.test(bedrockRaw));
  ok('writeProperties never wrote any Java-only key (motd/pvp/simulation-distance) into a Bedrock properties file', !/^motd=|^pvp=|^simulation-distance=/m.test(bedrockRaw));

  // 6. Path traversal + safe delete — the SAME generic guards apply
  // unchanged to a Bedrock server record (no edition-specific bypass).
  const traversal = mgr.readServerFile(bedrockId, '..\\..\\..\\Windows\\win.ini');
  ok('readServerFile REJECTS a traversal attempt against a Bedrock server the same as Java', traversal === null);
  const legit = mgr.readServerFile(bedrockId, 'server.properties');
  ok('readServerFile allows a real in-bounds file for a Bedrock server', legit !== null && legit.includes('Mercy Bedrock'));

  const delResult = await mgr.deleteServer(bedrockId, false);
  ok('deleteServer (registry only) succeeds for a Bedrock server', delResult.success === true);
  ok('deleteServer(deleteFiles=false) did NOT touch the real Bedrock directory', fs.existsSync(bedrockDir));
  ok('Bedrock server is gone from the registry', mgr.getServer(bedrockId) === undefined);

  // Cleanup — this test's own disposable temp dirs only.
  try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(migrateRoot, { recursive: true, force: true }); } catch {}

  console.log(`\nBEDROCK TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
