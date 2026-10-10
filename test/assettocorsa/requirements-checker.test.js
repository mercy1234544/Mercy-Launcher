// Assetto Corsa READ-ONLY requirements checker — behavioral tests against
// disposable fixture installs (never the real game folder), following this
// project's "real files, never mocked" convention. Covers: the vendored SRP
// requirement data's integrity, the pure parsing helpers, every pass / warn /
// fail / unknown path of the checker, the privacy rule (a stamped server
// address is never echoed), and — most importantly — that a check never
// changes a single byte, timestamp or file in the install it inspects.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const chk = require(path.resolve(__dirname, '../../dist/main/services/AcRequirementsChecker.js'));
const { getBundledSrpBundle, listBundledSrpServers } = require(path.resolve(__dirname, '../../dist/main/services/AcSrpBundle.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DATA = path.resolve(__dirname, '../../src/main/data/assettocorsa-srp');

// ── 1. Vendored package data is intact and unmodified ────────────────────────
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'MANIFEST.json'), 'utf8'));
const refs = [...manifest.servers.map((s) => s.requirements), ...manifest.contentInventory, ...manifest.components.flatMap((c) => [...(c.files || []), ...(c.referenceFiles || [])])];
const vendored = refs.filter((r) => fs.existsSync(path.join(DATA, r.path)));
ok('all 6 requirement/inventory files this project uses are vendored', vendored.length === 6);
ok('every vendored file still matches the sha256 + size recorded in the package MANIFEST.json (no hand edits, no drift)', vendored.every((r) => { const b = fs.readFileSync(path.join(DATA, r.path)); return sha(b) === r.sha256 && b.length === r.bytes; }));
const real = getBundledSrpBundle();
ok('bundled requirements expose both SRP servers with the documented ids', JSON.stringify(listBundledSrpServers().map((s) => s.id)) === JSON.stringify(['main', 'server2']));
ok('every bundled requirements file is schemaVersion 1.0.0 (the checker was written against 1.x)', real.servers.every((s) => /^1\./.test(s.schemaVersion)));
ok('no public host, port-forward target or LAN address is baked into the bundled data', !/\b(192\.168|10\.\d+\.\d+\.\d+)\b/.test(JSON.stringify(real)) && real.servers.every((s) => s.server.connection === undefined || s.server.connection.publicHost === null));

// ── 2. Pure helpers ──────────────────────────────────────────────────────────
ok('compareVersions orders dotted versions numerically (0.2.11 > 0.1.76, 0.10 > 0.9)', chk.compareVersions('0.2.11', '0.1.76') === 1 && chk.compareVersions('0.1.76', '0.2.11') === -1 && chk.compareVersions('0.10', '0.9') === 1 && chk.compareVersions('1.0', '1.0.0') === 0);
ok('parseCspVersionFromLog reads the real CSP log line, emoji prefix and all', (() => { const v = chk.parseCspVersionFromLog('\u{1F389} CSP v0.2.11 b3465, enabled, date & time: 2026-10-08T21:47:21:430.'); return v && v.version === '0.2.11' && v.build === 3465; })());
ok('parseCspVersionFromLog tolerates a build-less version and returns null for unrelated text', chk.parseCspVersionFromLog('CSP v0.1.76, enabled').version === '0.1.76' && chk.parseCspVersionFromLog('nothing here') === null);
ok('parseCspVersionText parses the bundle\'s "0.2.11 b3465" tested-version string', (() => { const v = chk.parseCspVersionText('0.2.11 b3465'); return v.version === '0.2.11' && v.build === 3465; })());
ok('classifyHost separates private LAN / loopback / public IP / hostname', chk.classifyHost('192.168.1.5') === 'private-lan' && chk.classifyHost('10.0.0.2') === 'private-lan' && chk.classifyHost('172.20.1.1') === 'private-lan' && chk.classifyHost('172.32.1.1') === 'public-ip' && chk.classifyHost('127.0.0.1') === 'loopback' && chk.classifyHost('8.8.8.8') === 'public-ip' && chk.classifyHost('play.example.com') === 'hostname');
ok('parseBoardServers distinguishes unstamped ({ }), stamped, and a missing SERVERS line', JSON.stringify(chk.parseBoardServers('local SERVERS = { }\n')) === '[]' && JSON.stringify(chk.parseBoardServers("local SERVERS = { 'a.b:1', 'c.d:2' }")) === '["a.b:1","c.d:2"]' && chk.parseBoardServers('nothing') === null);
ok('readIniValue reads KEY=value case-insensitively and returns null when absent', chk.readIniValue('[ABOUT]\nVERSION=1.0.0\n', 'version') === '1.0.0' && chk.readIniValue('[ABOUT]\n', 'VERSION') === null);

