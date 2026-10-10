// OPT-IN (slow, writes ~4.6 GB of zeros to the temp folder): MERCY_BIGTEST=1 node test/assettocorsa/large-download.test.js
// Not part of the default suite. Proves the downloader and archive code are correct ABOVE 4 GiB — the real SRP car pack
// is 4.8 GB, past every 32-bit boundary — using a generated stream instead of the real pack:
//   * a download is cut off after ~4.4 GB and RESUMED with a Range request whose offset is above 2^32,
//   * the final size and SHA-256 are verified over the whole >4 GiB file,
//   * archive listings report sizes above 4 GiB correctly and the free-space guard counts them.
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const F = require('./_acFixtures');
const { downloadVerified } = F.dist('ac/download.js');
const A = F.dist('ac/archive.js');

if (process.env.MERCY_BIGTEST !== '1') { console.log('large-download.test.js is opt-in (set MERCY_BIGTEST=1). Skipped.'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗', name); } };
const TOTAL = 4_600_000_000; // > 2^32 (4,294,967,296)
const CUT = 4_400_000_000;
const CHUNK = Buffer.alloc(1 << 20); // zeros

(async () => {
  const work = F.mkTmp('mercy-big-');
  console.log('computing the expected SHA-256 of', TOTAL, 'bytes…');
  const h = crypto.createHash('sha256'); for (let left = TOTAL; left > 0; left -= CHUNK.length) h.update(left >= CHUNK.length ? CHUNK : CHUNK.subarray(0, left));
  const expected = h.digest('hex');

  let ranges = [];
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || ''); const start = m ? Number(m[1]) : 0; ranges.push(req.headers.range || null);
    const end = server.cutAt && !m ? server.cutAt : TOTAL; // first request is cut short, the resume is served in full
    res.writeHead(m ? 206 : 200, { 'Content-Length': TOTAL - start, ...(m ? { 'Content-Range': `bytes ${start}-${TOTAL - 1}/${TOTAL}` } : {}), 'Accept-Ranges': 'bytes' });
    let sent = start;
    const pump = () => {
      while (sent < end) {
        const n = Math.min(CHUNK.length, end - sent);
        if (!res.write(n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n))) { sent += n; return res.once('drain', pump); }
        sent += n;
      }
      if (end < TOTAL) res.destroy(); else res.end();
    };
    pump();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${server.address().port}/big.7z`;
  const dest = path.join(work, 'big.7z'); const opts = { url, dest, expectedBytes: TOTAL, expectedSha256: expected, allowLoopbackHttp: true, reserveBytes: 1 << 20 };

  server.cutAt = CUT;
  let failed = false; try { await downloadVerified(opts); } catch { failed = true; }
  const partSize = fs.existsSync(dest + '.part') ? fs.statSync(dest + '.part').size : -1;
  ok('BIG: a connection that dies at ~4.4 GB is reported as a failure, not a finished file', failed && !fs.existsSync(dest));
  ok('BIG: the ~4.4 GB partial is kept (it is above the 32-bit limit)', partSize > 4_294_967_296 && partSize <= CUT + (1 << 20));

  server.cutAt = null; ranges = [];
  const r = await downloadVerified(opts);
  ok('BIG: the retry RESUMES with a Range offset above 2^32 (not from zero) and only fetches the remainder', r.resumed === true && ranges.length === 1 && Number(/bytes=(\d+)-/.exec(ranges[0])[1]) > 4_294_967_296);
  ok('BIG: the finished >4 GiB file has exactly the expected size and SHA-256', r.bytes === TOTAL && fs.statSync(dest).size === TOTAL && r.sha256 === expected && !fs.existsSync(dest + '.part'));
  fs.rmSync(dest, { force: true });

  // archive listing + free-space guard above 4 GiB
  if (!F.sevenAvailable()) console.log('  - SKIPPED archive part (needs 7-Zip)');
  else {
    const src = path.join(work, 'src'); fs.mkdirSync(path.join(src, 'content', 'cars', 'huge_car'), { recursive: true });
    const big = path.join(src, 'content', 'cars', 'huge_car', 'data.bin'); fs.closeSync(fs.openSync(big, 'w')); fs.truncateSync(big, TOTAL);
    console.log('archiving a', TOTAL, 'byte file (zeros; takes a while)…');
    const arc = F.makeArchive(src, path.join(work, 'huge.7z'), '7z'); fs.rmSync(src, { recursive: true, force: true });
    const tool = A.findArchiveTool('7z'); const entries = await A.listArchive(arc, tool);
    ok('BIG: the archive listing reports an entry larger than 4 GiB with the exact size', entries.some((e) => e.size === TOTAL));
    let msg = null; try { await A.extractFolders(arc, path.join(work, 'out'), ['content/cars/huge_car'], tool, { entries, spaceCheckDir: work, freeBytes: () => 2e9 }); } catch (e) { msg = e.message; }
    ok('BIG: the free-space guard counts the >4 GiB selection and refuses before extracting anything', /Not enough free disk space to install/.test(msg || '') && !fs.existsSync(path.join(work, 'out')));
    let msg2 = null; try { await A.extractFolders(arc, path.join(work, 'out2'), ['content/cars/huge_car'], tool, { entries, maxBytes: 4_000_000_000 }); } catch (e) { msg2 = e.message; }
    ok('BIG: the extraction size safety limit also counts it correctly', /safety limit/.test(msg2 || ''));
  }

  server.close(); F.rm(work);
  console.log(`\nAC LARGE-FILE (>4 GiB) TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
