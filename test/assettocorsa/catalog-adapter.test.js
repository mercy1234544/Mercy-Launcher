// Catalog → requirements-bundle adapter, the generalised checker (multi-track, optional, marker-less, default layout,
// base-game / DLC / manual content) and the download-authorisation rule. Pure fixtures; no network, no real game.
const fs = require('fs'), path = require('path');
const F = require('./_acFixtures');
const { validCatalog, H } = require('./_catalogFixtures');
const { validateCatalog } = F.dist('ac/catalogSchema.js');
const { catalogToBundle, bundleToCatalog } = F.dist('ac/catalogAdapter.js');
const { checkAcRequirements } = F.dist('AcRequirementsChecker.js');
const { isAuthorizedDownload, buildInstallPlan } = F.dist('ac/installer.js');
const { resolveEndpoints, EMPTY_LOCAL } = F.dist('ac/endpoints.js');
const { getBundledSrpBundle } = F.dist('AcSrpBundle.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };
const base = getBundledSrpBundle();
const adapt = (m) => catalogToBundle(validCatalog(m), base);

(async () => {
  // ── adapter ────────────────────────────────────────────────────────────────
  const a = adapt();
  const sv = a.bundle.servers[0];
  ok('one server adapted', a.bundle.servers.length === 1 && sv.server.id === 'srv-a' && sv.server.displayName === 'Server A');
  ok('primary track + layouts', sv.track.id === 'trk_one' && sv.track.layout === '' && sv.track.extraLayouts.join() === 'alt' && sv.track.name === 'Track One');
  ok('car mapping keeps hashes + roles', sv.cars.find((c) => c.id === 'car_a').identity.dataAcdSha256 === H('a') && sv.cars.find((c) => c.id === 'car_opt').role === 'traffic');
  ok('required:false becomes optional', sv.cars.find((c) => c.id === 'car_opt').requirement === 'optional' && sv.cars.find((c) => c.id === 'car_a').requirement === 'required-to-join');
  ok('base-game car maps to ac_base_game', sv.cars.find((c) => c.id === 'ks_base').source === 'ac_base_game' && a.bundle.sources.sources.some((s) => s.sourceId === 'ac_base_game' && s.kind === 'base-game'));
  const src = a.bundle.sources.sources.find((s) => s.sourceId === 'pack');
  ok('archive source carries allowedHosts + hash + authorisation', src.allowedHosts[0] === 'dl.example.com' && src.authorizedDownload === true && src.localArchive.sha256 === H('pack') && src.localArchive.bytes === 1234);
  ok('public endpoint reaches the release file', a.release.servers['srv-a'].host === 'play.example.com' && a.release.servers['srv-a'].tcpPort === 9600);
  ok('ports follow the public endpoint', sv.server.game.tcpPort === 9600 && sv.server.game.httpPort === 8081);
  ok('companion app only for srp_board', sv.companionApps.length === 1 && sv.companionApps[0].id === 'srp_board');
  ok('csp mapped', sv.csp.required === true && sv.csp.minimumVersion === '0.1.76' && !sv.csp.none);
  ok('csp null => none', adapt((c) => { c.servers[0].requirements.csp = null; }).bundle.servers[0].csp.none === true);
  ok('no LAN default in production', Object.keys(a.lanDefaults).length === 0);
  const dev = catalogToBundle(validCatalog((c) => { c.catalog.environment = 'development'; c.servers[0].connection.lan = { host: '192.168.1.9', gamePort: 9600, httpPort: 8081 }; }), base);
  ok('LAN default only in development', dev.lanDefaults['srv-a'].host === '192.168.1.9');
  ok('LAN never leaks into the release endpoints', JSON.stringify(dev.release).indexOf('192.168') < 0 && JSON.stringify(dev.bundle).indexOf('192.168') < 0);
  ok('retired server dropped, status kept', (() => { const r = adapt((c) => { c.servers[0].status = 'retired'; }); return r.bundle.servers.length === 0 && r.serverStatus['srv-a'] === 'retired'; })());
  ok('maintenance produces a notice', adapt((c) => { c.servers[0].status = 'maintenance'; }).notices.some((n) => /maintenance/.test(n)));
  ok('dlc + manual origins become non-downloadable sources', (() => {
    const r = adapt((c) => {
      c.content.cars.push({ id: 'dlc_car', name: 'DLC Car', version: null, origin: { kind: 'dlc', name: 'Dream Pack 1' }, identity: { dataAcdSha256: null, uiCarJsonSha256: null } });
      c.content.cars.push({ id: 'man_car', name: 'Manual Car', version: null, origin: { kind: 'manual', homepage: 'https://example.com/car', instructions: 'Buy it' }, identity: { dataAcdSha256: null, uiCarJsonSha256: null } });
      c.servers[0].cars.push({ carId: 'dlc_car', role: 'player' }, { carId: 'man_car', role: 'player' });
    });
    const d = r.bundle.sources.sources.find((s) => s.kind === 'dlc'), m = r.bundle.sources.sources.find((s) => s.kind === 'manual');
    return !!d && !!m && !d.officialDirectUrl && !m.officialDirectUrl && m.instructions === 'Buy it';
  })());
  ok('redistribution none => not authorised', adapt((c) => { c.archives[0].redistribution = 'none'; }).bundle.sources.sources.find((s) => s.sourceId === 'pack').authorizedDownload === false);
  ok('optional track flag carried', adapt((c) => { c.servers[0].tracks[0].required = false; }).bundle.servers[0].track.optional === true);

  // built-in package → catalog document round trip
  const asCat = bundleToCatalog(base, { generatedAt: '2030-01-01T00:00:00Z', example: true });
  ok('example catalog is refused as live data', !validateCatalog(asCat).ok && asCat.example === true);
  const real = bundleToCatalog(base, { generatedAt: '2030-01-01T00:00:00Z' });
  const v = validateCatalog(real);
  ok('built-in package converts to a VALID catalog document', v.ok);
  if (!v.ok) console.log('   ', v.errors.slice(0, 5));
  ok('converted catalog has both servers and no download URLs', real.servers.length === 2 && real.archives.every((x) => x.url === null && x.redistribution === 'none'));
  if (v.ok) {
    const back = catalogToBundle(real, base);
    ok('round trip keeps server ids, car counts and track', back.bundle.servers.map((s) => s.server.id).join() === 'main,server2' && back.bundle.servers[0].cars.length === base.servers[0].cars.length && back.bundle.servers[1].track.layout === 'main_layout');
    ok('round trip keeps car physics hashes', back.bundle.servers[0].cars[0].identity.dataAcdSha256 === base.servers[0].cars[0].identity.dataAcdSha256);
  }

  // ── generalised checker against a disposable game folder ───────────────────
  const fx = F.emptyAcInstall();
  const cat = validCatalog((c) => {
    // a marker-less track installed in the DEFAULT layout, plus a second track with a hashed layout
    c.content.tracks[0].verify = null; c.content.tracks[0].layouts = [{ config: '' }];
    c.servers[0].tracks = [{ trackId: 'trk_one', layouts: [''] }];
    c.content.cars[0].identity.dataAcdSha256 = F.sha(Buffer.from('physics-A'));
    c.content.cars[0].version = '2.0'; c.content.cars[0].identity.uiCarJsonSha256 = null;
    c.content.cars[2].origin = { kind: 'base-game' };
  });
  const ad = catalogToBundle(cat, base);
  const run = () => checkAcRequirements({ acRoot: fx.ac, bundle: ad.bundle, serverId: 'srv-a', deep: true, documentsAcDir: fx.docs });
  let r = await run();
  const byId = (rep, sec, id) => rep.sections[sec].find((i) => i.id === id);
  ok('missing required car fails', byId(r, 'cars', 'car:car_a').status === 'fail');
  ok('missing OPTIONAL car only warns', byId(r, 'cars', 'car:car_opt').status === 'warn');
  ok('missing base-game car fails with a Steam hint', byId(r, 'cars', 'car:ks_base').status === 'fail' && /Steam/.test(byId(r, 'cars', 'car:ks_base').detail));
  ok('missing track fails', byId(r, 'track', 'track').status === 'fail');
  ok('not ready while required content is missing', r.summary.readyToJoin === false);
  F.writeCar(path.join(fx.ac, 'content', 'cars'), 'car_a');
  F.writeCar(path.join(fx.ac, 'content', 'cars'), 'ks_base', { ui: '{"name":"Base"}', acd: 'x', skins: [] });
  fs.mkdirSync(path.join(fx.ac, 'content', 'tracks', 'trk_one', 'ui'), { recursive: true });
  r = await run();
  ok('marker-less default-layout track present => info (version unconfirmed), not fail', byId(r, 'track', 'track').status === 'info' && /cannot be confirmed/.test(byId(r, 'track', 'track').detail));
  ok('default layout needs no sub folder', byId(r, 'track', 'track-layout').status === 'pass');
  ok('ready to join once required content exists', r.summary.readyToJoin === true);
  ok('optional traffic car still only a warning', byId(r, 'cars', 'car:car_opt').status === 'warn');

  // layout hash drift on a default layout is reported
  fs.writeFileSync(path.join(fx.ac, 'content', 'tracks', 'trk_one', 'ui', 'ui_track.json'), '{"v":1}');
  const cat2 = JSON.parse(JSON.stringify(cat)); cat2.content.tracks[0].layouts = [{ config: '', uiTrackJsonSha256: H('different') }];
  const r2 = await checkAcRequirements({ acRoot: fx.ac, bundle: catalogToBundle(cat2, base).bundle, serverId: 'srv-a', deep: true, documentsAcDir: fx.docs });
  ok('default layout hash mismatch warns', byId(r2, 'track', 'track-layout').status === 'warn');

  // multiple tracks: each is checked and gets its own ids
  const cat3 = JSON.parse(JSON.stringify(cat));
  cat3.content.tracks.push({ id: 'trk_two', name: 'Track Two', version: '2', origin: { kind: 'base-game' }, verify: null, layouts: [{ config: 'a' }, { config: 'b' }] });
  cat3.servers[0].tracks.push({ trackId: 'trk_two', layouts: ['a', 'b'] });
  const r3 = await checkAcRequirements({ acRoot: fx.ac, bundle: catalogToBundle(cat3, base).bundle, serverId: 'srv-a', deep: true, documentsAcDir: fx.docs });
  ok('second track is checked with its own ids', byId(r3, 'track', 'track:trk_two').status === 'fail' && r3.summary.readyToJoin === false);
  cat3.servers[0].tracks[1].required = false;
  const r4 = await checkAcRequirements({ acRoot: fx.ac, bundle: catalogToBundle(cat3, base).bundle, serverId: 'srv-a', deep: true, documentsAcDir: fx.docs });
  ok('optional track missing => warn and still ready', byId(r4, 'track', 'track:trk_two').status === 'warn' && r4.summary.readyToJoin === true);

  // csp:null => nothing to install or update
  const cat5 = JSON.parse(JSON.stringify(cat)); cat5.servers[0].requirements.csp = null;
  const fx2 = F.emptyAcInstall({ csp: false });
  const r5 = await checkAcRequirements({ acRoot: fx2.ac, bundle: catalogToBundle(cat5, base).bundle, serverId: 'srv-a', deep: true, documentsAcDir: fx2.docs });
  ok('no-CSP server does not fail on a missing CSP', r5.sections.csp.every((i) => i.status === 'info'));

  // ── plan: base-game / DLC / manual are never installable ───────────────────
  const cat6 = JSON.parse(JSON.stringify(cat));
  cat6.content.cars.push({ id: 'dlc_car', name: 'DLC Car', version: null, origin: { kind: 'dlc', name: 'Dream Pack 1' }, identity: { dataAcdSha256: null, uiCarJsonSha256: null } });
  cat6.servers[0].cars.push({ carId: 'dlc_car', role: 'player' });
  const b6 = catalogToBundle(cat6, base);
  const plan = await buildInstallPlan({ acRoot: fx.ac, bundle: b6.bundle, serverId: 'srv-a', endpoints: resolveEndpoints(b6.bundle.servers[0], b6.release, EMPTY_LOCAL), documentsAcDir: fx.docs, tool: null });
  const dlc = plan.items.find((i) => i.id === 'car:dlc_car');
  ok('DLC car is a manual, blocked item that names the DLC', !!dlc && dlc.kind === 'external' && dlc.action === 'manual' && /Dream Pack 1/.test(dlc.blocked));
  ok('DLC item is never in the download list', !plan.downloads.some((d) => d.itemIds.includes('car:dlc_car')));
  const optItem = plan.items.find((i) => i.id === 'car:car_opt');
  ok('optional car is offered but flagged optional', !!optItem && optItem.optional === true);

  // ── download authorisation rule ────────────────────────────────────────────
  const S = (o) => ({ sourceId: 's', name: 'S', officialDirectUrl: 'https://dl.example.com/a.7z', allowedHosts: ['dl.example.com'], authorizedDownload: true, localArchive: { bytes: 5, sha256: H('x') }, ...o });
  ok('authorised https host accepted', isAuthorizedDownload(S({})));
  ok('not authorised => refused', !isAuthorizedDownload(S({ authorizedDownload: false })));
  ok('host off the allow-list refused', !isAuthorizedDownload(S({ officialDirectUrl: 'https://evil.example.net/a.7z' })));
  ok('look-alike sub-domain refused', !isAuthorizedDownload(S({ officialDirectUrl: 'https://dl.example.com.evil.net/a.7z' })));
  ok('missing sha refused', !isAuthorizedDownload(S({ localArchive: { bytes: 5, sha256: '' } })));
  ok('missing size refused', !isAuthorizedDownload(S({ localArchive: undefined })));
  ok('no url refused', !isAuthorizedDownload(S({ officialDirectUrl: undefined })));
  ok('ftp refused', !isAuthorizedDownload(S({ officialDirectUrl: 'ftp://dl.example.com/a.7z' })));
  ok('plain http refused by default', !isAuthorizedDownload(S({ officialDirectUrl: 'http://dl.example.com/a.7z' })));
  ok('plain http to a public host refused even with flags', !isAuthorizedDownload(S({ officialDirectUrl: 'http://dl.example.com/a.7z' }), { allowPrivateHttp: true, allowLoopbackHttp: true }));
  ok('private http accepted only in dev mode', !isAuthorizedDownload(S({ officialDirectUrl: 'http://192.168.1.5/a.7z', allowedHosts: ['192.168.1.5'] })) && isAuthorizedDownload(S({ officialDirectUrl: 'http://192.168.1.5/a.7z', allowedHosts: ['192.168.1.5'] }), { allowPrivateHttp: true }));
  ok('loopback http only with the test flag', !isAuthorizedDownload(S({ officialDirectUrl: 'http://127.0.0.1:9/a.7z', allowedHosts: ['127.0.0.1'] })) && isAuthorizedDownload(S({ officialDirectUrl: 'http://127.0.0.1:9/a.7z', allowedHosts: ['127.0.0.1'] }), { allowLoopbackHttp: true }));
  ok('built-in source rule unchanged (DEAD link refused)', !isAuthorizedDownload({ sourceId: 'x', name: 'x', homepage: 'https://example.com', officialDirectUrl: 'https://files.example.com/a.7z', directUrlStatus: 'DEAD on test day' }));
  ok('built-in source rule unchanged (LIVE on project domain accepted)', isAuthorizedDownload({ sourceId: 'x', name: 'x', homepage: 'https://example.com', officialDirectUrl: 'https://files.example.com/a.7z', directUrlStatus: 'LIVE on test day' }));

  [fx, fx2].forEach((f) => F.rm(f.base));
  console.log(`\nAC CATALOG ADAPTER TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
