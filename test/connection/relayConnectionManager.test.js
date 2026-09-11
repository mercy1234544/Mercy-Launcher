// RelayConnectionManager tests — the full local wiring chain, end to end:
// two independent RelayConnectionManager instances (simulating the HOST's
// and the REQUESTER's own separate Mercy Launcher processes), talking
// through one fake-but-real local WebSocket relay server that implements
// just enough of protocol.ts to pair a host registration with a client's
// request-relay (see this file's own startFakeRelay() for the documented
// interpretation of the one underspecified point in protocol.ts: a
// relay-granted message is sent to BOTH the requesting client's socket AND
// the host's own registered socket, since the protocol defines no separate
// host-notification message — see docs/linux-backend-client-contract.md §7).
//
// What this proves: real bytes flow HOST'S real local TCP "game server" →
// host TunnelProxy → host RelaySignalingClient → fake relay → client
// RelaySignalingClient → client TunnelProxy → a real TCP client, and back.
// What this does NOT prove: that the actual Linux relay at
// /home/harperlinux/mercy-launcher/ behaves identically — this repo has no
// access to that machine. This is a real, deterministic, local integration
// test, not a claimed cross-machine test (see Step 13's own requirement not
// to fabricate one).
const net = require('net');
const path = require('path');
const WebSocket = require('ws');
const { RelayConnectionManager } = require(path.resolve(__dirname, '../../dist/main/services/connection/RelayConnectionManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function startFakeRelay() {
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ port: 0 }, () => resolve({ wss, port: wss.address().port }));
    const hostSockets = new Map();
    const channelPairs = new Map();
    let relayCounter = 0, channelCounter = 0;
    wss.on('connection', (ws) => {
      // A real relay must free a host's registration on disconnect (Phase
      // 4 point 9 — cleanup must not depend on an explicit unregister-host).
      // This fake relay mirrors that so teardownHost() is actually testable.
      ws.on('close', () => {
        for (const [relayId, hostWs] of hostSockets) if (hostWs === ws) hostSockets.delete(relayId);
      });
      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'hello') {
          if (msg.token === 'REJECT_ME') { ws.send(JSON.stringify({ type: 'hello-rejected', reason: 'Invalid token.' })); return; }
          ws.send(JSON.stringify({ type: 'hello-ack', sessionId: 'sess-1' }));
          return;
        }
        if (msg.type === 'register-host') {
          const relayId = `relay-${++relayCounter}`;
          hostSockets.set(relayId, ws);
          ws.send(JSON.stringify({ type: 'host-registered', relayId, expiresAt: msg.expiresAt }));
          return;
        }
        if (msg.type === 'request-relay') {
          const hostWs = hostSockets.get(msg.relayId);
          if (!hostWs) { ws.send(JSON.stringify({ type: 'relay-denied', reason: 'Unknown relayId.' })); return; }
          const channelId = `chan-${++channelCounter}`;
          channelPairs.set(channelId, { hostWs, clientWs: ws });
          ws.send(JSON.stringify({ type: 'relay-granted', channelId }));
          hostWs.send(JSON.stringify({ type: 'relay-granted', channelId }));
          return;
        }
        if (msg.type === 'relay-data') {
          const pair = channelPairs.get(msg.channelId);
          if (!pair) return;
          const other = pair.hostWs === ws ? pair.clientWs : pair.hostWs;
          other.send(JSON.stringify({ type: 'relay-data', channelId: msg.channelId, data: msg.data }));
        }
      });
    });
    return { wss };
  });
}

