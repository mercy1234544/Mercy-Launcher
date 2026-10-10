// First install and UPDATE from an older release: the catalog must come from the release configuration with nothing typed,
// and a settings file written by an older build (an empty address saved as null) must never switch it off.
// Root cause this guards against (v1.109.0): an old build's settings panel saved {"baseUrl": null, "trustedKeys": []} when its
// address box was blank; that explicit null overrode the new release default, so the app never contacted the catalog and showed
// the built-in "No server address yet" list. Everything here is synthetic: a loopback HTTP server stands in for the catalog host.
const crypto = require('crypto'), fs = require('fs'), http = require('http'), path = require('path'), Module = require('module'), ts = require('typescript');
function loadTs(rel) {
  const prev = Module._extensions['.ts'];
  Module._extensions['.ts'] = (mod, filename) => { mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true } }).outputText, filename); };
  try { const p = path.resolve(__dirname, '../..', rel); delete require.cache[p]; return require(p); } finally { Module._extensions['.ts'] = prev; }
}
const F = require('./_acFixtures');
const { validCatalog } = require('./_catalogFixtures');
const { AcPlayerService } = F.dist('ac/playerService.js');
const { CatalogSettingsStore } = F.dist('ac/catalogSync.js');
const { sha256Hex } = F.dist('ac/catalogSigning.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
const HOME = '192.168.77.20', PUB = 'play.example.com';
const cfg = JSON.parse(read('src/main/data/assettocorsa-srp/catalog.config.json'));
const FILE = 'ac-catalog-settings.json';
const cleanup = []; const tmp = (p) => { const d = F.mkTmp(p); cleanup.push(d); return d; };
const put = (ud, text) => fs.writeFileSync(path.join(ud, FILE), typeof text === 'string' ? text : JSON.stringify(text));

(async () => {
  // ── 1. first installation: the shipped defaults apply, nothing to type ────────────────────────────────────────────
  const fresh = new CatalogSettingsStore(tmp('up-fresh-'), cfg).get();
  ok('FIRST INSTALL: the catalog address, endpoint paths, interval and pinned PUBLIC key come from the release config', fresh.baseUrl === cfg.baseUrl && fresh.paths.catalog === cfg.paths.catalog && fresh.intervalMinutes === cfg.intervalMinutes && fresh.trustedKeys.length === 1 && fresh.trustedKeys[0].keyId === cfg.trustedKeys[0].keyId);

  // ── 2. UPDATE from a build that saved an empty address (the real failure) ──────────────────────────────────────────
  const legacy = [
    ['the exact file the old panel wrote when Save was pressed with empty boxes', '{\n  "trustedKeys": [],\n  "baseUrl": null\n}'],
    ['an empty-string address', { baseUrl: '', trustedKeys: [] }],
    ['only the keys list, no address', { trustedKeys: [] }],
    ['an empty object', {}],
    ['a whitespace-only address', { baseUrl: '   ' }],
    ['an address that is not a valid URL', { baseUrl: 'not a url', trustedKeys: [] }],
    ['an address that policy refuses (public http)', { baseUrl: 'http://catalog.example.com', trustedKeys: [] }],
    ['a corrupt (non-JSON) file', '{ this is not json'],
  ];
  for (const [label, content] of legacy) {
    const ud = tmp('up-legacy-'); put(ud, content);
    const s = new CatalogSettingsStore(ud, cfg).get();
    ok(`UPDATE: ${label} → the release address and pinned key still apply`, s.baseUrl === cfg.baseUrl && s.trustedKeys.some((k) => k.keyId === cfg.trustedKeys[0].keyId) && s.paths.catalog === cfg.paths.catalog);
  }
  {
    const ud = tmp('up-prefs-'); put(ud, { baseUrl: null, trustedKeys: [], installMode: 'auto', autoServers: ['main'], autoUpdateExisting: true });
    const before = fs.readFileSync(path.join(ud, FILE), 'utf8'); const s = new CatalogSettingsStore(ud, cfg).get();
    ok('UPDATE: saved preferences (install mode, keep-ready list, replace-existing) survive while the address falls back to the release value', s.installMode === 'auto' && s.autoServers.join() === 'main' && s.autoUpdateExisting === true && s.baseUrl === cfg.baseUrl);
    ok('UPDATE: reading the settings never rewrites or deletes the user\'s file', fs.readFileSync(path.join(ud, FILE), 'utf8') === before);
  }

  // ── 3. overrides: honoured only for a developer; ordinary players always run the release config ────────────────────
  const custom = { baseUrl: 'http://10.9.8.7:19000', trustedKeys: [{ keyId: 'dev-key', publicKey: cfg.trustedKeys[0].publicKey }], installMode: 'auto' };
  { const ud = tmp('up-ovr-'); put(ud, custom);
    const dev = new CatalogSettingsStore(ud, cfg, () => true).get(), ply = new CatalogSettingsStore(ud, cfg, () => false).get();
    ok('OVERRIDE (developer mode on): a saved custom address and key are kept, and the release key stays pinned alongside', dev.baseUrl === custom.baseUrl && dev.trustedKeys.some((k) => k.keyId === 'dev-key') && dev.trustedKeys.some((k) => k.keyId === cfg.trustedKeys[0].keyId));
    ok('OVERRIDE (developer mode off): a stale saved address/key can never hide the release catalog from an ordinary player; preferences still apply', ply.baseUrl === cfg.baseUrl && !ply.trustedKeys.some((k) => k.keyId === 'dev-key') && ply.installMode === 'auto'); }
  { const ud = tmp('up-clear-'); const st = new CatalogSettingsStore(ud, cfg); st.set({ baseUrl: 'http://10.9.8.7:19000', installMode: 'auto' });
    ok('OVERRIDE: a developer-saved address is used', st.get().baseUrl === 'http://10.9.8.7:19000');
    st.set({ baseUrl: null });
    const onDisk = JSON.parse(fs.readFileSync(path.join(ud, FILE), 'utf8'));
    ok('CLEARING the address means "use the release default": the key is removed from the file (never saved as null) and other preferences are kept', st.get().baseUrl === cfg.baseUrl && !('baseUrl' in onDisk) && onDisk.installMode === 'auto');
    st.set({ baseUrl: '' }); ok('CLEARING with an empty string behaves the same', st.get().baseUrl === cfg.baseUrl); }
  { const s = new CatalogSettingsStore(tmp('up-nodef-'), {}); s.set({ baseUrl: null }); ok('with NO release default (a build that ships none) clearing leaves the catalog unconfigured', s.get().baseUrl === null); }

  // ── 4. the real app flow from the legacy file: fetch, verify, import, resolve LAN endpoints ────────────────────────
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); const rawKey = publicKey.export({ format: 'jwk' }).x;
  const live = { body: null, sig: null, mode: 'ok' }; const hits = [];
  const sign = (b, k = privateKey) => JSON.stringify({ alg: 'ed25519', keyId: 'up-key', signedAt: '2030-06-01T11:59:00Z', catalogSha256: sha256Hex(b), signature: crypto.sign(null, b, k).toString('base64url') });
  const publish = (cat, o = {}) => { const b = o.raw ?? Buffer.from(JSON.stringify(cat) + '\n'); live.body = b; live.sig = o.sig === undefined ? sign(b) : o.sig; };
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (live.mode === 'down') { res.writeHead(503); return res.end(); }
    if (req.url === '/catalog/v1/catalog') { res.writeHead(200); return res.end(live.body); }
    if (req.url === '/catalog/v1/signature') { if (live.sig === null) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(live.sig); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const clock = { t: Date.parse('2030-06-01T12:00:00Z') };
  const mkCat = (rev, servers) => validCatalog((c) => {
    c.catalog.id = 'up'; c.catalog.revision = rev; c.catalog.environment = 'development'; c.catalog.generatedAt = new Date(clock.t - 3600_000).toISOString(); c.archives = [];
    c.content.cars = [{ id: 'ks_base', name: 'Base Car', version: null, origin: { kind: 'base-game' }, identity: { dataAcdSha256: null, uiCarJsonSha256: null } }];
    c.content.tracks = [{ id: 'trk_one', name: 'Track One', version: '1', origin: { kind: 'manual', instructions: 'by hand' }, verify: null, layouts: [{ config: '' }] }];
    c.servers = servers.map(([id, name, game, http, conn]) => ({ id, displayName: name, description: 't', engine: { type: 'kunos-stock' }, maxPlayers: 10, connection: conn, tracks: [{ trackId: 'trk_one', layouts: [''] }], cars: [{ carId: 'ks_base', role: 'player' }], requirements: { csp: { required: true, minimumVersion: '0.1.76' } }, companionApps: [] }));
  });
  const LAN = (game, http) => ({ public: null, ports: { gamePort: game, httpPort: http }, lan: { host: HOME, gamePort: game, httpPort: http } });
  const calls = { opened: [] }; const online = { 8081: 'Server One', 8090: 'Server Two', 8100: 'Public Three' };
  const cmExe = path.join(tmp('up-cm-'), 'Content Manager.exe'); fs.writeFileSync(cmExe, 'x');
  const flag = { dev: false };
  const mk = (ud, over = {}) => { const fx = F.emptyAcInstall(); cleanup.push(fx.base); F.w(path.join(fx.ac, 'content', 'cars', 'ks_base', 'ui', 'ui_car.json'), '{}'); F.writeTrack(path.join(fx.ac, 'content', 'tracks', 'trk_one'));
    return new AcPlayerService({ userDataPath: ud, detectAcRoot: async () => fx.ac, documentsAcDir: () => fx.docs, broadcast() {}, isContentManagerAvailable: () => true, contentManagerExe: () => cmExe,
      openExternal: async (u) => { calls.opened.push(u); }, isGameRunning: async () => false, resolver: async () => ['203.0.113.7'], catalogNow: () => new Date(clock.t), catalogSleep: async () => {}, catalogRandom: () => 0.5,
      catalogReleaseDefaults: { ...cfg, baseUrl: `http://127.0.0.1:${port}`, trustedKeys: [{ keyId: 'up-key', publicKey: rawKey }] }, catalogAllowOverride: () => flag.dev,
      probe: async (h, p) => (online[p] && (h === HOME || h === PUB) ? { online: true, name: online[p], players: 0, maxPlayers: 10, checkedAt: 'x' } : { online: false, reason: 'No answer.', checkedAt: 'x' }),
      tcpProbe: async (h) => (h === HOME || h === PUB ? { ok: true } : { ok: false, code: 'ETIMEDOUT' }), ...over }); };

  publish(mkCat(1, [['main', 'Server One', 9600, 8081, LAN(9600, 8081)], ['server2', 'Server Two', 9650, 8090, LAN(9650, 8090)]]));
  const udUpd = tmp('up-app-'); put(udUpd, '{\n  "trustedKeys": [],\n  "baseUrl": null\n}');
  const unrelated = { 'mercy-settings.json': '{"minimizeToTray":true,"autoUpdate":true}', 'ac-player-settings.json': '{"acRootOverride":null}', 'mercy-theme.json': '{"x":1}' };
  for (const [n, t] of Object.entries(unrelated)) fs.writeFileSync(path.join(udUpd, n), t);
  const svc = mk(udUpd);
  ok('UPDATE (end to end): with the legacy settings file the catalog is CONFIGURED before the first refresh', svc.catalogStatus().configured === true);
  let r = await svc.refreshCatalog('startup');
  ok('UPDATE (end to end): the app contacts the catalog on the documented paths, the signature verifies against the pinned key, and the catalog is accepted', r.outcome === 'updated' && hits.join() === '/catalog/v1/catalog,/catalog/v1/signature' && svc.catalogStatus().signatureVerified === true && svc.catalogStatus().source === 'catalog' && svc.catalogStatus().keyId === 'up-key');
  ok('UPDATE (end to end): both servers appear from the catalog, not the built-in list', svc.listServers().map((s) => s.name).join() === 'Server One,Server Two' && svc.listServers().every((s) => s.fromCatalog));
  ok('UPDATE (end to end): unrelated launcher configuration in the profile is untouched', Object.entries(unrelated).every(([n, t]) => fs.readFileSync(path.join(udUpd, n), 'utf8') === t));
  const c1 = await svc.joinCheck('main'), c2 = await svc.joinCheck('server2');
  ok('LAN SERVERS: a catalog LAN address is a valid address (not "no public address"): both resolve to the LAN endpoint, answer as the right server, with open game ports', [c1, c2].every((c) => c.connection.configured && c.connection.scope === 'lan' && c.connection.infoOnline === true && c.connection.identity === 'match' && c.connection.gamePortTcp === 'open') && !c1.issues.some((i) => i.id === 'no-endpoint'));
  ok('LAN SERVERS: they are flagged as reachable only from the same network (lanOnly), never as internet-accessible', c1.connection.lanOnly === true && c2.connection.lanOnly === true);
  ok('LAN SERVERS: the renderer-facing check contains no address', !JSON.stringify([c1, c2, svc.catalogStatus(), svc.listServers()]).includes(HOME));

  // ── 5. public vs LAN-only, missing address, and the other failure modes ────────────────────────────────────────────
  step(); publish(mkCat(2, [['main', 'Server One', 9600, 8081, LAN(9600, 8081)], ['pub3', 'Public Three', 9700, 8100, { public: { host: PUB, gamePort: 9700, httpPort: 8100 } }], ['nowhere', 'No Address', 9800, 8200, { public: null }]]));
  r = await svc.refreshCatalog('manual');
  ok('MIXED CATALOG accepted (LAN-only, public-only and address-less servers together)', r.outcome === 'updated' && svc.listServers().length === 3);
  const cm = await svc.joinCheck('main'), cp = await svc.joinCheck('pub3'), cn = await svc.joinCheck('nowhere');
  ok('PUBLIC server: uses the public address and is NOT flagged LAN-only', cp.connection.scope === 'public' && cp.connection.lanOnly === false);
  ok('LAN-only server in the same catalog is flagged LAN-only', cm.connection.lanOnly === true && cm.connection.scope === 'lan');
  ok('MISSING ADDRESS: a server with no public, ports or lan is Connection Unavailable, says why, is never Ready and Join does nothing', cn.state === 'unavailable' && cn.connection.configured === false && cn.connection.lanOnly === false && cn.issues[0].id === 'no-endpoint' && !cn.canJoin && !(await svc.join('nowhere')).success && calls.opened.length === 0);
  const jp = await svc.join('pub3');
  ok('JOIN uses each server\'s own host and HTTP port (public host for the public server)', jp.success && calls.opened[0] === `acmanager://race/online/join?ip=${PUB}&httpPort=8100`);
  const J = loadTs('src/renderer/lib/acJoinView.ts');
  ok('LAN-only: the details say so in plain words; a public server\'s details do not', J.connectionLines(cm).some((l) => /no public internet address yet/.test(l) && /same network/.test(l)) && !J.connectionLines(cp).some((l) => /no public internet address/.test(l)) && J.connectionLines(cm).every((l) => !l.includes(HOME)));

  step(); publish(mkCat(3, [['main', 'Server One', 9600, 8081, LAN(9600, 8081)]]), { sig: sign(Buffer.from('other bytes'), privateKey) });
  r = await svc.refreshCatalog('manual'); ok('INVALID SIGNATURE: refused; the last good list stays', r.outcome === 'rejected' && r.error.code === 'signature' && svc.listServers().length === 3);
  step(); publish(null, { raw: Buffer.from('<html>oops</html>') }); r = await svc.refreshCatalog('manual'); ok('MALFORMED: refused; the last good list stays', r.outcome === 'rejected' && r.error.code === 'malformed' && svc.listServers().length === 3);
  step(); live.mode = 'down'; publish(mkCat(4, [['main', 'Server One', 9600, 8081, LAN(9600, 8081)]])); r = await svc.refreshCatalog('manual');
  ok('UNAVAILABLE catalog: reported as unavailable (not as a bad catalog); the last good list stays', r.outcome === 'unavailable' && svc.listServers().length === 3 && svc.catalogStatus().source === 'catalog');
  live.mode = 'ok';
  function step() { clock.t += 5 * 60_000 + 1000; }

  // ── 6. toggling Developer options re-evaluates which settings apply ────────────────────────────────────────────────
  const udDev = tmp('up-dev-'); put(udDev, { baseUrl: `http://127.0.0.1:${port}/nowhere`, trustedKeys: [] });   // a stale developer override pointing at a dead path
  step(); publish(mkCat(5, [['main', 'Server One', 9600, 8081, LAN(9600, 8081)]]));
  const sd = mk(udDev); flag.dev = false;
  r = await sd.refreshCatalog('startup'); ok('STALE OVERRIDE ignored for a player: the release catalog loads anyway', r.outcome === 'updated' && sd.listServers().length === 1 && sd.catalogStatus().source === 'catalog');
  flag.dev = true; sd.catalogOverrideChanged(); await new Promise((x) => setTimeout(x, 300));
  ok('DEVELOPER OPTIONS on: the saved override is now what is used (and a bad one is reported honestly, not hidden)', sd.getCatalogSettings().baseUrl.endsWith('/nowhere'));
  flag.dev = false; sd.catalogOverrideChanged();
  ok('DEVELOPER OPTIONS off again: back to the release address', !sd.getCatalogSettings().baseUrl.endsWith('/nowhere'));

  // ── 7. wiring in the real app ──────────────────────────────────────────────────────────────────────────────────────
  const main = read('src/main/main.ts'), view = read('src/renderer/lib/acJoinView.ts');
  ok('WIRING: the app passes the Developer-options switch to the catalog store and re-evaluates when it is toggled', /catalogAllowOverride: \(\) => settingsManager\.get\('developerMode'\) === true/.test(main) && /key === 'developerMode'\) acPlayerService\?\.catalogOverrideChanged\(\)/.test(main));
  ok('WIRING: the details view says when a server is LAN-only', /c\.lanOnly/.test(view) && /only be joined from the same network/.test(view));

  srv.close(); cleanup.forEach(F.rm);
  console.log(`\nAC CATALOG UPGRADE + LAN-ONLY TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