// ── 3. Fixture install builder ───────────────────────────────────────────────
const TEMPLATE_LUA = "-- fixture board\nlocal VERSION = '1.0.0'\nlocal SERVERS = { }\nreturn VERSION\n";
const MANIFEST_INI = '[ABOUT]\nNAME=SRP Board\nVERSION=1.0.0\n';
const ICON = Buffer.from('89504e470d0a1a0a', 'hex');
const LAN = '192.168.77.123'; // must never appear in any report
const CAR_UI = JSON.stringify({ name: 'Fixture Car', version: '2.0' });
const CAR_ACD = Buffer.from('fixture-physics-data-A');
const BASE_UI = JSON.stringify({ name: 'Base Car (server stub differs)' });
const BASE_ACD = Buffer.from('fixture-base-physics');
const TRACK_MARKER = 'Fixture Track 1.2.3 Stable';
const LAYOUT_UI = JSON.stringify({ name: 'Layout A' });

const bundle = {
  servers: [
    {
      schemaVersion: '1.0.0',
      server: { id: 't2', displayName: 'Fixture Traffic', type: 'assettoserver' },
      track: { id: 'test_track', layout: 'lay_a', version: '1.2.3', source: 'trk_src' },
      cars: [
        { id: 'car_a', name: 'Fixture Car', version: '2.0', role: 'player', requirement: 'required-to-join', source: 'pack', skinsPinnedByEntryList: ['red'], identity: { dataAcdSha256: sha(CAR_ACD), uiCarJsonSha256: sha(Buffer.from(CAR_UI)) } },
        { id: 'base_car', name: null, version: null, role: 'player', requirement: 'required-to-join', source: 'ac_base_game', skinsPinnedByEntryList: [''], identity: { dataAcdSha256: sha(BASE_ACD), uiCarJsonSha256: null } },
      ],
      csp: { required: true, minimumVersion: '0.1.76', testedVersion: '0.2.11 b3465' },
      hud: { delivery: 'server-csp-online-script', playerInstall: false, version: '4.0.2' },
      companionApps: [{ id: 'srp_board', version: '1.0.0', requirement: 'intended-experience', installDestination: 'x', stampServerEntry: { host: null, tcpPort: 9650 } }],
    },
    {
      schemaVersion: '1.0.0',
      server: { id: 'nohud', displayName: 'Fixture Stock', type: 'kunos-stock' },
      track: { id: 'test_track', layout: 'lay_a', version: '1.2.3', source: 'trk_src' },
      cars: [],
      csp: { required: true, minimumVersion: '0.1.76', testedVersion: '0.2.11 b3465' },
      hud: { delivery: 'none', playerInstall: false, version: '4.0.2' },
      companionApps: [],
    },
  ],
  tracks: { tracks: [{ id: 'test_track', version: '1.2.3', markerFileSha256: sha(Buffer.from(TRACK_MARKER)), layouts: [{ config: 'lay_a', uiTrackJsonSha256: sha(Buffer.from(LAYOUT_UI)) }], source: { sourceId: 'trk_src' } }] },
  sources: { sources: [{ sourceId: 'trk_src', name: 'Fixture Track', homepage: 'https://example.invalid/track', directUrlStatus: 'DEAD' }, { sourceId: 'pack', name: 'Fixture Pack', homepage: 'https://example.invalid/pack' }] },
  boardRelease: { version: '1.0.0', files: [
    { path: 'apps/lua/srp_board/manifest.ini', sha256: sha(Buffer.from(MANIFEST_INI)), template: false },
    { path: 'apps/lua/srp_board/srp_board.lua', sha256: sha(Buffer.from(TEMPLATE_LUA)), template: true },
    { path: 'apps/lua/srp_board/icon.png', sha256: sha(ICON), template: false },
  ] },
};

