// Catalog schema validator: the catalog is untrusted input, so almost every rule here is a rejection test.
const F = require('./_acFixtures');
const { validCatalog, H } = require('./_catalogFixtures');
const { validateCatalog, isSafeRelPath, isPrivateOrLocalString } = F.dist('ac/catalogSchema.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };
const bad = (n, mutate, re) => {
  const r = validateCatalog(validCatalog(mutate));
  const hit = !r.ok && (!re || r.errors.some((e) => re.test(e)));
  ok(n, hit);
  if (!hit && !r.ok) console.log('    got:', r.errors.slice(0, 3));
};

const good = validateCatalog(validCatalog());
ok('valid catalog accepted', good.ok);
ok('valid catalog has no warnings', good.ok && good.warnings.length === 0);

ok('array root rejected', !validateCatalog([]).ok);
ok('null root rejected', !validateCatalog(null).ok);
ok('string root rejected', !validateCatalog('{}').ok);

bad('wrong schema id', (c) => { c.schema = 'other'; }, /schema/);
bad('unknown major version', (c) => { c.schemaVersion = '2.0.0'; }, /not supported/);
ok('newer minor accepted', validateCatalog(validCatalog((c) => { c.schemaVersion = '1.7.2'; })).ok);
bad('bad schemaVersion string', (c) => { c.schemaVersion = 'one'; }, /schemaVersion/);
bad('example catalog refused', (c) => { c.example = true; }, /EXAMPLE/);
bad('negative revision', (c) => { c.catalog.revision = -1; }, /revision/);
bad('fractional revision', (c) => { c.catalog.revision = 1.5; }, /revision/);
bad('bad generatedAt', (c) => { c.catalog.generatedAt = 'yesterday'; }, /generatedAt/);
bad('expiresAt before generatedAt', (c) => { c.catalog.expiresAt = '2029-01-01T00:00:00Z'; }, /expiresAt/);
bad('bad environment', (c) => { c.catalog.environment = 'staging'; }, /environment/);

// ids & duplicates
bad('duplicate server id', (c) => { c.servers.push(JSON.parse(JSON.stringify(c.servers[0]))); }, /duplicate server/);
bad('duplicate car id', (c) => { c.content.cars.push({ ...c.content.cars[0] }); }, /duplicate car/);
bad('duplicate track id', (c) => { c.content.tracks.push({ ...c.content.tracks[0] }); }, /duplicate track/);
bad('duplicate archive id', (c) => { c.archives.push({ ...c.archives[0] }); }, /duplicate archive/);
bad('duplicate layout', (c) => { c.content.tracks[0].layouts.push({ config: 'alt' }); }, /duplicate layout/);
bad('car id with traversal', (c) => { c.content.cars[0].id = '..'; }, /safe folder/);
bad('car id with slash', (c) => { c.content.cars[0].id = 'a/b'; }, /safe folder/);
bad('car id with backslash', (c) => { c.content.cars[0].id = 'a\\b'; }, /safe folder/);
bad('layout with traversal', (c) => { c.content.tracks[0].layouts[1].config = '../x'; }, /layouts\[1\]/);

// dangling references
bad('server references unknown car', (c) => { c.servers[0].cars.push({ carId: 'ghost', role: 'player' }); }, /unknown car/);
bad('server references unknown track', (c) => { c.servers[0].tracks[0].trackId = 'ghost'; }, /unknown track/);
bad('server references undefined layout', (c) => { c.servers[0].tracks[0].layouts = ['nope']; }, /not defined by track/);
bad('car references unknown archive', (c) => { c.content.cars[0].origin.archiveId = 'ghost'; }, /unknown archive/);
bad('server with no tracks', (c) => { c.servers[0].tracks = []; }, /tracks/);

// hashes & sizes
bad('archive sha not hex', (c) => { c.archives[0].sha256 = 'XYZ'; }, /sha256/);
bad('archive sha uppercase', (c) => { c.archives[0].sha256 = H('x').toUpperCase(); }, /sha256/);
bad('archive sha short', (c) => { c.archives[0].sha256 = H('x').slice(0, 63); }, /sha256/);
bad('archive zero bytes', (c) => { c.archives[0].bytes = 0; }, /bytes/);
bad('archive over 16 GiB', (c) => { c.archives[0].bytes = 17 * 1024 ** 3; }, /bytes/);
bad('archive fractional bytes', (c) => { c.archives[0].bytes = 1.5; }, /bytes/);
bad('track marker sha bad', (c) => { c.content.tracks[0].verify.markerSha256 = 'abc'; }, /markerSha256/);
bad('track marker with path', (c) => { c.content.tracks[0].verify.markerFile = '../x.ai'; }, /markerFile/);
bad('car identity sha bad', (c) => { c.content.cars[0].identity.dataAcdSha256 = 'nope'; }, /dataAcdSha256/);
ok('track verify may be null', validateCatalog(validCatalog((c) => { c.content.tracks[0].verify = null; })).ok);
bad('archive fileName with parent path', (c) => { c.archives[0].fileName = '../evil.7z'; }, /fileName/);
bad('archive fileName with slash', (c) => { c.archives[0].fileName = 'a/b.7z'; }, /fileName/);
bad('archive format unknown', (c) => { c.archives[0].format = 'exe'; }, /format/);

// download rules
bad('archive http url in production', (c) => { c.archives[0].url = 'http://dl.example.com/pack.7z'; }, /https/);
bad('archive url host not in allowedHosts', (c) => { c.archives[0].url = 'https://evil.example.net/pack.7z'; }, /allowedHosts/);
bad('allowedHosts with wildcard', (c) => { c.archives[0].allowedHosts = ['*.example.com']; }, /allowedHosts/);
bad('allowedHosts with scheme', (c) => { c.archives[0].allowedHosts = ['https://dl.example.com']; }, /allowedHosts/);
bad('archive url not a url', (c) => { c.archives[0].url = 'not a url'; }, /url/);
ok('archive url null (manual) accepted', validateCatalog(validCatalog((c) => { c.archives[0].url = null; })).ok);
bad('redistribution invalid', (c) => { c.archives[0].redistribution = 'sure'; }, /redistribution/);
ok('redistribution none + url warns', (() => { const r = validateCatalog(validCatalog((c) => { c.archives[0].redistribution = 'none'; })); return r.ok && r.warnings.some((w) => /redistribution/.test(w)); })());
bad('provider homepage not https', (c) => { c.archives[0].provider.homepage = 'http://example.com'; }, /provider/);
bad('origin path traversal', (c) => { c.content.cars[0].origin.path = '../../x'; }, /unsafe path/);
bad('origin absolute path', (c) => { c.content.cars[0].origin.path = '/etc/passwd'; }, /unsafe path/);
bad('origin drive path', (c) => { c.content.cars[0].origin.path = 'C:/Windows'; }, /unsafe path/);
bad('origin backslash path', (c) => { c.content.cars[0].origin.path = 'a\\b'; }, /unsafe path/);
ok('origin nested path accepted', validateCatalog(validCatalog((c) => { c.content.cars[0].origin.path = 'content/cars/car_a'; })).ok);
bad('origin unknown kind', (c) => { c.content.cars[0].origin.kind = 'script'; }, /origin\.kind/);
bad('manual origin without instructions', (c) => { c.content.cars[0].origin = { kind: 'manual' }; }, /instructions/);
bad('dlc origin without name', (c) => { c.content.cars[0].origin = { kind: 'dlc' }; }, /name/);

// endpoints & LAN leakage
bad('port out of range', (c) => { c.servers[0].connection.public.gamePort = 70000; }, /gamePort/);
bad('port zero', (c) => { c.servers[0].connection.public.httpPort = 0; }, /httpPort/);
bad('host with scheme', (c) => { c.servers[0].connection.public.host = 'http://x.com'; }, /host/);
const LEAK = /private|loopback|local/;
bad('production: private LAN host', (c) => { c.servers[0].connection.public.host = '192.168.1.20'; }, LEAK);
bad('production: 10.x host', (c) => { c.servers[0].connection.public.host = '10.0.0.5'; }, LEAK);
bad('production: loopback host', (c) => { c.servers[0].connection.public.host = '127.0.0.1'; }, LEAK);
bad('production: localhost', (c) => { c.servers[0].connection.public.host = 'localhost'; }, LEAK);
bad('production: .local', (c) => { c.servers[0].connection.public.host = 'box.local'; }, LEAK);
bad('production: LAN address hidden in description', (c) => { c.servers[0].description = 'join at 172.16.4.4 today'; }, LEAK);
bad('production: LAN address in notice', (c) => { c.notice = 'dev box 192.168.0.9'; }, LEAK);
bad('production: LAN address in unknown field', (c) => { c.servers[0].extra = { note: '10.1.2.3' }; }, LEAK);
bad('production: LAN address in a key', (c) => { c.servers[0]['192.168.1.1'] = 1; }, LEAK);
bad('production: lan endpoint block', (c) => { c.servers[0].connection.lan = { host: '192.168.1.5', gamePort: 9600, httpPort: 8081 }; }, /LAN endpoint/);
bad('production: private http archive', (c) => { c.archives[0].url = 'http://192.168.1.2/pack.7z'; c.archives[0].allowedHosts = ['192.168.1.2']; }, /https|private/);
ok('public IP accepted in production', validateCatalog(validCatalog((c) => { c.servers[0].connection.public.host = '203.0.113.7'; })).ok);
ok('public endpoint may be null', validateCatalog(validCatalog((c) => { c.servers[0].connection.public = null; })).ok);
const dev = (m) => validCatalog((c) => { c.catalog.environment = 'development'; if (m) m(c); });
ok('development: lan endpoint allowed', validateCatalog(dev((c) => { c.servers[0].connection.lan = { host: '192.168.1.5', gamePort: 9600, httpPort: 8081 }; })).ok);
ok('development: private http archive allowed', validateCatalog(dev((c) => { c.archives[0].url = 'http://192.168.1.2/pack.7z'; c.archives[0].allowedHosts = ['192.168.1.2']; })).ok);
ok('development: public http archive still refused', !validateCatalog(dev((c) => { c.archives[0].url = 'http://dl.example.com/pack.7z'; })).ok);

// CSP, hud, companion
bad('csp bad minimumVersion', (c) => { c.servers[0].requirements.csp.minimumVersion = 'latest'; }, /csp/);
bad('csp missing key', (c) => { delete c.servers[0].requirements.csp; }, /csp/);
ok('csp null accepted', validateCatalog(validCatalog((c) => { c.servers[0].requirements.csp = null; })).ok);
ok('unknown companion app warns, not fails', (() => { const r = validateCatalog(validCatalog((c) => { c.servers[0].companionApps = ['srp_board', 'evil_app']; })); return r.ok && r.warnings.some((w) => /evil_app/.test(w)); })());
bad('companionApps not array', (c) => { c.servers[0].companionApps = 'srp_board'; }, /companionApps/);
bad('bad hud delivery', (c) => { c.servers[0].hud = { delivery: 'exe', version: '1' }; }, /hud/);
bad('bad status', (c) => { c.servers[0].status = 'nuked'; }, /status/);
bad('bad car role', (c) => { c.servers[0].cars[0].role = 'admin'; }, /role/);
bad('skin traversal', (c) => { c.servers[0].cars[0].skins = ['../x']; }, /skins/);
bad('duplicate car on a server', (c) => { c.servers[0].cars.push({ carId: 'car_a', role: 'player' }); }, /duplicate car/);

// limits
bad('oversize string', (c) => { c.servers[0].description = 'x'.repeat(5000); }, /description|longer/);
bad('too many servers', (c) => { c.servers = Array.from({ length: 51 }, (_, i) => ({ ...c.servers[0], id: 's' + i })); }, /too many/);

// warnings
ok('unused content warns', (() => {
  const r = validateCatalog(validCatalog((c) => {
    c.servers[0].cars = [c.servers[0].cars[0]];
    c.content.cars.push({ id: 'unused', name: 'U', version: null, origin: { kind: 'base-game' }, identity: { dataAcdSha256: null, uiCarJsonSha256: null } });
  }));
  return r.ok && r.warnings.some((w) => /not used/.test(w));
})());

// helpers
ok('isSafeRelPath good', isSafeRelPath('content/cars/x') && isSafeRelPath('a'));
ok('isSafeRelPath bad', !isSafeRelPath('') && !isSafeRelPath('/a') && !isSafeRelPath('a//b') && !isSafeRelPath('a/../b') && !isSafeRelPath('./a') && !isSafeRelPath('a\\b') && !isSafeRelPath('c:x'));
ok('isPrivateOrLocalString', isPrivateOrLocalString('192.168.0.1') && isPrivateOrLocalString('http://localhost:8787') && isPrivateOrLocalString('x fe80::1') && !isPrivateOrLocalString('play.example.com 203.0.113.9'));
ok('error list bounded', (() => { const r = validateCatalog(validCatalog((c) => { c.servers = Array.from({ length: 50 }, (_, i) => ({ id: '!' + i })); })); return !r.ok && r.errors.length <= 100; })());

console.log(`\nAC CATALOG SCHEMA TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
