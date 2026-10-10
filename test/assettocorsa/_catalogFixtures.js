// Disposable catalog fixtures. Everything here is synthetic (example.com / TEST-NET addresses) — never real server data.
const crypto = require('crypto');
const H = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** A minimal, fully valid production catalog. Pass a `mutate(cat)` callback to alter it. */
function validCatalog(mutate) {
  const cat = {
    schema: 'mercy.ac.catalog', schemaVersion: '1.0.0',
    catalog: { id: 'test', revision: 1, generatedAt: '2030-01-01T00:00:00Z', environment: 'production' },
    servers: [{
      id: 'srv-a', displayName: 'Server A', description: 'Test server',
      engine: { type: 'kunos-stock' }, maxPlayers: 10,
      connection: { public: { host: 'play.example.com', gamePort: 9600, httpPort: 8081 } },
      tracks: [{ trackId: 'trk_one', layouts: ['', 'alt'] }],
      cars: [{ carId: 'car_a', role: 'player' }, { carId: 'ks_base', role: 'player' }, { carId: 'car_opt', role: 'traffic', required: false }],
      requirements: { csp: { required: true, minimumVersion: '0.1.76' } }, companionApps: ['srp_board'],
    }],
    content: {
      cars: [
        { id: 'car_a', name: 'Car A', version: '1.0', origin: { kind: 'archive', archiveId: 'pack' }, identity: { dataAcdSha256: H('a'), uiCarJsonSha256: H('ui') } },
        { id: 'car_opt', name: 'Car Opt', version: null, origin: { kind: 'archive', archiveId: 'pack' }, identity: { dataAcdSha256: H('o'), uiCarJsonSha256: null } },
        { id: 'ks_base', name: 'Base Car', version: null, origin: { kind: 'base-game' }, identity: { dataAcdSha256: null, uiCarJsonSha256: null } },
      ],
      tracks: [{ id: 'trk_one', name: 'Track One', version: '1', origin: { kind: 'archive', archiveId: 'pack' }, verify: { markerFile: 'marker.ai', markerSha256: H('m') }, layouts: [{ config: '' }, { config: 'alt', uiTrackJsonSha256: H('l') }] }],
    },
    archives: [{
      id: 'pack', name: 'Pack', fileName: 'pack.7z', format: '7z', bytes: 1234, sha256: H('pack'),
      url: 'https://dl.example.com/pack.7z', allowedHosts: ['dl.example.com'],
      provider: { name: 'Example', homepage: 'https://example.com' }, redistribution: 'provider-official',
    }],
  };
  if (mutate) mutate(cat);
  return cat;
}
module.exports = { validCatalog, H };
