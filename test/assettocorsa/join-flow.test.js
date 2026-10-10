// The join flow, end to end in the main process: endpoint handling, the three readiness states, exact missing items,
// whether Join is allowed, and whether Content Manager is REALLY invoked (with the right server's address and port).
// Everything is disposable: a fixture game folder, injected probes, and a fake Content Manager hand-off (openExternal).
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const F = require('./_acFixtures');
const { buildJoinCheck, identityMatches } = F.dist('ac/joinCheck.js');
const { AcPlayerService } = F.dist('ac/playerService.js');
const { buildContentStatus } = F.dist('ac/contentStatus.js');
const { sha256Hex } = F.dist('ac/catalogSigning.js');
const { bundleToCatalog } = F.dist('ac/catalogAdapter.js');
const { getBundledSrpBundle } = F.dist('AcSrpBundle.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };
const LAN = '192.168.55.10', PUB = 'play.example.com', HOME = '192.168.77.20';

// ── pure builder ────────────────────────────────────────────────────────────────
const row = (id, kind, o = {}) => ({ id, kind, name: o.name ?? id, required: o.required ?? true, state: o.state ?? 'installed', detail: o.detail ?? '', planItemId: o.planItemId, action: o.action, blocked: o.blocked });
const content = (rows) => ({ serverId: 's', rows, counts: {}, requiredNotReady: 0 });
const GOOD_ROWS = [row('ac-install', 'game'), row('csp-installed', 'csp'), row('csp-version', 'csp'), row('car:a', 'car', { name: 'Car A', planItemId: 'car:a', action: 'install' }), row('track', 'track', { name: 'Track One' })];
const EP = { scope: 'public', host: PUB, tcpPort: 9650, httpPort: 8090 };
const base = (o = {}) => ({
  serverId: 's', serverName: 'SRP Traffic', content: content(GOOD_ROWS), endpoints: { serverId: 's', lan: null, public: EP, publicSource: 'release', problems: [] }, chosen: EP, chosenReason: 'Using the public address.',
  info: { online: true, players: 3, maxPlayers: 32, name: 'SRP Traffic ℹ8090', track: 'shuto_revival_project_beta-main_layout', checkedAt: 'x' }, tcp: { ok: true },
  contentManager: { available: true, exePath: 'C:/cm/Content Manager.exe', exeExists: true }, source: 'catalog', catalogHostIsPrivate: false, portsKnown: true,
  expectedTrack: { trackId: 'shuto_revival_project_beta', layout: 'main_layout' }, ...o,
});
const st = (o) => buildJoinCheck(base(o));
const has = (c, id) => c.issues.some((i) => i.id === id);

ok('identity: AssettoServer appends text to its name, the match still works', identityMatches('SRP Traffic ℹ8090', 'SRP Traffic') === 'match' && identityMatches('SRP Daishi PA', 'srp daishi pa') === 'match');
ok('identity: a different server is a mismatch; unknown when it gives no name', identityMatches('Some Other Server', 'SRP Traffic') === 'mismatch' && identityMatches(undefined, 'SRP Traffic') === 'unknown');

let c = st();
ok('READY: address + status page + right server + open game port + everything installed → Ready to Join, canJoin', c.state === 'ready' && c.headline === 'Ready to Join' && c.canJoin === true && c.issues.filter((i) => i.severity === 'blocker').length === 0);
ok('READY never claims more than it checked: the join is still flagged unverified', c.unverified === true);
ok('READY exposes the live player count from the server itself', c.connection.players === 3 && c.connection.maxPlayers === 32 && c.connection.identity === 'match' && c.connection.gamePortTcp === 'open');

// connection problems: files on disk never make an unreachable server "ready"
c = st({ info: { online: false, reason: 'No answer within the time limit.', checkedAt: 'x' }, tcp: { ok: false, code: 'ETIMEDOUT' } });
ok('UNAVAILABLE: complete content but the server does not answer → Connection Unavailable, cannot join', c.state === 'unavailable' && c.headline === 'Connection Unavailable' && !c.canJoin && has(c, 'server-offline'));
ok('...and the reason is shown without an address', /No answer within the time limit/.test(c.issues[0].detail) && !JSON.stringify(c).includes(PUB));
c = st({ tcp: { ok: false, code: 'ETIMEDOUT' } });
ok('UNAVAILABLE: status page answers but the game port does not (the SRP Traffic situation) → names the port and the firewall', c.state === 'unavailable' && has(c, 'game-port-closed') && /9650/.test(c.issues[0].title) && /firewall/.test(c.issues[0].detail) && /TCP and UDP/.test(c.issues[0].detail));
c = st({ tcp: { ok: false, code: 'ECONNREFUSED' } });
ok('UNAVAILABLE: a refused game port says nothing is listening', has(c, 'game-port-closed') && /nothing accepts connections/.test(c.issues[0].detail));
c = st({ info: { online: true, name: 'Some Other Server', players: 0, maxPlayers: 10, checkedAt: 'x' } });
ok('UNAVAILABLE: an address that is a DIFFERENT server is blocked (never join the wrong server)', c.state === 'unavailable' && has(c, 'wrong-server') && /different server/.test(c.issues[0].title) && c.connection.identity === 'mismatch');
c = st({ chosen: null, endpoints: { serverId: 's', lan: null, public: null, publicSource: 'none', problems: [] }, info: null, tcp: null, portsKnown: false });
ok('UNAVAILABLE: no address → says exactly which server-side fields are missing (connection.public and connection.ports)', c.state === 'unavailable' && has(c, 'no-endpoint') && /connection\.public/.test(c.issues[0].detail) && /connection\.ports/.test(c.issues[0].detail) && c.connection.configured === false);
ok('...and without an address nothing else is probed or claimed', c.connection.infoOnline === null && c.connection.gamePortTcp === 'untested' && !c.canAdoptHost);
c = st({ chosen: null, endpoints: { serverId: 's', lan: null, public: null, publicSource: 'none', problems: [] }, info: null, tcp: null, catalogHostIsPrivate: true, portsKnown: true });
ok('no address + the catalog is served from a private address + ports known → offers the verified home-network option', c.canAdoptHost === true && c.issues[0].fix.kind === 'adopt-host' && /home network/.test(c.issues[0].fix.label));
c = st({ chosen: null, endpoints: { serverId: 's', lan: null, public: null, publicSource: 'none', problems: [] }, info: null, tcp: null, catalogHostIsPrivate: true, portsKnown: false });
ok('...but not when the ports are unknown (nothing to verify against)', c.canAdoptHost === false && c.issues[0].fix.kind === 'setup');
c = st({ chosen: null, endpoints: { serverId: 's', lan: null, public: null, publicSource: 'none', problems: [] }, info: null, tcp: null, source: 'builtin' });
ok('no address from the BUILT-IN list is explained as such', /built into this version/.test(c.issues[0].detail));

// this PC: game, Content Manager, CSP, content
c = st({ content: content([row('ac-install', 'game', { state: 'missing', detail: 'Assetto Corsa was not found.' }), ...GOOD_ROWS.slice(1)]) });
ok('MISSING: Assetto Corsa not found → Missing Content with that item', c.state === 'missing' && has(c, 'game') && c.headline === 'Missing Content');
c = st({ contentManager: { available: false, exePath: null, exeExists: null } });
ok('MISSING: Content Manager not registered → blocked with how to fix it', c.state === 'missing' && has(c, 'content-manager') && /Content Manager/.test(c.issues[0].detail));
c = st({ contentManager: { available: true, exePath: 'C:/gone/Content Manager.exe', exeExists: false } });
ok('MISSING: Content Manager registered but its file is gone → the launch path is invalid, blocked', c.state === 'missing' && has(c, 'content-manager-path'));
c = st({ content: content([...GOOD_ROWS.slice(0, 1), row('csp-installed', 'csp', { state: 'missing', detail: 'dwrite.dll missing.' }), ...GOOD_ROWS.slice(3)]) });
ok('MISSING: Custom Shaders Patch missing → blocked, and it says the launcher never installs it', c.state === 'missing' && c.issues[0].kind === 'csp' && /never installs or updates/.test(c.issues[0].detail));
c = st({ content: content([...GOOD_ROWS.slice(0, 3), row('csp-version', 'csp', { state: 'outdated', detail: 'CSP 0.1.0 is older than 0.1.76.' })].concat(GOOD_ROWS.slice(3))) });
ok('MISSING: Custom Shaders Patch too old → blocked', c.state === 'missing' && /too old/.test(c.issues[0].title));
c = st({ content: content([...GOOD_ROWS.slice(0, 4), row('car:b', 'car', { name: 'Car B', state: 'missing', planItemId: 'car:b', action: 'install' }), row('track', 'track', { name: 'Track One', state: 'missing', planItemId: 'track', action: 'install' })]) });
ok('MISSING: lists the EXACT missing items and offers the download path that exists', c.state === 'missing' && c.missing.map((m) => m.name).join() === 'Car B,Track One' && c.issues[0].fix.kind === 'install' && c.issues[0].fix.planItemIds.join() === 'car:b,track');
c = st({ content: content([...GOOD_ROWS.slice(0, 4), row('car:b', 'car', { name: 'Car B', state: 'manual', planItemId: 'car:b', action: 'manual', blocked: 'No download is configured.' })]) });
ok('MISSING: when no legitimate download is configured it says so instead of offering one', c.state === 'missing' && c.issues[0].fix.kind === 'manual' && c.missing[0].installable === false);
c = st({ content: content([...GOOD_ROWS, row('car:opt', 'car', { name: 'Optional', required: false, state: 'missing', planItemId: 'car:opt', action: 'install' })]) });
ok('an OPTIONAL missing item is listed but does not block joining', c.state === 'ready' && c.missing.some((m) => m.name === 'Optional' && !m.required));
c = st({ tcp: { ok: false, code: 'ETIMEDOUT' }, content: content([...GOOD_ROWS.slice(0, 4), row('car:b', 'car', { name: 'Car B', state: 'missing', planItemId: 'car:b', action: 'install' })]) });
ok('PRIORITY: a connection problem wins over missing content, but BOTH are listed (connection first)', c.state === 'unavailable' && c.issues[0].kind === 'connection' && c.issues.some((i) => i.kind === 'content'));
c = st({ info: { online: true, name: 'SRP Traffic', players: 0, maxPlayers: 32, track: 'some_other_track-layout', checkedAt: 'x' } });
ok('a track the server reports that differs from the catalog is only a note; it does not block', c.state === 'ready' && c.issues.some((i) => i.id === 'track-differs' && i.severity === 'note'));

// ── service: real flow with fakes ───────────────────────────────────────────────
(async () => {
  const cleanup = []; const tmp = (p) => { const d = F.mkTmp(p); cleanup.push(d); return d; };
  const bundle = F.fixtureBundle(null);
  const release = { servers: { t2: { host: PUB, tcpPort: null, httpPort: null } } };
  const readyFx = () => {
    const fx = F.emptyAcInstall(); cleanup.push(fx.base);
    F.writeCar(path.join(fx.ac, 'content', 'cars'), 'car_a'); F.writeCar(path.join(fx.ac, 'content', 'cars'), 'car_b');
    F.w(path.join(fx.ac, 'content', 'cars', 'base_car', 'ui', 'ui_car.json'), '{}'); F.writeTrack(path.join(fx.ac, 'content', 'tracks', 'test_track'));
    return fx;
  };
  const calls = { opened: [], probes: [], tcp: [] };
  const mk = (fx, over = {}) => new AcPlayerService({
    userDataPath: tmp('ud-'), detectAcRoot: async () => fx.ac, documentsAcDir: () => fx.docs, bundle, release, broadcast() {},
    isContentManagerAvailable: () => true, contentManagerExe: () => 'C:/cm/Content Manager.exe', openExternal: async (u) => { calls.opened.push(u); },
    probe: async (h, p) => { calls.probes.push([h, p]); return { online: true, players: 4, maxPlayers: 32, name: 'Fixture Traffic', checkedAt: 'x' }; },
    tcpProbe: async (h, p) => { calls.tcp.push([h, p]); return { ok: true }; },
    isGameRunning: async () => false, resolver: async () => ['203.0.113.7'], ...over });
  const reset = () => { calls.opened.length = 0; calls.probes.length = 0; calls.tcp.length = 0; };

  // contentManagerExe → existsSync only for real files; the fixture says it exists via a temp file
  const cmExe = path.join(tmp('cm-'), 'Content Manager.exe'); fs.writeFileSync(cmExe, 'x');

  // READY → join really hands the right link to Content Manager
  reset(); let svc = mk(readyFx(), { contentManagerExe: () => cmExe });
  let chk = await svc.joinCheck('t2');
  ok('SERVICE: everything in order → Ready to Join, with the live player count', chk.state === 'ready' && chk.canJoin && chk.connection.players === 4 && chk.connection.scope === 'public');
  ok('SERVICE: the game port (TCP) of the SAME server is tested, and its status page', calls.tcp.some(([h, p]) => h === PUB && p === 9650) && calls.probes.some(([h, p]) => h === PUB && p === 8090));
  reset(); let r = await svc.join('t2');
  ok('JOIN: Content Manager is invoked exactly once, with the public host and the server\'s HTTP port', r.success && r.stage === 'handed-off' && calls.opened.length === 1 && calls.opened[0] === `acmanager://race/online/join?ip=${PUB}&httpPort=8090`);
  ok('JOIN: the result does not claim the game connected', /cannot see whether the connection then succeeds/.test(r.note) && !/connected successfully/i.test(r.note));
  ok('JOIN: the install log says it was handed over, without the address', (() => { const l = svc.readInstallLog(50).join('\n'); return /join link handed to Content Manager/.test(l) && !l.includes(PUB); })());

  // never joins while any check fails
  reset(); svc = mk(readyFx(), { contentManagerExe: () => cmExe, probe: async () => ({ online: false, reason: 'Connection refused (server not running, or the HTTP port is closed).', checkedAt: 'x' }), tcpProbe: async () => ({ ok: false, code: 'ECONNREFUSED' }) });
  r = await svc.join('t2');
  ok('JOIN BLOCKED: complete files but an unreachable server → not ready, Content Manager is NOT invoked', !r.success && r.stage === 'blocked' && calls.opened.length === 0 && r.check.state === 'unavailable');
  ok('...with a useful message for the player', /not answering/.test(r.error));

  reset(); svc = mk(readyFx(), { contentManagerExe: () => cmExe, tcpProbe: async () => ({ ok: false, code: 'ETIMEDOUT' }) });
  r = await svc.join('t2');
  ok('JOIN BLOCKED: status page up but game port closed → blocked, nothing launched, message names the port', !r.success && calls.opened.length === 0 && /9650/.test(r.error));

  reset(); svc = mk(readyFx(), { contentManagerExe: () => cmExe, probe: async () => ({ online: true, name: 'A Different Server', players: 1, maxPlayers: 5, checkedAt: 'x' }) });
  r = await svc.join('t2');
  ok('JOIN BLOCKED: the address answers as a different server → blocked', !r.success && calls.opened.length === 0 && /different server/.test(r.error));

  reset(); const fxM = readyFx(); fs.rmSync(path.join(fxM.ac, 'content', 'cars', 'car_b'), { recursive: true });
  svc = mk(fxM, { contentManagerExe: () => cmExe }); r = await svc.join('t2');
  ok('JOIN BLOCKED: missing required car → state Missing Content naming the car; nothing launched', !r.success && r.check.state === 'missing' && r.check.missing.some((m) => /Fixture Car B/.test(m.name)) && calls.opened.length === 0);

  reset(); svc = mk(readyFx(), { contentManagerExe: () => cmExe, isContentManagerAvailable: () => false }); r = await svc.join('t2');
  ok('JOIN BLOCKED: Content Manager not registered → blocked, with the reason', !r.success && /Content Manager/.test(r.error) && calls.opened.length === 0);
  reset(); svc = mk(readyFx(), { contentManagerExe: () => path.join(path.dirname(cmExe), 'moved.exe') }); r = await svc.join('t2');
  ok('JOIN BLOCKED: Content Manager\'s registered file no longer exists → blocked', !r.success && r.check.issues.some((i) => i.id === 'content-manager-path') && calls.opened.length === 0);
  reset(); svc = mk(readyFx(), { contentManagerExe: () => cmExe, detectAcRoot: async () => null }); r = await svc.join('t2');
  ok('JOIN BLOCKED: Assetto Corsa not found → blocked', !r.success && r.check.issues.some((i) => i.id === 'game') && calls.opened.length === 0);

  // the hand-off itself fails → reported honestly, with a retry path
  reset(); svc = mk(readyFx(), { contentManagerExe: () => cmExe, openExternal: async () => { throw new Error('No application is associated with the specified file for this operation'); } });
  r = await svc.join('t2');
  ok('JOIN FAILED to launch: the OS refuses the link → success=false, stage "launch", a message the player can act on', !r.success && r.stage === 'launch' && /Content Manager could not be opened/.test(r.error));
  reset(); svc = mk(readyFx(), { contentManagerExe: () => cmExe }); await svc.join('t2'); const again = await svc.join('t2');
  ok('RETRY: joining again works and invokes Content Manager again', again.success && calls.opened.length === 2);

  // LAN vs public
  reset(); svc = mk(readyFx(), { contentManagerExe: () => cmExe }); svc.setLocalEndpoints('t2', { lanHost: LAN });
  chk = await svc.joinCheck('t2'); r = await svc.join('t2');
  ok('LAN: a reachable LAN address is preferred, and the link points at it with the right port', chk.connection.scope === 'lan' && calls.opened[calls.opened.length - 1] === `acmanager://race/online/join?ip=${LAN}&httpPort=8090`);
  reset(); svc = mk(readyFx(), { contentManagerExe: () => cmExe, probe: async (h, p) => { calls.probes.push([h, p]); return h === LAN ? { online: false, reason: 'x', checkedAt: 'x' } : { online: true, name: 'Fixture Traffic', players: 1, maxPlayers: 32, checkedAt: 'x' }; } }); svc.setLocalEndpoints('t2', { lanHost: LAN });
  ok('LAN: when the LAN address does not answer, the public address is used', (await svc.joinCheck('t2')).connection.scope === 'public');
  ok('the renderer-facing check never contains an address', !JSON.stringify(await svc.joinCheck('t2')).includes(PUB) && !JSON.stringify(await svc.joinCheck('t2')).includes(LAN));

  // no address at all
  reset(); svc = mk(readyFx(), { contentManagerExe: () => cmExe, release: { servers: { t2: { host: null, tcpPort: null, httpPort: null } } } });
  chk = await svc.joinCheck('t2'); r = await svc.join('t2');
  ok('NO ADDRESS: Connection Unavailable, no probe is sent anywhere, nothing is launched', chk.state === 'unavailable' && chk.issues[0].id === 'no-endpoint' && calls.probes.length === 0 && calls.opened.length === 0 && !r.success);

  // ── the REAL situation: a signed catalog with no public address and no ports ────────────────────────────────
  const real = getBundledSrpBundle();
  const doc = bundleToCatalog(real, { generatedAt: new Date(Date.now() - 3600_000).toISOString(), revision: 1 });
  doc.catalog.id = 'srp';
  for (const s of doc.servers) { s.connection = { public: null }; }          // exactly what the Linux catalog publishes today
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const body = Buffer.from(JSON.stringify(doc) + '\n');
  const sig = JSON.stringify({ alg: 'ed25519', keyId: 'k1', signedAt: new Date().toISOString(), catalogSha256: sha256Hex(body), signature: crypto.sign(null, body, privateKey).toString('base64') });
  const transport = async (url) => (url.endsWith('catalog.json') ? { status: 200, headers: {}, body } : url.endsWith('.sig') ? { status: 200, headers: {}, body: Buffer.from(sig) } : { status: 404, headers: {}, body: Buffer.alloc(0) });
  const INFO = { 8081: { name: 'SRP Daishi PA', players: 0, maxPlayers: 14 }, 8090: { name: 'SRP Traffic ℹ8090', players: 1, maxPlayers: 170 } };
  const mkReal = (extra = {}) => {
    const fx = F.emptyAcInstall(); cleanup.push(fx.base);
    const s = new AcPlayerService({ userDataPath: tmp('ud-'), detectAcRoot: async () => fx.ac, documentsAcDir: () => fx.docs, broadcast() {}, isContentManagerAvailable: () => true, contentManagerExe: () => cmExe,
      openExternal: async (u) => { calls.opened.push(u); }, isGameRunning: async () => false, resolver: async () => [],
      catalogTransport: transport, catalogSleep: async () => {}, catalogReleaseDefaults: {},
      probe: async (h, p) => { calls.probes.push([h, p]); const i = INFO[p]; return i && h === HOME ? { online: true, ...i, checkedAt: 'x' } : { online: false, reason: 'No answer.', checkedAt: 'x' }; },
      tcpProbe: async (h, p) => { calls.tcp.push([h, p]); return p === 9650 ? { ok: false, code: 'ETIMEDOUT' } : { ok: true }; }, ...extra });
    s.setCatalogSettings({ baseUrl: `http://${HOME}:18790/`, trustedKeys: [{ keyId: 'k1', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }] });
    return { s, fx };
  };
  reset(); const R1 = mkReal(); await R1.s.refreshCatalog('manual');
  ok('REAL SITUATION: the signed catalog (no public address, no ports) is accepted; both servers are listed from it', R1.s.catalogStatus().source === 'catalog' && R1.s.listServers().map((x) => x.name).join() === 'SRP Daishi PA,SRP Traffic');
  chk = await R1.s.joinCheck('main');
  ok('REAL SITUATION: with no address the check says so, and offers the verified home-network option because the ports are known', chk.state === 'unavailable' && chk.issues[0].id === 'no-endpoint' && chk.canAdoptHost === true);
  ok('REAL SITUATION: the ports are NOT lost when the catalog replaces the built-in list (kept from the package for the same server id)', (() => { const e = R1.s.getLocalEndpoints('main'); return !!e && true; })() && !chk.issues[0].detail.includes('connection.ports'));
  reset(); const adopt = await R1.s.adoptCatalogHost();
  ok('ADOPT: the catalog\'s private host is used as THIS PC\'s LAN address only for servers whose own status page answers there with the right name', adopt.host && adopt.results.every((x) => x.adopted) && adopt.results.length === 2 && calls.probes.some(([h, p]) => h === HOME && p === 8081) && calls.probes.some(([h, p]) => h === HOME && p === 8090));
  ok('ADOPT: it is stored locally as a LAN address, never as a public one', R1.s.getLocalEndpoints('main').lanHost === HOME && R1.s.getLocalEndpoints('main').publicHostOverride === null);
  reset(); const cMain = await R1.s.joinCheck('main'); const cTraf = await R1.s.joinCheck('server2');
  ok('SRP Daishi PA: connection is fine (status page + game port 9600), so the only thing left is content → Missing Content', cMain.state === 'missing' && cMain.connection.gamePortTcp === 'open' && cMain.connection.infoOnline === true && cMain.connection.scope === 'lan');
  ok('SRP Traffic: game port 9650 does not answer → Connection Unavailable, and the message says which port the owner must open', cTraf.state === 'unavailable' && cTraf.connection.gamePortTcp === 'closed' && cTraf.issues[0].id === 'game-port-closed' && /9650/.test(cTraf.issues[0].title));
  ok('each server is probed on ITS OWN ports (8081/9600 and 8090/9650)', calls.probes.some(([, p]) => p === 8081) && calls.probes.some(([, p]) => p === 8090) && calls.tcp.some(([, p]) => p === 9600) && calls.tcp.some(([, p]) => p === 9650));
  reset(); const jr = await R1.s.join('server2');
  ok('JOIN on the unreachable server does nothing', !jr.success && jr.stage === 'blocked' && calls.opened.length === 0);
  ok('the two servers are told apart: different names, AI traffic, slots', (() => { const [a, b] = R1.s.listServers(); return a.aiTraffic === 0 && b.aiTraffic === 138 && a.maxPlayers === 14 && b.maxPlayers === 32; })());

  // adopting never uses a wrong server / a non-private catalog
  const R2 = mkReal({ probe: async (h, p) => ({ online: true, name: 'Not the SRP server', players: 0, maxPlayers: 5, checkedAt: 'x' }) }); await R2.s.refreshCatalog('manual');
  const adopt2 = await R2.s.adoptCatalogHost();
  ok('ADOPT refuses when what answers is not the expected server', adopt2.results.every((x) => !x.adopted && /not this server/.test(x.reason)) && R2.s.getLocalEndpoints('main').lanHost === null);
  const R3 = mkReal(); R3.s.setCatalogSettings({ baseUrl: 'https://catalog.example.com/ac/' });
  ok('ADOPT does nothing for a public catalog address', (await R3.s.adoptCatalogHost()).host === false);

  cleanup.forEach(F.rm);
  console.log(`\nAC JOIN FLOW TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
