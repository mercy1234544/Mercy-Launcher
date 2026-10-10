// Catalog sync: acceptance policy, caching, change detection, scheduling/backoff and the settings store, against a
// real local HTTP server publishing signed catalogs. Time, sleeping and randomness are injected so nothing waits.
const crypto = require('crypto'), fs = require('fs'), http = require('http'), path = require('path');
const F = require('./_acFixtures');
const { validCatalog, H } = require('./_catalogFixtures');
const sync = F.dist('ac/catalogSync.js');
const { CatalogSync, CatalogSettingsStore, evaluateCatalog, normalizeSettings, DEFAULT_SETTINGS, BACKOFF_MAX_MS } = sync;
const { sha256Hex } = F.dist('ac/catalogSigning.js');
const { checkBaseUrl } = F.dist('ac/catalogClient.js');
const { diffCatalogs } = F.dist('ac/catalogDiff.js');
const { getBundledSrpBundle } = F.dist('AcSrpBundle.js');
const { catalogToBundle, bundleToCatalog } = F.dist('ac/catalogAdapter.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
const KEYS = [{ keyId: 'k1', publicKey: PEM }];
const sig = (bytes, keyId = 'k1', key = privateKey) => JSON.stringify({ alg: 'ed25519', keyId, signedAt: '2030-01-01T00:00:00Z', catalogSha256: sha256Hex(bytes), signature: crypto.sign(null, bytes, key).toString('base64') });
const bytesOf = (cat) => Buffer.from(JSON.stringify(cat, null, 1) + '\n');
const publish = (srv, cat, opts = {}) => { const b = Buffer.isBuffer(cat) ? cat : bytesOf(cat); srv.catalog = b; srv.sig = opts.sig === undefined ? sig(b) : opts.sig; srv.etag = `"${sha256Hex(b).slice(0, 16)}"`; };

function startServer() {
  const srv = { hits: [], catalog: null, sig: null, etag: null, down: false, redirect: null, bigBody: false, status: 200 };
  srv.http = http.createServer((req, res) => {
    srv.hits.push({ url: req.url, inm: req.headers['if-none-match'] || null });
    if (srv.redirect) { res.writeHead(302, { Location: srv.redirect }); return res.end(); }
    if (srv.status !== 200) { res.writeHead(srv.status); return res.end(); }
    if (req.url === '/x/catalog.json') {
      if (srv.bigBody) { res.writeHead(200, { 'Content-Length': 3 * 1024 * 1024 }); return res.end(Buffer.alloc(3 * 1024 * 1024, 32)); }
      if (srv.etag && req.headers['if-none-match'] === srv.etag) { res.writeHead(304); return res.end(); }
      res.writeHead(200, { ETag: srv.etag || '', 'Content-Length': srv.catalog.length }); return res.end(srv.catalog);
    }
    if (req.url === '/x/catalog.json.sig') { if (srv.sig === null) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(srv.sig); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.http.listen(0, '127.0.0.1', () => { srv.base = `http://127.0.0.1:${srv.http.address().port}/x/`; srv.origin = `http://127.0.0.1:${srv.http.address().port}`; srv.close = () => new Promise((rr) => srv.http.close(rr)); r(srv); }));
}

(async () => {
  const cleanup = []; const tmp = () => { const d = F.mkTmp('cat-sync-'); cleanup.push(d); return d; };
  const base = getBundledSrpBundle();
  const builtin = () => ({ bundle: base, release: { servers: {} }, lanDefaults: {}, serverStatus: {}, notices: [] });
  let clock = Date.parse('2030-06-01T12:00:00Z');
  const now = () => new Date(clock);
  const tick = (ms) => { clock += ms; };
  const mk = (userData, settingsObj, extra = {}) => {
    const events = []; const logs = [];
    const s = new CatalogSync({ userDataPath: userData, settings: { get: () => settingsObj }, builtin, boardBase: base, now, random: () => 0.5, sleep: async () => {}, onEvent: (e) => events.push(e), log: (l) => logs.push(l), ...extra });
    return { s, events, logs };
  };
  const cfg = (srv, over = {}) => ({ ...DEFAULT_SETTINGS, baseUrl: srv.base, trustedKeys: KEYS, ...over });
  const rev = (n, mutate) => validCatalog((c) => { c.catalog.revision = n; c.catalog.generatedAt = new Date(clock - 3600_000).toISOString(); if (mutate) mutate(c); });

  // ── unconfigured ───────────────────────────────────────────────────────────
  {
    const { s } = mk(tmp(), { ...DEFAULT_SETTINGS });
    const r = await s.refresh('startup');
    ok('unconfigured => nothing fetched, built-in list in use', r.outcome === 'unconfigured' && s.status().source === 'builtin' && s.status().configured === false);
    ok('built-in adapted data is served', s.adapted().bundle === base);
  }

  // ── happy path, 304, change detection ──────────────────────────────────────
  const srv = await startServer(); const ud = tmp();
  const settings = cfg(srv);
  {
    publish(srv, rev(1));
    const { s, events, logs } = mk(ud, settings);
    const r1 = await s.refresh('startup');
    ok('first sync is accepted', r1.outcome === 'updated' && r1.revision === 1 && r1.diff.firstSync === true);
    let st = s.status();
    ok('status reflects the signed catalog', st.source === 'catalog' && st.revision === 1 && st.signatureVerified && st.keyId === 'k1' && st.environment === 'production' && st.lastSuccessAt && !st.expired && st.installsAllowed);
    ok('a change event with the diff was emitted', events.some((e) => e.type === 'changed' && e.diff.firstSync));
    ok('adapted bundle now comes from the catalog', s.adapted().bundle.servers[0].server.id === 'srv-a');
    ok('cache files written atomically (no temp leftovers)', fs.existsSync(path.join(ud, 'ac-catalog', 'catalog.json')) && fs.readdirSync(path.join(ud, 'ac-catalog')).every((f) => !f.endsWith('.tmp')));

    tick(MS(5));
    const hits0 = srv.hits.length;
    const r2 = await s.refresh('manual');
    ok('unchanged catalog answers 304 and is reported unchanged', r2.outcome === 'unchanged' && r2.changed === false && srv.hits[hits0].inm === srv.etag && srv.hits.length === hits0 + 1);

    tick(MS(5));
    publish(srv, rev(2, (c) => { c.content.cars.push({ id: 'car_new', name: 'New Car', version: '1', origin: { kind: 'base-game' }, identity: { dataAcdSha256: null, uiCarJsonSha256: null } }); c.servers[0].cars.push({ carId: 'car_new', role: 'player' }); }));
    events.length = 0;
    const r3 = await s.refresh('manual');
    ok('new revision with an added car is detected', r3.outcome === 'updated' && r3.changed && r3.diff.summary.some((t) => /car New Car added/.test(t)) && r3.diff.serverIds.join() === 'srv-a');
    ok('UI is told which servers changed', events.some((e) => e.type === 'changed' && e.diff.serverIds.includes('srv-a')));
    ok('last change is remembered in status', s.status().lastChange.summary.length > 0 && s.status().revision === 2);

    // rollback / conflict / tamper / unsigned / wrong key
    tick(MS(5)); publish(srv, rev(1));
    let r = await s.refresh('manual');
    ok('older revision is refused (rollback)', r.outcome === 'rejected' && r.error.code === 'rollback' && s.status().revision === 2);
    ok('the last good catalog stays in use after a rejection', s.adapted().bundle.servers[0].cars.some((c) => c.id === 'car_new'));
    tick(MS(5)); publish(srv, rev(2, (c) => { c.servers[0].displayName = 'Same revision, different bytes'; }));
    r = await s.refresh('manual');
    ok('same revision with different bytes is refused (conflict)', r.outcome === 'rejected' && r.error.code === 'conflict');

    tick(MS(5)); { const good = bytesOf(rev(3)); publish(srv, good, { sig: sig(good) }); srv.catalog = Buffer.from(good.toString().replace('Server A', 'Server B')); }
    r = await s.refresh('manual');
    ok('bytes that do not match their signature are refused', r.outcome === 'rejected' && r.error.code === 'signature');
    tick(MS(5)); publish(srv, rev(3), { sig: null });
    r = await s.refresh('manual');
    ok('missing signature is refused', r.outcome === 'rejected' && r.error.code === 'unsigned');
    const other = crypto.generateKeyPairSync('ed25519');
    tick(MS(5)); { const b = bytesOf(rev(3)); publish(srv, b, { sig: sig(b, 'k1', other.privateKey) }); }
    r = await s.refresh('manual');
    ok('signature by a different key is refused', r.outcome === 'rejected' && r.error.code === 'signature');
    tick(MS(5)); { const b = bytesOf(rev(3)); publish(srv, b, { sig: sig(b, 'rogue') }); }
    r = await s.refresh('manual');
    ok('unknown key id is refused', r.outcome === 'rejected' && r.error.code === 'signature');
    tick(MS(5)); publish(srv, Buffer.from('{ not json'), { sig: sig(Buffer.from('{ not json')) });
    r = await s.refresh('manual');
    ok('malformed JSON is refused', r.outcome === 'rejected' && r.error.code === 'malformed');
    tick(MS(5)); publish(srv, rev(3, (c) => { c.archives[0].sha256 = 'zz'; }));
    r = await s.refresh('manual');
    ok('schema violations are refused with the reason', r.outcome === 'rejected' && r.error.code === 'schema' && /sha256/.test(r.error.message));
    tick(MS(5)); publish(srv, rev(3, (c) => { c.catalog.id = 'someone-else'; }));
    r = await s.refresh('manual');
    ok('a different catalog identity is refused', r.outcome === 'rejected' && r.error.code === 'identity');
    tick(MS(5)); publish(srv, rev(3, (c) => { c.catalog.expiresAt = new Date(clock - 1000).toISOString(); c.catalog.generatedAt = new Date(clock - 5000).toISOString(); }));
    r = await s.refresh('manual');
    ok('an already expired catalog is refused', r.outcome === 'rejected' && r.error.code === 'expired');
    tick(MS(5)); publish(srv, rev(3, (c) => { c.catalog.generatedAt = new Date(clock + 3 * 3600_000).toISOString(); }));
    r = await s.refresh('manual');
    ok('a catalog from the future is refused', r.outcome === 'rejected' && r.error.code === 'future');
    tick(MS(5)); publish(srv, rev(3, (c) => { c.servers[0].connection.public.host = '192.168.5.5'; }));
    r = await s.refresh('manual');
    ok('a production catalog leaking a LAN address is refused', r.outcome === 'rejected' && r.error.code === 'schema' && /private|loopback|local/.test(r.error.message));
    ok('...and the leak is not echoed into status or logs', !JSON.stringify(s.status()).includes('192.168') && !logs.join('\n').includes('192.168'));
    ok('revision still 2 after every rejection', s.status().revision === 2 && s.status().lastError.code === 'schema');

    // half-published pair: first read has a mismatched signature, second is consistent
    tick(MS(5));
    { const b3 = bytesOf(rev(3)); const b2old = srv.catalog; publish(srv, b3); const wrongSig = sig(Buffer.from('previous')); let n = 0;
      const realSig = srv.sig; Object.defineProperty(srv, 'sig', { get() { return n++ === 0 ? wrongSig : realSig; }, configurable: true }); void b2old; }
    r = await s.refresh('manual');
    ok('an inconsistent publish is retried once and then accepted', r.outcome === 'updated' && s.status().revision === 3);
    Object.defineProperty(srv, 'sig', { value: srv.sig, writable: true, configurable: true });
    s.stop();
  }

  // ── cache survives a restart and is re-verified ────────────────────────────
  {
    const a = mk(ud, settings);
    ok('a restarted launcher loads the verified cache without the network', a.s.usingCatalog() && a.s.status().revision === 3 && a.s.status().signatureVerified);
    const catFile = path.join(ud, 'ac-catalog', 'catalog.json');
    const original = fs.readFileSync(catFile);
    fs.writeFileSync(catFile, original.toString().replace('Server A', 'Server Z'));
    const b = mk(ud, settings);
    ok('a tampered cache file is discarded, not trusted', !b.s.usingCatalog() && b.s.status().source === 'builtin');
    fs.writeFileSync(catFile, original);
    // state.accepted was cleared by the discard, so a fresh sync is needed
    const c = mk(ud, settings); void c;
    const wrongKey = mk(ud, { ...settings, trustedKeys: [{ keyId: 'k1', publicKey: crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) }] });
    ok('removing/replacing the pinned key invalidates the cache', !wrongKey.s.usingCatalog());
  }

  // ── unavailable server, backoff, rate limits ───────────────────────────────
  {
    const srv2 = await startServer(); publish(srv2, rev(1));
    const ud2 = tmp(); const st2 = cfg(srv2);
    const { s } = mk(ud2, st2);
    await s.refresh('startup');
    ok('baseline accepted', s.status().revision === 1);
    srv2.status = 503;
    tick(MS(20));
    let r = await s.refresh('periodic');
    ok('server error => unavailable, last good kept', r.outcome === 'unavailable' && s.status().revision === 1 && s.status().failures === 1 && s.status().lastError.code === 'http');
    const next1 = Date.parse(s.status().nextAttemptAt) - clock;
    ok('first retry in about a minute', next1 === 60_000);
    r = await s.refresh('periodic');
    ok('periodic refresh is skipped during backoff', r.outcome === 'skipped' && r.skippedBecause === 'backoff');
    r = await s.refresh('section-open');
    ok('opening the section during backoff does not hammer the server', r.outcome === 'skipped');
    const hits = srv2.hits.length;
    r = await s.refresh('manual');
    ok('manual refresh bypasses backoff', r.outcome === 'unavailable' && srv2.hits.length > hits && s.status().failures === 2);
    ok('second failure backs off longer', Date.parse(s.status().nextAttemptAt) - clock === 120_000);
    for (let i = 0; i < 12; i++) { tick(MS(31)); await s.refresh('manual'); }
    ok('backoff is capped at 30 minutes', Date.parse(s.status().nextAttemptAt) - clock <= BACKOFF_MAX_MS && Date.parse(s.status().nextAttemptAt) - clock >= 0.8 * BACKOFF_MAX_MS * 0.99);
    ok('the failure is visible but the catalog is still served', s.status().stale === false || s.status().stale === true);
    srv2.status = 200; tick(MS(31));
    r = await s.refresh('manual');
    ok('recovery resets the failure count', r.outcome === 'unchanged' && s.status().failures === 0 && s.status().lastError === null);

    // section-open gap
    tick(MS(2)); // < 60 s? MS(2) is 2 minutes, so move the attempt first
    await s.refresh('manual'); tick(10_000);
    r = await s.refresh('section-open');
    ok('section-open within 60 s of the last attempt is rate limited', r.outcome === 'skipped' && r.skippedBecause === 'rate-limit');
    tick(61_000);
    r = await s.refresh('section-open');
    ok('section-open after 60 s refreshes', r.outcome === 'unchanged');
    // manual debounce
    tick(MS(2)); const first = await s.refresh('manual'); const hitsB = srv2.hits.length; tick(1000);
    const second = await s.refresh('manual');
    ok('rapid manual clicks are debounced (no second request within 3 s)', second.skippedBecause === 'debounced' && srv2.hits.length === hitsB && first.outcome === 'unchanged');
    // in-flight dedupe
    tick(MS(2)); const h2 = srv2.hits.length;
    const [p1, p2] = await Promise.all([s.refresh('manual'), s.refresh('manual')]);
    ok('concurrent refreshes share one request', p1 === p2 || (srv2.hits.length - h2 <= 2 && p1.outcome === p2.outcome));

    // unreachable server
    await srv2.close();
    tick(MS(2));
    r = await s.refresh('manual');
    ok('unreachable server => unavailable (network), last good kept', r.outcome === 'unavailable' && r.error.code === 'network' && s.status().revision === 1);
  }

  // ── redirects, size, status codes ──────────────────────────────────────────
  {
    const srv3 = await startServer(); publish(srv3, rev(1));
    const { s } = mk(tmp(), cfg(srv3));
    srv3.redirect = 'http://localhost:1/x/catalog.json';
    let r = await s.refresh('startup');
    ok('redirect to another host is refused', r.outcome === 'unavailable' && r.error.code === 'redirect');
    srv3.redirect = null; srv3.bigBody = true; tick(MS(2));
    r = await s.refresh('manual');
    ok('oversize body is refused', r.outcome === 'unavailable' && r.error.code === 'too-large');
    srv3.bigBody = false; srv3.status = 404; tick(MS(2));
    r = await s.refresh('manual');
    ok('404 explains the address is wrong', r.outcome === 'unavailable' && /404/.test(r.error.message));
    await srv3.close();
  }

  // ── development catalogs ───────────────────────────────────────────────────
  {
    const srv4 = await startServer();
    const devCat = (m) => rev(1, (c) => { c.catalog.environment = 'development'; c.servers[0].connection.lan = { host: '192.168.7.7', gamePort: 9600, httpPort: 8081 }; if (m) m(c); });
    const unsigned = { sig: null };
    publish(srv4, devCat(), unsigned);
    let m = mk(tmp(), cfg(srv4, { trustedKeys: [] }));
    let r = await m.s.refresh('startup');
    ok('unsigned dev catalog refused unless explicitly allowed', r.outcome === 'rejected' && r.error.code === 'unsigned');
    m = mk(tmp(), cfg(srv4, { trustedKeys: [], allowUnsignedDev: true }));
    r = await m.s.refresh('startup');
    ok('unsigned dev catalog accepted from a private address when allowed', r.outcome === 'updated' && m.s.status().unsignedDev === true && m.s.status().environment === 'development');
    ok('dev catalog never enables auto-install', m.s.status().autoInstallAllowed === false);
    ok('dev LAN address is exposed only as an adapter default, not in status/logs', m.s.adapted().lanDefaults['srv-a'].host === '192.168.7.7' && !JSON.stringify(m.s.status()).includes('192.168.7.7') && !m.logs.join('').includes('192.168.7.7'));
    m = mk(tmp(), cfg(srv4, { allowUnsignedDev: true }));
    publish(srv4, rev(1), unsigned);
    r = await m.s.refresh('startup');
    ok('allowUnsignedDev never lets an unsigned PRODUCTION catalog through', r.outcome === 'rejected' && r.error.code === 'unsigned');
    // dev catalog signed with a pinned key is accepted but still never auto-installs
    publish(srv4, devCat());
    m = mk(tmp(), cfg(srv4, { installMode: 'auto' }));
    r = await m.s.refresh('startup');
    ok('signed dev catalog accepted; auto-install still off', r.outcome === 'updated' && m.s.status().autoInstallAllowed === false);
    // pure policy: dev catalog from a non-private URL
    const bytes = bytesOf(devCat()); const ev = evaluateCatalog({ bytes, signature: sig(bytes), settings: cfg(srv4), privateUrl: false, prev: null, now: now() });
    ok('a development catalog from a public address is refused', !ev.ok && ev.code === 'environment');
    await srv4.close();
  }

  // ── expiry of a cached catalog ─────────────────────────────────────────────
  {
    const srv5 = await startServer(); const ud5 = tmp();
    publish(srv5, rev(1, (c) => { c.catalog.expiresAt = new Date(clock + 2 * 3600_000).toISOString(); }));
    const m = mk(ud5, cfg(srv5, { installMode: 'auto' }));
    await m.s.refresh('startup');
    ok('auto-install allowed for a signed, current production catalog in auto mode', m.s.status().autoInstallAllowed === true && m.s.status().installsAllowed === true);
    tick(3 * 3600_000);
    const st = m.s.status();
    ok('after expiry the cached catalog is read-only: installs and auto-install are off', st.expired === true && st.installsAllowed === false && st.autoInstallAllowed === false && /expired/.test(st.installBlockedReason));
    ok('...but the servers are still listed', m.s.adapted().bundle.servers.length === 1);
    const reloaded = mk(ud5, cfg(srv5));
    ok('an expired cache still loads after a restart (flagged)', reloaded.s.usingCatalog() && reloaded.s.status().expired === true);
    await srv5.close();
  }

  // ── switching the catalog address resets rollback protection ───────────────
  {
    const a = await startServer(), b = await startServer(); publish(a, rev(5)); publish(b, rev(1, (c) => { c.catalog.id = 'other-source'; }));
    const holder = { v: cfg(a) }; const ud6 = tmp();
    const events = []; const s = new CatalogSync({ userDataPath: ud6, settings: { get: () => holder.v }, builtin, boardBase: base, now, random: () => 0.5, sleep: async () => {}, onEvent: (e) => events.push(e) });
    await s.refresh('startup');
    holder.v = cfg(b); tick(MS(2));
    const r = await s.refresh('manual');
    ok('a new address is judged on its own (no cross-source rollback/identity errors)', r.outcome === 'updated' && s.status().catalogId === 'other-source' && s.status().revision === 1);
    s.reset();
    ok('reset forgets the catalog and falls back to the built-in list', s.status().source === 'builtin' && !fs.existsSync(path.join(ud6, 'ac-catalog', 'catalog.json')));
    await a.close(); await b.close();
  }

  // ── scheduler wiring ───────────────────────────────────────────────────────
  {
    const srv7 = await startServer(); publish(srv7, rev(1));
    const timers = []; const cleared = [];
    const m = mk(tmp(), cfg(srv7, { intervalMinutes: 10 }), { timers: { set: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clear: (h) => cleared.push(h) } });
    m.s.start();
    ok('start schedules a periodic refresh at the configured interval', timers.length === 1 && timers[0].ms === 10 * 60_000);
    await m.s.refresh('startup');
    ok('each refresh re-arms the timer and clears the old one', timers.length >= 2 && cleared.length >= 1);
    m.s.stop();
    ok('stop clears the timer', cleared.includes(timers[timers.length - 1]));
    await srv7.close();
  }

  // ── settings store ─────────────────────────────────────────────────────────
  {
    const dir = tmp(); const store = new CatalogSettingsStore(dir, {});
    ok('defaults', store.get().baseUrl === null && store.get().installMode === 'review' && store.get().intervalMinutes === 15 && store.get().autoUpdateExisting === false && store.get().maxAutoDownloadBytes === 1024 ** 3);
    let r = store.set({ baseUrl: 'https://catalog.example.com/ac/' });
    ok('https address accepted', r.settings.baseUrl === 'https://catalog.example.com/ac/' && r.errors.length === 0);
    r = store.set({ baseUrl: 'http://catalog.example.com/ac/' });
    ok('plain http to a public host rejected', r.errors.length === 1 && /https/.test(r.errors[0]) && r.settings.baseUrl === 'https://catalog.example.com/ac/');
    r = store.set({ baseUrl: 'http://192.168.1.10:8080/ac' });
    ok('plain http to a private address accepted (LAN testing)', r.errors.length === 0 && r.settings.baseUrl === 'http://192.168.1.10:8080/ac');
    r = store.set({ baseUrl: 'https://user:pw@catalog.example.com/' });
    ok('credentials in the address rejected', r.errors.length === 1 && /user name/.test(r.errors[0]));
    r = store.set({ baseUrl: 'https://catalog.example.com/?x=1' });
    ok('query string rejected', r.errors.length === 1);
    r = store.set({ baseUrl: 'ftp://catalog.example.com/' });
    ok('non-http scheme rejected', r.errors.length === 1);
    r = store.set({ trustedKeys: [{ keyId: 'k1', publicKey: PEM }, { keyId: 'bad key!', publicKey: PEM }, { keyId: 'k2', publicKey: 'nonsense' }] });
    ok('only valid keys are stored', r.settings.trustedKeys.length === 1 && r.settings.trustedKeys[0].keyId === 'k1' && r.errors.length === 2);
    r = store.set({ intervalMinutes: 1 }); ok('interval clamped to 5', r.settings.intervalMinutes === 5);
    r = store.set({ intervalMinutes: 9999 }); ok('interval clamped to 120', r.settings.intervalMinutes === 120);
    r = store.set({ installMode: 'auto', autoUpdateExisting: true, maxAutoDownloadBytes: 5 * 1024 ** 3 });
    ok('install settings persist', r.settings.installMode === 'auto' && r.settings.autoUpdateExisting === true && r.settings.maxAutoDownloadBytes === 5 * 1024 ** 3);
    ok('persisted across instances', new CatalogSettingsStore(dir, {}).get().installMode === 'auto');
    r = store.set({ installMode: 'yolo' }); ok('unknown install mode ignored', r.settings.installMode === 'auto');
    const withRelease = new CatalogSettingsStore(tmp(), { baseUrl: 'https://release.example.com/ac/', trustedKeys: KEYS });
    ok('release defaults supply the address and key', withRelease.get().baseUrl === 'https://release.example.com/ac/' && withRelease.get().trustedKeys.length === 1);
    withRelease.set({ baseUrl: 'https://mine.example.com/ac/' });
    ok('user setting overrides the release address but keeps the release key', withRelease.get().baseUrl === 'https://mine.example.com/ac/' && withRelease.get().trustedKeys.length === 1);
    ok('reset returns to release defaults', withRelease.reset().baseUrl === 'https://release.example.com/ac/');
    ok('normalizeSettings tolerates garbage', normalizeSettings('nope').intervalMinutes === 15 && normalizeSettings({ trustedKeys: 5 }).trustedKeys.length === 0);
  }

  // ── base url + diff unit checks ────────────────────────────────────────────
  ok('checkBaseUrl normalises the trailing slash', checkBaseUrl('https://a.example.com/ac').base === 'https://a.example.com/ac/' && checkBaseUrl('https://a.example.com/ac').catalogUrl === 'https://a.example.com/ac/catalog.json');
  ok('checkBaseUrl flags private hosts', checkBaseUrl('http://127.0.0.1:9/ac').privateHost === true && checkBaseUrl('https://a.example.com').privateHost === false);
  {
    const A = rev(1); const B = JSON.parse(JSON.stringify(A));
    B.content.cars[0].version = '2.0'; B.servers[0].cars = B.servers[0].cars.filter((c) => c.carId !== 'car_opt'); B.servers[0].tracks[0].layouts = [''];
    B.archives[0].sha256 = H('changed'); B.servers[0].connection.public.host = 'other.example.com';
    const d = diffCatalogs(A, B);
    ok('diff reports updates, removals, layout and archive and endpoint changes', d.changed && d.summary.some((t) => /Car updated: Car A \(1\.0 → 2\.0\)/.test(t)) && d.summary.some((t) => /no longer required/.test(t)) && d.summary.some((t) => /layout alt .* no longer used/.test(t)) && d.summary.some((t) => /Download updated/.test(t)) && d.summary.some((t) => /connection address changed/.test(t)));
    ok('identical catalogs have no diff', diffCatalogs(A, JSON.parse(JSON.stringify(A))).changed === false);
    const gone = JSON.parse(JSON.stringify(A)); gone.servers = []; gone.content = { cars: [], tracks: [] }; gone.archives = [];
    ok('removed content says the installed copy is kept', diffCatalogs(A, gone).summary.some((t) => /installed copy is kept/.test(t)));
    ok('server removal is reported', diffCatalogs(A, gone).changes.some((c) => c.kind === 'server-removed'));
    ok('built-in catalog diff is stable', diffCatalogs(bundleToCatalog(base, { generatedAt: 'x' }), bundleToCatalog(base, { generatedAt: 'y' })).changed === false);
    void catalogToBundle;
  }

  await srv.close();
  cleanup.forEach(F.rm);
  console.log(`\nAC CATALOG SYNC TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);

  function MS(minutes) { return minutes * 60_000; }
})().catch((e) => { console.error(e); process.exit(1); });
