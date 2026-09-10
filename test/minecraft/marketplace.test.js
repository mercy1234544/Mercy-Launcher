// Marketplace + delete-safety tests — deterministic, no network required.
// classifyForServer() is pure logic (no HTTP), tested directly with real
// Modrinth project-type/loader shapes copied from actual API responses.
// Content-manifest tracking (add/update/remove/list) and delete safety are
// tested against a real MinecraftManager + real filesystem, same as the
// existing service.test.js suite. The real network search/download/install
// path is proven separately in marketplace-live-e2e.js, per this project's
// existing convention (see service.test.js's own header comment).
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));
const { MinecraftMarketplace, classifyForServer } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftMarketplace.js'));

/** Genuinely (not mocked) locks a file exclusively on Windows via
 *  PowerShell's FileShare.None — a plain Node fs.openSync does NOT block
 *  deletion on Windows (libuv opens with FILE_SHARE_DELETE by default), so
 *  this is the real mechanism needed to force an actual filesystem failure
 *  for the "failed deletion" test below. Returns a stop() function that
 *  releases the lock. */
function lockFileExclusively(filePath, holdMs) {
  const ready = `${filePath}.locked-ready`;
  try { fs.unlinkSync(ready); } catch {}
  const script = `
$stream = [System.IO.File]::Open('${filePath.replace(/'/g, "''")}', 'Open', 'ReadWrite', 'None')
New-Item -ItemType File -Path '${ready.replace(/'/g, "''")}' -Force | Out-Null
Start-Sleep -Milliseconds ${holdMs}
$stream.Close()
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
  return {
    waitUntilLocked: async () => {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return fs.existsSync(ready);
    },
    release: async () => {
      await new Promise((resolve) => { child.on('exit', resolve); setTimeout(resolve, holdMs + 2000); });
      try { fs.unlinkSync(ready); } catch {}
    },
  };
}

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-market-test-')); }
function mkFakeServer(dir, jarName = 'server.jar') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, jarName), 'fake jar bytes');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25566\nlevel-name=world\n');
}

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();
  const mgr = new MinecraftManager(userDataRoot);
  const market = new MinecraftMarketplace();

  // 1. classifyForServer — real project_type/loader shapes from Modrinth's
  // actual API (see the session's live curl checks against api.modrinth.com).
  const paperPlugin = classifyForServer('plugin', ['bukkit', 'paper', 'spigot'], 'paper');
  ok('a real Paper plugin is installable on a Paper server', paperPlugin.installable === true && paperPlugin.kind === 'plugin');

  const pluginOnVanilla = classifyForServer('plugin', ['bukkit', 'paper', 'spigot'], 'vanilla');
  ok('a plugin is REJECTED for a Vanilla server (no plugin support)', pluginOnVanilla.installable === false);
  ok('the rejection reason explains why (Vanilla has no plugin support)', /vanilla/i.test(pluginOnVanilla.reason) || /plugin support/i.test(pluginOnVanilla.reason));

  const fabricMod = classifyForServer('mod', ['fabric', 'neoforge'], 'paper');
  ok('a Fabric mod is REJECTED even on a Paper server (Mercy runs no mod loader)', fabricMod.installable === false);
  const fabricModVanilla = classifyForServer('mod', ['fabric'], 'vanilla');
  ok('a Fabric mod is REJECTED on Vanilla too', fabricModVanilla.installable === false);
  ok('the mod rejection names what it would actually need', /fabric|forge|loader/i.test(fabricMod.reason));

  const datapackVanilla = classifyForServer('datapack', [], 'vanilla');
  ok('a datapack IS installable on Vanilla (no mod loader needed)', datapackVanilla.installable === true && datapackVanilla.kind === 'datapack');
  const datapackPaper = classifyForServer('datapack', [], 'paper');
  ok('a datapack IS installable on Paper too', datapackPaper.installable === true);

  const resourcepack = classifyForServer('resourcepack', [], 'paper');
  ok('a resourcepack (client-side content) is REJECTED — a server does not install this', resourcepack.installable === false);
  const shader = classifyForServer('shader', [], 'paper');
  ok('a shader (client-side content) is REJECTED for the same reason', shader.installable === false);

  const pluginWrongLoader = classifyForServer('plugin', ['fabric'], 'paper');
  ok('a "plugin" that only lists Fabric (mislabeled/edge case) is rejected on Paper', pluginWrongLoader.installable === false);

  // Bedrock gate — added for the Bedrock milestone. A datapack has NO
  // serverType check elsewhere in this function (it's a vanilla game
  // feature, valid for both vanilla and paper), so without this explicit
  // check first it would incorrectly report itself installable on Bedrock
  // too. Confirmed rejected here for every content shape, not just datapacks.
  const datapackBedrock = classifyForServer('datapack', [], 'bedrock');
  ok('a datapack is REJECTED for a Bedrock server (Bedrock is gated before the datapack no-loader-needed path)', datapackBedrock.installable === false);
  ok('the Bedrock rejection reason explains why', /bedrock/i.test(datapackBedrock.reason));
  const pluginBedrock = classifyForServer('plugin', ['bukkit', 'paper', 'spigot'], 'bedrock');
  ok('a Paper plugin is REJECTED for a Bedrock server too', pluginBedrock.installable === false);

  // 2. Content manifest tracking — real persistence via MinecraftManager,
  // surviving a fresh instance the same way theme/settings do on restart.
  const serverDir = path.join(base, 'content-server');
  mkFakeServer(serverDir);
  const imp = await mgr.importServer(serverDir, 'Content Test Server', 1024);
  ok('test server registered for content tracking', imp.success);
  const serverId = imp.server.id;

  ok('a fresh server starts with no installed content', mgr.getInstalledContent(serverId).length === 0);

  const record = {
    id: 'test-content-1', kind: 'plugin', source: 'modrinth',
    projectId: 'hXiIvTyT', projectName: 'EssentialsX', versionId: 'nY6VN1XH', versionNumber: '2.22.0',
    fileName: 'EssentialsX-2.22.0.jar', relPath: path.join('plugins', 'EssentialsX-2.22.0.jar'),
    sha1: 'c509ef487056e460dff2fbd0462ae8f0c3b5b0d2', size: 4861125,
    enabled: true, installedAt: new Date().toISOString(), dependencies: [],
  };
  ok('addInstalledContent succeeds', mgr.addInstalledContent(serverId, record) === true);
  ok('getInstalledContent reflects it immediately', mgr.getInstalledContent(serverId).length === 1);

  const mgr2 = new MinecraftManager(userDataRoot); // simulate a restart
  const afterRestart = mgr2.getInstalledContent(serverId);
  ok('installed content SURVIVES a restart', afterRestart.length === 1 && afterRestart[0].projectName === 'EssentialsX');

  ok('updateInstalledContent can toggle enabled state', mgr2.updateInstalledContent(serverId, 'test-content-1', { enabled: false }) === true);
  ok('the update is reflected', mgr2.getInstalledContent(serverId)[0].enabled === false);

  const removed = mgr2.removeInstalledContent(serverId, 'test-content-1');
  ok('removeInstalledContent returns the removed record', removed && removed.projectId === 'hXiIvTyT');
  ok('content list is empty after removal', mgr2.getInstalledContent(serverId).length === 0);

  // 3. Path safety for content installation — the same guarantee
  // listFiles/readServerFile rely on, reused by the Marketplace installer.
  const okPath = mgr2.resolveWithinServer(serverId, path.join('plugins', 'Foo.jar'));
  ok('a normal plugins/ path resolves inside the server directory', okPath !== null && okPath.startsWith(path.resolve(serverDir)));
  const traversal = mgr2.resolveWithinServer(serverId, path.join('..', '..', 'outside.jar'));
  ok('a path-traversal attempt for content install is REJECTED', traversal === null);
  const traversalWindows = mgr2.resolveWithinServer(serverId, '..\\..\\..\\Windows\\evil.jar');
  ok('a Windows-style traversal attempt is REJECTED too', traversalWindows === null);

  // 4. listInstalled reports real, honest status — never a fake "installed" count.
  const missingRecord = { ...record, id: 'missing-1', relPath: path.join('plugins', 'DoesNotExist.jar') };
  mgr2.addInstalledContent(serverId, missingRecord);
  const listed = market.listInstalled(mgr2, serverId);
  ok('listInstalled flags a tracked file that is actually missing from disk', listed.find((c) => c.id === 'missing-1')?.missingOnDisk === true);
  mgr2.removeInstalledContent(serverId, 'missing-1');

  // 5. Delete safety — never delete Mercy's own directories, never delete a
  // drive root, and never remove from the registry unless the filesystem
  // deletion genuinely succeeded.
  const deleteTestDir = path.join(base, 'delete-me');
  mkFakeServer(deleteTestDir);
  const delImp = await mgr.importServer(deleteTestDir, 'Delete Safety Test', 1024);
  const delServerId = delImp.server.id;

  // 5a. Refuse to delete if the registered path is redirected at Mercy's own userData dir.
  const dangerousServer = mgr.getServer(delServerId);
  const realInstallPath = dangerousServer.installPath;
  dangerousServer.installPath = userDataRoot;
  const overlapResult = await mgr.deleteServer(delServerId, true);
  ok('refuses to delete a directory overlapping Mercy\'s own userData', overlapResult.success === false);
  ok('Mercy\'s real userData directory was NOT touched', fs.existsSync(userDataRoot) && fs.existsSync(path.join(userDataRoot, 'data')));
  ok('the server was NOT removed from the registry after a refused delete', mgr.getServer(delServerId) !== undefined);

  // 5b. Refuse to delete an actual drive root.
  dangerousServer.installPath = path.parse(base).root; // e.g. "C:\\" — genuinely exists, never touched
  const rootResult = await mgr.deleteServer(delServerId, true);
  ok('refuses to delete a drive root', rootResult.success === false);
  ok('the server is still registered after refusing a drive-root delete', mgr.getServer(delServerId) !== undefined);

  // 5c. A failed filesystem deletion (a genuinely, exclusively locked file —
  // not just an open fd, which Windows/libuv doesn't treat as blocking)
  // leaves the server registered rather than silently losing track of
  // orphaned files.
  dangerousServer.installPath = realInstallPath;
  const lockedFile = path.join(realInstallPath, 'eula.txt');
  const lock = lockFileExclusively(lockedFile, 3000);
  const gotLock = await lock.waitUntilLocked();
  ok('the real exclusive file lock was actually acquired before testing delete', gotLock);
  const lockedResult = await mgr.deleteServer(delServerId, true);
  ok('a genuinely failed deletion (exclusively locked file) reports success:false', lockedResult.success === false);
  ok('the server stays registered after a failed deletion so the user can retry', mgr.getServer(delServerId) !== undefined);
  ok('the directory was not partially deleted out from under the still-registered server', fs.existsSync(realInstallPath) && fs.existsSync(lockedFile));
  await lock.release();

  // 5d. The real accept path: deletion actually succeeds, files are
  // genuinely gone, and the registry is cleaned up only afterward.
  ok('the real server directory exists before the real delete', fs.existsSync(realInstallPath));
  const realDeleteResult = await mgr.deleteServer(delServerId, true);
  ok('a real, unobstructed delete succeeds', realDeleteResult.success === true);
  ok('the real server directory is actually gone from disk', !fs.existsSync(realInstallPath));
  ok('the server is removed from the registry only after real deletion succeeded', mgr.getServer(delServerId) === undefined);

  // 5e. deleteFiles=false never touches the real directory (still safe with the new signature).
  const keepDir = path.join(base, 'keep-files');
  mkFakeServer(keepDir);
  const keepImp = await mgr.importServer(keepDir, 'Keep Files Test', 1024);
  const keepResult = await mgr.deleteServer(keepImp.server.id, false);
  ok('deleteFiles=false still succeeds', keepResult.success === true);
  ok('deleteFiles=false does NOT touch the real directory', fs.existsSync(keepDir));

  // Cleanup.
  try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}

  console.log(`\nMARKETPLACE + DELETE SAFETY TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
