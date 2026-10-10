// Shared disposable fixtures for the Assetto Corsa installer tests. NOTHING here touches a real game
// install: every "Assetto Corsa folder" is a temp directory, every "official download" is a local HTTP
// server, every archive is built on the fly from small fake car/track folders.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), http = require('http');
const { spawnSync } = require('child_process');
const dist = (p) => require(path.resolve(__dirname, '../../dist/main/services', p));
const { findArchiveTool } = dist('ac/archive.js');
const { getBundledSrpBundle } = dist('AcSrpBundle.js');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mkTmp = (p = 'mercy-ac-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const w = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

/** Sorted "path size" listing of a tree (content only — mtimes are legitimately different after a move). */
function tree(dir) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { out.push('D ' + path.relative(dir, p).replace(/\\/g, '/')); walk(p); } else out.push(`F ${path.relative(dir, p).replace(/\\/g, '/')} ${sha(fs.readFileSync(p))}`); } })(dir);
  return out.sort().join('\n');
}
/** Same, but ignoring the installer's own working folders. */
const treeSansWork = (dir) => tree(dir).split('\n').filter((l) => !/\.mercy-(staging|backups)/.test(l)).join('\n');

const CAR = {
  car_a: { ui: JSON.stringify({ name: 'Fixture Car A', version: '2.0' }), acd: 'physics-A', skins: ['red', 'blue'] },
  car_b: { ui: JSON.stringify({ name: 'Fixture Car B', version: '1.0' }), acd: 'physics-B', skins: ['red'] },
};
function writeCar(root, id, over = {}) {
  const c = { ...CAR[id], ...over };
  w(path.join(root, id, 'ui', 'ui_car.json'), c.ui);
  w(path.join(root, id, 'data.acd'), c.acd);
  for (const s of c.skins) w(path.join(root, id, 'skins', s, `${s}.dds`), `skin-${id}-${s}`);
}
const MARKER = 'Fixture Track 1.2.3 Stable';
const LAYOUT_UI = JSON.stringify({ name: 'Layout A' });
function writeTrack(root, over = {}) {
  w(path.join(root, over.markerName || '1.2.3 Stable.txt'), over.marker || MARKER);
  w(path.join(root, 'lay_a', 'models.kn5'), 'kn5');
  w(path.join(root, 'ui', 'lay_a', 'ui_track.json'), over.layoutUi || LAYOUT_UI);
}

/** Build an archive. fmt: '7z' | 'zip'. Returns the file path, or null if no tool can create it. */
function makeArchive(srcDir, outFile, fmt = '7z') {
  const seven = findArchiveTool('7z');
  if (seven) {
    const r = spawnSync(seven.exe, ['a', fmt === 'zip' ? '-tzip' : '-t7z', outFile, '.'], { cwd: srcDir, windowsHide: true });
    return r.status === 0 ? outFile : null;
  }
  return null;
}
const sevenAvailable = () => !!findArchiveTool('7z');

