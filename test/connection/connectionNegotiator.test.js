// ConnectionNegotiator tests — deterministic against a fake PortMapper (no
// real router), plus a REAL loopback TCP reachability check (genuinely
// real sockets on 127.0.0.1, no fakery needed for that part).
const net = require('net');
const path = require('path');
const { ConnectionNegotiator } = require(path.resolve(__dirname, '../../dist/main/services/connection/ConnectionNegotiator.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function fakeMapper(result) { return { mapPort: async () => result, unmapPort: async () => {} }; }

(async () => {
  // ── LAN address alone (no listening port yet — never attempts UPnP for
  //    a port nothing is actually listening on) ──────────────────────────
  const neg1 = new ConnectionNegotiator(fakeMapper({ success: false, reason: 'should never be called' }));
  const plan1 = await neg1.planHostEndpoint({ lanAddress: '192.168.1.50', port: 25565, portListening: false }, false);
  ok('a LAN address alone is offered as a real candidate even when the port isn\'t confirmed listening yet', plan1.candidates.some((c) => c.strategy === 'lan-direct' && c.address === '192.168.1.50:25565'));

  // ── LAN address + successful UPnP mapping — both real candidates ───────
  const neg2 = new ConnectionNegotiator(fakeMapper({ success: true, externalAddress: '203.0.113.9', externalPort: 25565 }));
  const plan2 = await neg2.planHostEndpoint({ lanAddress: '192.168.1.50', port: 25565, portListening: true }, false);
  ok('a successful UPnP mapping is offered as a real upnp-direct candidate with the real external address', plan2.candidates.some((c) => c.strategy === 'upnp-direct' && c.address === '203.0.113.9:25565'));
  ok('both a LAN and a UPnP candidate can be offered together — real, independent options', plan2.candidates.length === 2);

  // ── No LAN address, UPnP fails, no relay configured — honest failure ───
  const neg3 = new ConnectionNegotiator(fakeMapper({ success: false, reason: 'No UPnP-capable gateway responded on the local network.' }));
  const plan3 = await neg3.planHostEndpoint({ lanAddress: null, port: 25565, portListening: true }, false);
  ok('with no working candidate and no relay configured, the plan is honestly empty, never a fabricated address', plan3.candidates.length === 0);
  ok('the honest "no relay available" explanation is present and says relay is unavailable, matching assessConnectivity\'s own wording', /no relay/i.test(plan3.unavailableExplanation || ''));
  ok('relayAvailable correctly reflects that no relay is configured', plan3.relayAvailable === false);

  // ── No candidates, but a relay IS configured — no fabricated explanation ─
  const neg4 = new ConnectionNegotiator(fakeMapper({ success: false, reason: 'no gateway' }));
  const plan4 = await neg4.planHostEndpoint({ lanAddress: null, port: 25565, portListening: true }, true);
  ok('when a relay is actually configured, relayAvailable is true and no confusing "unavailable" text is shown', plan4.relayAvailable === true && plan4.unavailableExplanation === null);

  // ── UPnP is never attempted when the port isn't listening at all ───────
  let upnpCalled = false;
  const trackingMapper = { mapPort: async () => { upnpCalled = true; return { success: false }; }, unmapPort: async () => {} };
  const neg5 = new ConnectionNegotiator(trackingMapper);
  await neg5.planHostEndpoint({ lanAddress: null, port: 25565, portListening: false }, false);
  ok('UPnP mapping is never attempted for a port that isn\'t actually listening — would be pointless and misleading', upnpCalled === false);

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
