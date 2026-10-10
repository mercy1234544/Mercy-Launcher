// Endpoint handling (LAN for the owner, public for everyone) + SRP Board stamping + log redaction, and the
// release-facing privacy guarantees: no private LAN address may exist anywhere the app ships.
const fs = require('fs'), path = require('path');
const F = require('./_acFixtures');
const ep = F.dist('ac/endpoints.js');
const tpl = F.dist('ac/srpBoardTemplate.js');
const { getBundledSrpBundle } = F.dist('AcSrpBundle.js');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗', name); } };
const real = getBundledSrpBundle();
const [mainReq, server2Req] = real.servers;
const rel = (host) => ({ servers: { main: { host, tcpPort: null, httpPort: null }, server2: { host, tcpPort: null, httpPort: null } } });

(async () => {
  // ── 1. embedded template == the package's release, byte for byte ──────────
  for (const f of real.boardRelease.files) {
    const name = f.path.replace('apps/lua/srp_board/', '');
    const buf = Buffer.from(tpl.SRP_BOARD_TEMPLATE_B64[name], 'base64');
    ok(`TEMPLATE: embedded ${name} matches the package release sha256`, F.sha(buf) === f.sha256);
  }
  ok('TEMPLATE: the embedded version equals the release version', tpl.SRP_BOARD_TEMPLATE_VERSION === real.boardRelease.version);
  const tv = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/main/data/assettocorsa-srp/COMPANION_APPS/srp_board/srp_board_release.json'), 'utf8')).stamping.testVector;
  const tplLua = Buffer.from(tpl.SRP_BOARD_TEMPLATE_B64['srp_board.lua'], 'base64').toString('latin1');
  ok('STAMP: reproduces the package\'s official stamping test vector exactly (same bytes as stamp-srp-board.js)', F.sha(Buffer.from(ep.stampLua(tplLua, tv.servers), 'latin1')) === tv.stampedSrpBoardLuaSha256);
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  ok('STAMP: an empty list, a bad entry, a bad port, and an already-stamped file are all refused', throws(() => ep.stampLua(tplLua, [])) && throws(() => ep.stampLua(tplLua, ['bad host:1'])) && throws(() => ep.stampLua(tplLua, ['a.b:70000'])) && throws(() => ep.stampLua(ep.stampLua(tplLua, ['a.b:1']), ['c.d:2'])));
  ok('STAMP: several entries are written lower-cased in order', /^local SERVERS = \{ 'a\.b:1', 'c\.d:2' \}/m.test(ep.stampLua(tplLua, ['A.B:1', 'c.d:2'])));

  // ── 2. host validation ────────────────────────────────────────────────────
  ok('HOST: a public endpoint cannot be a private or loopback address', !ep.validateHost('192.168.1.5', 'public').ok && !ep.validateHost('10.1.2.3', 'public').ok && !ep.validateHost('127.0.0.1', 'public').ok && ep.validateHost('play.example.com', 'public').ok && ep.validateHost('203.0.113.7', 'public').ok);
  ok('HOST: the LAN field takes a private address or local name but refuses a public IP', ep.validateHost('192.168.1.5', 'lan').ok && ep.validateHost('mypc', 'lan').ok && !ep.validateHost('203.0.113.7', 'lan').ok);
  ok('HOST: schemes, ports, spaces and empty input are rejected with a message', !ep.validateHost('http://x.com', 'public').ok && !ep.validateHost('x.com:9600', 'public').ok && !ep.validateHost('a b', 'public').ok && !ep.validateHost('', 'public').ok && typeof ep.validateHost('', 'public').error === 'string');
  ok('HOST: input is trimmed and lower-cased', ep.validateHost('  Play.Example.COM ', 'public').host === 'play.example.com');

  // ── 3. resolving endpoints for the two real SRP servers ───────────────────
  const rNone = ep.resolveEndpoints(mainReq, rel(null), ep.EMPTY_LOCAL);
  ok('RESOLVE: with the shipped release data (host null) there is NO public endpoint and the problem says exactly what is missing', rNone.public === null && rNone.publicSource === 'none' && rNone.problems.some((p) => /PUBLIC_HOST_TBD/.test(p)));
  const shipped = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/main/data/assettocorsa-srp/endpoints.public.json'), 'utf8'));
  ok('RESOLVE: the release file really ships with every public host null — nothing invented', Object.values(shipped.servers).every((s) => s.host === null) && ep.resolveEndpoints(server2Req, shipped, ep.EMPTY_LOCAL).public === null);
  const rRel = ep.resolveEndpoints(mainReq, rel('play.example.com'), ep.EMPTY_LOCAL);
  ok('RESOLVE: a release host uses each server\'s own ports from its requirements (Server 1: 9600/8081, Server 2: 9650/8090)', rRel.public.tcpPort === 9600 && rRel.public.httpPort === 8081 && ep.resolveEndpoints(server2Req, rel('play.example.com'), ep.EMPTY_LOCAL).public.tcpPort === 9650 && ep.resolveEndpoints(server2Req, rel('play.example.com'), ep.EMPTY_LOCAL).public.httpPort === 8090);
  const rOv = ep.resolveEndpoints(mainReq, rel('play.example.com'), { ...ep.EMPTY_LOCAL, publicHostOverride: 'other.example.net', publicTcpPortOverride: 19600 });
  ok('RESOLVE: a local override wins over the release host and can remap the public port', rOv.public.host === 'other.example.net' && rOv.public.tcpPort === 19600 && rOv.publicSource === 'local-override');
  const rBadRel = ep.resolveEndpoints(mainReq, rel('192.168.0.9'), ep.EMPTY_LOCAL);
  ok('RESOLVE: a private address smuggled into the release file is rejected, not used', rBadRel.public === null && rBadRel.problems.some((p) => /Release public endpoint is invalid/.test(p)));
  const rLan = ep.resolveEndpoints(mainReq, rel(null), { ...ep.EMPTY_LOCAL, lanHost: '192.168.9.9' });
  ok('RESOLVE: a LAN address exists only when the local settings hold one, and uses the server\'s own ports', rLan.lan.host === '192.168.9.9' && rLan.lan.tcpPort === 9600 && rLan.lan.httpPort === 8081 && rNone.lan === null);

  // ── 4. stamp planning ─────────────────────────────────────────────────────
  const resolver = async () => ['203.0.113.7', '203.0.113.8'];
  const both = ep.resolveEndpoints(server2Req, rel('play.example.com'), { ...ep.EMPTY_LOCAL, lanHost: '192.168.9.9' });
  const sp = await ep.planStamp(both, resolver);
  ok('STAMP PLAN: hostname + every resolved IPv4 + the local LAN entry (the package design\'s "stamp what CSP might report")', JSON.stringify(sp.entries) === JSON.stringify(['play.example.com:9650', '203.0.113.7:9650', '203.0.113.8:9650', '192.168.9.9:9650']));
  ok('STAMP PLAN: the description shows origin + kind + port only — never an address', JSON.stringify(sp.described) === JSON.stringify([{ origin: 'public-host', kind: 'hostname', port: 9650 }, { origin: 'public-resolved-ip', kind: 'public-ip', port: 9650 }, { origin: 'public-resolved-ip', kind: 'public-ip', port: 9650 }, { origin: 'lan', kind: 'private-lan', port: 9650 }]) && !/play\.example|203\.0|192\.168/.test(JSON.stringify(sp.described)));
  const spPublic = await ep.planStamp(ep.resolveEndpoints(server2Req, rel('play.example.com'), ep.EMPTY_LOCAL), resolver);
  ok('STAMP PLAN (privacy): a remote player (no LAN setting) never gets a LAN entry', spPublic.entries.length === 3 && !spPublic.entries.some((e) => e.startsWith('192.168')));
  const spIpHost = await ep.planStamp(ep.resolveEndpoints(server2Req, rel('203.0.113.50'), ep.EMPTY_LOCAL), async () => { throw new Error('should not resolve an IP'); });
  ok('STAMP PLAN: an IP public host is stamped as-is and never sent to DNS', JSON.stringify(spIpHost.entries) === '["203.0.113.50:9650"]');
  const spDnsFail = await ep.planStamp(ep.resolveEndpoints(server2Req, rel('play.example.com'), ep.EMPTY_LOCAL), async () => { throw new Error('ENOTFOUND'); });
  ok('STAMP PLAN: if DNS is down it still stamps the name and tells the player to re-run when online', spDnsFail.entries.length === 1 && spDnsFail.warnings.some((w) => /could not be resolved/.test(w)));
  const spNone = await ep.planStamp(rNone, resolver);
  ok('STAMP PLAN: with nothing configured there is nothing to stamp, with a warning', spNone.entries.length === 0 && spNone.warnings.some((w) => /Nothing to stamp/.test(w)));
  const files = ep.buildSrpBoardFiles(sp.entries);
  ok('STAMP PLAN → FILES: the generated lua differs from the template only in its server list; manifest and icon are untouched', files['manifest.ini'].equals(Buffer.from(tpl.SRP_BOARD_TEMPLATE_B64['manifest.ini'], 'base64')) && files['icon.png'].equals(Buffer.from(tpl.SRP_BOARD_TEMPLATE_B64['icon.png'], 'base64')) && files['srp_board.lua'].toString('latin1').replace(/^local SERVERS = \{.*\}/m, 'local SERVERS = { }') === tplLua);
  ok('COVERAGE: stampCoversEndpoints reports exactly which endpoint kind is missing from a stamp', JSON.stringify(ep.stampCoversEndpoints(['play.example.com:9650'], [both.public, both.lan]).missing) === '[{"scope":"lan","port":9650}]' && ep.stampCoversEndpoints(sp.entries, [both.public, both.lan]).covered);

  // ── 5. choosing where to join + the join link ─────────────────────────────
  ok('JOIN: prefers the LAN endpoint when it answers (router hairpin NAT is not guaranteed)', ep.chooseJoinEndpoint(both, true).endpoint.scope === 'lan');
  ok('JOIN: falls back to the public endpoint when the LAN one does not answer', ep.chooseJoinEndpoint(both, false).endpoint.scope === 'public' && /did not answer/.test(ep.chooseJoinEndpoint(both, false).reason));
  ok('JOIN: a remote player (no LAN) is sent to the public endpoint', ep.chooseJoinEndpoint(ep.resolveEndpoints(server2Req, rel('play.example.com'), ep.EMPTY_LOCAL), null).endpoint.scope === 'public');
  const noneJoin = ep.chooseJoinEndpoint(rNone, null);
  ok('JOIN: with nothing configured there is no endpoint and the reason says the owner must assign a public host', noneJoin.endpoint === null && /PUBLIC_HOST_TBD/.test(noneJoin.reason));
  ok('JOIN: only a LAN address configured → that is used but flagged as having no public endpoint', ep.chooseJoinEndpoint(rLan, null).endpoint.scope === 'lan' && /no public endpoint yet/.test(ep.chooseJoinEndpoint(rLan, null).reason));
  ok('JOIN LINK: builds the Content Manager acmanager:// online-join URL from host + HTTP port (format not yet verified end-to-end)', ep.buildJoinUrl({ scope: 'public', host: 'play.example.com', tcpPort: 9650, httpPort: 8090 }) === 'acmanager://race/online/join?ip=play.example.com&httpPort=8090');

  // ── 6. redaction ──────────────────────────────────────────────────────────
  const red = ep.redactForLog('[SRP Board] v1.0.0 loaded; servers: 192.168.9.9:9650, play.example.com:9650, 203.0.113.7:9650 and 127.0.0.1', ['play.example.com']);
  ok('REDACT: private, public and loopback addresses and configured host names are removed from log text', !/192\.168|203\.0|127\.0|play\.example/.test(red) && /\[lan-ip\]/.test(red) && /\[ip\]/.test(red) && /\[host\]/.test(red) && /\[loopback\]/.test(red));
  ok('REDACT: ports and surrounding text survive so a mismatch is still diagnosable', /:9650/.test(red) && /SRP Board/.test(red));

  // ── 7. local settings live in userData only ───────────────────────────────
  const ud = F.mkTmp('mercy-userdata-'); const store = new ep.LocalEndpointStore(ud);
  ok('STORE: an invalid LAN value (public IP) is refused and nothing is written', store.set('main', { lanHost: '203.0.113.7' }).success === false && !fs.existsSync(path.join(ud, 'ac-endpoints.json')));
  ok('STORE: a private public-override and out-of-range ports are refused', store.set('main', { publicHostOverride: '192.168.1.1' }).success === false && store.set('main', { publicTcpPortOverride: 70000 }).success === false);
  ok('STORE: valid settings persist (atomically) in userData and reload', store.set('main', { lanHost: '192.168.9.9', publicHostOverride: 'play.example.com' }).success && new ep.LocalEndpointStore(ud).get('main').lanHost === '192.168.9.9' && !fs.existsSync(path.join(ud, 'ac-endpoints.json.tmp')));
  ok('STORE: settings are per server', new ep.LocalEndpointStore(ud).get('server2').lanHost === null);
  F.rm(ud);

  // ── 8. RELEASE-FACING PRIVACY: no private address anywhere the app ships ──
  const PRIV = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;
  const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/node_modules/.test(p)) walk(p, out); } else out.push(p); } return out; };
  const srcRoot = path.resolve(__dirname, '../../src');
  const hits = walk(srcRoot).filter((f) => /\.(ts|tsx|json|md|css|html)$/.test(f) && PRIV.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(srcRoot, f));
  ok('PRIVACY (guard): the scan really covered the codebase (more than 100 source/data files, including the SRP data folder)', walk(srcRoot).filter((f) => /\.(ts|tsx|json)$/.test(f)).length > 100 && walk(srcRoot).some((f) => /assettocorsa-srp/.test(f)));
  ok('PRIVACY: no private LAN address literal exists in any source or data file that ships with the app', hits.length === 0 || (console.log('     found in:', hits), false));
  ok('PRIVACY: the embedded SRP Board template is the inert one (no server addresses) and the shipped data holds no private address', parseBoard(tplLua).length === 0 && !PRIV.test(JSON.stringify(real)) && !PRIV.test(JSON.stringify(shipped)));
  function parseBoard(lua) { const m = /^local SERVERS = \{(.*)\}/m.exec(lua); return m ? Array.from(m[1].matchAll(/'([^']+)'/g)) : null; }

  console.log(`\nAC ENDPOINT TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
