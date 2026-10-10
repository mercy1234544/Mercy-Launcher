// Installer hardening — the failure modes a real player will actually hit: damaged archives, a full disk, a file
// locked by another program, cancelling mid-way, and the app being killed in the middle of an install. Every
// scenario uses disposable fixtures (never a real game folder) and asserts the SAME thing: the install folder is
// either fully finished or exactly as it was — never half-done.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');
const F = require('./_acFixtures');
const { buildInstallPlan, executeInstall, recoverInterruptedInstalls, listInterruptedInstalls, friendlyFsError } = F.dist('ac/installer.js');
const { resolveEndpoints, EMPTY_LOCAL } = F.dist('ac/endpoints.js');
const { checkAcRequirements } = F.dist('AcRequirementsChecker.js');

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗', name); } };
const skip = (why) => { skipped++; console.log('  - SKIPPED:', why); };

(async () => {
  if (!F.sevenAvailable()) { skip('everything (needs 7-Zip to build fixture archives)'); console.log(`\nAC INSTALLER HARDENING TESTS: ${pass} passed, ${fail} failed, ${skipped} skipped`); process.exit(0); }
  const cleanup = []; const tmp = (p) => { const d = F.mkTmp(p); cleanup.push(d); return d; };
  const arcDir = tmp('hard-arc-');

  // fixture archives
  const src = tmp('hard-src-'); for (const id of ['car_a', 'car_b']) F.writeCar(path.join(src, 'content', 'cars'), id);
  const goodArc = F.makeArchive(src, path.join(arcDir, 'good.7z'), '7z');
  const goodBytes = fs.readFileSync(goodArc);
  const bundle = F.fixtureBundle('http://127.0.0.1:1/pack.7z');
  const eps = resolveEndpoints(bundle.servers[0], { servers: { t2: { host: 'play.example.com', tcpPort: null, httpPort: null } } }, EMPTY_LOCAL);

  const mk = (fx, over = {}) => ({ acRoot: fx.ac, bundle, serverId: 't2', endpoints: eps, downloadDir: path.join(fx.base, 'dl'), documentsAcDir: fx.docs, isGameRunning: async () => false, allowLoopbackHttp: true, resolver: async () => ['203.0.113.7'], ...over });
  const planOf = (fx, b = bundle) => buildInstallPlan({ acRoot: fx.ac, bundle: b, serverId: 't2', endpoints: eps, documentsAcDir: fx.docs, resolver: async () => ['203.0.113.7'], allowLoopbackHttp: true });
  const fresh = (o) => { const fx = F.emptyAcInstall(o); cleanup.push(fx.base); return fx; };
  const noStaging = (fx) => { const d = path.join(fx.ac, 'content', '.mercy-staging'); return !fs.existsSync(d) || fs.readdirSync(d).length === 0; };
  const names = (dir) => { const o = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { o.push('D ' + path.relative(dir, p)); w(p); } else o.push(`F ${path.relative(dir, p)} ${fs.statSync(p).size}`); } })(dir); return o.filter((l) => !/\.mercy-(staging|backups)/.test(l)).sort().join('\n'); };

  // ── 1. damaged archives ────────────────────────────────────────────────────
  const garbage = path.join(arcDir, 'garbage.7z'); fs.writeFileSync(garbage, 'this is definitely not an archive'.repeat(50));
  const truncated = path.join(arcDir, 'truncated.7z'); fs.writeFileSync(truncated, goodBytes.subarray(0, Math.floor(goodBytes.length * 0.6)));
  const flipped = path.join(arcDir, 'flipped.7z'); { const b = Buffer.from(goodBytes); for (let i = 40; i < Math.min(80, b.length - 40); i++) b[i] ^= 0xff; fs.writeFileSync(flipped, b); }
  const empty = path.join(arcDir, 'empty.7z'); fs.writeFileSync(empty, '');
  for (const [label, file] of [['garbage bytes', garbage], ['a truncated download', truncated], ['flipped bytes inside the data', flipped], ['an empty file', empty]]) {
    const fx = fresh(); const before = names(fx.ac);
    const res = await executeInstall(mk(fx), await planOf(fx), ['car:car_a', 'car:car_b'], { carPackArchivePath: file });
    const g = res.groups.find((x) => x.group === 'cars');
    ok(`CORRUPT (${label}): the install fails with a readable message instead of crashing`, g && g.ok === false && typeof g.error === 'string' && g.error.length > 10 && !/undefined|\[object/.test(g.error));
    ok(`CORRUPT (${label}): the game folder is exactly as it was and no staging leftovers remain`, names(fx.ac) === before && noStaging(fx) && g.rolledBack === true);
  }

  // ── 2. not enough disk space ───────────────────────────────────────────────
  { const fx = fresh(); const before = names(fx.ac);
    const res = await executeInstall(mk(fx, { freeBytes: () => 1000 }), await planOf(fx), ['car:car_a'], { carPackArchivePath: goodArc });
    const g = res.groups.find((x) => x.group === 'cars');
    ok('DISK FULL (during extraction): refused up front with the needed vs available amounts, and nothing changed', g.ok === false && /Not enough free disk space to install/.test(g.error) && /GB/.test(g.error) && names(fx.ac) === before && noStaging(fx)); }
  { const host = await F.serve({ '/pack.7z': goodArc }); const b2 = F.fixtureBundle(`${host.base}/pack.7z`); b2.sources.sources[1].localArchive = { bytes: goodBytes.length, sha256: F.sha(goodBytes) };
    const fx = fresh(); const before = names(fx.ac);
    const res = await executeInstall(mk(fx, { bundle: b2, freeBytes: () => 1000 }), await planOf(fx, b2), ['car:car_a']);
    const g = res.groups.find((x) => x.group === 'cars');
    ok('DISK FULL (before downloading): the download is refused before a single byte is fetched', g.ok === false && /Not enough free disk space for this download/.test(g.error) && host.hits.length === 0 && names(fx.ac) === before);
    await host.close(); }
  ok('DISK FULL (mapping): an ENOSPC from the OS becomes a plain "ran out of free space" message and keeps the code', (() => { const e = friendlyFsError({ code: 'ENOSPC' }, 'x'); return /ran out of free space/.test(e.message) && e.code === 'ENOSPC'; })());
  ok('FS ERRORS (mapping): lock/permission codes explain what to close; unknown errors pass through untouched', /in use or protected/.test(friendlyFsError({ code: 'EBUSY' }, 'C:/x/car_a').message) && /Close Assetto Corsa/.test(friendlyFsError({ code: 'EPERM' }, 'car_a').message) && friendlyFsError(new Error('weird'), 'x').message === 'weird');

  // ── 3. a file locked by another program (real exclusive lock held by a separate process) ──
  if (process.platform !== 'win32') skip('locked-file test (uses a Windows exclusive file lock)');
  else {
    const fx = fresh();
    F.writeCar(path.join(fx.ac, 'content', 'cars'), 'car_a', { acd: 'WRONG-PHYSICS' }); // exists, needs repair
    const locked = path.join(fx.ac, 'content', 'cars', 'car_a', 'data.acd');
    const ps = spawn('powershell', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${locked.replace(/'/g, "''")}','Open','Read','None'); Write-Output LOCKED; Start-Sleep 120`], { windowsHide: true });
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('lock helper did not start')), 15000); ps.stdout.on('data', (d) => { if (String(d).includes('LOCKED')) { clearTimeout(t); resolve(); } }); ps.on('error', reject); });
    const before = names(fx.ac);
    const res = await executeInstall(mk(fx), await planOf(fx), ['car:car_a'], { carPackArchivePath: goodArc });
    const g = res.groups.find((x) => x.group === 'cars');
    ok('LOCKED FILE: repairing a car whose file another program holds open fails with a message telling the player what to close', g.ok === false && /in use or protected/.test(g.error) && /Close Assetto Corsa/.test(g.error));
    ok('LOCKED FILE: nothing was half-moved — the car folder is exactly as it was, no partial backup copy, no staging left', names(fx.ac) === before && noStaging(fx) && g.rolledBack === true && !fs.existsSync(path.join(fx.ac, 'content', 'cars', 'car_a.mercy-partial')));
    ok('LOCKED FILE: the failed attempt left no car files in any backup folder (a locked file is never "worked around" by copying)', (() => { const b = path.join(fx.ac, 'content', '.mercy-backups'); if (!fs.existsSync(b)) return true; let leaked = false; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (/data\.acd|ui_car\.json/.test(e.name)) leaked = true; } })(b); return !leaked; })());
    try { ps.kill(); } catch {} spawnSync('taskkill', ['/PID', String(ps.pid), '/T', '/F'], { windowsHide: true });
    await new Promise((r) => setTimeout(r, 800));
    const retry = await executeInstall(mk(fx), await planOf(fx), ['car:car_a'], { carPackArchivePath: goodArc });
    ok('LOCKED FILE: once the lock is released, trying again simply succeeds', retry.groups.find((x) => x.group === 'cars')?.ok === true && fs.readFileSync(path.join(fx.ac, 'content', 'cars', 'car_a', 'data.acd'), 'utf8') === 'physics-A');
  }

  // ── 4. cancellation ────────────────────────────────────────────────────────
  { // cancel at the extraction stage (deterministic: abort the moment the phase is announced)
    const fx = fresh(); const before = names(fx.ac); const ac = new AbortController();
    const res = await executeInstall(mk(fx, { signal: ac.signal, onProgress: (p) => { if (p.phase === 'extracting') ac.abort(); } }), await planOf(fx), ['car:car_a', 'car:car_b'], { carPackArchivePath: goodArc });
    ok('CANCEL (extracting): reported as cancelled, nothing installed, staging cleaned', res.cancelled === true && names(fx.ac) === before && noStaging(fx) && res.groups.find((x) => x.group === 'cars')?.rolledBack === true); }
  { // cancel mid-download from a deliberately slow server; the partial file is kept so it can resume
    const slow = require('http').createServer((req, res) => { res.writeHead(200, { 'Content-Length': goodBytes.length }); let o = 0; const t = setInterval(() => { if (o >= goodBytes.length) { clearInterval(t); return res.end(); } res.write(goodBytes.subarray(o, o + 20)); o += 20; }, 25); res.on('close', () => clearInterval(t)); });
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    const b2 = F.fixtureBundle(`http://127.0.0.1:${slow.address().port}/pack.7z`); b2.sources.sources[1].localArchive = { bytes: goodBytes.length, sha256: F.sha(goodBytes) };
    const fx = fresh(); const before = names(fx.ac); const ac = new AbortController();
    const res = await executeInstall(mk(fx, { bundle: b2, signal: ac.signal, onProgress: (p) => { if (p.phase === 'downloading' && p.received > 100) ac.abort(); } }), await planOf(fx, b2), ['car:car_a']);
    ok('CANCEL (downloading): cancelling stops the transfer, installs nothing, and the game folder is untouched', res.cancelled === true && names(fx.ac) === before && noStaging(fx));
    ok('CANCEL (downloading): the partial download is kept for resuming and is never mistaken for a finished file', fs.existsSync(path.join(fx.base, 'dl', 'pack.7z.part')) && !fs.existsSync(path.join(fx.base, 'dl', 'pack.7z')));
    slow.closeAllConnections?.(); slow.close(); }

  // ── 5. the app is killed mid-install (a REAL process crash), then recovery ─
  const runChild = (fx, killAt, mode) => spawnSync(process.execPath, ['-e', `
    const F = require(${JSON.stringify(path.resolve(__dirname, '_acFixtures.js'))});
    const { buildInstallPlan, executeInstall } = F.dist('ac/installer.js');
    const { resolveEndpoints, EMPTY_LOCAL } = F.dist('ac/endpoints.js');
    const bundle = F.fixtureBundle('http://127.0.0.1:1/x'); const fx = ${JSON.stringify(fx)};
    const eps = resolveEndpoints(bundle.servers[0], { servers: { t2: { host: 'play.example.com', tcpPort: null, httpPort: null } } }, EMPTY_LOCAL);
    (async () => {
      const plan = await buildInstallPlan({ acRoot: fx.ac, bundle, serverId: 't2', endpoints: eps, documentsAcDir: fx.docs, resolver: async () => [], allowLoopbackHttp: true });
      await executeInstall({ acRoot: fx.ac, bundle, serverId: 't2', endpoints: eps, downloadDir: fx.base + '/dl', documentsAcDir: fx.docs, isGameRunning: async () => false, allowLoopbackHttp: true,
        onProgress: (p) => { if (${JSON.stringify(mode)} === 'staging' && p.phase === 'verifying-staged') process.exit(7); },
        hooks: { afterPlace: (i) => { if (${JSON.stringify(mode)} === 'placing' && i === ${killAt}) process.exit(7); } } }, plan, ['car:car_a', 'car:car_b'], { carPackArchivePath: ${JSON.stringify(goodArc)} });
      process.exit(0);
    })();`], { encoding: 'utf8', timeout: 60000 });

  for (const mode of ['placing', 'staging']) {
    const fx = fresh();
    F.writeCar(path.join(fx.ac, 'content', 'cars'), 'car_a', { acd: 'ORIGINAL-WRONG' }); // forces a repair, so a backup exists mid-install
    fs.mkdirSync(path.join(fx.ac, 'content', 'cars', 'car_a', 'skins', 'mine'), { recursive: true }); fs.writeFileSync(path.join(fx.ac, 'content', 'cars', 'car_a', 'skins', 'mine', 'my.dds'), 'player skin');
    const before = names(fx.ac); const beforeFull = F.treeSansWork(fx.ac);
    const r = runChild(fx, 0, mode);
    ok(`CRASH (${mode}): the child process really died mid-install (exit code 7)`, r.status === 7);
    ok(`CRASH (${mode}): the interrupted install is detected from its on-disk journal`, listInterruptedInstalls(fx.ac).length === 1);
    if (mode === 'placing') ok('CRASH (placing): the folder was really left half-done (proves the test crashed at the dangerous moment)', names(fx.ac) !== before);
    const rec = recoverInterruptedInstalls(fx.ac);
    ok(`CRASH (${mode}): recovery rolls it back with no errors`, rec.recovered.length === 1 && rec.errors.length === 0 && listInterruptedInstalls(fx.ac).length === 0);
    ok(`CRASH (${mode}): after recovery every file — including the player's own skin — is back exactly as before the crash`, F.treeSansWork(fx.ac) === beforeFull && noStaging(fx));
    const again = await executeInstall(mk(fx), await planOf(fx), ['car:car_a', 'car:car_b'], { carPackArchivePath: goodArc });
    const rr = await checkAcRequirements({ acRoot: fx.ac, bundle, serverId: 't2', deep: true, documentsAcDir: fx.docs });
    ok(`CRASH (${mode}): a fresh install afterwards completes and verifies`, again.groups.find((x) => x.group === 'cars')?.ok === true && rr.sections.cars.filter((c) => c.id !== 'car:base_car').every((c) => c.status === 'pass'));
  }
  { // crash, then the NEXT install heals it automatically without a separate recovery step
    const fx = fresh(); F.writeCar(path.join(fx.ac, 'content', 'cars'), 'car_a', { acd: 'ORIGINAL-WRONG' });
    const r = runChild(fx, 0, 'placing'); const interrupted = listInterruptedInstalls(fx.ac).length === 1;
    const msgs = []; const res = await executeInstall(mk(fx, { onProgress: (p) => msgs.push(p.message) }), await planOf(fx), ['car:car_a'], { carPackArchivePath: goodArc });
    ok('CRASH: starting the next install automatically rolls the interrupted one back first (and says so), then installs normally', r.status === 7 && interrupted && msgs.some((m) => /Rolled back 1 earlier interrupted install/.test(m)) && res.groups.find((x) => x.group === 'cars')?.ok === true && listInterruptedInstalls(fx.ac).length === 0);
  }

  // ── 6. one install at a time per game folder ──────────────────────────────
  { const fx = fresh(); const slowPlan = await planOf(fx);
    const first = executeInstall(mk(fx, { isGameRunning: async () => { await new Promise((r) => setTimeout(r, 300)); return false; } }), slowPlan, ['car:car_a'], { carPackArchivePath: goodArc });
    let err = null; try { await executeInstall(mk(fx), slowPlan, ['car:car_a'], { carPackArchivePath: goodArc }); } catch (e) { err = e.message; }
    await first;
    ok('LOCKING: a second install on the same game folder while one runs is refused, not interleaved', /already running/.test(err || '')); }

  for (const d of cleanup) F.rm(d);
  console.log(`\nAC INSTALLER HARDENING TESTS: ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
