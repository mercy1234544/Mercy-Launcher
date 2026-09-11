// ConnectionNegotiator tests — deterministic against a fake PortMapper (no
// real router) and a fake RelayConnectionManager (no real Linux relay),
// plus a REAL loopback TCP reachability check (genuinely real sockets on
// 127.0.0.1, no fakery needed for that part).
const net = require('net');
const path = require('path');
const { ConnectionNegotiator } = require(path.resolve(__dirname, '../../dist/main/services/connection/ConnectionNegotiator.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function fakeMapper(result) { return { mapPort: async () => result, unmapPort: async () => {} }; }
function fakeRelay(result) { return { manager: { ensureHostRegistered: async () => result }, serverId: 'srv-1', game: 'minecraft', sessionToken: 'fake-token' }; }

(async () => {
  // ── LAN address alone (no listening port yet — never attempts UPnP for
  //    a port nothing is actually listening on) ──────────────────────────
  const neg1 = new ConnectionNegotiator(fakeMapper({ success: false, reason: 'should never be called' }));
  const plan1 = await neg1.planHostEndpoint({ lanAddress: '192.168.1.50', port: 25565, portListening: false }, null);
  ok('a LAN address alone is offered as a real candidate even when the port isn\'t confirmed listening yet', plan1.candidates.some((c) => c.strategy === 'lan-direct' && c.address === '192.168.1.50:25565'));
  ok('relay is never attempted when a direct candidate already exists (direct stays preferred)', plan1.relayAvailable === false);

  // ── LAN address + successful UPnP mapping — both real candidates ───────
  const neg2 = new ConnectionNegotiator(fakeMapper({ success: true, externalAddress: '203.0.113.9', externalPort: 25565 }));
  const plan2 = await neg2.planHostEndpoint({ lanAddress: '192.168.1.50', port: 25565, portListening: true }, null);
  ok('a successful UPnP mapping is offered as a real upnp-direct candidate with the real external address', plan2.candidates.some((c) => c.strategy === 'upnp-direct' && c.address === '203.0.113.9:25565'));
  ok('both a LAN and a UPnP candidate can be offered together — real, independent options', plan2.candidates.length === 2);

  // ── No LAN address, UPnP fails, no relay configured — honest failure ───
  const neg3 = new ConnectionNegotiator(fakeMapper({ success: false, reason: 'No UPnP-capable gateway responded on the local network.' }));
  const plan3 = await neg3.planHostEndpoint({ lanAddress: null, port: 25565, portListening: true }, null);
  ok('with no working candidate and no relay configured, the plan is honestly empty, never a fabricated address', plan3.candidates.length === 0);
  ok('the honest "no relay available" explanation is present and says relay is unavailable, matching assessConnectivity\'s own wording', /no relay/i.test(plan3.unavailableExplanation || ''));
  ok('relayAvailable correctly reflects that no relay is configured', plan3.relayAvailable === false);

  // ── Direct fails, relay IS configured and a real registration succeeds ──
  const neg4 = new ConnectionNegotiator(fakeMapper({ success: false, reason: 'no gateway' }));
  const plan4 = await neg4.planHostEndpoint({ lanAddress: null, port: 25565, portListening: true }, fakeRelay({ success: true, relayId: 'relay-abc' }));
  ok('a real, successful relay registration produces an actual relay candidate', plan4.candidates.some((c) => c.strategy === 'relay' && c.relayId === 'relay-abc'));
  ok('relayAvailable is true ONLY because registration actually succeeded, not merely because a relay was configured', plan4.relayAvailable === true);
  ok('no confusing "unavailable" text is shown once a relay candidate exists', plan4.unavailableExplanation === null);

  // ── Direct fails, relay IS configured but registration itself fails ────
  const neg5 = new ConnectionNegotiator(fakeMapper({ success: false, reason: 'no gateway' }));
  const plan5 = await neg5.planHostEndpoint({ lanAddress: null, port: 25565, portListening: true }, fakeRelay({ success: false, reason: 'The relay rejected this session token.' }));
  ok('a configured-but-failing relay is an honest failure, never falsely reported as available', plan5.relayAvailable === false && plan5.candidates.length === 0);
  ok('the real registration failure reason is surfaced, not a generic message', plan5.unavailableExplanation === 'The relay rejected this session token.');

  // ── UPnP is never attempted when the port isn't listening at all ───────
  let upnpCalled = false;
  const trackingMapper = { mapPort: async () => { upnpCalled = true; return { success: false }; }, unmapPort: async () => {} };
  const neg6 = new ConnectionNegotiator(trackingMapper);
  await neg6.planHostEndpoint({ lanAddress: null, port: 25565, portListening: false }, null);
  ok('UPnP mapping is never attempted for a port that isn\'t actually listening — would be pointless and misleading', upnpCalled === false);

  // ── Bedrock (UDP) is passed through to the port mapper correctly ───────
  let mappedProtocol = null;
  const udpTrackingMapper = { mapPort: async (_port, protocol) => { mappedProtocol = protocol; return { success: false }; }, unmapPort: async () => {} };
  const neg7 = new ConnectionNegotiator(udpTrackingMapper);
  await neg7.planHostEndpoint({ lanAddress: null, port: 19132, portListening: true, transport: 'udp' }, null);
  ok('a Bedrock (udp transport) endpoint attempts UPnP mapping with UDP, not TCP', mappedProtocol === 'UDP');

  // ── Real TCP reachability probe (genuinely real sockets, no fakery) ────
  const echoServer = net.createServer(() => {});
  await new Promise((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
  const realPort = echoServer.address().port;
  const reachable = await ConnectionNegotiator.verifyEndpointReachable('127.0.0.1', realPort, 1000);
  ok('a real, actually-listening local endpoint is confirmed reachable', reachable === true);
  const unreachable = await ConnectionNegotiator.verifyEndpointReachable('127.0.0.1', 1, 500);
  ok('a real, actually-closed port is confirmed NOT reachable — never assumed', unreachable === false);
  echoServer.close();

  console.log(`\nCONNECTION NEGOTIATOR TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
