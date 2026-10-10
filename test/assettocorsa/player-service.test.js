// AcPlayerService — server profiles, join gating, live status, install orchestration, diagnostics.
// All against fixtures and injected dependencies. "Joining" is tested only up to handing a link to an
// injected openExternal; a real connection to a real server is NOT something these tests can claim.
const fs = require('fs'), path = require('path');
const F = require('./_acFixtures');
const { AcPlayerService } = F.dist('ac/playerService.js');
const { getBundledSrpBundle } = F.dist('AcSrpBundle.js');

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗', name); } };
const LAN = '192.168.55.10', PUB = 'play.example.com';

(async () => {
  const cleanup = []; const tmp = (p) => { const d = F.mkTmp(p); cleanup.push(d); return d; };

  // ── profiles from the REAL verified package ───────────────────────────────
  const realSvc = new AcPlayerService({ userDataPath: tmp('ud-'), detectAcRoot: async () => null, documentsAcDir: () => tmp('docs-'), broadcast() {}, isContentManagerAvailable: () => true, openExternal: async () => {} });
  const profiles = realSvc.listServers();
  const [p1, p2] = profiles;
  ok('PROFILES: both verified SRP servers are listed with their real names', profiles.length === 2 && p1.id === 'main' && p1.name === 'SRP Daishi PA' && p2.id === 'server2' && p2.name === 'SRP Traffic');
  ok('PROFILES: the purpose line is built from the package data (layout, slots, AI), not invented', /Daishi PA/.test(p1.purpose) && /14 player slots/.test(p1.purpose) && /no AI traffic/.test(p1.purpose) && /32 player slots/.test(p2.purpose) && /138 AI traffic cars/.test(p2.purpose));
  ok('PROFILES: required content spells out CSP, the exact track version/layout and the car counts per source', p1.requiredContent.some((c) => /Custom Shaders Patch 0\.1\.76\+/.test(c.name)) && p1.requiredContent.some((c) => c.name === 'Shutoko Revival Project 0.9.3 — Daishi PA') && p2.requiredContent.some((c) => c.name === 'Shutoko Revival Project 0.9.3 — Main Layout') && p1.requiredContent.some((c) => /^14 cars from SRP Car Pack 3\.6/.test(c.name)) && p2.requiredContent.some((c) => /^44 cars from SRP Car Pack 3\.6/.test(c.name)) && p2.requiredContent.some((c) => /^2 cars from Assetto Corsa/.test(c.name)));
  ok('PROFILES: the stock server has no HUD/companion app; the AssettoServer one delivers HUD 4.0.2 and lists the optional SRP Board', p1.hud.delivered === false && p1.companionApp === false && p2.hud.delivered === true && p2.hud.version === '4.0.2' && p2.companionApp === true && p2.requiredContent.some((c) => c.id === 'app:srp_board' && c.required === false));
  ok('PROFILES (honesty): with the shipped data no public endpoint is configured, and the card data says so', profiles.every((p) => p.endpoint.publicConfigured === false && p.endpoint.problems.some((x) => /PUBLIC_HOST_TBD/.test(x))));
  ok('PROFILES: an unknown server id is an error, never a default', await (async () => { try { await realSvc.check('nope'); return false; } catch { return true; } })());

  // ── a "ready" fixture install ─────────────────────────────────────────────
  const bundle = F.fixtureBundle(null);
  const release = { servers: { t2: { host: PUB, tcpPort: null, httpPort: null } } };
  const noRelease = { servers: { t2: { host: null, tcpPort: null, httpPort: null } } };
  function ready() {
    const fx = F.emptyAcInstall(); cleanup.push(fx.base);
    F.writeCar(path.join(fx.ac, 'content', 'cars'), 'car_a'); F.writeCar(path.join(fx.ac, 'content', 'cars'), 'car_b');
    F.w(path.join(fx.ac, 'content', 'cars', 'base_car', 'ui', 'ui_car.json'), '{}');
    F.writeTrack(path.join(fx.ac, 'content', 'tracks', 'test_track'));
    return fx;
  }
  const calls = { probe: [], opened: [], broadcast: [] };
  const mkSvc = (fx, over = {}) => new AcPlayerService({
    userDataPath: tmp('ud-'), detectAcRoot: async () => fx.ac, documentsAcDir: () => fx.docs, bundle, release,
    broadcast: (c, d) => calls.broadcast.push([c, d]), isContentManagerAvailable: () => true, openExternal: async (u) => { calls.opened.push(u); },
    probe: async (h, p) => { calls.probe.push([h, p]); return { online: true, checkedAt: new Date().toISOString(), players: 5, maxPlayers: 32, name: 'Fixture Traffic' }; },
    tcpProbe: async () => ({ ok: true }),
    isGameRunning: async () => false, allowLoopbackHttp: true, resolver: async () => ['203.0.113.7'], ...over });

  // ── join gating ───────────────────────────────────────────────────────────
  const fxA = ready(); const svcA = mkSvc(fxA);
  const jsA = await svcA.joinStatus('t2');
  ok('JOIN: all requirements met + a public endpoint + Content Manager present → can join, and it is flagged unverified', jsA.canJoin === true && jsA.via === 'public' && jsA.port === 9650 && jsA.unverified === true);
  calls.opened.length = 0;
  const joinA = await svcA.join('t2');
  ok('JOIN: hands exactly one acmanager:// link (public host + the server\'s HTTP port) to Content Manager and does NOT claim the connection worked', joinA.success && calls.opened.length === 1 && calls.opened[0] === `acmanager://race/online/join?ip=${PUB}&httpPort=8090` && /cannot see whether the connection then succeeds/.test(joinA.note) && joinA.stage === 'handed-off');

  const fxB = ready(); fs.rmSync(path.join(fxB.ac, 'content', 'cars', 'car_b'), { recursive: true });
  calls.opened.length = 0; const svcB = mkSvc(fxB);
  const jsB = await svcB.joinStatus('t2'); const joinB = await svcB.join('t2');
  ok('JOIN: a missing required car blocks joining with the reason, and nothing is opened', jsB.canJoin === false && jsB.blockers.some((b) => /Fixture Car B/.test(b)) && joinB.success === false && calls.opened.length === 0);

  const svcC = mkSvc(ready(), { release: noRelease });
  const jsC = await svcC.joinStatus('t2');
  ok('JOIN: ready content but NO endpoint configured → blocked, saying the owner must assign the public host (not guessed)', jsC.canJoin === false && jsC.via === null && jsC.blockers.some((b) => /PUBLIC_HOST_TBD/.test(b)));

  const jsD = await mkSvc(ready(), { isContentManagerAvailable: () => false }).joinStatus('t2');
  ok('JOIN: without Content Manager\'s link handler it is blocked with a clear message', jsD.canJoin === false && jsD.blockers.some((b) => /Content Manager/.test(b)));

  const fxE = ready(); const svcE = mkSvc(fxE); svcE.setLocalEndpoints('t2', { lanHost: LAN });
  calls.probe.length = 0; calls.opened.length = 0;
  const jsE = await svcE.joinStatus('t2'); await svcE.join('t2');
  ok('JOIN (owner): with a reachable LAN address the LAN endpoint is preferred and the link points at it', jsE.via === 'lan' && calls.opened[0] === `acmanager://race/online/join?ip=${LAN}&httpPort=8090` && calls.probe.some(([h]) => h === LAN));
  const svcF = mkSvc(ready(), { probe: async (h) => ({ online: h !== LAN, checkedAt: 'x' }) }); svcF.setLocalEndpoints('t2', { lanHost: LAN });
  ok('JOIN (owner): if the LAN address does not answer it falls back to the public endpoint', (await svcF.joinStatus('t2')).via === 'public');
  ok('JOIN: the renderer-facing join status never contains an address', !JSON.stringify(jsE).includes(LAN) && !JSON.stringify(jsA).includes(PUB));

  // ── live status ───────────────────────────────────────────────────────────
  const svcS = mkSvc(ready());
  calls.probe.length = 0;
  const st1 = await svcS.status('t2'); const st2 = await svcS.status('t2');
  ok('STATUS: a verified answer shows online with real player numbers, and is cached for a short time rather than hammering the server', st1.state === 'online' && st1.players === 5 && st1.maxPlayers === 32 && calls.probe.length === 1 && st2.state === 'online');
  await svcS.status('t2', true);
  ok('STATUS: a forced refresh queries again', calls.probe.length === 2);
  svcS.setLocalEndpoints('t2', { lanHost: LAN }); await svcS.status('t2');
  ok('STATUS: changing the endpoints invalidates the cache', calls.probe.length === 3 && calls.probe[2][0] === LAN);
  const svcOff = mkSvc(ready(), { probe: async () => ({ online: false, reason: 'Connection refused (server not running, or the HTTP port is closed).', checkedAt: 'x' }) });
  const stOff = await svcOff.status('t2');
  ok('STATUS: an unreachable server is "offline" with the reason, not "unknown-but-assumed-up"', stOff.state === 'offline' && /refused/.test(stOff.reason));
  const stNone = await mkSvc(ready(), { release: noRelease }).status('t2');
  ok('STATUS: with no endpoint it says "unconfigured" and never probes anything', stNone.state === 'unconfigured' && /PUBLIC_HOST_TBD/.test(stNone.reason));

  // ── game folder selection ─────────────────────────────────────────────────
  const fxG = ready(); const svcG = mkSvc(fxG, { detectAcRoot: async () => null });
  ok('ROOT: when nothing is detected, no root — and a wrong folder is refused as a manual choice', (await svcG.resolveAcRoot()).source === 'none' && svcG.setAcRootOverride(tmp('nothing-')).success === false);
  ok('ROOT: a real AC folder chosen manually is accepted, remembered, and wins over auto-detection', svcG.setAcRootOverride(fxG.ac).success && (await svcG.resolveAcRoot()).source === 'manual' && (await svcG.resolveAcRoot()).root === fxG.ac);

  // ── install through the service (progress events + redacted log + single-run lock) ──
  const packSrc = tmp('pack-'); F.writeCar(path.join(packSrc, 'content', 'cars'), 'car_a'); F.writeCar(path.join(packSrc, 'content', 'cars'), 'car_b');
  if (!F.sevenAvailable()) { skipped++; console.log('  - SKIPPED service install tests (no 7-Zip to build archives)'); }
  else {
    const arc = F.makeArchive(packSrc, path.join(tmp('arc-'), 'pack.7z'), '7z'); const bytes = fs.readFileSync(arc);
    const host = await F.serve({ '/pack.7z': arc });
    const b2 = F.fixtureBundle(`${host.base}/pack.7z`); b2.sources.sources[1].localArchive = { bytes: bytes.length, sha256: F.sha(bytes) };
    const fx = F.emptyAcInstall(); cleanup.push(fx.base);
    const ev = []; const svc = mkSvc(fx, { bundle: b2, broadcast: (c, d) => ev.push([c, d]) }); svc.setLocalEndpoints('t2', { lanHost: LAN });
    const plan = await svc.plan('t2');
    ok('SERVICE: the plan reflects this machine\'s endpoints (LAN entry present for the owner)', plan.items.some((i) => i.id === 'companion:srp_board'));
    const first = svc.install('t2', ['car:car_a', 'car:car_b', 'companion:srp_board']);
    let secondErr = null; try { await svc.install('t2', ['car:car_a']); } catch (e) { secondErr = e.message; }
    const res = await first;
    ok('SERVICE: a second install while one is running is refused', /already running/.test(secondErr || ''));
    ok('SERVICE: installs run, progress is broadcast on the install channel with the server id, and the lock is released afterwards', res.groups.every((g) => g.ok) && ev.some(([c, d]) => c === 'assettocorsa:install:progress' && d.serverId === 't2' && d.phase === 'downloading') && svc.isInstalling() === false);
    const logText = svc.readInstallLog(500).join('\n');
    ok('SERVICE (privacy): the persisted install log exists, is useful, and contains neither the LAN address nor the public host', /install started/.test(logText) && /install finished: success/.test(logText) && !logText.includes(LAN) && !logText.includes(PUB) && !logText.includes('203.0.113.7'));
    ok('SERVICE: cancelling when nothing is running is a harmless no-op', svc.cancelInstall() === false);

    // ── diagnostics ─────────────────────────────────────────────────────────
    fs.writeFileSync(path.join(fx.docs, 'logs', 'custom_shaders_patch.log'), `CSP v0.2.11 b3465, enabled\nrandom line\n[SRP Board] v1.0.0 loaded; servers: ${LAN}:9650, ${PUB}:9650\nSRP server: strip was mode 3, hiding it\nRemote server script: http://${LAN}:8090/api/scripts/0\n`);
    fs.mkdirSync(path.join(fx.ac, 'content', '.mercy-backups', 'T1'), { recursive: true });
    fs.writeFileSync(path.join(fx.ac, 'content', '.mercy-backups', 'T1', 'journal.json'), JSON.stringify({ txn: 'T1', state: 'placing', ops: [], acRoot: fx.ac, startedAt: 'x' }));
    const snapBefore = F.tree(fx.ac) + F.tree(fx.docs);
    const dg = await svc.diagnostics();
    ok('DIAGNOSTICS: detected game path, how it was found, CSP version from the log, content counts, free space and archive tool', dg.acRoot === fx.ac && dg.acRootSource === 'detected' && dg.csp.installed === true && dg.csp.version === '0.2.11' && dg.csp.build === 3465 && dg.content.cars >= 2 && dg.freeGb > 0 && ['7z', 'bsdtar'].includes(dg.archiveTool));
    ok('DIAGNOSTICS: the SRP Board is reported with version and stamped entries as kind + port only', dg.srpBoard.installed && dg.srpBoard.version === '1.0.0' && dg.srpBoard.stamped.length === 3 && dg.srpBoard.stamped.every((s) => s.port === 9650 && !('host' in s)) && dg.srpBoard.stamped.some((s) => s.kind === 'private-lan'));
    ok('DIAGNOSTICS: CSP-log lines about the SRP apps are shown with every address redacted, but the useful words survive', dg.cspLogSrpLines.length === 3 && dg.cspLogSrpLines.some((l) => /loaded; servers/.test(l)) && dg.cspLogSrpLines.some((l) => /hiding it/.test(l)));
    ok('DIAGNOSTICS (privacy): nothing in the whole diagnostics object contains the LAN address, public host or resolved IP', !/192\.168\.55|play\.example|203\.0\.113/.test(JSON.stringify(dg)));
    ok('DIAGNOSTICS: an interrupted install is listed (and reported to the player)', dg.interruptedInstalls.includes('T1'));
    ok('DIAGNOSTICS: viewing diagnostics is strictly read-only — the interrupted install was NOT rolled back and no file changed', F.tree(fx.ac) + F.tree(fx.docs) === snapBefore && JSON.parse(fs.readFileSync(path.join(fx.ac, 'content', '.mercy-backups', 'T1', 'journal.json'), 'utf8')).state === 'placing');
    ok('DIAGNOSTICS: the endpoint section says what is configured without exposing it', dg.endpoints[0].publicConfigured === true && dg.endpoints[0].lanConfigured === true);
    ok('DIAGNOSTICS: reports whether the installed SRP Board stamp covers the endpoints saved on THIS computer (booleans only)', (() => { const c = dg.srpBoard.coverage.find((x) => x.serverId === 't2'); return c && c.public === true && c.lan === true && Object.keys(c).sort().join() === 'lan,public,serverId'; })());
    svc.setLocalEndpoints('t2', { lanHost: '192.168.9.9' });
    const dg2 = await svc.diagnostics();
    ok('DIAGNOSTICS: when the saved LAN address changes the coverage flags it as NOT in the stamp, and still shows no address', (() => { const c = dg2.srpBoard.coverage.find((x) => x.serverId === 't2'); return c.public === true && c.lan === false && !/192\.168\.9\.9/.test(JSON.stringify(dg2)); })());
    await host.close();
  }

  // ── storage: downloaded archives + backups are visible and deletable, and deletion can't escape ──
  {
    const fx = F.emptyAcInstall(); cleanup.push(fx.base);
    F.writeCar(path.join(fx.ac, 'content', 'cars'), 'car_a');
    const ud = tmp('ud-store-');
    const mkB = (id, state, files) => { const d = path.join(fx.ac, 'content', '.mercy-backups', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'journal.json'), JSON.stringify({ txn: id, state, startedAt: '2026-10-09T12:00:00.000Z', ops: [], acRoot: fx.ac })); for (const f of files) F.w(path.join(d, f), 'x'.repeat(1000)); };
    mkB('2026-10-09T12-00-00-000Z_cars', 'committed', ['content/cars/old_car/data.acd', 'content/cars/old_car/ui/ui_car.json']);
    mkB('2026-10-09T13-00-00-000Z_conflict', 'committed', ['apps/lua/srp_hud/srp_hud.lua']);
    mkB('2026-10-09T14-00-00-000Z_cars', 'placing', ['content/cars/half/data.acd']);
    const dlDir = path.join(ud, 'ac-downloads'); fs.mkdirSync(dlDir, { recursive: true }); fs.writeFileSync(path.join(dlDir, 'SRP_Car_Pack_3.6.7z'), Buffer.alloc(5000)); fs.writeFileSync(path.join(dlDir, 'x.7z.part'), Buffer.alloc(100));
    const sv = new AcPlayerService({ userDataPath: ud, detectAcRoot: async () => fx.ac, documentsAcDir: () => fx.docs, bundle, release, broadcast() {}, isContentManagerAvailable: () => true, openExternal: async () => {} });
    const info = await sv.storageInfo();
    ok('STORAGE: lists the downloaded archives with their real sizes (including a partial download)', info.downloads.files.length === 2 && info.downloads.totalBytes === 5100);
    ok('STORAGE: lists each backup newest-first with what it contains (cars, apps) and its size', info.backups.length === 3 && info.backups[0].id.startsWith('2026-10-09T14') && info.backups.find((b) => b.id.includes('_conflict')).items.includes('apps/lua/srp_hud') && info.backups.find((b) => b.id.startsWith('2026-10-09T12')).items.includes('content/cars/old_car') && info.backups.find((b) => b.id.startsWith('2026-10-09T12')).bytes >= 2000);
    ok('STORAGE: an install that never finished is marked in-progress', info.backups.find((b) => b.id.startsWith('2026-10-09T14')).inProgress === true && info.backups.filter((b) => b.inProgress).length === 1);
    const bad = await Promise.all(['../x', '..\\x', 'a/b', '', 'x y'].map((i) => sv.deleteBackup(i)));
    ok('STORAGE: a backup name that could point outside the backups folder is refused', bad.every((r) => r.success === false) && fs.existsSync(path.join(fx.ac, 'content', 'cars', 'car_a')));
    ok('STORAGE: an unfinished install\'s backup cannot be deleted (it is needed for the rollback)', (await sv.deleteBackup('2026-10-09T14-00-00-000Z_cars')).success === false && fs.existsSync(path.join(fx.ac, 'content', '.mercy-backups', '2026-10-09T14-00-00-000Z_cars')));
    const d1 = await sv.deleteBackup('2026-10-09T12-00-00-000Z_cars');
    ok('STORAGE: deleting a finished backup frees exactly its files and touches nothing else (installed cars are untouched)', d1.success && d1.freedBytes >= 2000 && !fs.existsSync(path.join(fx.ac, 'content', '.mercy-backups', '2026-10-09T12-00-00-000Z_cars')) && fs.existsSync(path.join(fx.ac, 'content', '.mercy-backups', '2026-10-09T13-00-00-000Z_conflict')) && fs.existsSync(path.join(fx.ac, 'content', 'cars', 'car_a', 'data.acd')));
    ok('STORAGE: deleting a backup that is already gone says so', (await sv.deleteBackup('2026-10-09T12-00-00-000Z_cars')).success === false);
    fs.mkdirSync(path.join(ud, 'precious'), { recursive: true }); fs.writeFileSync(path.join(ud, 'precious', 'keep.txt'), 'keep');
    const dd = sv.deleteDownloads();
    ok('STORAGE: "delete downloads" removes only the cached archives and reports the space freed', dd.success && dd.freedBytes === 5100 && fs.readdirSync(dlDir).length === 0 && fs.existsSync(path.join(ud, 'precious', 'keep.txt')) && fs.existsSync(path.join(fx.ac, 'content', 'cars', 'car_a')));
    ok('STORAGE: deleting when there is nothing to delete is a harmless success', sv.deleteDownloads().success === true);
  }

  const dgNone = await realSvc.diagnostics();
  ok('DIAGNOSTICS: with no game found it reports that plainly instead of throwing', dgNone.acRoot === null && dgNone.acRootSource === 'none' && dgNone.endpoints.length === 2);

  for (const d of cleanup) F.rm(d);
  console.log(`\nAC PLAYER SERVICE TESTS: ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
