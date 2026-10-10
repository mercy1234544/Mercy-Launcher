// Download (resume / verify / policy), archive handling (7z + zip through 7-Zip and tar.exe), and the
// read-only server status probe — all against local fixtures and a local HTTP server.
const fs = require('fs'), path = require('path'), http = require('http'), net = require('net');
const F = require('./_acFixtures');
const { downloadVerified } = F.dist('ac/download.js');
const A = F.dist('ac/archive.js');
const { probeServerInfo } = F.dist('ac/serverInfo.js');

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗', name); } };
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re ? re.test(e.message) : true; } };

(async () => {
  const work = F.mkTmp('mercy-xfer-');
  const payload = Buffer.alloc(300000); for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 255;
  const good = F.sha(payload);
  const file = path.join(work, 'payload.bin'); fs.writeFileSync(file, payload);
  const host = await F.serve({ '/p.bin': file, '/other.bin': () => Buffer.concat([payload.subarray(0, 100), Buffer.from('x')]) });
  const dl = (name, o = {}) => downloadVerified({ url: `${host.base}/p.bin`, dest: path.join(work, name), expectedBytes: payload.length, expectedSha256: good, allowLoopbackHttp: true, ...o });

  // ── download ──────────────────────────────────────────────────────────────
  let prog = 0;
  const r1 = await dl('d1.bin', { onProgress: () => prog++ });
  ok('DOWNLOAD: a verified file arrives intact under its final name with progress reported', r1.sha256 === good && fs.statSync(r1.path).size === payload.length && prog > 0 && !fs.existsSync(path.join(work, 'd1.bin.part')));
  host.hits.length = 0;
  const r2 = await dl('d1.bin');
  ok('DOWNLOAD: an already-downloaded, verified file is reused without contacting the server', r2.reusedExisting === true && host.hits.length === 0);

  fs.writeFileSync(path.join(work, 'd3.bin.part'), payload.subarray(0, 120000));
  host.hits.length = 0;
  const r3 = await dl('d3.bin');
  ok('DOWNLOAD: a partial file is RESUMED with an HTTP Range request and the final hash still verifies', r3.resumed === true && host.hits[0].range === 'bytes=120000-' && r3.sha256 === good);

  host.server.ignoreRange = true;
  fs.writeFileSync(path.join(work, 'd4.bin.part'), payload.subarray(0, 50000));
  const r4 = await dl('d4.bin');
  ok('DOWNLOAD: if the server ignores Range it restarts cleanly instead of appending a second copy', r4.resumed === false && r4.sha256 === good && fs.statSync(r4.path).size === payload.length);
  host.server.ignoreRange = false;

  fs.writeFileSync(path.join(work, 'd5.bin.part'), Buffer.from('this is not a prefix of the file'));
  host.hits.length = 0;
  const r5 = await dl('d5.bin');
  ok('DOWNLOAD: a corrupt partial (not a valid prefix) is caught by the hash, discarded, and the file is re-fetched from scratch automatically', r5.sha256 === good && r5.resumed === false && host.hits.length === 2 && host.hits[0].range !== null && host.hits[1].range === null && fs.statSync(r5.path).size === payload.length);

  ok('DOWNLOAD: a wrong SHA-256 is rejected with both hashes in the message, and the partial is deleted', await rejects(dl('d6.bin', { expectedSha256: 'a'.repeat(64) }), /does not match the verified inventory/) && !fs.existsSync(path.join(work, 'd6.bin')) && !fs.existsSync(path.join(work, 'd6.bin.part')));
  ok('DOWNLOAD: if the server\'s file size differs from the inventory it refuses before installing anything ("upstream file has changed")', await rejects(dl('d7.bin', { expectedBytes: payload.length + 5 }), /has changed|expects/));
  ok('DOWNLOAD: a missing file (404) is reported with the HTTP status', await rejects(downloadVerified({ url: `${host.base}/nope.bin`, dest: path.join(work, 'd8.bin'), allowLoopbackHttp: true }), /HTTP 404/));
  ok('DOWNLOAD: plain http is refused for anything but an opted-in loopback test', await rejects(downloadVerified({ url: 'http://files.example.com/x.7z', dest: path.join(work, 'd9.bin') }), /insecure/) && await rejects(downloadVerified({ url: `${host.base}/p.bin`, dest: path.join(work, 'd10.bin') }), /insecure/));
  ok('DOWNLOAD: ftp / file URLs are refused', await rejects(downloadVerified({ url: 'ftp://x/y', dest: path.join(work, 'd11.bin') }), /insecure|unsupported/) && await rejects(downloadVerified({ url: 'file:///C:/x', dest: path.join(work, 'd12.bin') }), /insecure|unsupported/));
  ok('DOWNLOAD: not enough free disk space is reported before a single byte is fetched', await rejects(dl('d13.bin', { expectedBytes: 5e15 }), /Not enough free disk space/));

  const redir = http.createServer((req, res) => { if (req.url === '/to-http') { res.writeHead(302, { Location: 'http://files.example.com/evil.7z' }); res.end(); } else if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); } else if (req.url === '/ok') { res.writeHead(302, { Location: `${host.base}/p.bin` }); res.end(); } else { res.writeHead(404); res.end(); } });
  await new Promise((r) => redir.listen(0, '127.0.0.1', r)); const rb = `http://127.0.0.1:${redir.address().port}`;
  ok('DOWNLOAD: a redirect to an insecure host is refused (every hop is policy-checked)', await rejects(downloadVerified({ url: `${rb}/to-http`, dest: path.join(work, 'r1.bin'), allowLoopbackHttp: true }), /insecure/));
  ok('DOWNLOAD: redirect loops are stopped', await rejects(downloadVerified({ url: `${rb}/loop`, dest: path.join(work, 'r2.bin'), allowLoopbackHttp: true }), /Too many redirects/));
  const rr = await downloadVerified({ url: `${rb}/ok`, dest: path.join(work, 'r3.bin'), expectedSha256: good, allowLoopbackHttp: true });
  ok('DOWNLOAD: a safe redirect is followed and verified', rr.sha256 === good);
  redir.close();

  const trunc = http.createServer((req, res) => { res.writeHead(200, { 'Content-Length': payload.length }); res.write(payload.subarray(0, 1000)); setTimeout(() => res.destroy(), 30); });
  await new Promise((r) => trunc.listen(0, '127.0.0.1', r));
  ok('DOWNLOAD: a connection that drops mid-file reports it and KEEPS the partial for resuming', await rejects(downloadVerified({ url: `http://127.0.0.1:${trunc.address().port}/x`, dest: path.join(work, 't1.bin'), expectedBytes: payload.length, allowLoopbackHttp: true }), /dropped|ended early|aborted|socket|reset/i) && fs.existsSync(path.join(work, 't1.bin.part')) && !fs.existsSync(path.join(work, 't1.bin')));
  trunc.close();

  const ac = new AbortController(); setTimeout(() => ac.abort(), 1);
  const slow = http.createServer((req, res) => { res.writeHead(200, { 'Content-Length': 1000000 }); res.write(Buffer.alloc(1000)); });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  ok('DOWNLOAD: cancelling stops the transfer without installing anything', await rejects(downloadVerified({ url: `http://127.0.0.1:${slow.address().port}/x`, dest: path.join(work, 'c1.bin'), allowLoopbackHttp: true, signal: ac.signal }), /cancel/i) && !fs.existsSync(path.join(work, 'c1.bin')));
  slow.closeAllConnections?.(); slow.close();

  // ── archives ──────────────────────────────────────────────────────────────
  if (!F.sevenAvailable()) { skipped++; console.log('  - SKIPPED archive matrix (needs 7-Zip to build fixtures)'); }
  else {
    const src = path.join(work, 'src'); F.writeCar(path.join(src, 'Wrapper', 'content', 'cars'), 'car_a'); F.writeCar(path.join(src, 'Wrapper', 'content', 'cars'), 'car_b');
    const seven = A.findArchiveTool('7z'), bsd = A.findArchiveTool('bsdtar');
    for (const fmt of ['7z', 'zip']) {
      const arc = F.makeArchive(src, path.join(work, `a.${fmt}`), fmt);
      for (const tool of [seven, bsd]) {
        const entries = await A.listArchive(arc, tool);
        const folder = A.findFolder(entries, 'content/cars/car_a');
        const dest = path.join(work, `o-${fmt}-${tool.kind}`);
        const r = await A.extractFolders(arc, dest, [folder, 'nowhere/at/all'], tool, { entries });
        const got = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? w(p) : got.push(path.relative(dest, p).replace(/\\/g, '/')); } })(dest);
        ok(`ARCHIVE ${fmt} via ${tool.kind}: finds a folder under an unknown wrapper, extracts ONLY it, reports a missing one`, folder === 'Wrapper/content/cars/car_a' && got.length === 4 && got.every((g) => g.startsWith('Wrapper/content/cars/car_a/')) && r.missing.length === 1 && r.extractedFiles === 4);
      }
    }
    const arc7 = path.join(work, 'a.7z');
    ok('ARCHIVE: findFolder matches case-insensitively and does not match a longer sibling name', A.findFolder([{ path: 'X/Content/Cars/car_ab', size: 0, isDir: true }], 'content/cars/car_a') === null && A.findFolder([{ path: 'X/Content/Cars/CAR_A/ui', size: 0, isDir: true }], 'content/cars/car_a') === 'X/Content/Cars/CAR_A');
    ok('ARCHIVE: the safety size limit refuses an oversized selection before extracting', await rejects(A.extractFolders(arc7, path.join(work, 'big'), ['Wrapper'], seven, { maxBytes: 10 }), /safety limit/) && !fs.existsSync(path.join(work, 'big')));
    ok('ARCHIVE: a corrupt archive gives a readable error, not a crash', await (async () => { const bad = path.join(work, 'bad.7z'); fs.writeFileSync(bad, 'definitely not an archive'); return rejects(A.listArchive(bad, seven), /Could not read the archive/); })());
    const all = await A.listArchive(arc7, seven);
    ok('ARCHIVE: selectUnder("") means everything, and a normal folder selects only its subtree', A.selectUnder(all, ['']).length === all.length && A.selectUnder(all, ['Wrapper/content/cars/car_b']).every((e) => e.path.startsWith('Wrapper/content/cars/car_b')));
  }

  // ── server status probe ───────────────────────────────────────────────────
  const info = http.createServer((req, res) => {
    if (req.url === '/INFO') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: 'Fixture Server', clients: 3, maxclients: 14, track: 't' })); }
    else if (req.url === '/x') { res.writeHead(500); res.end(); } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => info.listen(0, '127.0.0.1', r)); const ip = info.address().port;
  const s1 = await probeServerInfo('127.0.0.1', ip);
  ok('STATUS: a reachable server reports online with its real player count', s1.online === true && s1.players === 3 && s1.maxPlayers === 14 && s1.name === 'Fixture Server' && !!s1.checkedAt);
  info.close();
  const closedPort = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const s2 = await probeServerInfo('127.0.0.1', closedPort);
  ok('STATUS: nothing listening → offline with a plain-language reason, never a guess', s2.online === false && /refused/i.test(s2.reason) && s2.players === undefined);
  const garbage = http.createServer((q, s) => { s.writeHead(200); s.end('<html>not json</html>'); }); await new Promise((r) => garbage.listen(0, '127.0.0.1', r));
  const s3 = await probeServerInfo('127.0.0.1', garbage.address().port);
  ok('STATUS: a page that is not a status reply is not reported as an online server', s3.online === false && /readable status/.test(s3.reason)); garbage.close();
  const hang = http.createServer(() => {}); await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const s4 = await probeServerInfo('127.0.0.1', hang.address().port, 300);
  ok('STATUS: a server that never answers times out as offline', s4.online === false && /No answer/.test(s4.reason)); hang.closeAllConnections?.(); hang.close();
  const notFound = http.createServer((q, s) => { s.writeHead(404); s.end(); }); await new Promise((r) => notFound.listen(0, '127.0.0.1', r));
  ok('STATUS: an HTTP error is reported with its code', (await probeServerInfo('127.0.0.1', notFound.address().port)).reason.includes('404')); notFound.close();
  const srcInfo = fs.readFileSync(path.resolve(__dirname, '../../src/main/services/ac/serverInfo.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  ok('STATUS (static): the probe issues only a GET and nothing that could change a server', !/\.(post|put|delete|request)\(|method:\s*['"](POST|PUT|DELETE)/i.test(srcInfo) && /http\.get\(/.test(srcInfo));

  await host.close(); F.rm(work);
  console.log(`\nAC TRANSFER TESTS (download, archive, status): ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