/** Local stand-in for the official host. Supports Range (206) and an optional per-request tamper. */
function serve(files) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const f = files[req.url];
    hits.push({ url: req.url, range: req.headers.range || null });
    if (!f) { res.writeHead(404); return res.end(); }
    let buf = typeof f === 'function' ? f() : fs.readFileSync(f);
    if (req.headers.range && !server.ignoreRange) {
      const m = /bytes=(\d+)-/.exec(req.headers.range); const start = m ? parseInt(m[1], 10) : 0;
      if (start >= buf.length) { res.writeHead(416, { 'Content-Range': `bytes */${buf.length}` }); return res.end(); }
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${buf.length - 1}/${buf.length}`, 'Content-Length': buf.length - start, 'Accept-Ranges': 'bytes' });
      return res.end(buf.subarray(start));
    }
    res.writeHead(200, { 'Content-Length': buf.length, 'Accept-Ranges': 'bytes' });
    res.end(buf);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

/** A fixture AC folder with the game + CSP "installed" but none of the SRP content. */
function emptyAcInstall({ csp = true, hud = false } = {}) {
  const base = mkTmp(); const ac = path.join(base, 'assettocorsa'); const docs = path.join(base, 'docs');
  w(path.join(ac, 'acs.exe'), 'x');
  fs.mkdirSync(path.join(ac, 'content', 'cars'), { recursive: true }); fs.mkdirSync(path.join(ac, 'content', 'tracks'), { recursive: true });
  if (csp) { w(path.join(ac, 'dwrite.dll'), 'x'); fs.mkdirSync(path.join(ac, 'extension'), { recursive: true }); fs.mkdirSync(path.join(ac, 'apps', 'lua'), { recursive: true }); w(path.join(docs, 'logs', 'custom_shaders_patch.log'), 'CSP v0.2.11 b3465, enabled\n'); }
  if (hud) w(path.join(ac, 'apps', 'lua', 'srp_hud', 'srp_hud.lua'), 'old hud');
  return { base, ac, docs };
}

/** The fixture server + inventory. Board release/template are the REAL embedded ones. */
function fixtureBundle(carPackUrl) {
  const real = getBundledSrpBundle();
  const car = (id, name, version) => ({ id, name, version, role: 'player', requirement: 'required-to-join', source: 'pack', skinsPinnedByEntryList: CAR[id].skins.slice(0, 1), identity: { dataAcdSha256: sha(Buffer.from(CAR[id].acd)), uiCarJsonSha256: null } });
  return {
    servers: [{
      schemaVersion: '1.0.0',
      server: { id: 't2', displayName: 'Fixture Traffic', type: 'assettoserver', game: { udpPort: 9650, tcpPort: 9650, httpPort: 8090 }, maxPlayers: 32, ai: { enabled: true, trafficCars: 5 }, connection: { publicHost: null, publicPort: 9650 } },
      track: { id: 'test_track', layout: 'lay_a', version: '1.2.3', source: 'trk_src' },
      cars: [car('car_a', 'Fixture Car A', '2.0'), car('car_b', 'Fixture Car B', '1.0'),
        { id: 'base_car', name: null, version: null, role: 'player', requirement: 'required-to-join', source: 'ac_base_game', skinsPinnedByEntryList: [''], identity: { dataAcdSha256: null, uiCarJsonSha256: null } }],
      csp: { required: true, minimumVersion: '0.1.76', testedVersion: '0.2.11 b3465' },
      hud: { delivery: 'server-csp-online-script', playerInstall: false, version: '4.0.2' },
      companionApps: [{ id: 'srp_board', version: '1.0.0', requirement: 'intended-experience', installDestination: 'x', stampServerEntry: { host: null, tcpPort: 9650 } }],
    }],
    tracks: { tracks: [{ id: 'test_track', version: '1.2.3', markerFileSha256: sha(Buffer.from(MARKER)), layouts: [{ config: 'lay_a', uiTrackJsonSha256: sha(Buffer.from(LAYOUT_UI)) }], source: { sourceId: 'trk_src' } }] },
    sources: { sources: [
      { sourceId: 'trk_src', name: 'Fixture Track', homepage: 'https://example.invalid/track', officialDirectUrl: 'https://example.invalid/track.7z', directUrlStatus: 'DEAD on test day: HTTP 302 to the homepage' },
      { sourceId: 'pack', name: 'Fixture Car Pack', homepage: 'https://example.invalid', officialDirectUrl: carPackUrl, directUrlStatus: 'LIVE on test day', ...(carPackUrl ? {} : {}) },
    ] },
    boardRelease: real.boardRelease,
  };
}

module.exports = { sha, mkTmp, w, rm, tree, treeSansWork, CAR, writeCar, writeTrack, MARKER, LAYOUT_UI, makeArchive, sevenAvailable, serve, emptyAcInstall, fixtureBundle, dist };
