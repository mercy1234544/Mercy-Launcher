// FiveM Marketplace tests — deterministic, no network required for most of
// this (parseRepoUrl/githubPreviewImage are pure functions; install-guard
// rejections all return before any network call; content tracking and path
// safety are tested against a real ServerManager + real filesystem, same
// convention as the Minecraft test suites). The real download → extract →
// install → server.cfg → enable/disable → remove path is proven for real,
// no mocks, in fivem-live-e2e.js.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { ServerManager } = require(path.resolve(__dirname, '../../dist/main/services/ServerManager.js'));
const { FiveMMarketplace, parseRepoUrl, githubPreviewImage } = require(path.resolve(__dirname, '../../dist/main/services/FiveMMarketplace.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-fivem-market-test-')); }

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();
  const mgr = new ServerManager(userDataRoot);
  const market = new FiveMMarketplace();

  // 1. parseRepoUrl — real GitHub URL shapes, including ones actually used
  // in the existing curated catalog (with/without trailing slash, .git suffix).
  ok('parses a plain https URL', JSON.stringify(parseRepoUrl('https://github.com/overextended/ox_lib')) === JSON.stringify({ owner: 'overextended', repo: 'ox_lib' }));
  ok('parses a URL with a trailing slash', JSON.stringify(parseRepoUrl('https://github.com/qbcore-framework/qb-core/')) === JSON.stringify({ owner: 'qbcore-framework', repo: 'qb-core' }));
  ok('parses a URL with a .git suffix', JSON.stringify(parseRepoUrl('https://github.com/esx-framework/esx_core.git')) === JSON.stringify({ owner: 'esx-framework', repo: 'esx_core' }));
  ok('rejects a non-GitHub URL', parseRepoUrl('https://gitlab.com/someone/something') === null);
  ok('rejects an empty string', parseRepoUrl('') === null);

  // 2. githubPreviewImage — real, deterministic, no API call needed at all.
  ok('builds the real GitHub OpenGraph image URL', githubPreviewImage('overextended', 'ox_lib') === 'https://opengraph.githubassets.com/1/overextended/ox_lib');

  // 3. Content manifest tracking on a real ServerManager — real persistence,
  // surviving a fresh instance the same way Minecraft's did on "restart".
  const serverDir = path.join(base, 'fivem-server');
  fs.mkdirSync(serverDir, { recursive: true });
  const imp = await mgr.importExistingServer(serverDir, 'FiveM Content Test');
  ok('test FiveM server registered', imp.success);
  const serverId = imp.server.id;

  ok('a fresh server starts with no installed marketplace content', mgr.getInstalledMarketplaceContent(serverId).length === 0);

  const record = {
    id: 'test-1', source: 'github', repo: 'overextended/ox_lib', resourceName: 'ox_lib',
    category: '[core]', relPath: path.join('resources', '[core]', 'ox_lib'),
    version: '3.20.0', sha: 'abc123', enabled: true, installedAt: new Date().toISOString(), dependencies: [],
  };
  ok('addInstalledMarketplaceContent succeeds', mgr.addInstalledMarketplaceContent(serverId, record) === true);
  ok('getInstalledMarketplaceContent reflects it immediately', mgr.getInstalledMarketplaceContent(serverId).length === 1);

  const mgr2 = new ServerManager(userDataRoot); // simulate a restart
  const afterRestart = mgr2.getInstalledMarketplaceContent(serverId);
  ok('installed marketplace content SURVIVES a restart', afterRestart.length === 1 && afterRestart[0].resourceName === 'ox_lib');

  ok('updateInstalledMarketplaceContent can toggle enabled state', mgr2.updateInstalledMarketplaceContent(serverId, 'test-1', { enabled: false }) === true);
  ok('the update is reflected', mgr2.getInstalledMarketplaceContent(serverId)[0].enabled === false);

  const removed = mgr2.removeInstalledMarketplaceContent(serverId, 'test-1');
  ok('removeInstalledMarketplaceContent returns the removed record', removed && removed.repo === 'overextended/ox_lib');
  ok('content list is empty after removal', mgr2.getInstalledMarketplaceContent(serverId).length === 0);

  // 4. Path safety — the same guarantee Minecraft's resolveWithinServer gives,
  // now on ServerManager, used by the FiveM installer for resource placement.
  const okPath = mgr2.resolveWithinServer(serverId, path.join('resources', '[core]', 'ox_lib'));
  ok('a normal resources/[core]/name path resolves inside the server directory', okPath !== null && okPath.startsWith(path.resolve(serverDir)));
  const traversal = mgr2.resolveWithinServer(serverId, path.join('..', '..', 'outside'));
  ok('a path-traversal attempt is REJECTED', traversal === null);
  const traversalWindows = mgr2.resolveWithinServer(serverId, '..\\..\\..\\Windows\\evil');
  ok('a Windows-style traversal attempt is REJECTED too', traversalWindows === null);
  const rootPath = mgr2.resolveWithinServer(serverId, '');
  ok('the server root itself resolves (not a traversal)', rootPath === path.resolve(serverDir));

  // 5. installResource — validation guards that must reject BEFORE any
  // network call (the whole point being: no half-done install, no crash).
  const badRepo = await market.installResource(mgr2, serverId, { repoUrl: 'not-a-github-url', resourceName: 'x', category: '[core]' });
  ok('installResource rejects a non-GitHub repo URL before touching the network', badRepo.success === false && /valid GitHub/i.test(badRepo.error));

  const noServer = await market.installResource(mgr2, 'does-not-exist', { repoUrl: 'https://github.com/overextended/ox_lib', resourceName: 'ox_lib', category: '[core]' });
  ok('installResource rejects an unknown server id', noServer.success === false && /server not found/i.test(noServer.error));

  // Pre-existing, unrelated folder with the same resource name must never be
  // silently overwritten.
  const conflictDir = path.join(serverDir, 'resources', '[core]', 'ox_lib');
  fs.mkdirSync(conflictDir, { recursive: true });
  fs.writeFileSync(path.join(conflictDir, 'not-mine.txt'), 'a real file the user put here, not Mercy');
  const conflictResult = await market.installResource(mgr2, serverId, { repoUrl: 'https://github.com/overextended/ox_lib', resourceName: 'ox_lib', category: '[core]' });
  ok('installResource refuses to overwrite an existing, untracked resource folder', conflictResult.success === false && /already exists/i.test(conflictResult.error));
  ok('the untracked folder\'s real file was left untouched', fs.existsSync(path.join(conflictDir, 'not-mine.txt')));
  fs.rmSync(conflictDir, { recursive: true, force: true });

  // 6. listInstalled reports real, honest status — a tracked record whose
  // file is actually missing from disk is flagged, never silently hidden.
  mgr2.addInstalledMarketplaceContent(serverId, { ...record, id: 'missing-1', relPath: path.join('resources', '[core]', 'does-not-exist-on-disk') });
  const listed = market.listInstalled(mgr2, serverId);
  ok('listInstalled flags a tracked resource that is actually missing from disk', listed.find((c) => c.id === 'missing-1')?.missingOnDisk === true);
  mgr2.removeInstalledMarketplaceContent(serverId, 'missing-1');

  // 7. removeResource / setResourceEnabled against a real (fake-content)
  // resource folder + real server.cfg, proving the file operations and
  // server.cfg ensure-line management are genuinely real, not stubbed.
  const realResourceDir = path.join(serverDir, 'resources', '[core]', 'test_resource');
  fs.mkdirSync(realResourceDir, { recursive: true });
  fs.writeFileSync(path.join(realResourceDir, 'fxmanifest.lua'), "fx_version 'cerulean'\ngame 'gta5'\nversion '1.0.0'\n");
  fs.writeFileSync(path.join(serverDir, 'server.cfg'), '# test server.cfg\nsv_hostname "Test"\n');
  const realRecord = { id: 'real-1', source: 'github', repo: 'someone/test_resource', resourceName: 'test_resource', category: '[core]', relPath: path.join('resources', '[core]', 'test_resource'), version: '1.0.0', sha: null, enabled: false, installedAt: new Date().toISOString(), dependencies: [] };
  mgr2.addInstalledMarketplaceContent(serverId, realRecord);

  const enableResult = await market.setResourceEnabled(mgr2, serverId, 'real-1', true);
  ok('setResourceEnabled succeeds', enableResult.success === true);
  const cfgAfterEnable = fs.readFileSync(path.join(serverDir, 'server.cfg'), 'utf-8');
  ok('enabling a resource REALLY adds an ensure line to server.cfg', /ensure test_resource/.test(cfgAfterEnable));
  ok('the tracked record reflects enabled:true', mgr2.getInstalledMarketplaceContent(serverId).find((c) => c.id === 'real-1').enabled === true);

  const disableResult = await market.setResourceEnabled(mgr2, serverId, 'real-1', false);
  ok('setResourceEnabled(false) succeeds', disableResult.success === true);
  const cfgAfterDisable = fs.readFileSync(path.join(serverDir, 'server.cfg'), 'utf-8');
  ok('disabling a resource REALLY removes the ensure line from server.cfg', !/ensure test_resource/.test(cfgAfterDisable));

  const removeResult = await market.removeResource(mgr2, serverId, 'real-1');
  ok('removeResource succeeds', removeResult.success === true);
  ok('removeResource actually deletes the real resource folder', !fs.existsSync(realResourceDir));
  ok('removeResource clears the tracked record', mgr2.getInstalledMarketplaceContent(serverId).length === 0);

  // Cleanup.
  try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}

  console.log(`\nFIVEM MARKETPLACE TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
