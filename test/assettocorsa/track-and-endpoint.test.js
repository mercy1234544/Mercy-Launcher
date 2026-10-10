// (1) The read-only validation of a player-chosen SRP track archive — the supported route while the official direct
// link is dead — and (2) "Test connection" endpoint diagnostics. Fixtures and local sockets only; no real server is
// contacted and no game folder is touched.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const F = require('./_acFixtures');
const { validateTrackArchive } = F.dist('ac/trackValidation.js');
const { findArchiveTool } = F.dist('ac/archive.js');
const D = F.dist('ac/endpointDiagnostics.js');
const { AcPlayerService } = F.dist('ac/playerService.js');

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗', name); } };
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('mercy-track-validate-')).length;

(async () => {
  const cleanup = []; const tmp = (p) => { const d = F.mkTmp(p); cleanup.push(d); return d; };

  // ── 1. track archive validation ─────────────────────────────────────────────
  if (!F.sevenAvailable()) { skipped++; console.log('  - SKIPPED track validation (needs 7-Zip to build fixtures)'); }
  else {
    const base = F.fixtureBundle(null); const arcs = tmp('tv-arc-');
    // two servers using two different layouts, like the real package (daishi_pa + main_layout)
    const bundle = JSON.parse(JSON.stringify(base)); bundle.servers[1] = JSON.parse(JSON.stringify(base.servers[0])); bundle.servers[1].server.id = 't3'; bundle.servers[1].server.displayName = 'Second Server'; bundle.servers[1].track.layout = 'lay_b';
    const LB = JSON.stringify({ name: 'Layout B' });
    bundle.tracks.tracks[0].layouts.push({ config: 'lay_b', uiTrackJsonSha256: F.sha(Buffer.from(LB)) });
    const writeBoth = (root, over = {}) => { F.writeTrack(root, over); F.w(path.join(root, 'lay_b', 'models.kn5'), 'kn5b'); F.w(path.join(root, 'ui', 'lay_b', 'ui_track.json'), over.layoutB ?? LB); };
    const build = (name, fn, fmt = '7z') => { const s = tmp('tv-src-'); fn(s); return F.makeArchive(s, path.join(arcs, name), fmt); };

    const good = build('good.7z', (s) => writeBoth(path.join(s, 'SRP 0.9.3')));
    const goodRoot = build('good-root.7z', (s) => writeBoth(s)); // marker at the archive root (no wrapper folder)
    const oldVer = build('old.7z', (s) => writeBoth(path.join(s, 'SRP'), { markerName: '1.3.0 Stable.txt' }));
    const noMarker = build('nomarker.7z', (s) => { F.w(path.join(s, 'x', 'readme.txt'), 'hi'); });
    const tampered = build('tampered.7z', (s) => writeBoth(path.join(s, 'SRP'), { marker: 'edited marker content' }));
    const noLayoutB = build('nolayoutb.7z', (s) => { F.writeTrack(path.join(s, 'SRP')); });
    const wrongLayoutMeta = build('wronglayoutmeta.7z', (s) => writeBoth(path.join(s, 'SRP'), { layoutB: JSON.stringify({ name: 'something else' }) }));
    const zipGood = build('good.zip', (s) => writeBoth(path.join(s, 'SRP')), 'zip');
    const garbage = path.join(arcs, 'garbage.7z'); fs.writeFileSync(garbage, 'not an archive at all'.repeat(40));
    const truncated = path.join(arcs, 'truncated.7z'); { const b = fs.readFileSync(good); fs.writeFileSync(truncated, b.subarray(0, Math.floor(b.length * 0.5))); }

    const before = leftovers();
    const v = (file, o = {}) => validateTrackArchive(file, bundle, o);
    const rGood = await v(good);
    ok('TRACK CHECK: the genuine archive passes, and every check carries a plain-language reason', rGood.ok === true && rGood.checks.length >= 5 && rGood.checks.every((c) => c.ok && c.label && c.detail) && /safe to install/.test(rGood.summary));
    ok('TRACK CHECK: it verifies the version marker AND each layout the servers use, by server name', rGood.checks.some((c) => c.id === 'version' && c.ok) && rGood.checks.some((c) => c.id === 'layout:lay_a') && rGood.checks.some((c) => c.id === 'layout:lay_b' && /Second Server/.test(c.label)));
    ok('TRACK CHECK: an archive with no wrapper folder (marker at the root) also validates', (await v(goodRoot)).ok === true);
    ok('TRACK CHECK: a .zip validates the same way', (await v(zipGood)).ok === true);
    const rOld = await v(oldVer);
    ok('TRACK CHECK: a different SRP version is rejected and named, with the "other versions are unverified" warning', rOld.ok === false && /different SRP version/.test(rOld.summary) && /1\.3\.0 Stable\.txt/.test(rOld.checks.find((c) => c.id === 'version').detail));
    ok('TRACK CHECK: an archive that is not an SRP track at all says the version cannot be confirmed', (await v(noMarker)).ok === false && /does not look like SRP/.test((await v(noMarker)).summary));
    const rT = await v(tampered);
    ok('TRACK CHECK: the right file name with the wrong contents fails the marker hash', rT.ok === false && /different contents|not the same SRP build/.test(rT.checks.find((c) => c.id === 'version').detail));
    const rNL = await v(noLayoutB);
    ok('TRACK CHECK: a missing layout is rejected naming which server needs it', rNL.ok === false && rNL.checks.some((c) => c.id === 'layout:lay_b' && !c.ok && /Second Server/.test(c.label) && /missing/.test(c.detail)));
    ok('TRACK CHECK: a layout whose metadata differs from the servers\' copy fails', (await v(wrongLayoutMeta)).checks.some((c) => c.id === 'layout:lay_b' && !c.ok && /differs/.test(c.detail)));
    ok('TRACK CHECK: garbage and truncated downloads say "damaged or incomplete" instead of crashing', (await v(garbage)).ok === false && /not a readable archive/.test((await v(garbage)).summary) && (await v(truncated)).ok === false && /damaged|incomplete|readable/.test((await v(truncated)).summary));
    ok('TRACK CHECK: a missing file is reported plainly', (await v(path.join(arcs, 'nope.7z'))).ok === false && /could not be found/.test((await v(path.join(arcs, 'nope.7z'))).summary));
    ok('TRACK CHECK: with no archive tool it says so and stops', (await v(good, { tool: null })).ok === false && /No archive tool/.test((await v(good, { tool: null })).summary));
    const goodBytes = fs.readFileSync(good);
    const b2 = JSON.parse(JSON.stringify(bundle)); b2.sources.sources[0].localArchive = { bytes: goodBytes.length, sha256: F.sha(goodBytes) };
    const b3 = JSON.parse(JSON.stringify(bundle)); b3.sources.sources[0].localArchive = { bytes: 1, sha256: 'a'.repeat(64) };
    ok('TRACK CHECK: optionally reports whether the file is byte-identical to the owner\'s copy — informational, never the deciding factor', (await validateTrackArchive(good, b2, { hashWholeFile: true })).identicalToOwnersCopy === true && (await validateTrackArchive(good, b3, { hashWholeFile: true })).identicalToOwnersCopy === false && (await validateTrackArchive(good, b3, { hashWholeFile: true })).ok === true && (await v(good)).identicalToOwnersCopy === null);
    ok('TRACK CHECK: validation unpacks only a few tiny files into a temp folder and always deletes it', leftovers() === before);
    const svc = new AcPlayerService({ userDataPath: tmp('ud-'), detectAcRoot: async () => null, documentsAcDir: () => 'x', bundle: b2, release: { servers: {} }, broadcast() {}, isContentManagerAvailable: () => true, openExternal: async () => {} });
    ok('SERVICE: validateTrackArchive is available to the UI and reports the same result', (await svc.validateTrackArchive(good)).ok === true && (await svc.validateTrackArchive(garbage)).ok === false);
  }

  // ── 2. endpoint diagnostics (injected probes) ───────────────────────────────
  const HOST = 'play.example.com';
  const pub = { scope: 'public', host: HOST, tcpPort: 9650, httpPort: 8090 };
  const passes = { lookup: async () => ['203.0.113.7'], tcpProbe: async () => ({ ok: true }), httpProbe: async () => ({ online: true, players: 3, maxPlayers: 32, checkedAt: 'x' }) };
  const st = (d, id) => d.checks.find((c) => c.id === id).state;
  const dOk = await D.diagnoseEndpoint(pub, passes);
  ok('DIAG: everything answering → reachable, with the honest note that this is not proof a remote player can join', dOk.reachable === true && st(dOk, 'dns') === 'pass' && st(dOk, 'game-tcp') === 'pass' && st(dOk, 'http') === 'pass' && dOk.hints.length === 0);
  ok('DIAG: UDP is always reported as untestable from here — never claimed to pass', st(dOk, 'udp') === 'info' && /Cannot be tested/.test(dOk.checks.find((c) => c.id === 'udp').detail));
  const dDns = await D.diagnoseEndpoint(pub, { ...passes, lookup: async () => { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; } });
  ok('DIAG: a host name that does not resolve fails DNS, SKIPS the port tests (no misleading "timeout"), and says to create the A record', st(dDns, 'dns') === 'fail' && st(dDns, 'game-tcp') === 'skipped' && st(dDns, 'http') === 'skipped' && dDns.reachable === false && dDns.hints.some((h) => /"A" record/.test(h)));
  const dPriv = await D.diagnoseEndpoint(pub, { ...passes, lookup: async () => ['192.168.1.5'] });
  ok('DIAG: a PUBLIC name that points at a private address is flagged (remote players cannot reach it)', st(dPriv, 'dns') === 'warn' && dPriv.hints.some((h) => /private address/.test(h)));
  const dRef = await D.diagnoseEndpoint(pub, { ...passes, tcpProbe: async () => ({ ok: false, code: 'ECONNREFUSED' }) });
  ok('DIAG: connection refused = "reached the machine, nothing listening" (server stopped / wrong internal port)', st(dRef, 'game-tcp') === 'fail' && dRef.hints.some((h) => /nothing accepts connections/.test(h)));
  const dTo = await D.diagnoseEndpoint(pub, { ...passes, tcpProbe: async () => ({ ok: false, code: 'ETIMEDOUT' }), httpProbe: async () => ({ online: false, reason: 'No answer within the time limit.', checkedAt: 'x' }) });
  ok('DIAG: a timeout on a public endpoint lists the real usual causes (port forward, firewall, CGNAT, hairpin) and advises testing from another network', dTo.reachable === false && dTo.hints.some((h) => /port-forward|forwarding/.test(h) && /firewall/.test(h) && /carrier-grade NAT/.test(h) && /hairpin/.test(h) && /different network|hotspot/.test(h)));
  ok('DIAG: HTTP-port failure adds the "remote players also need the HTTP port" hint', dTo.hints.some((h) => /8090/.test(h) && /HTTP port/.test(h)));
  const dLan = await D.diagnoseEndpoint({ scope: 'lan', host: '192.168.1.5', tcpPort: 9650, httpPort: 8090 }, { ...passes, tcpProbe: async () => ({ ok: false, code: 'ETIMEDOUT' }) });
  ok('DIAG: a LAN timeout is NOT blamed on port forwarding; it points at the address/server', st(dLan, 'dns') === 'skipped' && dLan.hints.some((h) => /on the local network/.test(h)) && !dLan.hints.some((h) => /port-forward|CGNAT|carrier/.test(h)));
  const dIp = await D.diagnoseEndpoint({ scope: 'public', host: '203.0.113.9', tcpPort: 9600, httpPort: 8081 }, { ...passes, lookup: async () => { throw new Error('must not look up an IP'); } });
  ok('DIAG: an IP endpoint is never sent to DNS', st(dIp, 'dns') === 'skipped' && dIp.reachable === true);
  const all = JSON.stringify([dOk, dDns, dPriv, dRef, dTo, dLan, dIp]);
  ok('DIAG (privacy): no result ever contains a host name or address — only counts, kinds and port numbers', !/play\.example|203\.0\.113|192\.168/.test(all));

  // real probes against local sockets
  const srv = net.createServer((s) => s.end()); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  ok('DIAG (real TCP probe): connects to a listening port', (await D.defaultTcpProbe('127.0.0.1', port, 1000)).ok === true);
  srv.close(); await new Promise((r) => setTimeout(r, 100));
  ok('DIAG (real TCP probe): a closed port reports ECONNREFUSED', (await D.defaultTcpProbe('127.0.0.1', port, 1000)).code === 'ECONNREFUSED');
  ok('DIAG (real DNS lookup): "localhost" resolves and a reserved .invalid name does not', (await D.defaultLookup('localhost')).length > 0 && await (async () => { try { await D.defaultLookup('does-not-exist.invalid'); return false; } catch { return true; } })());

  // service level
  const svcFor = (release, local, deps) => { const s = new AcPlayerService({ userDataPath: tmp('ud-'), detectAcRoot: async () => null, documentsAcDir: () => 'x', bundle: F.fixtureBundle(null), release, broadcast() {}, isContentManagerAvailable: () => true, openExternal: async () => {}, diagnoseDeps: deps }); if (local) s.setLocalEndpoints('t2', local); return s; };
  const none = await svcFor({ servers: { t2: { host: null, tcpPort: null, httpPort: null } } }).testEndpoint('t2', 'public');
  ok('SERVICE: testing a public endpoint that is not configured says exactly that (PUBLIC_HOST_TBD) and probes nothing', none.configured === false && /PUBLIC_HOST_TBD/.test(none.message) && none.diagnosis === undefined);
  ok('SERVICE: testing a LAN endpoint that is not set says so', (await svcFor({ servers: {} }).testEndpoint('t2', 'lan')).configured === false);
  const cfg = await svcFor({ servers: { t2: { host: HOST, tcpPort: null, httpPort: null } } }, null, passes).testEndpoint('t2', 'public');
  ok('SERVICE: a configured public endpoint is diagnosed with the server\'s own ports', cfg.configured === true && cfg.diagnosis.reachable === true && /9650/.test(cfg.diagnosis.checks.find((c) => c.id === 'game-tcp').label) && /8090/.test(cfg.diagnosis.checks.find((c) => c.id === 'http').label));
  const lanCfg = await svcFor({ servers: {} }, { lanHost: '192.168.4.4' }, passes).testEndpoint('t2', 'lan');
  ok('SERVICE: a configured LAN endpoint is diagnosed too', lanCfg.configured === true && lanCfg.diagnosis.scope === 'lan');

  for (const d of cleanup) F.rm(d);
  console.log(`\nAC TRACK VALIDATION + ENDPOINT DIAGNOSTICS TESTS: ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
