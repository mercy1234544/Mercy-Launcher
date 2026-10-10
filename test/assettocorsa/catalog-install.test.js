// Catalog-driven installs, end to end, against disposable fixtures: a local HTTP server stands in for the owner's
// download host, archives are built with 7-Zip on the fly, and the "game" is a temp folder.
// Covers: multi-archive / multi-track installs, marker-less tracks, the default layout, unauthorised and off-list
// sources, redirects to other hosts, wrong hash / size / over-limit downloads, resuming a partial download,
// backups when something is replaced, and that nothing outside the approved items is ever touched or deleted.
const fs = require('fs'), path = require('path'), http = require('http');
const F = require('./_acFixtures');
const { validCatalog } = require('./_catalogFixtures');
const { validateCatalog } = F.dist('ac/catalogSchema.js');
const { catalogToBundle } = F.dist('ac/catalogAdapter.js');
const { buildInstallPlan, executeInstall } = F.dist('ac/installer.js');
const { resolveEndpoints, EMPTY_LOCAL } = F.dist('ac/endpoints.js');
const { getBundledSrpBundle } = F.dist('AcSrpBundle.js');

let pass = 0, fail = 0, skipped = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };

(async () => {
  if (!F.sevenAvailable()) { console.log('  - SKIPPED (no 7-Zip to build fixture archives)'); console.log(`\nAC CATALOG INSTALL TESTS: 0 passed, 0 failed, 1 skipped`); process.exit(0); }
  const cleanup = []; const tmp = (p) => { const d = F.mkTmp(p); cleanup.push(d); return d; };
  const base = getBundledSrpBundle();

  // fixture archives: a car pack, a marker-less default-layout track, and a second track with a named layout
  const src = tmp('cat-src'); const arc = tmp('cat-arc');
  for (const id of ['car_a', 'car_b']) F.writeCar(path.join(src, 'pack', 'content', 'cars'), id);
  F.w(path.join(src, 'trk1', 'content', 'tracks', 'mt_one', 'ui', 'ui_track.json'), '{"name":"One"}');
  F.w(path.join(src, 'trk1', 'content', 'tracks', 'mt_one', 'models.kn5'), 'kn5-one');
  F.w(path.join(src, 'trk2', 'content', 'tracks', 'mt_two', 'alt', 'models.kn5'), 'kn5-two');
  F.w(path.join(src, 'trk2', 'content', 'tracks', 'mt_two', 'ui', 'alt', 'ui_track.json'), '{"name":"Two alt"}');
  const files = {};
  for (const n of ['pack', 'trk1', 'trk2']) files[n] = F.makeArchive(path.join(src, n), path.join(arc, `${n}.7z`), '7z');
  const meta = (n) => ({ bytes: fs.statSync(files[n]).size, sha256: F.sha(fs.readFileSync(files[n])) });

  const mkCatalog = (baseUrl, mutate) => validCatalog((c) => {
    c.catalog.environment = 'development';
    const host = '127.0.0.1';
    const arch = (id, fileName) => ({ id, name: id, fileName, format: '7z', ...meta(id), url: `${baseUrl}/${fileName}`, allowedHosts: [host], provider: { name: 'Fixture', homepage: 'https://example.com' }, redistribution: 'owner-authorized' });
    c.archives = [arch('pack', 'pack.7z'), arch('trk1', 'trk1.7z'), arch('trk2', 'trk2.7z')];
    c.content.cars = [
      { id: 'car_a', name: 'Car A', version: '2.0', origin: { kind: 'archive', archiveId: 'pack' }, identity: { dataAcdSha256: F.sha(Buffer.from(F.CAR.car_a.acd)), uiCarJsonSha256: null } },
      { id: 'car_b', name: 'Car B', version: '1.0', origin: { kind: 'archive', archiveId: 'pack' }, identity: { dataAcdSha256: F.sha(Buffer.from(F.CAR.car_b.acd)), uiCarJsonSha256: null } },
    ];
    c.content.tracks = [
      { id: 'mt_one', name: 'Track One', version: '1', origin: { kind: 'archive', archiveId: 'trk1' }, verify: null, layouts: [{ config: '' }] },
      { id: 'mt_two', name: 'Track Two', version: '1', origin: { kind: 'archive', archiveId: 'trk2' }, verify: null, layouts: [{ config: 'alt', uiTrackJsonSha256: F.sha(Buffer.from('{"name":"Two alt"}')) }] },
    ];
    c.servers[0].tracks = [{ trackId: 'mt_one', layouts: [''] }, { trackId: 'mt_two', layouts: ['alt'] }];
    c.servers[0].cars = [{ carId: 'car_a', role: 'player' }, { carId: 'car_b', role: 'player' }];
    c.servers[0].companionApps = []; c.servers[0].connection = { public: null, ports: { gamePort: 9600, httpPort: 8081 } };
    c.servers[0].requirements = { csp: { required: true, minimumVersion: '0.1.76' } };
    if (mutate) mutate(c);
  });

  const setup = async (catalog, over = {}) => {
    const v = validateCatalog(catalog); if (!v.ok) throw new Error('fixture catalog invalid: ' + v.errors.join('; '));
    const ad = catalogToBundle(catalog, base);
    const fx = F.emptyAcInstall(); cleanup.push(fx.base);
    const dl = tmp('cat-dl');
    const ep = resolveEndpoints(ad.bundle.servers[0], ad.release, EMPTY_LOCAL);
    const common = { acRoot: fx.ac, bundle: ad.bundle, serverId: 'srv-a', endpoints: ep, documentsAcDir: fx.docs, allowLoopbackHttp: true, ...over.plan };
    const plan = await buildInstallPlan(common);
    const ctx = { ...common, downloadDir: dl, isGameRunning: async () => false, freeBytes: () => 1e13, ...over.exec };
    return { fx, ad, dl, plan, ctx, run: (ids, inputs) => executeInstall(ctx, plan, ids ?? plan.items.filter((i) => !i.blocked).map((i) => i.id), inputs) };
  };

  // ── 1. full install from an authorised host ───────────────────────────────
  {
    const hosts = await F.serve({ '/pack.7z': files.pack, '/trk1.7z': files.trk1, '/trk2.7z': files.trk2 });
    const s = await setup(mkCatalog(hosts.base));
    const ids = s.plan.items.map((i) => i.id).sort().join();
    ok('plan lists both cars and both tracks, none blocked', ids === 'car:car_a,car:car_b,track,track:mt_two' && s.plan.items.every((i) => !i.blocked));
    ok('plan downloads three authorised archives (hash + size known)', s.plan.downloads.length === 3 && s.plan.downloads.every((d) => d.sha256 && d.bytes && d.allowedHosts[0] === '127.0.0.1'));
    const unrelated = path.join(s.fx.ac, 'content', 'cars', 'user_own_car'); F.w(path.join(unrelated, 'ui', 'ui_car.json'), '{"name":"mine"}');
    const before = F.treeSansWork(unrelated);
    const res = await s.run();
    ok('catalog install succeeds', res.success === true && res.groups.every((g) => g.ok));
    ok('cars installed with verified physics', fs.existsSync(path.join(s.fx.ac, 'content', 'cars', 'car_a', 'data.acd')) && fs.existsSync(path.join(s.fx.ac, 'content', 'cars', 'car_b', 'data.acd')));
    ok('default-layout marker-less track installed', fs.existsSync(path.join(s.fx.ac, 'content', 'tracks', 'mt_one', 'models.kn5')));
    ok('second track with a named layout installed (hash-verified layout)', fs.existsSync(path.join(s.fx.ac, 'content', 'tracks', 'mt_two', 'alt', 'models.kn5')));
    ok('server reports ready to join afterwards', res.report.summary.readyToJoin === true);
    ok('each archive downloaded exactly once', ['/pack.7z', '/trk1.7z', '/trk2.7z'].every((u) => hosts.hits.filter((h) => h.url === u).length === 1));
    ok('catalog downloads are saved under a hash-prefixed name', fs.readdirSync(s.dl).every((f) => /^[0-9a-f]{12}-/.test(f)));
    ok('unrelated user content untouched', F.treeSansWork(unrelated) === before);
    const again = await buildInstallPlan({ ...s.ctx });
    ok('a second plan has nothing left to do', again.items.length === 0);
    // content that LEAVES the catalog is never deleted
    const cat2 = mkCatalog(hosts.base, (c) => { c.servers[0].cars = [c.servers[0].cars[0]]; c.content.cars = [c.content.cars[0]]; c.servers[0].tracks = [c.servers[0].tracks[0]]; c.content.tracks = [c.content.tracks[0]]; c.archives = c.archives.slice(0, 2); });
    ok('slimmer catalog still valid', validateCatalog(cat2).ok);
    const ad2 = catalogToBundle(cat2, base);
    const plan2 = await buildInstallPlan({ ...s.ctx, bundle: ad2.bundle, endpoints: resolveEndpoints(ad2.bundle.servers[0], ad2.release, EMPTY_LOCAL) });
    ok('no-longer-required content produces no plan items and nothing is removed', plan2.items.length === 0 && fs.existsSync(path.join(s.fx.ac, 'content', 'cars', 'car_b')) && fs.existsSync(path.join(s.fx.ac, 'content', 'tracks', 'mt_two')));
    await hosts.close();
  }

  // ── 2. replacing an existing car keeps a backup ───────────────────────────
  {
    const hosts = await F.serve({ '/pack.7z': files.pack, '/trk1.7z': files.trk1, '/trk2.7z': files.trk2 });
    const s = await setup(mkCatalog(hosts.base));
    F.writeCar(path.join(s.fx.ac, 'content', 'cars'), 'car_a', { acd: 'user-modified-physics', skins: ['my_custom_skin'] });
    const plan = await buildInstallPlan(s.ctx);
    const item = plan.items.find((i) => i.id === 'car:car_a');
    ok('mismatched physics is a destructive repair', !!item && item.action === 'repair' && item.destructive === true);
    const res = await executeInstall(s.ctx, plan, plan.items.map((i) => i.id));
    const bk = res.groups.find((g) => g.group === 'cars')?.backupDir;
    ok('old folder was moved to a backup, not deleted', !!bk && fs.existsSync(path.join(bk, 'content', 'cars', 'car_a', 'skins', 'my_custom_skin')));
    ok('repaired car now matches the catalog', fs.readFileSync(path.join(s.fx.ac, 'content', 'cars', 'car_a', 'data.acd'), 'utf8') === F.CAR.car_a.acd);
    await hosts.close();
  }

  // ── 3. unauthorised / off-list / unreachable sources ──────────────────────
  {
    const hosts = await F.serve({ '/pack.7z': files.pack, '/trk1.7z': files.trk1, '/trk2.7z': files.trk2 });
    const s = await setup(mkCatalog(hosts.base, (c) => { c.archives.find((a) => a.id === 'pack').redistribution = 'none'; }));
    const car = s.plan.items.find((i) => i.id === 'car:car_a');
    ok('redistribution "none" => car blocked, owner must supply it', !!car && !!car.blocked && !s.plan.downloads.some((d) => d.sourceId === 'pack'));
    const res = await s.run(s.plan.items.map((i) => i.id));
    ok('blocked items are skipped, never downloaded', res.skipped.some((x) => x.id === 'car:car_a') && !hosts.hits.some((h) => h.url === '/pack.7z'));
    ok('nothing from the blocked archive was installed', !fs.existsSync(path.join(s.fx.ac, 'content', 'cars', 'car_a')));
    await hosts.close();

    // a source whose host is not on its own allow-list (bypassing schema validation) is refused by the installer
    const hosts2 = await F.serve({ '/pack.7z': files.pack });
    const cat = mkCatalog(hosts2.base);
    const ad = catalogToBundle(cat, base); ad.bundle.sources.sources.find((x) => x.sourceId === 'pack').allowedHosts = ['example.com'];
    const fx = F.emptyAcInstall(); cleanup.push(fx.base);
    const ep = resolveEndpoints(ad.bundle.servers[0], ad.release, EMPTY_LOCAL);
    const plan = await buildInstallPlan({ acRoot: fx.ac, bundle: ad.bundle, serverId: 'srv-a', endpoints: ep, documentsAcDir: fx.docs, allowLoopbackHttp: true });
    ok('host not on the allow-list => blocked in the plan', plan.items.find((i) => i.id === 'car:car_a').blocked && plan.downloads.length === 2);
    const forced = { ...plan, downloads: [...plan.downloads, { sourceId: 'pack', name: 'pack', url: `${hosts2.base}/pack.7z`, bytes: meta('pack').bytes, sha256: meta('pack').sha256, itemIds: ['car:car_a'], allowedHosts: ['example.com'] }], items: plan.items.map((i) => (i.id === 'car:car_a' ? { ...i, blocked: undefined } : i)) };
    const dl2 = tmp('cat-dl');
    const r2 = await executeInstall({ acRoot: fx.ac, bundle: ad.bundle, serverId: 'srv-a', endpoints: ep, documentsAcDir: fx.docs, downloadDir: dl2, isGameRunning: async () => false, allowLoopbackHttp: true, freeBytes: () => 1e13 }, forced, ['car:car_a']);
    ok('even a tampered plan cannot make the installer fetch from an unlisted host', r2.success === false && hosts2.hits.length === 0 && !fs.existsSync(path.join(fx.ac, 'content', 'cars', 'car_a')));
    await hosts2.close();
  }

  // ── 4. redirects must stay on an authorised host ──────────────────────────
  {
    const target = await F.serve({ '/pack.7z': files.pack });
    const portOf = (b) => b.split(':').pop();
    const redir = http.createServer((req, res) => { res.writeHead(302, { Location: `http://localhost:${portOf(target.base)}/pack.7z` }); res.end(); });
    await new Promise((r) => redir.listen(0, '127.0.0.1', r));
    const base1 = `http://127.0.0.1:${redir.address().port}`;
    const files2 = await F.serve({ '/trk1.7z': files.trk1, '/trk2.7z': files.trk2 });
    const s = await setup(mkCatalog(base1, (c) => { for (const a of c.archives) if (a.id !== 'pack') a.url = `${files2.base}/${a.fileName}`; }));
    const res = await s.run(['car:car_a', 'car:car_b']);
    ok('redirect to a different host is refused and nothing is installed', res.success === false && !fs.existsSync(path.join(s.fx.ac, 'content', 'cars', 'car_a')) && target.hits.length === 0);
    ok('the failed install is reported as rolled back', res.groups.some((g) => g.group === 'cars' && g.ok === false && /not one of the hosts/.test(g.error ?? '')));
    await new Promise((r) => redir.close(r)); await target.close(); await files2.close();
  }

  // ── 5. integrity: wrong hash, wrong size, over the limit ──────────────────
  {
    const tampered = Buffer.from(fs.readFileSync(files.pack)); tampered[tampered.length - 5] ^= 0xff;
    const hosts = await F.serve({ '/pack.7z': () => tampered, '/trk1.7z': files.trk1, '/trk2.7z': files.trk2 });
    const s = await setup(mkCatalog(hosts.base));
    const res = await s.run(['car:car_a', 'car:car_b']);
    ok('tampered archive (right size, wrong SHA-256) is rejected', res.success === false && /SHA-256 does not match/.test(res.groups.find((g) => g.group === 'cars')?.error ?? ''));
    ok('nothing was installed and the bad download was discarded', !fs.existsSync(path.join(s.fx.ac, 'content', 'cars', 'car_a')) && fs.readdirSync(s.dl).length === 0);
    await hosts.close();

    const shorter = fs.readFileSync(files.pack).subarray(0, meta('pack').bytes - 10);
    const hosts2 = await F.serve({ '/pack.7z': () => shorter });
    const s2 = await setup(mkCatalog(hosts2.base));
    const r2 = await s2.run(['car:car_a', 'car:car_b']);
    ok('size that differs from the catalog is rejected before installing', r2.success === false && /expects/.test(r2.groups.find((g) => g.group === 'cars')?.error ?? '') && !fs.existsSync(path.join(s2.fx.ac, 'content', 'cars', 'car_a')));
    await hosts2.close();

    const hosts3 = await F.serve({ '/pack.7z': files.pack });
    const s3 = await setup(mkCatalog(hosts3.base), { exec: { maxDownloadBytes: 100 } });
    const r3 = await s3.run(['car:car_a', 'car:car_b']);
    ok('a download over the configured size limit is refused', r3.success === false && /limit/.test(r3.groups.find((g) => g.group === 'cars')?.error ?? '') && hosts3.hits.length === 0);
    await hosts3.close();

    // a server that streams MORE than it promised is cut off
    const big = http.createServer((req, res) => { res.writeHead(200, { 'Content-Length': meta('pack').bytes }); res.write(Buffer.alloc(meta('pack').bytes + 5000, 1)); res.end(); });
    await new Promise((r) => big.listen(0, '127.0.0.1', r));
    const s4 = await setup(mkCatalog(`http://127.0.0.1:${big.address().port}`));
    const r4 = await s4.run(['car:car_a', 'car:car_b']);
    ok('over-long body is rejected and installs nothing', r4.success === false && !fs.existsSync(path.join(s4.fx.ac, 'content', 'cars', 'car_a')));
    await new Promise((r) => big.close(r));
  }

  // ── 6. interrupted download resumes with a Range request ──────────────────
  {
    const hosts = await F.serve({ '/pack.7z': files.pack });
    const s = await setup(mkCatalog(hosts.base));
    const dl = s.plan.downloads.find((d) => d.sourceId === 'pack');
    const name = `${dl.sha256.slice(0, 12)}-pack.7z`;
    const half = fs.readFileSync(files.pack).subarray(0, Math.floor(meta('pack').bytes / 2));
    fs.writeFileSync(path.join(s.dl, name + '.part'), half);
    const res = await s.run(['car:car_a', 'car:car_b']);
    ok('resumed download completes and installs', res.success === true && fs.existsSync(path.join(s.fx.ac, 'content', 'cars', 'car_a', 'data.acd')));
    ok('the server saw a Range request for the missing part only', hosts.hits.length === 1 && hosts.hits[0].range === `bytes=${half.length}-`);
    await hosts.close();
  }

  // ── 7. player-supplied archive for a source the owner did not authorise ───
  {
    const hosts = await F.serve({});
    const s = await setup(mkCatalog(hosts.base, (c) => { c.archives.find((a) => a.id === 'trk2').redistribution = 'none'; }));
    const t2 = s.plan.items.find((i) => i.id === 'track:mt_two');
    ok('unauthorised track needs the player to choose a file', !!t2 && t2.needsLocalFile === true && !!t2.blocked && (t2.manualSteps ?? []).length > 0);
    const res = await s.run(['track:mt_two'], { trackArchivePaths: { mt_two: files.trk2 } });
    ok('installs from the player-chosen archive and verifies the layout hash', res.success === true && fs.existsSync(path.join(s.fx.ac, 'content', 'tracks', 'mt_two', 'alt', 'models.kn5')));
    const bad = await setup(mkCatalog(hosts.base, (c) => { c.archives.find((a) => a.id === 'trk2').redistribution = 'none'; c.content.tracks[1].layouts = [{ config: 'alt', uiTrackJsonSha256: F.sha(Buffer.from('something else')) }]; }));
    const r2 = await bad.run(['track:mt_two'], { trackArchivePaths: { mt_two: files.trk2 } });
    ok('a layout whose metadata differs from the catalog is rejected', r2.success === false && /differs from the servers/.test(r2.groups.find((g) => g.group === 'track')?.error ?? '') && !fs.existsSync(path.join(bad.fx.ac, 'content', 'tracks', 'mt_two')));
    const wrong = await bad.run(['track:mt_two'], { trackArchivePaths: { mt_two: files.trk1 } });
    ok('an archive that does not contain the track is rejected', wrong.success === false && !fs.existsSync(path.join(bad.fx.ac, 'content', 'tracks', 'mt_two')));
    await hosts.close();
  }

  // ── 8. the game running blocks everything ─────────────────────────────────
  {
    const hosts = await F.serve({ '/pack.7z': files.pack });
    const s = await setup(mkCatalog(hosts.base), { exec: { isGameRunning: async () => true } });
    const res = await s.run(['car:car_a']);
    ok('nothing installs while Assetto Corsa is running', res.success === false && hosts.hits.length === 0);
    await hosts.close();
  }

  // ── 9. a hostile archive: valid hash (the catalog vouches for it) but path-traversal entries ───────────────
  {
    const crc = (b) => require('zlib').crc32(b) >>> 0;
    const zip = (entries) => {
      const locals = [], centrals = []; let off = 0;
      for (const [name, data] of entries) {
        const n = Buffer.from(name), d = Buffer.from(data), c = crc(d);
        const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26);
        const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
        locals.push(lh, n, d); centrals.push(ch, n); off += 30 + n.length + d.length;
      }
      const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
      return Buffer.concat([...locals, cd, end]);
    };
    const carEntries = (id) => [[`content/cars/${id}/ui/ui_car.json`, F.CAR[id].ui], [`content/cars/${id}/data.acd`, F.CAR[id].acd]];
    const clean = zip([...carEntries('car_a'), ...carEntries('car_b')]);
    const evil = zip([...carEntries('car_a'), ...carEntries('car_b'), ['content/cars/car_a/../../../../escaped.txt', 'pwned']]);
    const run = async (buf) => {
      const f = path.join(arc, `h-${F.sha(buf).slice(0, 8)}.zip`); fs.writeFileSync(f, buf);
      const hosts = await F.serve({ '/pack.7z': f, '/trk1.7z': files.trk1, '/trk2.7z': files.trk2 });
      const s = await setup(mkCatalog(hosts.base, (c) => { const a = c.archives.find((x) => x.id === 'pack'); a.bytes = buf.length; a.sha256 = F.sha(buf); a.format = 'zip'; a.fileName = 'pack.7z'; }));
      const res = await s.run(['car:car_a', 'car:car_b']);
      await hosts.close();
      return { s, res };
    };
    // control: the SAME archive without the hostile entry installs, so any refusal below is caused by that entry alone
    const ctl = await run(clean);
    ok('control: the identical archive without the traversal entry installs fine', ctl.res.success === true && fs.existsSync(path.join(ctl.s.fx.ac, 'content', 'cars', 'car_b', 'data.acd')));
    const { s, res } = await run(evil);
    const err = res.groups.find((g) => g.group === 'cars')?.error ?? '';
    const escaped = [path.join(s.fx.ac, 'escaped.txt'), path.join(path.dirname(s.fx.ac), 'escaped.txt'), path.join(s.fx.ac, 'content', 'escaped.txt'), path.join(s.fx.ac, 'content', 'cars', 'escaped.txt'), path.join(path.dirname(path.dirname(s.fx.ac)), 'escaped.txt')];
    ok('an archive with a path-traversal entry is refused even though its hash matches the catalog', res.success === false && res.groups.some((g) => g.group === 'cars' && g.ok === false));
    ok('it is refused FOR the unsafe path (not for some other reason)', /unsafe|outside|escape|\.\./i.test(err) && !/not inside this archive/.test(err));
    ok('nothing was written outside the game folder, and no car was installed', escaped.every((p) => !fs.existsSync(p)) && !fs.existsSync(path.join(s.fx.ac, 'content', 'cars', 'car_a')) && !fs.existsSync(path.join(s.fx.ac, 'content', 'cars', 'car_b')));
    ok('the failed step reports a clean rollback', res.groups.some((g) => g.group === 'cars' && g.rolledBack === true));
  }

  cleanup.forEach(F.rm);
  console.log(`\nAC CATALOG INSTALL TESTS: ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