function startEchoServer() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => sock.on('data', (d) => sock.write(d)));
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  const { wss, port: relayPort } = await startFakeRelay();
  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  const { server: echoServer, port: echoPort } = await startEchoServer();

  // ── Full pairing + real byte forwarding, HOST's and REQUESTER's own
  //    independent RelayConnectionManager instances ─────────────────────
  const hostManager = new RelayConnectionManager(relayUrl);
  const hostResult = await hostManager.ensureHostRegistered('srv-1', 'minecraft', 'tcp', echoPort, 'host-token');
  ok('a real host registration against a real (fake) relay succeeds with a real relayId', hostResult.success === true && !!hostResult.relayId);

  const requesterManager = new RelayConnectionManager(relayUrl);
  const clientListenPort = 41000 + Math.floor(Math.random() * 1000);
  const clientResult = await requesterManager.connectViaRelay('join-req-1', hostResult.relayId, 'client-token', 'tcp', clientListenPort);
  ok('a real client relay request against the real registered relayId succeeds with a real local address', clientResult.success === true && clientResult.localAddress === `127.0.0.1:${clientListenPort}`);

  const roundTrip = await new Promise((resolve, reject) => {
    const gameClient = net.createConnection({ host: '127.0.0.1', port: clientListenPort }, () => {
      gameClient.write(Buffer.from('mercy relay end to end'));
    });
    let received = Buffer.alloc(0);
    gameClient.on('data', (d) => {
      received = Buffer.concat([received, d]);
      if (received.length >= Buffer.byteLength('mercy relay end to end')) { gameClient.end(); resolve(received.toString()); }
    });
    gameClient.on('error', reject);
    setTimeout(() => reject(new Error('timed out')), 5000);
  });
  ok('real bytes flow: TCP client -> client TunnelProxy -> relay -> host TunnelProxy -> real local "game server" -> and all the way back', roundTrip === 'mercy relay end to end');

  // ── Idempotent host registration ────────────────────────────────────────
  const secondCall = await hostManager.ensureHostRegistered('srv-1', 'minecraft', 'tcp', echoPort, 'host-token');
  ok('registering the same serverId again while still connected reuses the existing registration (no duplicate round trip)', secondCall.success === true && secondCall.relayId === hostResult.relayId);

  // ── Cleanup ──────────────────────────────────────────────────────────────
  hostManager.teardownHost('srv-1');
  const afterTeardown = await requesterManager.connectViaRelay('join-req-2', hostResult.relayId, 'client-token', 'tcp', clientListenPort + 1);
  ok('after the host tears down, a new relay request against the same relayId is honestly denied, not silently accepted', afterTeardown.success === false);

  // ── Honest failure paths ─────────────────────────────────────────────────
  const badTokenManager = new RelayConnectionManager(relayUrl);
  const rejectedHost = await badTokenManager.ensureHostRegistered('srv-2', 'minecraft', 'tcp', echoPort, 'REJECT_ME');
  ok('a rejected session token produces an honest host-registration failure, never a fabricated relayId', rejectedHost.success === false && !!rejectedHost.reason);

  const unreachableManager = new RelayConnectionManager('ws://127.0.0.1:1');
  const unreachableResult = await unreachableManager.ensureHostRegistered('srv-3', 'minecraft', 'tcp', echoPort, 'token');
  ok('an unreachable relay produces an honest failure, never hangs or fabricates success', unreachableResult.success === false);

  const notConfiguredManager = new RelayConnectionManager(null);
  const notConfiguredResult = await notConfiguredManager.ensureHostRegistered('srv-4', 'minecraft', 'tcp', echoPort, 'token');
  ok('with no relay configured at all, ensureHostRegistered fails honestly without attempting any network call', notConfiguredResult.success === false && /no mercy relay is configured/i.test(notConfiguredResult.reason));
  ok('isConfigured() correctly reflects whether a relay URL was actually provided', notConfiguredManager.isConfigured() === false && hostManager.isConfigured() === true);

  const deniedRelayId = await requesterManager.connectViaRelay('join-req-3', 'not-a-real-relay-id', 'client-token', 'tcp', clientListenPort + 2);
  ok('requesting relay for an unregistered relayId is honestly denied', deniedRelayId.success === false);

  wss.close();
  echoServer.close();

  console.log(`\nRELAY CONNECTION MANAGER TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
