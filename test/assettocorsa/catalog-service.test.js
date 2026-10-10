// AcPlayerService with the signed catalog wired in: server list from the catalog, content status, readiness stepper,
// review vs automatic install, and that no private address ever reaches status, logs or diagnostics.
// Archives are served from a local HTTP server; the downloader's https.get is routed to it by a TEST-ONLY shim so a
// production catalog (which must use https and public host names) can be exercised end to end.
const crypto = require('crypto'), fs = require('fs'), http = require('http'), https = require('https'), path = require('path');
const F = require('./_acFixtures');
const { validCatalog } = require('./_catalogFixtures');
const { AcPlayerService } = F.dist('ac/playerService.js');
const { sha256Hex } = F.dist('ac/catalogSigning.js');
const { selectAutoInstall } = F.dist('ac/autoInstall.js');
const { getBundledSrpBundle } = F.dist('AcSrpBundle.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const KEYS = [{ keyId: 'k1', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }];
const sign = (b) => JSON.stringify({ alg: 'ed25519', keyId: 'k1', signedAt: '2030-01-01T00:00:00Z', catalogSha256: sha256Hex(b), signature: crypto.sign(null, b, privateKey).toString('base64') });

(async () => {
  if (!F.sevenAvailable()) { console.log('  - SKIPPED (no 7-Zip)'); console.log('\nAC CATALOG SERVICE TESTS: 0 passed, 0 failed, 1 skipped'); process.exit(0); }
  const cleanup = []; const tmp = (p) => { const d = F.mkTmp(p); cleanup.push(d); return d; };

  // archives
  const src = tmp('svc-src'), arc = tmp('svc-arc');
  for (const id of ['car_a', 'car_b']) F.writeCar(path.join(src, 'pack', 'content', 'cars'), id);
  F.w(path.join(src, 'trk', 'content', 'tracks', 'mt_one', 'models.kn5'), 'kn5');
  F.w(path.join(src, 'trk', 'content', 'tracks', 'mt_one', 'ui', 'ui_track.json'), '{"n":1}');
  const files = { pack: F.makeArchive(path.join(src, 'pack'), path.join(arc, 'pack.7z')), trk: F.makeArchive(path.join(src, 'trk'), path.join(arc, 'trk.7z')) };
  const meta = (n) => ({ bytes: fs.statSync(files[n]).size, sha256: F.sha(fs.readFileSync(files[n])) });

  // fixture file server (also serves the catalog)
  const state = { catalog: null, sig: null, etag: null };
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/cat/catalog.json') { res.writeHead(200, { ETag: state.etag, 'Content-Length': state.catalog.length }); return res.end(state.catalog); }
    if (req.url === '/cat/catalog.json.sig') { if (state.sig === null) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(state.sig); }
    const m = /^\/dl\/(pack|trk)\.7z$/.exec(req.url);
    if (m) { const buf = fs.readFileSync(files[m[1]]); res.writeHead(200, { 'Content-Length': buf.length }); return res.end(buf); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const origGet = https.get;
  https.get = (u, opts, cb) => { const url = new URL(u.toString()); const t = new URL(`http://127.0.0.1:${url.port}${url.pathname}${url.search}`); return http.get(t, opts, cb); };

  const clockRef = { t: Date.parse('2030-06-01T12:00:00Z') };
  const catalog = (rev, mutate, env = 'production') => validCatalog((c) => {
    c.catalog.revision = rev; c.catalog.environment = env; c.catalog.generatedAt = new Date(clockRef.t - 3600_000).toISOString();
    const arch = (id, fileName) => ({ id, name: id, fileName, format: '7z', ...meta(id), url: `https://dl.example.test:${port}/dl/${fileName}`, allowedHosts: ['dl.example.test'], provider: { name: 'Fixture', homepage: 'https://example.com' }, redistribution: 'owner-authorized' });
    c.archives = [arch('pack', 'pack.7z'), arch('trk', 'trk.7z')];
    c.content.cars = [
      { id: 'car_a', name: 'Car A', version: '2.0', origin: { kind: 'archive', archiveId: 'pack' }, identity: { dataAcdSha256: F.sha(Buffer.from(F.CAR.car_a.acd)), uiCarJsonSha256: null } },
      { id: 'car_b', name: 'Car B', version: '1.0', origin: { kind: 'archive', archiveId: 'pack' }, identity: { dataAcdSha256: F.sha(Buffer.from(F.CAR.car_b.acd)), uiCarJsonSha256: null } },
      { id: 'ks_base', name: 'Base Car', version: null, origin: { kind: 'base-game' }, identity: { dataAcdSha256: null, uiCarJsonSha256: null } },
    ];
    c.content.tracks = [{ id: 'mt_one', name: 'Track One', version: '1', origin: { kind: 'archive', archiveId: 'trk' }, verify: null, layouts: [{ config: '' }] }];
    c.servers[0].tracks = [{ trackId: 'mt_one', layouts: [''] }];
    c.servers[0].cars = [{ carId: 'car_a', role: 'player' }, { carId: 'car_b', role: 'player' }, { carId: 'ks_base', role: 'player' }];
    c.servers[0].companionApps = []; c.servers[0].connection = { public: { host: 'play.example.com', gamePort: 9600, httpPort: 8081 } };
    c.servers[0].requirements = { csp: { required: true, minimumVersion: '0.1.76' } };
    if (mutate) mutate(c);
  });
  const publish = (cat, o = {}) => { const b = Buffer.from(JSON.stringify(cat, null, 1) + '\n'); state.catalog = b; state.sig = o.sig === undefined ? sign(b) : o.sig; state.etag = `"${sha256Hex(b).slice(0, 12)}"`; };

  const mkSvc = (over = {}, fxOver = {}) => {
    const fx = F.emptyAcInstall(fxOver); cleanup.push(fx.base);
    const ud = tmp('svc-ud'); const sent = [];
    const svc = new AcPlayerService({
      userDataPath: ud, detectAcRoot: async () => fx.ac, documentsAcDir: () => fx.docs, broadcast: (ch, d) => sent.push({ ch, d }),
      isContentManagerAvailable: () => true, openExternal: async () => {}, allowLoopbackHttp: true, isGameRunning: async () => false,
      probe: async () => ({ online: false, reason: 'test', checkedAt: 'x' }), resolver: async () => [],
      catalogNow: () => new Date(clockRef.t), catalogSleep: async () => {}, catalogRandom: () => 0.5,
      catalogReleaseDefaults: {}, ...over,
    });
    return { svc, fx, ud, sent };
  };
  const configure = (svc, extra = {}) => svc.setCatalogSettings({ baseUrl: `http://127.0.0.1:${port}/cat/`, trustedKeys: KEYS, ...extra });
  const tick = (ms) => { clockRef.t += ms; };
  const waitFor = async (cond, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 25)); } return cond(); };
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  // ── without a catalog: the built-in list, unchanged ────────────────────────
  {
    const { svc } = mkSvc();
    ok('no catalog => built-in servers, flagged as such', svc.listServers().length === 2 && svc.catalogStatus().source === 'builtin' && svc.listServers().every((s) => s.fromCatalog === false));
    ok('built-in profile keeps the original wording', /Shutoko Revival Project/.test(svc.listServers()[0].purpose));
    const r = await svc.refreshCatalog('startup');
    ok('refreshing an unconfigured catalog is a harmless no-op', r.outcome === 'unconfigured');
  }

  // ── catalog drives the listing ─────────────────────────────────────────────
  publish(catalog(1));
  const A = mkSvc();
  {
    const r0 = configure(A.svc);
    ok('settings saved without errors', r0.errors.length === 0 && r0.settings.trustedKeys.length === 1);
    const r = await A.svc.refreshCatalog('manual');
    ok('catalog accepted and the server list comes from it', r.outcome === 'updated' && A.svc.listServers().length === 1 && A.svc.listServers()[0].id === 'srv-a' && A.svc.listServers()[0].fromCatalog === true);
    const p = A.svc.listServers()[0];
    ok('profile carries catalog details', p.name === 'Server A' && p.description === 'Test server' && p.serverState === 'active' && p.tracks[0].name === 'Track One' && /Track One/.test(p.purpose) && !/Shutoko/.test(p.purpose));
    ok('required content rows are generic (not SRP-specific)', p.requiredContent.some((c) => c.id === 'track' && /Track One 1/.test(c.name)) && !p.requiredContent.some((c) => /SRP/.test(c.name)));
    ok('catalog events were broadcast to the window', A.sent.some((s) => s.ch === 'assettocorsa:catalog:event' && s.d.type === 'changed') && A.sent.some((s) => s.ch === 'assettocorsa:catalog:event' && s.d.status.revision === 1));
    ok('endpoint resolves from the catalog (public only)', (() => { const e = A.svc.getLocalEndpoints('srv-a'); return e.lanHost === null; })());
  }

  // ── content status + readiness ─────────────────────────────────────────────
  {
    const cs = await A.svc.contentStatus('srv-a');
    const row = (id) => cs.rows.find((r) => r.id === id);
    ok('missing downloadable car is "missing" with an install action', row('car:car_a').state === 'missing' && row('car:car_a').action === 'install');
    ok('missing base-game car is a manual step', row('car:ks_base').state === 'manual' && /Steam/.test(row('car:ks_base').detail));
    ok('missing track is "missing"', row('track').state === 'missing');
    ok('CSP present => installed', row('csp-installed').state === 'installed');
    ok('counts add up', cs.counts.missing >= 3 && cs.counts.manual >= 1 && cs.requiredNotReady >= 4);
    let rd = await A.svc.readiness('srv-a');
    const step = (id) => rd.steps.find((s) => s.id === id);
    ok('readiness: catalog current', step('catalog').state === 'done' && rd.facts.catalogAvailable === true);
    ok('readiness: content not ready, blocked/todo', rd.facts.contentReady === false && ['todo', 'blocked'].includes(step('content').state));
    ok('readiness: base-game car missing blocks the install step', step('install').state === 'blocked' && /base-game/.test(step('install').detail));
    ok('readiness: game port is NOT claimed reachable', rd.facts.gamePort === 'untested' && /not been tested/.test(step('endpoint').detail));
    ok('readiness never claims a verified join', rd.facts.joinVerified === false && /NOT verified/.test(step('join').detail) && rd.readyToLaunch === false);
    ok('readiness: status page answer is reported separately', rd.facts.infoPage === 'no-answer');

    // satisfy everything by hand and re-check
    F.writeCar(path.join(A.fx.ac, 'content', 'cars'), 'car_a'); F.writeCar(path.join(A.fx.ac, 'content', 'cars'), 'car_b'); F.writeCar(path.join(A.fx.ac, 'content', 'cars'), 'ks_base', { ui: '{"name":"Base"}', acd: 'x', skins: [] });
    F.w(path.join(A.fx.ac, 'content', 'tracks', 'mt_one', 'models.kn5'), 'kn5');
    rd = await A.svc.readiness('srv-a');
    ok('readiness: ready to launch once content is in place (join still unverified)', rd.readyToLaunch === true && rd.facts.contentReady === true && rd.facts.joinVerified === false);
    ok('content status: everything installed', (await A.svc.contentStatus('srv-a')).requiredNotReady === 0);

    // outdated / incompatible
    F.writeCar(path.join(A.fx.ac, 'content', 'cars'), 'car_a', { ui: JSON.stringify({ name: 'Fixture Car A', version: '1.0' }) });
    F.writeCar(path.join(A.fx.ac, 'content', 'cars'), 'car_b', { acd: 'tampered physics' });
    const cs2 = await A.svc.contentStatus('srv-a');
    ok('older version => outdated', cs2.rows.find((r) => r.id === 'car:car_a').state === 'outdated');
    ok('different physics => incompatible', cs2.rows.find((r) => r.id === 'car:car_b').state === 'incompatible');
    F.writeCar(path.join(A.fx.ac, 'content', 'cars'), 'car_a'); F.writeCar(path.join(A.fx.ac, 'content', 'cars'), 'car_b');
  }

  // ── a new revision updates everything without deleting anything ────────────
  {
    tick(5 * 60_000);
    publish(catalog(2, (c) => { c.servers[0].cars = c.servers[0].cars.filter((x) => x.carId !== 'car_b'); }));
    const before = F.treeSansWork(path.join(A.fx.ac, 'content'));
    const r = await A.svc.refreshCatalog('manual');
    ok('removing a car from the catalog is detected', r.outcome === 'updated' && r.diff.summary.some((t) => /Car B no longer required/.test(t)));
    ok('...and the installed copy is left alone', F.treeSansWork(path.join(A.fx.ac, 'content')) === before);
    ok('...the UI list updates immediately', A.svc.listServers()[0].requiredContent.some((c) => c.id === 'cars:pack' && /^1 car from/.test(c.name)));
    tick(5 * 60_000); publish(catalog(3));
    await A.svc.refreshCatalog('manual');
  }

  // ── review mode never installs by itself ───────────────────────────────────
  {
    const B = mkSvc(); configure(B.svc); await B.svc.refreshCatalog('manual');
    const res = await B.svc.runAutoInstall('test');
    ok('review mode: nothing is installed automatically', res.ran.length === 0 && !fs.existsSync(path.join(B.fx.ac, 'content', 'cars', 'car_a')));
    const plan = await B.svc.plan('srv-a');
    ok('review mode: the plan is offered for approval', plan.items.some((i) => i.id === 'car:car_a') && plan.downloads.length === 2);
    const hitsBefore = hits.length;
    const r = await B.svc.install('srv-a', ['car:car_a', 'car:car_b', 'track']);
    ok('approved install works through the service', r.success === true && fs.existsSync(path.join(B.fx.ac, 'content', 'cars', 'car_a', 'data.acd')) && fs.existsSync(path.join(B.fx.ac, 'content', 'tracks', 'mt_one', 'models.kn5')) && hits.length > hitsBefore);
  }

  // ── automatic mode ─────────────────────────────────────────────────────────
  {
    const C = mkSvc(); configure(C.svc); await C.svc.refreshCatalog('manual');
    C.svc.setCatalogSettings({ installMode: 'auto' });
    let res = await C.svc.runAutoInstall('t');
    ok('auto mode alone does nothing for a server that is not marked "keep ready"', res.ran.length === 0 && !fs.existsSync(path.join(C.fx.ac, 'content', 'cars', 'car_a')));
    C.svc.setCatalogSettings({ autoServers: ['srv-a'] });
    await waitFor(() => fs.existsSync(path.join(C.fx.ac, 'content', 'tracks', 'mt_one', 'models.kn5')) && C.sent.some((x) => x.d && x.d.phase === 'done')); // the settings change triggers a background run
    ok('marking the server "keep ready" installs verified authorised content automatically', fs.existsSync(path.join(C.fx.ac, 'content', 'cars', 'car_a', 'data.acd')) && fs.existsSync(path.join(C.fx.ac, 'content', 'tracks', 'mt_one', 'models.kn5')));
    ok('auto-install broadcast progress to the UI', C.sent.some((s) => s.ch === 'assettocorsa:catalog:auto-install' && s.d.phase === 'started') && C.sent.some((s) => s.ch === 'assettocorsa:catalog:auto-install' && s.d.phase === 'done' && s.d.success === true));
    ok('base-game content is never touched by auto mode', !fs.existsSync(path.join(C.fx.ac, 'content', 'cars', 'ks_base')));
    ok('the auto install is in the install log', C.svc.readInstallLog(200).some((l) => /auto-install/.test(l)));
    res = await C.svc.runAutoInstall('t');
    ok('a second run has nothing left to do', res.ran.length === 0);

    // destructive changes need the extra opt-in; one revision is attempted once
    F.writeCar(path.join(C.fx.ac, 'content', 'cars'), 'car_a', { acd: 'player-modified' });
    C.svc.setCatalogSettings({ autoServers: ['srv-a'] }); // clears the attempt memory
    await settle();
    ok('replacing existing content is NOT automatic by default', fs.readFileSync(path.join(C.fx.ac, 'content', 'cars', 'car_a', 'data.acd'), 'utf8') === 'player-modified');
    C.svc.setCatalogSettings({ autoUpdateExisting: true });
    await waitFor(() => fs.readFileSync(path.join(C.fx.ac, 'content', 'cars', 'car_a', 'data.acd'), 'utf8') === F.CAR.car_a.acd);
    ok('with "also update existing" it is replaced, with a backup', fs.readFileSync(path.join(C.fx.ac, 'content', 'cars', 'car_a', 'data.acd'), 'utf8') === F.CAR.car_a.acd && fs.existsSync(path.join(C.fx.ac, 'content', '.mercy-backups')) && fs.readdirSync(path.join(C.fx.ac, 'content', '.mercy-backups')).length > 0);
  }

  // ── automatic mode is refused when the catalog is not trustworthy ──────────
  {
    // expired
    const D = mkSvc(); configure(D.svc, { installMode: 'auto', autoServers: ['srv-a'] });
    publish(catalog(10, (c) => { c.catalog.expiresAt = new Date(clockRef.t + 600_000).toISOString(); }));
    D.svc.setCatalogSettings({ autoServers: [] }); // keep the first sync from installing; we test the gate explicitly below
    await D.svc.refreshCatalog('manual');
    D.svc.setCatalogSettings({ autoServers: ['srv-a'], installMode: 'review' });
    D.svc.setCatalogSettings({ installMode: 'auto' });
    tick(2 * 3600_000);
    await settle();
    ok('expired catalog: no automatic install and manual install is paused', !fs.existsSync(path.join(D.fx.ac, 'content', 'cars', 'car_a')) && D.svc.catalogStatus().expired === true);
    let threw = null; try { await D.svc.install('srv-a', ['car:car_a']); } catch (e) { threw = e; }
    ok('expired catalog: install() refuses with the reason', !!threw && /expired/.test(threw.message));
    const jr = await D.svc.joinStatus('srv-a');
    ok('expired catalog: join is blocked with a refresh hint', jr.blockers.some((b) => /expired/.test(b)));
    tick(-2 * 3600_000);

    // development catalog never auto-installs
    publish(catalog(20, null, 'development'));
    const E = mkSvc(); configure(E.svc, { installMode: 'auto', autoServers: ['srv-a'], allowUnsignedDev: true });
    await E.svc.refreshCatalog('manual');
    await settle();
    ok('development catalog: automatic install is refused', E.svc.catalogStatus().environment === 'development' && E.svc.catalogStatus().autoInstallAllowed === false && !fs.existsSync(path.join(E.fx.ac, 'content', 'cars', 'car_a')));
    publish(catalog(30));
  }

  // ── pure auto-install policy ───────────────────────────────────────────────
  {
    const S = { installMode: 'auto', autoServers: ['s'], autoUpdateExisting: false, maxAutoDownloadBytes: 1000 };
    const ST = { autoInstallAllowed: true, expired: false, environment: 'production', signatureVerified: true };
    const dl = (id, bytes, over = {}) => ({ sourceId: id, name: id, url: 'https://x/y', bytes, sha256: 'a'.repeat(64), itemIds: [], allowedHosts: ['x'], ...over });
    const it = (id, sourceId, over = {}) => ({ id, kind: 'car', label: id, action: 'install', destructive: false, optional: false, reason: '', sourceId, ...over });
    const plan = (items, downloads) => ({ serverId: 's', acRoot: 'C:/x', items, downloads, archiveTool: '7z', csp: {}, summary: {}, warnings: [] });
    const sel = (p, o = {}) => selectAutoInstall({ plan: p, settings: { ...S, ...(o.settings ?? {}) }, status: { ...ST, ...(o.status ?? {}) }, serverId: 's', gameRunning: !!o.gameRunning });
    ok('policy: simple eligible item', sel(plan([it('car:a', 'p')], [dl('p', 500)])).itemIds.join() === 'car:a');
    ok('policy: review mode refuses', sel(plan([it('car:a', 'p')], [dl('p', 500)]), { settings: { installMode: 'review' } }).itemIds.length === 0);
    ok('policy: server not marked keep-ready refuses', sel(plan([it('car:a', 'p')], [dl('p', 500)]), { settings: { autoServers: [] } }).itemIds.length === 0);
    ok('policy: unverified signature refuses', sel(plan([it('car:a', 'p')], [dl('p', 500)]), { status: { autoInstallAllowed: false, signatureVerified: false } }).refused !== null);
    ok('policy: game running refuses', sel(plan([it('car:a', 'p')], [dl('p', 500)]), { gameRunning: true }).refused !== null);
    ok('policy: download over the limit is skipped with its items', sel(plan([it('car:a', 'p'), it('car:b', 'p')], [dl('p', 5000)])).itemIds.length === 0);
    ok('policy: total over the limit drops the later download', (() => { const r = sel(plan([it('car:a', 'p'), it('track', 'q', { kind: 'track' })], [dl('p', 700), dl('q', 700)])); return r.itemIds.join() === 'car:a'; })());
    ok('policy: destructive item needs the extra opt-in', sel(plan([it('car:a', 'p', { destructive: true, action: 'repair' })], [dl('p', 500)])).itemIds.length === 0 && sel(plan([it('car:a', 'p', { destructive: true, action: 'repair' })], [dl('p', 500)]), { settings: { autoUpdateExisting: true } }).itemIds.length === 1);
    ok('policy: blocked / manual / external / local-file items skipped', sel(plan([it('car:a', 'p', { blocked: 'no' }), it('car:b', 'p', { kind: 'external', action: 'manual' }), it('track', 'p', { kind: 'track', needsLocalFile: true })], [dl('p', 500)])).itemIds.length === 0);
    ok('policy: conflicts and the SRP Board are never automatic', sel(plan([it('conflict:srp_hud', undefined, { kind: 'conflict', destructive: true }), it('companion:srp_board', undefined, { kind: 'companion' })], [])).itemIds.length === 0);
    ok('policy: items without a verified authorised download are skipped', sel(plan([it('car:a', 'p')], [dl('p', 500, { sha256: null })])).itemIds.length === 0 && sel(plan([it('car:a', 'p')], [dl('p', 500, { allowedHosts: undefined })])).itemIds.length === 0);
    ok('policy: no archive tool refuses', sel({ ...plan([it('car:a', 'p')], [dl('p', 500)]), archiveTool: 'none' }).refused !== null);
  }

  // ── nothing private leaks ──────────────────────────────────────────────────
  {
    publish(catalog(40, (c) => { c.catalog.environment = 'development'; c.servers[0].connection.lan = { host: '192.168.99.7', gamePort: 9600, httpPort: 8081 }; }));
    const G = mkSvc(); configure(G.svc, { allowUnsignedDev: true });
    await G.svc.refreshCatalog('manual');
    const ep = await G.svc.testEndpoint('srv-a', 'lan');
    ok('dev catalog LAN default is used for LAN testing only', ep.configured === true);
    F.writeCar(path.join(G.fx.ac, 'content', 'cars'), 'ks_base', { ui: '{"name":"Base"}', acd: 'x', skins: [] });
    await G.svc.install('srv-a', ['car:car_a', 'car:car_b', 'track']);
    const diag = JSON.stringify(await G.svc.diagnostics());
    const log = G.svc.readInstallLog(500).join('\n');
    ok('the install log never contains the LAN address', !log.includes('192.168.99.7') && log.length > 0);
    ok('diagnostics never contain the LAN address', !diag.includes('192.168.99.7') && /"catalog"/.test(diag));
    ok('status never contains the LAN address', !JSON.stringify(G.svc.catalogStatus()).includes('192.168.99.7'));
    ok('broadcast events never contain the LAN address', !JSON.stringify(G.sent).includes('192.168.99.7'));
    ok('profile never exposes the LAN address', !JSON.stringify(G.svc.listServers()).includes('192.168.99.7'));
    G.svc.resetCatalog();
    ok('reset returns to the built-in list', G.svc.listServers().length === 2 && G.svc.catalogStatus().source === 'builtin');
    void getBundledSrpBundle;
  }

  https.get = origGet;
  await new Promise((r) => server.close(r));
  cleanup.forEach(F.rm);
  console.log(`\nAC CATALOG SERVICE TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
