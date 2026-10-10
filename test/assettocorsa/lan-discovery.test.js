// Automatic server discovery from a PRIVATE-NETWORK (development) catalog, and the developer-only gate around its settings.
// Everything is synthetic: a loopback HTTP server stands in for the Linux box, game folders are disposable fixtures, the
// Content Manager hand-off is a recorder, and no real address, key or server is used. The release config itself is checked
// as shipped (shape, pinned PUBLIC key, centralized address) without ever contacting the address it names.
const crypto = require('crypto'), fs = require('fs'), http = require('http'), path = require('path'), Module = require('module'), ts = require('typescript');
const F = require('./_acFixtures');
const { validCatalog } = require('./_catalogFixtures');
const { AcPlayerService } = F.dist('ac/playerService.js');
const { checkBaseUrl, normalizeCatalogPaths, DEFAULT_CATALOG_PATHS } = F.dist('ac/catalogClient.js');
const { CatalogSettingsStore, normalizeSettings, DEFAULT_SETTINGS } = F.dist('ac/catalogSync.js');
const { parsePublicKey, sha256Hex } = F.dist('ac/catalogSigning.js');
const gate = F.dist('ac/developerGate.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
function loadTs(rel) {
  const prev = Module._extensions['.ts'];
  Module._extensions['.ts'] = (mod, filename) => { mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true } }).outputText, filename); };
  try { const p = path.resolve(__dirname, '../..', rel); delete require.cache[p]; return require(p); } finally { Module._extensions['.ts'] = prev; }
}
const HOME = '192.168.77.20';                       // synthetic "Linux box" LAN address used inside the catalog

