// What the launcher must REFUSE, end to end through AcPlayerService with an injected transport (no network, no disk
// outside temp): unsigned / wrongly signed / tampered production catalogs, unsafe or unauthorised download sources,
// private addresses in production, replay of older catalogs — and that after any refusal the player is never shown the
// built-in package or an old catalog as if it were current.
const crypto = require('crypto'), fs = require('fs');
const F = require('./_acFixtures');
const { validCatalog } = require('./_catalogFixtures');
const { AcPlayerService } = F.dist('ac/playerService.js');
const { sha256Hex } = F.dist('ac/catalogSigning.js');
const { buildInstallPlan } = F.dist('ac/installer.js');
const { resolveEndpoints, EMPTY_LOCAL } = F.dist('ac/endpoints.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };

const kp = () => crypto.generateKeyPairSync('ed25519');
const good = kp(), other = kp();
const KEYS = [{ keyId: 'k1', publicKey: good.publicKey.export({ type: 'spki', format: 'pem' }) }];
const sigDoc = (b, key = good.privateKey, keyId = 'k1') => JSON.stringify({ alg: 'ed25519', keyId, signedAt: '2030-01-01T00:00:00Z', catalogSha256: sha256Hex(b), signature: crypto.sign(null, b, key).toString('base64') });
const BASE = 'https://catalog.example.com/ac/';

(async () => {
  const cleanup = []; const tmp = () => { const d = F.mkTmp('pol-'); cleanup.push(d); return d; };
  const clock = { t: Date.parse('2030-06-01T12:00:00Z') };
  const pub = { body: null, sig: null, etag: 'e0', status: 200 };
  const transport = async (url) => {
    if (pub.status !== 200) return { status: pub.status, headers: {}, body: Buffer.alloc(0) };
    if (url.endsWith('catalog.json')) return { status: 200, headers: { etag: pub.etag }, body: pub.body };
    if (url.endsWith('catalog.json.sig')) return pub.sig === null ? { status: 404, headers: {}, body: Buffer.alloc(0) } : { status: 200, headers: {}, body: Buffer.from(pub.sig) };
    return { status: 404, headers: {}, body: Buffer.alloc(0) };
  };
  const publish = (cat, o = {}) => { const b = Buffer.isBuffer(cat) ? cat : Buffer.from(JSON.stringify(cat) + '\n'); pub.body = b; pub.etag = 'e-' + sha256Hex(b).slice(0, 8); pub.sig = o.sig === undefined ? sigDoc(b) : o.sig; };
  const rev = (n, mut) => validCatalog((c) => { c.catalog.revision = n; c.catalog.generatedAt = new Date(clock.t - 3600_000).toISOString(); if (mut) mut(c); });
  const mk = (over = {}) => {
    const fx = F.emptyAcInstall(); cleanup.push(fx.base);
    const svc = new AcPlayerService({ userDataPath: tmp(), detectAcRoot: async () => fx.ac, documentsAcDir: () => fx.docs, broadcast: () => {}, isContentManagerAvailable: () => true, openExternal: async () => {},
      probe: async () => ({ online: false, reason: 'x', checkedAt: 'x' }), resolver: async () => [], isGameRunning: async () => false,
      catalogTransport: transport, catalogNow: () => new Date(clock.t), catalogSleep: async () => {}, catalogRandom: () => 0.5, catalogReleaseDefaults: {}, ...over });
    svc.setCatalogSettings({ baseUrl: BASE, trustedKeys: KEYS });
    return { svc, fx };
  };
  const refuses = async (name, cat, o, code) => {
    const { svc } = mk(); publish(cat, o);
    const r = await svc.refreshCatalog('manual'); const st = svc.catalogStatus();
    ok(`REFUSED: ${name}`, r.outcome === 'rejected' && (!code || r.error.code === code));
    ok(`  ...and nothing from it is used (${name})`, st.source === 'builtin' && svc.listServers().every((s) => s.fromCatalog === false) && st.revision === null);
    return svc;
  };

  // ── 7a. signatures ──────────────────────────────────────────────────────────
  await refuses('unsigned production catalog', rev(1), { sig: null }, 'unsigned');
  { const b = Buffer.from(JSON.stringify(rev(1)) + '\n'); await refuses('production catalog signed by a different key', b, { sig: sigDoc(b, other.privateKey) }, 'signature'); }
  { const b = Buffer.from(JSON.stringify(rev(1)) + '\n'); await refuses('signature naming an unpinned key id', b, { sig: sigDoc(b, good.privateKey, 'rogue') }, 'signature'); }
  { const b = Buffer.from(JSON.stringify(rev(1)) + '\n'); await refuses('catalog bytes altered after signing', Buffer.from(b.toString().replace('Server A', 'Server X')), { sig: sigDoc(b) }, 'signature'); }
  { const b = Buffer.from(JSON.stringify(rev(1)) + '\n'); const ok2 = mk(); publish(b, { sig: sigDoc(b).replace(/"alg":"ed25519"/, '"alg":"none"') }); const r = await ok2.svc.refreshCatalog('manual'); ok('REFUSED: signature with alg "none"', r.outcome === 'rejected' && ok2.svc.catalogStatus().source === 'builtin'); }
  { const m = mk({}); m.svc.setCatalogSettings({ trustedKeys: [] }); publish(rev(1)); const r = await m.svc.refreshCatalog('manual'); ok('REFUSED: no pinned key at all (nothing is trusted by default)', r.outcome === 'rejected' && m.svc.catalogStatus().source === 'builtin'); }
  { const m = mk({}); m.svc.setCatalogSettings({ allowUnsignedDev: true }); publish(rev(1), { sig: null }); const r = await m.svc.refreshCatalog('manual'); ok('REFUSED: "allow unsigned dev" never rescues an unsigned PRODUCTION catalog', r.outcome === 'rejected' && r.error.code === 'unsigned'); }
  await refuses('catalog flagged example:true', rev(1, (c) => { c.example = true; }), undefined, 'schema');

  // ── 7b. unsafe downloads / unknown hosts / private LAN in production ────────
  await refuses('download over plain http in production', rev(1, (c) => { c.archives[0].url = 'http://dl.example.com/pack.7z'; }), undefined, 'schema');
  await refuses('download host missing from allowedHosts', rev(1, (c) => { c.archives[0].url = 'https://evil.example.net/pack.7z'; }), undefined, 'schema');
  await refuses('wildcard allowedHosts', rev(1, (c) => { c.archives[0].allowedHosts = ['*.example.com']; }), undefined, 'schema');
  await refuses('archive path traversal in origin.path', rev(1, (c) => { c.content.cars[0].origin.path = '../../Windows'; }), undefined, 'schema');
  await refuses('archive larger than 16 GiB', rev(1, (c) => { c.archives[0].bytes = 20 * 1024 ** 3; }), undefined, 'schema');
  await refuses('malformed checksum', rev(1, (c) => { c.archives[0].sha256 = 'not-a-hash'; }), undefined, 'schema');
  await refuses('private LAN address as the public host (production)', rev(1, (c) => { c.servers[0].connection.public.host = '192.168.1.50'; }), undefined, 'schema');
  await refuses('loopback / localhost in production', rev(1, (c) => { c.servers[0].connection.public.host = 'localhost'; }), undefined, 'schema');
  await refuses('LAN endpoint block in a production catalog', rev(1, (c) => { c.servers[0].connection.lan = { host: '10.0.0.5', gamePort: 9600, httpPort: 8081 }; }), undefined, 'schema');
  await refuses('private address smuggled into a description', rev(1, (c) => { c.servers[0].description = 'play on 172.16.0.9'; }), undefined, 'schema');
  await refuses('unknown major schema version', rev(1, (c) => { c.schemaVersion = '2.0.0'; }), undefined, 'schema');

  // an authorised host list is also enforced at install time: no plan item may download from an off-list host
  {
    const { svc, fx } = mk(); publish(rev(1, (c) => { c.archives[0].redistribution = 'none'; }));
    await svc.refreshCatalog('manual'); const plan = await svc.plan('srv-a');
    ok('redistribution "none": no download is planned, the player must supply the file', plan.downloads.length === 0 && plan.items.some((i) => i.id === 'car:car_a' && i.blocked));
    void fx;
  }

  // ── 8. fallback: never makes old data look current ──────────────────────────
  {
    const { svc } = mk();
    publish(rev(1), { sig: null });
    await svc.refreshCatalog('manual');
    let st = svc.catalogStatus();
    const bar = loadBar();
    const view = bar(st, clock.t);
    ok('fallback is labelled built-in / may be outdated, in warning colour, never "good"', st.source === 'builtin' && view.tone === 'warn' && /not the live catalog/.test(view.title) && view.warnings.some((w) => /out of date/.test(w)));
    ok('fallback: automatic install is off and installs are not attributed to a catalog', st.autoInstallAllowed === false);
    const rd = await svc.readiness(svc.listServers()[0].id);
    ok('fallback: the readiness stepper does not say the catalog is current', rd.steps[0].state !== 'done' && rd.facts.catalogAvailable === false);
  }
  {
    const { svc } = mk(); const mkBar = loadBar();
    publish(rev(5)); await svc.refreshCatalog('manual');
    ok('baseline: signed catalog accepted and shown as current', svc.catalogStatus().source === 'catalog' && mkBar(svc.catalogStatus(), clock.t).tone === 'good');
    clock.t += 5 * 60_000; publish(rev(3)); const r = await svc.refreshCatalog('manual');
    const st = svc.catalogStatus();
    ok('replayed older catalog is refused and the accepted one is kept', r.outcome === 'rejected' && r.error.code === 'rollback' && st.revision === 5);
    ok('...but the player is told the latest refresh failed (not shown as simply "current")', st.lastError?.code === 'rollback' && mkBar(st, clock.t).tone !== 'good' && mkBar(st, clock.t).warnings.length > 0);
    clock.t += 3 * 3600_000; pub.status = 503; await svc.refreshCatalog('manual'); pub.status = 200;
    const st2 = svc.catalogStatus();
    ok('after hours without a successful refresh the old catalog is marked stale', st2.stale === true && mkBar(st2, clock.t).tone !== 'good' && /synced/.test(mkBar(st2, clock.t).warnings.join(' ')));
    // key removed / changed => the stored copy is no longer trusted and the built-in list is NOT shown as current
    svc.setCatalogSettings({ trustedKeys: [{ keyId: 'k9', publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }) }] });
    const st3 = svc.catalogStatus();
    ok('changing the pinned key invalidates the cached catalog; the fallback is labelled, never "current"', st3.source === 'builtin' && st3.revision === null && mkBar(st3, clock.t).tone === 'warn');
  }
  {
    const { svc } = mk(); const mkBar = loadBar();
    publish(rev(1, (c) => { c.catalog.expiresAt = new Date(clock.t + 60_000).toISOString(); })); await svc.refreshCatalog('manual');
    clock.t += 3600_000; const st = svc.catalogStatus();
    ok('an expired cached catalog is shown as expired (bad), installs paused, never "current"', st.expired && !st.installsAllowed && mkBar(st, clock.t).tone === 'bad');
    let threw = null; try { await svc.install('srv-a', ['car:car_a']); } catch (e) { threw = e; }
    ok('...and install() refuses', !!threw && /expired/.test(threw.message));
  }

  cleanup.forEach(F.rm);
  console.log(`\nAC CATALOG REFUSAL + FALLBACK POLICY TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);

  function loadBar() {
    const Module = require('module'), ts = require('typescript'), path = require('path');
    const prev = Module._extensions['.ts'];
    Module._extensions['.ts'] = (mod, filename) => { mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true } }).outputText, filename); };
    try { const p = path.resolve(__dirname, '../../src/renderer/lib/acMercyView.ts'); delete require.cache[p]; return require(p).catalogBar; } finally { Module._extensions['.ts'] = prev; }
  }
})().catch((e) => { console.error(e); process.exit(1); });