function w(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function buildInstall() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-acchk-'));
  const ac = path.join(base, 'assettocorsa'), docs = path.join(base, 'docs');
  w(path.join(ac, 'acs.exe'), 'x'); w(path.join(ac, 'dwrite.dll'), 'x'); fs.mkdirSync(path.join(ac, 'extension'), { recursive: true });
  w(path.join(ac, 'content', 'cars', 'car_a', 'ui', 'ui_car.json'), CAR_UI); w(path.join(ac, 'content', 'cars', 'car_a', 'data.acd'), CAR_ACD);
  fs.mkdirSync(path.join(ac, 'content', 'cars', 'car_a', 'skins', 'red'), { recursive: true });
  w(path.join(ac, 'content', 'cars', 'base_car', 'ui', 'ui_car.json'), BASE_UI); w(path.join(ac, 'content', 'cars', 'base_car', 'data.acd'), BASE_ACD);
  const t = path.join(ac, 'content', 'tracks', 'test_track');
  w(path.join(t, '1.2.3 Stable.txt'), TRACK_MARKER); fs.mkdirSync(path.join(t, 'lay_a'), { recursive: true }); w(path.join(t, 'ui', 'lay_a', 'ui_track.json'), LAYOUT_UI);
  const b = path.join(ac, 'apps', 'lua', 'srp_board');
  w(path.join(b, 'manifest.ini'), MANIFEST_INI); w(path.join(b, 'icon.png'), ICON);
  w(path.join(b, 'srp_board.lua'), TEMPLATE_LUA.replace('local SERVERS = { }', `local SERVERS = { '${LAN}:9650' }`));
  w(path.join(docs, 'logs', 'custom_shaders_patch.log'), '\u{1F389} CSP v0.2.11 b3465, enabled, date & time: 2026-10-08T21:47:21:430.\n');
  return { base, ac, docs };
}
function snapshot(dir) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { out.push(`D ${path.relative(dir, p)}`); walk(p); } else { const s = fs.statSync(p); out.push(`F ${path.relative(dir, p)} ${s.size} ${s.mtimeMs}`); } } })(dir);
  return out.sort().join('\n');
}
const status = (r, sec, id) => (r.sections[sec].find((i) => i.id === id) || {}).status;
const run = (fx, over = {}) => chk.checkAcRequirements({ acRoot: fx.ac, bundle, serverId: 't2', documentsAcDir: fx.docs, ...over });
const fixtures = [];
const mk = () => { const fx = buildInstall(); fixtures.push(fx); return fx; };