(async () => {
  // ── A. address policy ───────────────────────────────────────────────────────────────────────────────────────────
  ok('URL: plain http is accepted for a private LAN address', checkBaseUrl('http://192.168.77.20:18790').ok && checkBaseUrl('http://10.1.2.3:18790').ok && checkBaseUrl('http://172.20.0.5:18790').ok && checkBaseUrl('http://localhost:18790').ok);
  ok('URL: plain http is REJECTED for a public address (name or IP)', !checkBaseUrl('http://catalog.example.com').ok && !checkBaseUrl('http://203.0.113.9:18790').ok && /https/.test(checkBaseUrl('http://catalog.example.com').error));
  ok('URL: public https is accepted; credentials, query and fragment are refused', checkBaseUrl('https://catalog.example.com/ac/').ok && !checkBaseUrl('http://u:p@192.168.77.20').ok && !checkBaseUrl('http://192.168.77.20/?k=1').ok && !checkBaseUrl('http://192.168.77.20/#x').ok && !checkBaseUrl('ftp://192.168.77.20').ok);
  const v1 = { catalog: 'catalog/v1/catalog', signature: 'catalog/v1/signature' };
  const u = checkBaseUrl('http://192.168.77.20:18790', v1);
  ok('URL: the documented /catalog/v1 endpoints are used when configured', u.ok && u.catalogUrl === 'http://192.168.77.20:18790/catalog/v1/catalog' && u.signatureUrl === 'http://192.168.77.20:18790/catalog/v1/signature' && u.privateHost === true);
  ok('URL: with no paths configured the static-file layout is unchanged (catalog.json / catalog.json.sig)', checkBaseUrl('https://catalog.example.com/ac').catalogUrl === 'https://catalog.example.com/ac/catalog.json' && checkBaseUrl('https://catalog.example.com/ac').signatureUrl.endsWith('/catalog.json.sig'));
  ok('URL: configured paths cannot escape the base address (absolute URL, parent segment, query, backslash all fall back to the defaults)', ['https://evil.example/x', '../x', 'a/../../b', 'a?b=1', 'a\\b', ''].every((p) => normalizeCatalogPaths({ catalog: p }).catalog === DEFAULT_CATALOG_PATHS.catalog));

  // ── B. the release config as shipped ────────────────────────────────────────────────────────────────────────────
  const cfg = JSON.parse(read('src/main/data/assettocorsa-srp/catalog.config.json'));
  const ud0 = F.mkTmp('lan-cfg-');
  const shipped = new CatalogSettingsStore(ud0, cfg).get();
  ok('RELEASE CONFIG: ships a preconfigured catalog address (private http) and the documented endpoint paths, so no player types an address', !!shipped.baseUrl && checkBaseUrl(shipped.baseUrl, shipped.paths).ok && checkBaseUrl(shipped.baseUrl, shipped.paths).privateHost === true && shipped.paths.catalog === 'catalog/v1/catalog' && shipped.paths.signature === 'catalog/v1/signature');
  ok('RELEASE CONFIG: pins exactly one trusted PUBLIC Ed25519 key, in the raw base64url form the server publishes', shipped.trustedKeys.length === 1 && shipped.trustedKeys[0].keyId === 'srp-ed25519-93365446dba82f13' && !!parsePublicKey(shipped.trustedKeys[0].publicKey) && /^[A-Za-z0-9_-]{43}$/.test(shipped.trustedKeys[0].publicKey));
  ok('RELEASE CONFIG: refreshes every 5 minutes, unsigned catalogs stay refused, review install mode stays the default', shipped.intervalMinutes === 5 && shipped.allowUnsignedDev === false && shipped.installMode === 'review');
  ok('RELEASE CONFIG: a player cannot change the endpoint paths through the settings store', (() => { const s = new CatalogSettingsStore(F.mkTmp('lan-cfg2-'), cfg); s.set({ paths: { catalog: 'x', signature: 'y' } }); return s.get().paths.catalog === 'catalog/v1/catalog'; })());
  ok('RELEASE CONFIG: a public http address in the release config is dropped, never used', normalizeSettings({ baseUrl: 'http://catalog.example.com' }, DEFAULT_SETTINGS).baseUrl === DEFAULT_SETTINGS.baseUrl);
  ok('RELEASE CONFIG: only public key material is shipped (each key is exactly {keyId, publicKey})', cfg.trustedKeys.every((k) => Object.keys(k).sort().join() === 'keyId,publicKey'));

  // ── C. discovery end to end against a stand-in for the Linux box ───────────────────────────────────────────────
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519');
  const rawKey = publicKey.export({ format: 'jwk' }).x;                                   // base64url of the 32 raw bytes, like the server's
  const KEYID = 'lan-test-key';
  const clock = { t: Date.parse('2030-06-01T12:00:00Z') };
  const hits = [];
  const live = { body: null, sig: null, mode: 'ok' };
  const signWith = (b, key = privateKey, keyId = KEYID) => JSON.stringify({ alg: 'ed25519', keyId, signedAt: '2030-06-01T11:59:00Z', catalogSha256: sha256Hex(b), signature: crypto.sign(null, b, key).toString('base64url') });
  const publish = (cat, o = {}) => { const b = Buffer.from(JSON.stringify(cat) + '\n'); live.body = o.raw ?? b; live.sig = o.sig === undefined ? signWith(o.raw ?? b) : o.sig; };
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (live.mode === 'down') { res.writeHead(503); return res.end(); }
    if (req.url === '/catalog/v1/catalog') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(live.body); }
    if (req.url === '/catalog/v1/signature') { if (live.sig === null) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(live.sig); }
    res.writeHead(404); res.end();                                                       // the static-file layout does NOT exist here: proves the configured paths are used
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const mkCat = (rev, o = {}) => validCatalog((c) => {
    c.catalog.id = 'lan-test'; c.catalog.revision = rev; c.catalog.environment = 'development';
    c.catalog.generatedAt = new Date(clock.t - 3600_000).toISOString();
    if (o.expiresAt) c.catalog.expiresAt = o.expiresAt;
    c.archives = [];
    c.content.cars = [{ id: 'ks_base', name: 'Base Car', version: null, origin: { kind: 'base-game' }, identity: { dataAcdSha256: null, uiCarJsonSha256: null } }];
    c.content.tracks = [{ id: 'trk_one', name: 'Track One', version: '1', origin: { kind: 'manual', instructions: 'Install Track One by hand.' }, verify: null, layouts: [{ config: '' }] }];
    const srvr = (id, name, game, http) => ({ id, displayName: name, description: 'Test server', engine: { type: 'kunos-stock' }, maxPlayers: 10,
      connection: { public: null, ports: { gamePort: game, httpPort: http }, lan: { host: HOME, gamePort: game, httpPort: http } },
      tracks: [{ trackId: 'trk_one', layouts: [''] }], cars: [{ carId: 'ks_base', role: 'player' }], requirements: { csp: { required: true, minimumVersion: '0.1.76' } }, companionApps: [] });
    c.servers = (o.servers ?? [['main', 'Server One', 9600, 8081], ['server2', 'Server Two', 9650, 8090]]).map((s) => srvr(...s));
  });

  const cleanup = []; const calls = { opened: [], probes: [], tcp: [] };
  const online = { 8081: 'Server One', 8090: 'Server Two' };
  const mkFx = () => { const fx = F.emptyAcInstall(); cleanup.push(fx.base); F.w(path.join(fx.ac, 'content', 'cars', 'ks_base', 'ui', 'ui_car.json'), '{}'); F.writeTrack(path.join(fx.ac, 'content', 'tracks', 'trk_one')); return fx; };
  const cmExe = path.join(F.mkTmp('lan-cm-'), 'Content Manager.exe'); fs.writeFileSync(cmExe, 'x');
  const mk = (over = {}, fx = mkFx()) => {
    const ud = F.mkTmp('lan-ud-'); cleanup.push(ud);
    return new AcPlayerService({
      userDataPath: ud, detectAcRoot: async () => fx.ac, documentsAcDir: () => fx.docs, broadcast() {}, isContentManagerAvailable: () => true, contentManagerExe: () => cmExe,
      openExternal: async (u) => { calls.opened.push(u); }, isGameRunning: async () => false, resolver: async () => [],
      catalogNow: () => new Date(clock.t), catalogSleep: async () => {}, catalogRandom: () => 0.5,
      // the RELEASE defaults, exactly as shipped, pointed at the stand-in: nobody calls setCatalogSettings
      catalogReleaseDefaults: { baseUrl: `http://127.0.0.1:${port}`, paths: v1, intervalMinutes: 5, trustedKeys: [{ keyId: KEYID, publicKey: rawKey }] },
      probe: async (h, p) => { calls.probes.push([h, p]); return h === HOME && online[p] ? { online: true, name: online[p], players: 1, maxPlayers: 10, checkedAt: 'x' } : { online: false, reason: 'No answer.', checkedAt: 'x' }; },
      tcpProbe: async (h, p) => { calls.tcp.push([h, p]); return h === HOME ? { ok: true } : { ok: false, code: 'ETIMEDOUT' }; }, ...over });
  };
  const reset = () => { calls.opened.length = 0; calls.probes.length = 0; calls.tcp.length = 0; hits.length = 0; };
  const step = () => { clock.t += 5 * 60_000 + 1000; };                                    // past every debounce / rate limit

  publish(mkCat(1));
  let svc = mk();
  ok('DISCOVERY: before any refresh the player sees the built-in list and the catalog counts as configured (nothing to type)', svc.catalogStatus().configured === true && svc.catalogStatus().source === 'builtin');
  let r = await svc.refreshCatalog('startup');
  ok('DISCOVERY: the signed catalog (base64url key + signature, public:null, lan + ports) is fetched from the configured /catalog/v1 paths and accepted', r.outcome === 'updated' && svc.catalogStatus().source === 'catalog' && svc.catalogStatus().signatureVerified === true && svc.catalogStatus().keyId === KEYID && hits.join() === '/catalog/v1/catalog,/catalog/v1/signature');
  ok('DISCOVERY: both servers appear automatically, from the catalog', svc.listServers().map((s) => s.name).join() === 'Server One,Server Two' && svc.listServers().every((s) => s.fromCatalog));
  ok('DISCOVERY: the catalog is recognised as a development catalog', svc.catalogStatus().environment === 'development');

  // connection: LAN endpoints from connection.lan, ports from connection.ports, even though connection.public is null
  reset(); let c1 = await svc.joinCheck('main'); let c2 = await svc.joinCheck('server2');
  ok('LAN: with connection.public null, the LAN endpoint + ports are used (status page and game port probed on EACH server\'s own ports)', c1.connection.scope === 'lan' && c2.connection.scope === 'lan' && calls.probes.some(([h, p]) => h === HOME && p === 8081) && calls.probes.some(([h, p]) => h === HOME && p === 8090) && calls.tcp.some(([h, p]) => h === HOME && p === 9600) && calls.tcp.some(([h, p]) => h === HOME && p === 9650));
  // required content here is the manual track, which the fixture does not contain until installed
  const fxReady = mkFx(); svc = mk({}, fxReady); await svc.refreshCatalog('startup');
  c1 = await svc.joinCheck('main');
  ok('READY: both servers are Ready to Join with complete content', c1.state === 'ready' && c1.canJoin && (await svc.joinCheck('server2')).state === 'ready');
  reset(); let j1 = await svc.join('main'); let j2 = await svc.join('server2');
  ok('JOIN: Content Manager is handed the LAN address and EACH server\'s own HTTP port (8081 for one, 8090 for the other)', j1.success && j2.success && calls.opened.join() === `acmanager://race/online/join?ip=${HOME}&httpPort=8081,acmanager://race/online/join?ip=${HOME}&httpPort=8090`);
  ok('JOIN: the result does not claim the game connected', /cannot see whether the connection then succeeds/.test(j1.note));
  ok('PRIVACY: the renderer-facing status, server list and join check never contain the LAN or catalog address', (() => { const blob = JSON.stringify([svc.catalogStatus(), svc.listServers(), c1, j1]); return !blob.includes(HOME) && !blob.includes(`127.0.0.1:${port}`) && !blob.includes('/catalog/v1'); })());
  ok('PRIVACY: the install log never contains the address', !svc.readInstallLog(200).join('\n').includes(HOME));

  // a server that is not reachable is never reported Ready; a missing item is reported as such; neither launches Content Manager
  reset(); online[8090] = undefined; let cu = await svc.joinCheck('server2'); let ju = await svc.join('server2');
  ok('SERVER UNAVAILABLE: status page not answering → Connection Unavailable (not Ready), Join blocked, Content Manager untouched', cu.state === 'unavailable' && !cu.canJoin && !ju.success && ju.stage === 'blocked' && calls.opened.length === 0);
  online[8090] = 'Server Two';
  const svcTcp = mk({ tcpProbe: async (h, p) => ({ ok: p !== 9650, code: 'ETIMEDOUT' }) }, mkFx()); await svcTcp.refreshCatalog('startup');
  ok('SERVER UNAVAILABLE: game port closed on one server only → that one is unavailable naming its port, the other stays Ready', (await svcTcp.joinCheck('server2')).state === 'unavailable' && /9650/.test((await svcTcp.joinCheck('server2')).issues[0].title) && (await svcTcp.joinCheck('main')).state === 'ready');
  const svcMiss = mk({}, (() => { const fx = mkFx(); fs.rmSync(path.join(fx.ac, 'content', 'tracks', 'trk_one'), { recursive: true }); return fx; })()); await svcMiss.refreshCatalog('startup');
  reset(); const jm = await svcMiss.join('main');
  ok('MISSING CONTENT: reported as Missing Content (distinct from unavailable), naming the item; nothing is launched', jm.check.state === 'missing' && jm.check.missing.some((m) => /Track One/.test(m.name)) && calls.opened.length === 0);

  // dashboard changes flow through the catalog: add, rename, remove (no launcher release involved)
  step(); publish(mkCat(2, { servers: [['main', 'Server One (renamed)', 9600, 8081], ['server2', 'Server Two', 9650, 8090], ['server3', 'Server Three', 9700, 8100]] }));
  r = await svc.refreshCatalog('manual');
  ok('CHANGE: a newly registered server appears and a renamed one shows its new name after a refresh', r.outcome === 'updated' && svc.listServers().map((s) => s.name).join() === 'Server One (renamed),Server Two,Server Three' && r.diff && r.diff.summary.length > 0);
  reset(); online[8100] = 'Server Three'; const c3 = await svc.joinCheck('server3'); await svc.join('server3');
  ok('CHANGE: the new server is probed on its own ports and its Join link uses them (9700 / 8100)', c3.connection.scope === 'lan' && calls.tcp.some(([h, p]) => h === HOME && p === 9700) && calls.opened[0] === `acmanager://race/online/join?ip=${HOME}&httpPort=8100`);
  step(); publish(mkCat(3, { servers: [['main', 'Server One (renamed)', 9600, 8081]] }));
  r = await svc.refreshCatalog('manual');
  ok('CHANGE: a removed server disappears from the list', r.outcome === 'updated' && svc.listServers().map((s) => s.id).join() === 'main');

  // refusals: nothing unverified is ever shown, the last good list is kept, and the reason is the right one
  const keepGood = (s) => s.listServers().map((x) => x.id).join() === 'main';
  step(); publish(mkCat(4), { sig: signWith(Buffer.from(JSON.stringify(mkCat(4)) + '\n'), other.privateKey) });
  r = await svc.refreshCatalog('manual');
  ok('INVALID SIGNATURE: signed by a key that is not the pinned one → rejected as a signature problem, last good list kept', r.outcome === 'rejected' && r.error.code === 'signature' && keepGood(svc) && svc.catalogStatus().lastError.code === 'signature');
  step(); publish(mkCat(4), { sig: signWith(Buffer.from(JSON.stringify(mkCat(4)) + '\n'), other.privateKey, 'some-other-key-id') });
  r = await svc.refreshCatalog('manual');
  ok('UNPINNED KEY ID: a key id that is not pinned is refused (never trusted because the catalog says so)', r.outcome === 'rejected' && r.error.code === 'signature' && /not one of the keys pinned/.test(r.error.message));
  step(); const tampered = Buffer.from(JSON.stringify(mkCat(4)) + '\n'); publish(mkCat(4), { raw: Buffer.from(tampered.toString().replace('Server One', 'Server Evil')), sig: signWith(tampered) });
  r = await svc.refreshCatalog('manual');
  ok('TAMPERED: bytes that differ from what was signed are refused', r.outcome === 'rejected' && r.error.code === 'signature' && keepGood(svc));
  step(); publish(mkCat(4), { sig: null });
  r = await svc.refreshCatalog('manual');
  ok('UNSIGNED: a catalog with no signature is refused (no dev bypass without the explicit local opt-in, which a player cannot reach)', r.outcome === 'rejected' && r.error.code === 'unsigned' && keepGood(svc));
  step(); publish(null, { raw: Buffer.from('<html>502 Bad Gateway</html>') });
  r = await svc.refreshCatalog('manual');
  ok('MALFORMED: something that is not JSON is refused', r.outcome === 'rejected' && r.error.code === 'malformed' && keepGood(svc));
  step(); publish(mkCat(5, { expiresAt: new Date(clock.t - 60_000).toISOString() }));
  r = await svc.refreshCatalog('manual');
  ok('STALE: an already-expired catalog is refused and the last good list is kept', r.outcome === 'rejected' && r.error.code === 'expired' && keepGood(svc));
  step(); publish(mkCat(1));
  r = await svc.refreshCatalog('manual');
  ok('ROLLBACK: an older revision is refused', r.outcome === 'rejected' && r.error.code === 'rollback' && keepGood(svc));
  step(); publish(mkCat(6, { servers: [['main', 'Server One (renamed)', 9600, 8081]] })); live.mode = 'down';
  r = await svc.refreshCatalog('manual');
  ok('UNREACHABLE: the catalog server being down is "unavailable" (a different outcome from an invalid catalog) and the last good list stays', r.outcome === 'unavailable' && r.error.code === 'http' && keepGood(svc) && svc.catalogStatus().source === 'catalog');
  live.mode = 'ok'; step(); r = await svc.refreshCatalog('manual');
  ok('RECOVERY: when the server is back the next refresh succeeds without any user action', r.outcome === 'updated' && !svc.catalogStatus().lastError);
  const tr = await (async () => { const s = mk({ catalogReleaseDefaults: { baseUrl: 'http://127.0.0.1:9', paths: v1, trustedKeys: [{ keyId: KEYID, publicKey: rawKey }] } }); return s.refreshCatalog('startup'); })();
  ok('UNREACHABLE (nothing listening): reported as a network problem, the built-in list is used', tr.outcome === 'unavailable' && ['network', 'timeout'].includes(tr.error.code));

  // a development catalog is never accepted from a public address, and a public catalog may not use plain http
  const pubSvc = mk({ catalogReleaseDefaults: { baseUrl: 'https://catalog.example.com', trustedKeys: [{ keyId: KEYID, publicKey: rawKey }] },
    catalogTransport: async (url) => ({ status: 200, headers: {}, body: url.endsWith('signature') || url.endsWith('.sig') ? Buffer.from(live.sig) : live.body }) });
  publish(mkCat(7)); const pr = await pubSvc.refreshCatalog('manual');
  ok('ENVIRONMENT: a DEVELOPMENT catalog served from a public address is refused', pr.outcome === 'rejected' && pr.error.code === 'environment');
  const bad = svc.setCatalogSettings({ baseUrl: 'http://catalog.example.com' });
  ok('POLICY: setting a public http catalog address is refused', bad.errors.length > 0 && /https/.test(bad.errors[0]));

  // ── D. developer-only gate ─────────────────────────────────────────────────────────────────────────────────────
  const full = new CatalogSettingsStore(F.mkTmp('lan-gate-'), cfg).get();
  const red = gate.redactCatalogSettings(full, false);
  ok('GATE: a player never receives the catalog address or the pinned keys', red.baseUrl === null && red.trustedKeys.length === 0 && !JSON.stringify(red).includes('192.168') && !JSON.stringify(red).includes(cfg.trustedKeys[0].publicKey) && red.installMode === full.installMode);
  ok('GATE: developer mode returns everything', gate.redactCatalogSettings(full, true) === full);
  const lim = gate.restrictCatalogPatch({ baseUrl: 'https://x.example.com', trustedKeys: [], allowUnsignedDev: true, intervalMinutes: 5, installMode: 'auto', autoServers: ['main'] }, false);
  ok('GATE: a player cannot change the address, keys, unsigned opt-in or refresh interval, and is told why; ordinary preferences still work', Object.keys(lim.patch).sort().join() === 'autoServers,installMode' && lim.errors.length === 1 && /Developer options/.test(lim.errors[0]));
  ok('GATE: developer mode passes the whole patch', Object.keys(gate.restrictCatalogPatch({ baseUrl: 'x', trustedKeys: [] }, true).patch).length === 2 && gate.restrictCatalogPatch({ baseUrl: 'x' }, true).errors.length === 0);
  const ep = gate.redactEndpoints({ lanHost: HOME, publicHostOverride: 'play.example.com', publicTcpPortOverride: 9600, publicHttpPortOverride: 8081 }, false);
  ok('GATE: per-server connection overrides are redacted for players (host names/addresses removed)', ep.lanHost === null && ep.publicHostOverride === null && gate.redactEndpoints({ lanHost: HOME }, true).lanHost === HOME);

  const main = read('src/main/main.ts'), setup = read('src/renderer/pages/AssettoCorsaSetup.tsx'), bar = read('src/renderer/components/ac/AcCatalogBar.tsx'), settings = read('src/renderer/pages/Settings.tsx'), sm = read('src/main/services/SettingsManager.ts');
  ok('WIRING: the IPC layer applies the gate to catalog settings (get + set + reset) and to the connection overrides (get + set)', /redactCatalogSettings\(acPlayerService\.getCatalogSettings\(\), developerMode\(\)\)/.test(main) && /restrictCatalogPatch\(/.test(main) && /catalog:reset', \(\) => acSafe\(\(\) => \{ if \(!developerMode\(\)\) throw/.test(main) && /redactEndpoints\(acPlayerService\.getLocalEndpoints/.test(main) && /setEndpoints[\s\S]{0,260}if \(!developerMode\(\)\) throw/.test(main));
  ok('WIRING: developerMode is a main-process setting, off by default, with a toggle in Settings', /developerMode: boolean/.test(sm) && /developerMode: false/.test(sm) && /Developer options/.test(settings) && /settings\?\.set\('developerMode'/.test(settings));
  ok('UI: Setup & Diagnostics shows the catalog panel, connection endpoints, stamp coverage and raw logs ONLY in developer mode', (setup.match(/\{developer && /g) || []).length >= 4 && /\{developer && <AcCatalogSettingsPanel/.test(setup) && /\{developer && \(\s*<Panel className="space-y-3">/.test(setup) && /\{developer && \(\s*<Panel>\s*<div className="flex items-center gap-2 mb-1">\s*<ScrollText/.test(setup));
  ok('UI: the catalog bar offers the Setup link and technical wording only in developer mode, and labels a private test list plainly otherwise', /stripView\(status, .*, developer\)/.test(bar) && /developer \? 'developer' : 'player'/.test(bar) && /TEST NETWORK/.test(bar));
  ok('UI: players can still copy redacted diagnostics', /data-testid="copy-diagnostics"/.test(setup));

  const V = loadTs('src/renderer/lib/acMercyView.ts'), J = loadTs('src/renderer/lib/acJoinView.ts');
  const codes = [['network', 'Could not reach the catalog server (ECONNREFUSED).'], ['timeout', 'x'], ['http', 'The catalog server answered HTTP 503.'], ['http', 'HTTP 404'], ['signature', 'The catalog is signed by a key that is not one of the keys pinned in Mercy Launcher.'], ['unsigned', 'x'], ['schema', 'The catalog failed validation (1 problem): servers[0].connection.public: x'], ['malformed', 'x'], ['rollback', 'x'], ['expired', 'x'], ['environment', 'x'], ['unconfigured', 'x'], ['weird', 'secret detail 192.168.1.1']];
  const playerText = codes.map(([code, message]) => V.catalogErrorHelp({ code, message }, 'player')).map((h) => `${h.title} ${h.hint}`).join(' | ');
  ok('PLAYER MESSAGES: every refresh failure gets plain wording with no settings, keys, paths, addresses or raw server text', codes.every(([code, message]) => { const h = V.catalogErrorHelp({ code, message }, 'player'); return h && h.title && h.hint; }) && !/pinn|signing key|public key|Trusted|catalog address|\/catalog|catalog\.json|192\.168|ECONN|HTTP \d{3}|secret detail|Setup & Diagnostics|Reset catalog/i.test(playerText));
  ok('PLAYER MESSAGES: unavailable, unverifiable and out-of-date lists are told apart', V.catalogErrorHelp({ code: 'network', message: 'x' }, 'player').title !== V.catalogErrorHelp({ code: 'signature', message: 'x' }, 'player').title && V.catalogErrorHelp({ code: 'signature', message: 'x' }, 'player').title !== V.catalogErrorHelp({ code: 'expired', message: 'x' }, 'player').title && /verified/.test(V.catalogErrorHelp({ code: 'signature', message: 'x' }, 'player').title));
  ok('DEVELOPER MESSAGES: the technical help is unchanged (still names the key / address to fix)', /pinned/.test(V.catalogErrorHelp({ code: 'signature', message: 'The catalog is signed by a key that is not one of the keys pinned' }).title) && /Trusted signing keys/.test(V.catalogErrorHelp({ code: 'signature', message: 'not one of the keys pinned' }).hint) && /catalog address/i.test(V.catalogErrorHelp({ code: 'unconfigured', message: 'x' }).hint));
  const S = (o) => ({ configured: true, source: 'catalog', syncing: false, environment: 'development', lastSuccessAt: '2030-06-01T11:58:00Z', lastError: null, stale: false, expired: false, ...o });
  const rel = () => '2 min ago';
  ok('STRIP: a player is never sent to the catalog settings; a developer is', ['builtin-failed', 'refresh-failed', 'unconfigured'].every((k) => { const st = k === 'builtin-failed' ? S({ source: 'builtin', lastError: { code: 'network', message: 'x', at: 'x' } }) : k === 'refresh-failed' ? S({ lastError: { code: 'http', message: 'x', at: 'x' } }) : S({ configured: false, source: 'builtin' }); return J.stripView(st, rel, false).showSetup === false && J.stripView(st, rel, true).showSetup === true; }));
  ok('STRIP: the failure is still stated plainly to a player (genuine errors are not hidden)', /Could not refresh the server list/.test(J.stripView(S({ lastError: { code: 'http', message: 'x', at: 'x' } }), rel, false).text) && /could not be loaded/.test(J.stripView(S({ source: 'builtin', lastError: { code: 'network', message: 'x', at: 'x' } }), rel, false).text));
  const uiSrc = ['src/renderer/components/ac/AcServerRow.tsx', 'src/renderer/components/ac/AcCatalogBar.tsx', 'src/renderer/pages/AssettoCorsaMercyServers.tsx'].map(read).join('\n').replace(/\/\/.*$/gm, '');
  ok('UI: no catalog address, key id, private address or LAN wording is hardcoded in the player-facing server browser', !/192\.168|10\.\d+\.\d+\.\d+|:18790|srp-ed25519|catalog\/v1/.test(uiSrc));

  fs.rmSync(ud0, { recursive: true, force: true });
  srv.close(); cleanup.forEach(F.rm);
  console.log(`\nAC LAN DISCOVERY + DEVELOPER GATE TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
