// Assetto Corsa PLAYER installer — behavioral tests against disposable fixtures only. No real game folder,
// no real network: archives are built on the fly, the "official host" is a local HTTP server.
// Covers: plan building, successful installs (cars, skins, track-from-file, companion app), every
// verification failure, byte-for-byte rollback, crash-recovery from a journal, backups on repair, the
// "never installs CSP / never touches unapproved items / never runs while the game runs" rules, and that
// no address ever reaches the install log.
const fs = require('fs'), path = require('path');
const F = require('./_acFixtures');
const { buildInstallPlan, executeInstall, recoverInterruptedInstalls, isOfficialSourceUrl } = F.dist('ac/installer.js');
const { resolveEndpoints, EMPTY_LOCAL } = F.dist('ac/endpoints.js');
const { findArchiveTool, assertSafeEntryPaths, assertTreeIsSafe } = F.dist('ac/archive.js');
const { checkAcRequirements, parseBoardServers } = F.dist('AcRequirementsChecker.js');

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗', name); } };
const skip = (name) => { skipped++; console.log('  - SKIPPED (no 7-Zip to build fixture archives):', name); };

const LAN = '192.168.55.10', PUB = 'play.example.com', PUB_IP = '203.0.113.7';

(async () => {
  if (!F.sevenAvailable()) { skip('the entire installer suite (needs 7-Zip to create .7z/.zip fixtures)'); console.log(`\nAC INSTALLER TESTS: ${pass} passed, ${fail} failed, ${skipped} skipped`); process.exit(0); }
  const cleanup = [];
  const tmp = (p) => { const d = F.mkTmp(p); cleanup.push(d); return d; };

  // ── fixture archives ───────────────────────────────────────────────────────
  const packSrc = tmp('pack-src');
  for (const id of ['car_a', 'car_b']) F.writeCar(path.join(packSrc, 'content', 'cars'), id);
  F.writeCar(path.join(packSrc, 'content', 'cars'), 'car_z', { ui: '{"version":"9"}', acd: 'decoy', skins: ['x'] }); // never requested
  const arcDir = tmp('arc');
  const packArc = F.makeArchive(packSrc, path.join(arcDir, 'pack.7z'), '7z');
  const packZip = F.makeArchive(packSrc, path.join(arcDir, 'pack.zip'), 'zip');

  const badSrc = tmp('bad-src'); F.writeCar(path.join(badSrc, 'content', 'cars'), 'car_a', { acd: 'TAMPERED' }); F.writeCar(path.join(badSrc, 'content', 'cars'), 'car_b');
  const badArc = F.makeArchive(badSrc, path.join(arcDir, 'bad.7z'), '7z');

  const trackSrc = tmp('trk-src'); F.writeTrack(path.join(trackSrc, 'SRP Release'));
  const trackArc = F.makeArchive(trackSrc, path.join(arcDir, 'track.7z'), '7z');
  const oldVerSrc = tmp('trk-old'); F.writeTrack(path.join(oldVerSrc, 'SRP Release'), { markerName: '1.3.0 Stable.txt' });
  const oldVerArc = F.makeArchive(oldVerSrc, path.join(arcDir, 'track-130.7z'), '7z');
  const tamperSrc = tmp('trk-tamper'); F.writeTrack(path.join(tamperSrc, 'SRP Release'), { marker: 'edited marker' });
  const tamperArc = F.makeArchive(tamperSrc, path.join(arcDir, 'track-tamper.7z'), '7z');

  const packBytes = fs.readFileSync(packArc);
  const host = await F.serve({ '/pack.7z': packArc });
  const bundle = F.fixtureBundle(`${host.base}/pack.7z`);
  bundle.sources.sources[1].localArchive = { bytes: packBytes.length, sha256: F.sha(packBytes) };

  const release = { servers: { t2: { host: PUB, tcpPort: null, httpPort: null } } };
  const epsFull = resolveEndpoints(bundle.servers[0], release, { ...EMPTY_LOCAL, lanHost: LAN });
  const epsPublicOnly = resolveEndpoints(bundle.servers[0], release, EMPTY_LOCAL);
  const epsNone = resolveEndpoints(bundle.servers[0], { servers: { t2: { host: null, tcpPort: null, httpPort: null } } }, EMPTY_LOCAL);

  const logLines = [];
  const mk = (fx, over = {}) => ({ acRoot: fx.ac, bundle, serverId: 't2', endpoints: epsFull, downloadDir: path.join(fx.base, 'dl'), documentsAcDir: fx.docs,
    isGameRunning: async () => false, allowLoopbackHttp: true, resolver: async () => [PUB_IP], log: (l) => logLines.push(l), ...over });
  const planOf = (fx, over = {}) => buildInstallPlan({ acRoot: fx.ac, bundle, serverId: 't2', endpoints: epsFull, documentsAcDir: fx.docs, resolver: async () => [PUB_IP], allowLoopbackHttp: true, ...over });
  const fresh = (o) => { const fx = F.emptyAcInstall(o); cleanup.push(fx.base); return fx; };
  const item = (plan, id) => plan.items.find((i) => i.id === id);
  const noWork = (fx) => !fs.existsSync(path.join(fx.ac, 'content', '.mercy-staging')) || fs.readdirSync(path.join(fx.ac, 'content', '.mercy-staging')).length === 0;

  // ── 1. policy + helpers ───────────────────────────────────────────────────
  ok('isOfficialSourceUrl: https on the owner\'s own domain (or a subdomain) only', isOfficialSourceUrl('https://files.shutokorevivalproject.com/x.7z', 'https://shutokorevivalproject.com') && isOfficialSourceUrl('https://shutokorevivalproject.com/x', 'https://shutokorevivalproject.com'));
  ok('isOfficialSourceUrl refuses other domains, look-alikes, http, and malformed URLs', !isOfficialSourceUrl('https://evil.example/x.7z', 'https://shutokorevivalproject.com') && !isOfficialSourceUrl('https://shutokorevivalproject.com.evil.example/x', 'https://shutokorevivalproject.com') && !isOfficialSourceUrl('http://files.shutokorevivalproject.com/x', 'https://shutokorevivalproject.com') && !isOfficialSourceUrl('not a url', 'https://shutokorevivalproject.com'));
  ok('loopback http is accepted only when a test explicitly opts in', !isOfficialSourceUrl('http://127.0.0.1:1/x', 'https://example.invalid') && isOfficialSourceUrl('http://127.0.0.1:1/x', 'https://example.invalid', true));
  let threw = false; try { assertSafeEntryPaths([{ path: 'content/../../evil.txt', size: 1, isDir: false }]); } catch { threw = true; }
  let threw2 = false; try { assertSafeEntryPaths([{ path: 'C:/Windows/x', size: 1, isDir: false }]); } catch { threw2 = true; }
  ok('archive entries that escape the destination (.. or absolute) are refused before extraction', threw && threw2);
  const jd = tmp('junction'); fs.mkdirSync(path.join(jd, 'real')); fs.symlinkSync(path.join(jd, 'real'), path.join(jd, 'link'), 'junction');
  let threw3 = false; try { assertTreeIsSafe(jd); } catch { threw3 = true; }
  ok('a link/junction inside extracted content is refused', threw3);

  // ── 2. plan on an empty install ───────────────────────────────────────────
  const fxPlan = fresh();
  const plan0 = await planOf(fxPlan);
  ok('PLAN: missing cars become install items sourced from the car pack, with a real download entry', item(plan0, 'car:car_a')?.action === 'install' && item(plan0, 'car:car_b')?.action === 'install' && plan0.downloads.length === 1 && plan0.downloads[0].sha256 === F.sha(packBytes));
  ok('PLAN: a base-game car is manual only ("verify game files in Steam") — never touched by the launcher', item(plan0, 'car:base_car')?.action === 'manual' && /Verify integrity/.test((item(plan0, 'car:base_car').manualSteps || []).join(' ')));
  ok('PLAN: the SRP track has NO live link, so it is blocked with an honest explanation and asks for the player\'s own archive — no URL is invented', item(plan0, 'track')?.needsLocalFile === true && /redirects to its home page/.test(item(plan0, 'track').blocked) && !plan0.downloads.some((d) => d.itemIds.includes('track')));
  ok('PLAN: the SRP Board is offered as optional and not blocked when endpoints exist', item(plan0, 'companion:srp_board')?.optional === true && !item(plan0, 'companion:srp_board').blocked);
  ok('PLAN: CSP is reported as fine here and is never an installable item', plan0.csp.status === 'ok' && !plan0.items.some((i) => /csp|shader/i.test(i.id)));
  const planNoCsp = await planOf(fresh({ csp: false }));
  ok('PLAN: with CSP missing the plan explains it and says the launcher will NOT install it', planNoCsp.csp.status === 'missing' && /will not install it/.test(planNoCsp.csp.message));
  const planNoEp = await planOf(fresh(), { endpoints: epsNone });
  ok('PLAN: with no endpoint configured at all, the companion app is blocked and says exactly what to configure', /Configure the public endpoint/.test(item(planNoEp, 'companion:srp_board').blocked));
  const planNoTool = await planOf(fresh(), { tool: null });
  ok('PLAN: no archive tool is surfaced as a warning rather than a silent failure', planNoTool.archiveTool === 'none' && planNoTool.warnings.some((w) => /No archive tool/.test(w)));
  const bundleNoUrl = F.fixtureBundle(null); bundleNoUrl.sources.sources[1].officialDirectUrl = undefined;
  const planNoUrl = await buildInstallPlan({ acRoot: fxPlan.ac, bundle: bundleNoUrl, serverId: 't2', endpoints: epsFull, documentsAcDir: fxPlan.docs, resolver: async () => [PUB_IP] });
  ok('PLAN: a source with no verified direct URL is never auto-installed (manual steps instead)', item(planNoUrl, 'car:car_a').blocked && item(planNoUrl, 'car:car_a').manualSteps.length > 0 && planNoUrl.downloads.length === 0);
  const bundleEvil = F.fixtureBundle('https://evil.example/pack.7z');
  const planEvil = await buildInstallPlan({ acRoot: fxPlan.ac, bundle: bundleEvil, serverId: 't2', endpoints: epsFull, documentsAcDir: fxPlan.docs, resolver: async () => [PUB_IP] });
  ok('PLAN: a download URL outside the source owner\'s own site is refused even if the inventory says LIVE', !!item(planEvil, 'car:car_a').blocked && planEvil.downloads.length === 0);

  // ── 3. successful car install via the (local) official download ────────
  const fx1 = fresh();
  const before1 = F.treeSansWork(fx1.ac);
  const progress = [];
  const plan1 = await planOf(fx1);
  const res1 = await executeInstall(mk(fx1, { onProgress: (p) => progress.push(p.phase) }), plan1, ['car:car_a', 'car:car_b']);
  const r1 = await checkAcRequirements({ acRoot: fx1.ac, bundle, serverId: 't2', deep: true, documentsAcDir: fx1.docs });
  ok('INSTALL: the cars group succeeded and both cars now pass the real deep checker', res1.groups.find((g) => g.group === 'cars')?.ok === true && r1.sections.cars.find((c) => c.id === 'car:car_a').status === 'pass' && r1.sections.cars.find((c) => c.id === 'car:car_b').status === 'pass');
  ok('INSTALL: only the requested cars came out of the pack (the decoy car in the same archive was not extracted)', !fs.existsSync(path.join(fx1.ac, 'content', 'cars', 'car_z')));
  ok('INSTALL: the full car folder arrives, including its extra skins', fs.existsSync(path.join(fx1.ac, 'content', 'cars', 'car_a', 'skins', 'blue', 'blue.dds')));
  ok('INSTALL: progress went through download → verify → extract → install → verify → done', ['downloading', 'verifying-download', 'extracting', 'verifying-staged', 'installing', 'verifying', 'done'].every((p) => progress.includes(p)));
  ok('INSTALL: no staging folders and no empty backup folders are left behind after a clean install', noWork(fx1) && (!fs.existsSync(path.join(fx1.ac, 'content', '.mercy-backups')) || fs.readdirSync(path.join(fx1.ac, 'content', '.mercy-backups')).length === 0));
  ok('INSTALL: the verified archive stays cached in the download folder for repairs', fs.existsSync(path.join(fx1.base, 'dl', 'pack.7z')));
  ok('INSTALL: CSP files were not created or modified by an install that ran with CSP "missing" being impossible — dwrite.dll untouched', fs.readFileSync(path.join(fx1.ac, 'dwrite.dll'), 'utf8') === 'x');
  const reuse = await executeInstall(mk(fx1), await planOf(fx1, { report: undefined }), []);
  ok('INSTALL: approving nothing installs nothing', reuse.groups.length === 0 && F.treeSansWork(fx1.ac).includes('car_a'));

  // ── 4. unapproved items are never touched ────────────────────────────────
  const fx2 = fresh();
  await executeInstall(mk(fx2), await planOf(fx2), ['car:car_a']);
  ok('APPROVALS: approving only car_a installs only car_a (car_b, track and companion untouched)', fs.existsSync(path.join(fx2.ac, 'content', 'cars', 'car_a')) && !fs.existsSync(path.join(fx2.ac, 'content', 'cars', 'car_b')) && !fs.existsSync(path.join(fx2.ac, 'apps', 'lua', 'srp_board')));

  // ── 5. download integrity failure ─────────────────────────────────────────
  const fx3 = fresh(); const before3 = F.treeSansWork(fx3.ac);
  const bundleBadHash = JSON.parse(JSON.stringify(bundle)); bundleBadHash.sources.sources[1].localArchive.sha256 = 'f'.repeat(64);
  const res3 = await executeInstall(mk(fx3, { bundle: bundleBadHash }), await buildInstallPlan({ acRoot: fx3.ac, bundle: bundleBadHash, serverId: 't2', endpoints: epsFull, documentsAcDir: fx3.docs, allowLoopbackHttp: true, resolver: async () => [PUB_IP] }), ['car:car_a']);
  const g3 = res3.groups.find((g) => g.group === 'cars');
  ok('DOWNLOAD FAILURE: a file whose SHA-256 differs from the inventory is rejected with a clear message and NOT installed', g3.ok === false && /does not match the verified inventory/.test(g3.error));
  ok('DOWNLOAD FAILURE: the install folder is exactly as it was and the bad download was discarded', F.treeSansWork(fx3.ac) === before3 && !fs.existsSync(path.join(fx3.base, 'dl', 'pack.7z')) && !fs.existsSync(path.join(fx3.base, 'dl', 'pack.7z.part')));

  // ── 6. tampered content inside an otherwise fine archive ──────────────────
  const fx4 = fresh(); const before4 = F.treeSansWork(fx4.ac);
  const res4 = await executeInstall(mk(fx4), await planOf(fx4), ['car:car_a', 'car:car_b'], { carPackArchivePath: badArc });
  ok('TAMPERED CONTENT: physics data that differs from the server\'s copy is caught in staging, before anything is placed', res4.groups[0].ok === false && /different physics data/.test(res4.groups[0].error) && res4.groups[0].rolledBack === true);
  ok('TAMPERED CONTENT: nothing at all was installed (including the car that was fine)', F.treeSansWork(fx4.ac) === before4);

  // ── 7. repair keeps a backup (including the player's custom skin) ─────────
  const fx5 = fresh();
  F.writeCar(path.join(fx5.ac, 'content', 'cars'), 'car_a', { acd: 'WRONG-PHYSICS' });
  fs.mkdirSync(path.join(fx5.ac, 'content', 'cars', 'car_a', 'skins', 'mine')); fs.writeFileSync(path.join(fx5.ac, 'content', 'cars', 'car_a', 'skins', 'mine', 'my.dds'), 'my custom skin');
  const plan5 = await planOf(fx5);
  ok('REPAIR: a car whose physics differs is planned as a destructive repair that says the old folder is backed up first', item(plan5, 'car:car_a').action === 'repair' && item(plan5, 'car:car_a').destructive && /moved to a backup/.test(item(plan5, 'car:car_a').reason));
  const res5 = await executeInstall(mk(fx5), plan5, ['car:car_a']);
  const g5 = res5.groups.find((g) => g.group === 'cars');
  ok('REPAIR: the car now matches the server', g5.ok && fs.readFileSync(path.join(fx5.ac, 'content', 'cars', 'car_a', 'data.acd'), 'utf8') === 'physics-A');
  ok('REPAIR: the old folder — with the player\'s own custom skin — was kept in the backup, not deleted', g5.backupDir && fs.readFileSync(path.join(g5.backupDir, 'content', 'cars', 'car_a', 'skins', 'mine', 'my.dds'), 'utf8') === 'my custom skin' && fs.readFileSync(path.join(g5.backupDir, 'content', 'cars', 'car_a', 'data.acd'), 'utf8') === 'WRONG-PHYSICS');

  // ── 8. mid-install failure restores the previous state byte-for-byte ──────
  const fx6 = fresh();
  F.writeCar(path.join(fx6.ac, 'content', 'cars'), 'car_a', { acd: 'WRONG-PHYSICS' });
  fs.mkdirSync(path.join(fx6.ac, 'content', 'cars', 'car_a', 'skins', 'mine')); fs.writeFileSync(path.join(fx6.ac, 'content', 'cars', 'car_a', 'skins', 'mine', 'my.dds'), 'my custom skin');
  const before6 = F.treeSansWork(fx6.ac);
  const res6 = await executeInstall(mk(fx6, { hooks: { afterPlace: (i) => { if (i === 1) throw new Error('simulated disk failure after the second car'); } } }), await planOf(fx6), ['car:car_a', 'car:car_b']);
  const g6 = res6.groups.find((g) => g.group === 'cars');
  ok('ROLLBACK: a failure after some folders were already placed is reported and flagged rolled back', g6.ok === false && g6.rolledBack === true && /simulated disk failure/.test(g6.error));
  ok('ROLLBACK: the repaired car is restored to its original (wrong-physics + custom skin) state and the new car is gone — byte-for-byte identical to before', F.treeSansWork(fx6.ac) === before6);

  // ── 9. crash recovery from the on-disk journal ─────────────────────────────
  const fx7 = fresh();
  F.writeCar(path.join(fx7.ac, 'content', 'cars'), 'car_a', { acd: 'ORIGINAL' });
  const origTree = F.treeSansWork(fx7.ac);
  const T = '2026-01-01T00-00-00-000Z_cars'; const bdir = path.join(fx7.ac, 'content', '.mercy-backups', T);
  const target = path.join(fx7.ac, 'content', 'cars', 'car_a'); const backup = path.join(bdir, 'content', 'cars', 'car_a');
  fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.renameSync(target, backup); // "backup" op happened
  F.writeCar(path.join(fx7.ac, 'content', 'cars'), 'car_a', { acd: 'HALF-WRITTEN' });   // "place" op happened, then the machine lost power
  fs.writeFileSync(path.join(bdir, 'journal.json'), JSON.stringify({ txn: T, state: 'placing', startedAt: 'x', acRoot: fx7.ac, ops: [{ op: 'backup', from: target, to: backup }, { op: 'place', target }] }));
  const rec = recoverInterruptedInstalls(fx7.ac);
  ok('CRASH RECOVERY: an interrupted install found on disk is rolled back and reported', rec.recovered.length === 1 && rec.errors.length === 0);
  ok('CRASH RECOVERY: the original files are back exactly as they were', F.treeSansWork(fx7.ac) === origTree && !fs.existsSync(bdir));
  ok('CRASH RECOVERY: running it again does nothing (idempotent)', recoverInterruptedInstalls(fx7.ac).recovered.length === 0);

  // ── 10. skins are added without touching anything else ─────────────────────
  const fx8 = fresh();
  F.writeCar(path.join(fx8.ac, 'content', 'cars'), 'car_a', { skins: ['blue'] }); // 'red' (pinned by the server) is missing
  F.writeCar(path.join(fx8.ac, 'content', 'cars'), 'car_b');
  const before8 = F.treeSansWork(fx8.ac);
  const plan8 = await planOf(fx8);
  ok('SKIN: a missing pinned skin is a small, NON-destructive plan item', item(plan8, 'skin:car_a:red')?.kind === 'car-skin' && item(plan8, 'skin:car_a:red').destructive === false);
  const res8 = await executeInstall(mk(fx8), plan8, ['skin:car_a:red']);
  const after8 = F.treeSansWork(fx8.ac);
  const added = after8.split('\n').filter((l) => !before8.split('\n').includes(l)); const lost = before8.split('\n').filter((l) => !after8.split('\n').includes(l));
  ok('SKIN: exactly one new skin folder appeared and not a single existing file changed or disappeared', res8.groups[0].ok && lost.length === 0 && added.every((l) => /skins\/red/.test(l)) && added.length >= 2);

  // ── 11. track: only from an archive the player supplies, verified ──────────
  const fx9 = fresh();
  const plan9 = await planOf(fx9);
  const noFile = await executeInstall(mk(fx9), plan9, ['track']);
  ok('TRACK: approving the track without choosing an archive installs nothing and explains why', noFile.groups.length === 0 && noFile.skipped.some((s) => s.id === 'track' && /no live official direct download/.test(s.reason)));
  const before9 = F.treeSansWork(fx9.ac);
  const wrongVer = await executeInstall(mk(fx9), plan9, ['track'], { trackArchivePath: oldVerArc });
  ok('TRACK: an archive of a DIFFERENT SRP version is refused, naming it, and nothing changes', wrongVer.groups[0].ok === false && /different SRP version/.test(wrongVer.groups[0].error) && F.treeSansWork(fx9.ac) === before9);
  const tampered = await executeInstall(mk(fx9), plan9, ['track'], { trackArchivePath: tamperArc });
  ok('TRACK: the right file name with the wrong contents fails the version-marker hash and nothing changes', tampered.groups[0].ok === false && /hash mismatch/.test(tampered.groups[0].error) && F.treeSansWork(fx9.ac) === before9);
  const good = await executeInstall(mk(fx9), plan9, ['track'], { trackArchivePath: trackArc });
  const r9 = await checkAcRequirements({ acRoot: fx9.ac, bundle, serverId: 't2', deep: false, documentsAcDir: fx9.docs });
  ok('TRACK: the genuine archive (inside an unknown wrapper folder) is installed and passes the real checker', good.groups[0].ok === true && r9.sections.track.find((t) => t.id === 'track').status === 'pass' && r9.sections.track.find((t) => t.id === 'track-layout').status === 'pass');

  const fx10 = fresh();
  F.writeTrack(path.join(fx10.ac, 'content', 'tracks', 'test_track'), { markerName: '1.0.0 Stable.txt', marker: 'old build' });
  fs.writeFileSync(path.join(fx10.ac, 'content', 'tracks', 'test_track', 'my-notes.txt'), 'player file');
  const before10 = F.treeSansWork(fx10.ac);
  const plan10 = await planOf(fx10);
  ok('TRACK REPAIR: a different installed version is a destructive replace item', item(plan10, 'track').action === 'repair' && item(plan10, 'track').destructive);
  const fail10 = await executeInstall(mk(fx10, { hooks: { afterPlace: () => { throw new Error('simulated failure right after the track was swapped in'); } } }), plan10, ['track'], { trackArchivePath: trackArc });
  ok('TRACK REPAIR: a failure right after the swap restores the old track exactly (including the player\'s own file)', fail10.groups[0].rolledBack === true && F.treeSansWork(fx10.ac) === before10);
  const okTrack = await executeInstall(mk(fx10), plan10, ['track'], { trackArchivePath: trackArc });
  ok('TRACK REPAIR: on success the old version is kept in the backup folder', okTrack.groups[0].ok && fs.readFileSync(path.join(okTrack.groups[0].backupDir, 'content', 'tracks', 'test_track', 'my-notes.txt'), 'utf8') === 'player file');

  // ── 12. companion app ───────────────────────────────────────────────────────
  const fx11 = fresh({ hud: true });
  const resC = await executeInstall(mk(fx11, { endpoints: epsPublicOnly }), await planOf(fx11, { endpoints: epsPublicOnly }), ['companion:srp_board', 'conflict:srp_hud']);
  const stamped = parseBoardServers(fs.readFileSync(path.join(fx11.ac, 'apps', 'lua', 'srp_board', 'srp_board.lua'), 'latin1'));
  ok('COMPANION: installed from the embedded template, stamped with the public host name AND its resolved address', resC.groups.find((g) => g.group === 'companion').ok && stamped.includes(`${PUB}:9650`) && stamped.includes(`${PUB_IP}:9650`));
  ok('COMPANION (privacy): a public player\'s stamp does NOT contain the owner\'s LAN address', !stamped.some((s) => s.includes(LAN)));
  const rC = await checkAcRequirements({ acRoot: fx11.ac, bundle, serverId: 't2', deep: false, documentsAcDir: fx11.docs });
  ok('COMPANION: the real checker confirms the installed app is current and its files match the release', rC.sections.companion.find((c) => c.id === 'app:srp_board').status === 'pass' && rC.sections.companion.find((c) => c.id === 'app:srp_board:integrity').status === 'pass');
  ok('COMPANION: the old dev HUD was moved to the backup (not deleted) and no longer sits in apps\\lua', !fs.existsSync(path.join(fx11.ac, 'apps', 'lua', 'srp_hud')) && fs.readFileSync(path.join(resC.groups.find((g) => g.group === 'conflict').backupDir, 'apps', 'lua', 'srp_hud', 'srp_hud.lua'), 'utf8') === 'old hud');
  const planAgain = await planOf(fx11, { endpoints: epsPublicOnly });
  ok('COMPANION: once current, it is not offered again', !item(planAgain, 'companion:srp_board'));
  const planWithLan = await planOf(fx11, { endpoints: epsFull });
  ok('COMPANION: adding a LAN address on this PC (the owner\'s) makes the plan offer an update, because the stamp no longer covers it', item(planWithLan, 'companion:srp_board')?.action === 'update' && item(planWithLan, 'companion:srp_board').destructive);
  const resC2 = await executeInstall(mk(fx11, { endpoints: epsFull }), planWithLan, ['companion:srp_board']);
  const stamped2 = parseBoardServers(fs.readFileSync(path.join(fx11.ac, 'apps', 'lua', 'srp_board', 'srp_board.lua'), 'latin1'));
  ok('COMPANION: the updated stamp holds the public name, its resolved address and the local LAN entry; the previous app is in the backup', resC2.groups[0].ok && stamped2.length === 3 && stamped2.includes(`${LAN}:9650`) && fs.existsSync(path.join(resC2.groups[0].backupDir, 'apps', 'lua', 'srp_board', 'srp_board.lua')));
  const fx12 = fresh(); const before12 = F.treeSansWork(fx12.ac);
  const resC3 = await executeInstall(mk(fx12, { endpoints: epsFull, hooks: { afterPlace: () => { throw new Error('simulated failure'); } } }), await planOf(fx12), ['companion:srp_board']);
  ok('COMPANION: a failure after placement removes the new app again', resC3.groups[0].rolledBack === true && F.treeSansWork(fx12.ac) === before12);
  const fxNoCsp = fresh({ csp: false });
  const resC4 = await executeInstall(mk(fxNoCsp), await planOf(fxNoCsp), ['companion:srp_board']);
  ok('COMPANION: with CSP absent the install refuses and tells the player to install CSP themselves — and does not create dwrite.dll or the apps folder', resC4.groups[0].ok === false && /install CSP yourself/i.test(resC4.groups[0].error) && !fs.existsSync(path.join(fxNoCsp.ac, 'dwrite.dll')) && !fs.existsSync(path.join(fxNoCsp.ac, 'apps')));
  const fxNoEp = fresh();
  const resC5 = await executeInstall(mk(fxNoEp, { endpoints: epsNone }), await planOf(fxNoEp, { endpoints: epsNone }), ['companion:srp_board']);
  ok('COMPANION: with no endpoint configured, approving it installs nothing (it is blocked, not guessed)', resC5.groups.length === 0 && resC5.skipped.some((s) => s.id === 'companion:srp_board'));

  // ── 13. global safety rules ───────────────────────────────────────────────
  const fx13 = fresh(); const before13 = F.treeSansWork(fx13.ac);
  const resRun = await executeInstall(mk(fx13, { isGameRunning: async () => true }), await planOf(fx13), ['car:car_a']);
  ok('GAME RUNNING: nothing is installed while Assetto Corsa is running, with a clear message', resRun.success === false && resRun.groups[0].group === 'preflight' && /is running/.test(resRun.groups[0].error) && F.treeSansWork(fx13.ac) === before13);
  const ac = new AbortController(); ac.abort();
  const fx14 = fresh(); const before14 = F.treeSansWork(fx14.ac);
  const resCancel = await executeInstall(mk(fx14, { signal: ac.signal }), await planOf(fx14), ['car:car_a']);
  ok('CANCEL: cancelling leaves the install exactly as it was', resCancel.cancelled === true && F.treeSansWork(fx14.ac) === before14);
  const fxNotAc = F.mkTmp(); cleanup.push(fxNotAc);
  const resNotAc = await executeInstall({ ...mk({ ac: fxNotAc, base: fxNotAc, docs: fxNotAc }), acRoot: fxNotAc }, { items: [], downloads: [] }, []);
  ok('NOT AN AC FOLDER: a folder without content\\cars and content\\tracks is rejected up front', resNotAc.success === false && /does not look like an Assetto Corsa folder/.test(resNotAc.groups[0].error));
  ok('PRIVACY: the install log never contains the LAN address or the public host name', !logLines.some((l) => l.includes(LAN) || l.includes(PUB) || l.includes(PUB_IP)));
  const instSrc = fs.readFileSync(path.resolve(__dirname, '../../src/main/services/ac/installer.ts'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('STATIC: the installer source never references the CSP loader (dwrite) at all — it cannot install or alter CSP', !/dwrite/.test(instSrc));

  // ── 14. other archive tools / formats ────────────────────────────────────
  const bsd = findArchiveTool('bsdtar');
  if (bsd && packZip) {
    const fx15 = fresh();
    const res15 = await executeInstall(mk(fx15, { tool: bsd }), await planOf(fx15), ['car:car_a', 'car:car_b'], { carPackArchivePath: packZip });
    const r15 = await checkAcRequirements({ acRoot: fx15.ac, bundle, serverId: 't2', deep: true, documentsAcDir: fx15.docs });
    ok('FORMATS: a .zip pack installs through Windows\' built-in tar.exe with identical results', res15.groups[0].ok && r15.sections.cars.filter((c) => c.id !== 'car:base_car').every((c) => c.status === 'pass'));
    const fx16 = fresh();
    const res16 = await executeInstall(mk(fx16, { tool: bsd }), await planOf(fx16), ['car:car_a'], { carPackArchivePath: packArc });
    ok('FORMATS: the same .7z installs through tar.exe when 7-Zip is not used', res16.groups[0].ok && fs.existsSync(path.join(fx16.ac, 'content', 'cars', 'car_a', 'data.acd')));
  } else skip('tar.exe fallback tests');

  await host.close();
  for (const d of cleanup) F.rm(d);
  F.rm(arcDir);
  console.log(`\nAC INSTALLER TESTS: ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