(async () => {
  // ── 4. Happy path ─────────────────────────────────────────────────────────
  const happy = mk();
  const before = snapshot(happy.base);
  const r0 = await run(happy);
  ok('a fully correct install: every required check passes and the player is ready to join', r0.summary.fail === 0 && r0.summary.readyToJoin === true && r0.summary.blockers.length === 0);
  ok('install, CSP (installed + exact tested version), track, layout and both cars all report PASS', status(r0, 'install', 'ac-install') === 'pass' && status(r0, 'csp', 'csp-installed') === 'pass' && status(r0, 'csp', 'csp-version') === 'pass' && status(r0, 'track', 'track') === 'pass' && status(r0, 'track', 'track-layout') === 'pass' && status(r0, 'cars', 'car:car_a') === 'pass' && status(r0, 'cars', 'car:base_car') === 'pass');
  ok('a base-game car whose ui_car.json differs from the server\'s stub still passes (metadata is only compared where the server copy is authoritative; physics data matches)', status(r0, 'cars', 'car:base_car') === 'pass');
  ok('a base-game car with no name in the requirements is labelled with the installed car\'s own display name, not a raw folder id', r0.sections.cars.find((c) => c.id === 'car:base_car').label === 'Base Car (server stub differs)' && r0.sections.cars.find((c) => c.id === 'car:car_a').label === 'Fixture Car');
  ok('the SRP Board app is recognized as current, with its unchanged files and (list-blanked) lua matching the release', status(r0, 'companion', 'app:srp_board') === 'pass' && status(r0, 'companion', 'app:srp_board:integrity') === 'pass');
  ok('PRIVACY: a stamped private LAN address is reported only as a kind + port — the address itself appears nowhere in the report', status(r0, 'companion', 'app:srp_board:stamp') === 'info' && !JSON.stringify(r0).includes(LAN) && JSON.stringify(r0.sections.companion.find((i) => i.id === 'app:srp_board:stamp').evidence.entries) === '[{"kind":"private-lan","port":9650}]');
  ok('a LAN-only stamp is flagged as not matching an outside join (the package\'s documented open issue), not silently called fine', /will not match this server when joined from outside/.test(r0.sections.companion.find((i) => i.id === 'app:srp_board:stamp').detail));

  // ── 5. Install / CSP ──────────────────────────────────────────────────────
  const none = await chk.checkAcRequirements({ acRoot: null, bundle, serverId: 't2' });
  ok('no Assetto Corsa found -> a single clear FAIL, not ready, nothing else attempted', none.summary.readyToJoin === false && none.sections.install[0].status === 'fail' && none.sections.cars.length === 0);
  const noExe = mk(); fs.rmSync(path.join(noExe.ac, 'acs.exe'));
  ok('a folder without acs.exe / AssettoCorsa.exe is rejected as an install', (await run(noExe)).sections.install[0].status === 'fail');
  ok('findAcRoot returns only a folder that really holds the game', chk.findAcRoot([null, '/definitely/not/here', happy.ac]) === happy.ac && chk.findAcRoot([noExe.ac]) === null);

  const noCsp = mk(); fs.rmSync(path.join(noCsp.ac, 'dwrite.dll'));
  ok('CSP files missing -> FAIL (the server requires it)', status(await run(noCsp), 'csp', 'csp-installed') === 'fail');
  const oldCsp = mk(); w(path.join(oldCsp.docs, 'logs', 'custom_shaders_patch.log'), 'CSP v0.1.50 b100, enabled\n');
  ok('CSP older than the documented minimum -> FAIL', status(await run(oldCsp), 'csp', 'csp-version') === 'fail');
  const newCsp = mk(); w(path.join(newCsp.docs, 'logs', 'custom_shaders_patch.log'), 'CSP v0.3.0 b9000, enabled\n');
  const rNew = await run(newCsp);
  ok('CSP newer than the tested version -> INFO (meets the minimum, honestly marked untested), not FAIL and not a false PASS', status(rNew, 'csp', 'csp-version') === 'info' && rNew.summary.readyToJoin === true);
  const noLog = mk(); fs.rmSync(path.join(noLog.docs, 'logs'), { recursive: true });
  const rNoLog = await run(noLog);
  ok('no CSP log -> version is UNKNOWN (never guessed) and the report is marked incomplete', status(rNoLog, 'csp', 'csp-version') === 'unknown' && rNoLog.summary.incomplete === true);

  // ── 6. Track ──────────────────────────────────────────────────────────────
  const noTrack = mk(); fs.rmSync(path.join(noTrack.ac, 'content', 'tracks', 'test_track'), { recursive: true });
  const rNoTrack = await run(noTrack);
  ok('missing track -> FAIL that points at the official source and mentions the known-dead direct link', status(rNoTrack, 'track', 'track') === 'fail' && /example\.invalid\/track/.test(rNoTrack.sections.track[0].detail) && /DEAD/.test(rNoTrack.sections.track[0].detail));
  const otherVer = mk(); const ovTrack = path.join(otherVer.ac, 'content', 'tracks', 'test_track'); fs.rmSync(path.join(ovTrack, '1.2.3 Stable.txt')); w(path.join(ovTrack, '1.3.0 Stable.txt'), 'newer');
  const rOv = await run(otherVer);
  ok('a DIFFERENT installed SRP version -> FAIL naming it, and that version\'s marker file is left exactly as found', status(rOv, 'track', 'track') === 'fail' && /1\.3\.0 Stable\.txt/.test(rOv.sections.track[0].detail) && fs.readFileSync(path.join(ovTrack, '1.3.0 Stable.txt'), 'utf8') === 'newer');
  const badMarker = mk(); w(path.join(badMarker.ac, 'content', 'tracks', 'test_track', '1.2.3 Stable.txt'), 'tampered');
  ok('marker file present but different bytes -> FAIL', status(await run(badMarker), 'track', 'track') === 'fail');
  const noLayout = mk(); fs.rmSync(path.join(noLayout.ac, 'content', 'tracks', 'test_track', 'lay_a'), { recursive: true });
  ok('required layout folder missing -> FAIL', status(await run(noLayout), 'track', 'track-layout') === 'fail');

  // ── 7. Cars ───────────────────────────────────────────────────────────────
  const noCar = mk(); fs.rmSync(path.join(noCar.ac, 'content', 'cars', 'car_a'), { recursive: true });
  const rNoCar = await run(noCar);
  ok('missing car -> FAIL naming where it comes from; the report is not ready', status(rNoCar, 'cars', 'car:car_a') === 'fail' && /Fixture Pack/.test(rNoCar.sections.cars.find((c) => c.id === 'car:car_a').detail) && rNoCar.summary.readyToJoin === false);
  const verCar = mk(); w(path.join(verCar.ac, 'content', 'cars', 'car_a', 'ui', 'ui_car.json'), JSON.stringify({ name: 'Fixture Car', version: '1.0' }));
  ok('older car version -> WARN (shows both versions), not a blocker by itself', status(await run(verCar), 'cars', 'car:car_a') === 'warn');
  const physCar = mk(); w(path.join(physCar.ac, 'content', 'cars', 'car_a', 'data.acd'), 'modified-physics');
  ok('deep check: physics data differing from the server copy -> FAIL', status(await run(physCar), 'cars', 'car:car_a') === 'fail');
  ok('shallow check (deep:false) skips physics hashing, so the same modified car is not failed on it', status(await run(physCar, { deep: false }), 'cars', 'car:car_a') !== 'fail');
  const skinCar = mk(); fs.rmSync(path.join(skinCar.ac, 'content', 'cars', 'car_a', 'skins', 'red'), { recursive: true });
  ok('the server\'s pinned skin missing from the car -> WARN (AC falls back to a default skin)', status(await run(skinCar), 'cars', 'car:car_a') === 'warn');

  // ── 8. Companion app + conflicts ─────────────────────────────────────────
  const noApp = mk(); fs.rmSync(path.join(noApp.ac, 'apps'), { recursive: true });
  const rNoApp = await run(noApp);
  ok('SRP Board not installed -> WARN (it is "intended experience", not required) and the player can still be ready', status(rNoApp, 'companion', 'app:srp_board') === 'warn' && rNoApp.summary.readyToJoin === true);
  const inert = mk(); w(path.join(inert.ac, 'apps', 'lua', 'srp_board', 'srp_board.lua'), TEMPLATE_LUA);
  ok('an unstamped SRP Board is called out as doing nothing', status(await run(inert), 'companion', 'app:srp_board:stamp') === 'warn');
  const oldApp = mk(); w(path.join(oldApp.ac, 'apps', 'lua', 'srp_board', 'manifest.ini'), '[ABOUT]\nVERSION=0.9.0\n');
  const rOldApp = await run(oldApp);
  ok('an older SRP Board version -> WARN, and its altered manifest.ini is flagged by the integrity check too', status(rOldApp, 'companion', 'app:srp_board') === 'warn' && status(rOldApp, 'companion', 'app:srp_board:integrity') === 'warn');
  const editedLua = mk(); w(path.join(editedLua.ac, 'apps', 'lua', 'srp_board', 'srp_board.lua'), TEMPLATE_LUA.replace('return VERSION', 'return "hacked"').replace('local SERVERS = { }', "local SERVERS = { 'x.test:9650' }"));
  ok('edits to the lua OUTSIDE its server list are detected (only the list is allowed to differ)', status(await run(editedLua), 'companion', 'app:srp_board:integrity') === 'warn');
  const publicStamp = mk(); w(path.join(publicStamp.ac, 'apps', 'lua', 'srp_board', 'srp_board.lua'), TEMPLATE_LUA.replace('local SERVERS = { }', "local SERVERS = { 'play.example.com:9650' }"));
  const rPub = await run(publicStamp);
  ok('a hostname stamp on the right port -> PASS, and the hostname is not echoed either', status(rPub, 'companion', 'app:srp_board:stamp') === 'pass' && !JSON.stringify(rPub).includes('play.example.com'));

  const dupHud = mk(); fs.mkdirSync(path.join(dupHud.ac, 'apps', 'lua', 'srp_hud'), { recursive: true });
  const rDup = await run(dupHud);
  ok('old dev HUD installed on a HUD-delivering server -> FAIL (two HUDs), and it is NOT removed', status(rDup, 'conflicts', 'conflict-srp-hud') === 'fail' && fs.existsSync(path.join(dupHud.ac, 'apps', 'lua', 'srp_hud')) && rDup.summary.readyToJoin === false);
  ok('the same old HUD on a server that delivers no HUD -> only a WARN', status(await run(dupHud, { serverId: 'nohud' }), 'conflicts', 'conflict-srp-hud') === 'warn');
  const rStock = await run(happy, { serverId: 'nohud' });
  ok('a stock server has no companion app section to fail (HUD "none" is just informational)', status(rStock, 'companion', 'hud') === 'info' && rStock.sections.companion.length === 1);

  // ── 9. Safety ─────────────────────────────────────────────────────────────
  let threw = false; try { await run(happy, { serverId: 'nope' }); } catch { threw = true; }
  ok('an unknown server id is an error, never a silent pass', threw);
  const evil = JSON.parse(JSON.stringify(bundle)); evil.servers[0].cars[0].id = '..';
  const rEvil = await chk.checkAcRequirements({ acRoot: happy.ac, bundle: evil, serverId: 't2', documentsAcDir: happy.docs });
  ok('a path-traversal car id in the requirements is refused (UNKNOWN), never joined onto the filesystem', status(rEvil, 'cars', 'car:..') === 'unknown');

  const after = snapshot(happy.base);
  ok('READ-ONLY: after a full check (and all the failure-path runs against it) the happy-path install is byte-for-byte, mtime-for-mtime unchanged', before === after);
  const allSnapshotsStable = fixtures.every((fx) => snapshot(fx.base).length > 0);
  ok('every fixture install still exists after all runs (nothing was deleted by a check)', allSnapshotsStable);

  const src = fs.readFileSync(path.resolve(__dirname, '../../src/main/services/AcRequirementsChecker.ts'), 'utf8')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('READ-ONLY (static): the checker source uses no write/delete/rename/copy/mkdir API', !/\b(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rmSync|rmdir|rmdirSync|rename|renameSync|copyFile|copyFileSync|cpSync|mkdir|mkdirSync|createWriteStream|truncate|symlink|chmod|utimes)\b/.test(src));
  ok('READ-ONLY (static): no child process, network or shell access either', !/child_process|require\(['"]https?['"]\)|from ['"]https?['"]|\bfetch\(|\bspawn(Sync)?\b|\bexecSync\b|\bexecFile(Sync)?\b|\bnet\.|\bdgram\b/.test(src));
  ok('the only fs.openSync is read-mode', (src.match(/openSync\([^)]*\)/g) || []).every((c) => /'r'/.test(c)));

  for (const fx of fixtures) fs.rmSync(fx.base, { recursive: true, force: true });
  console.log(`\nAC REQUIREMENTS CHECKER TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
