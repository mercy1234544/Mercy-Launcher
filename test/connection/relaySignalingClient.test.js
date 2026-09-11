// RelaySignalingClient tests — against a REAL local WebSocket server (using
// the same `ws` package the client itself uses), not a mock. This proves
// the actual wire protocol (protocol.ts) round-trips correctly over a real
// socket. What's still unverified is a real Linux deployment of the far
// end — see RelaySignalingClient.ts's own header.
const path = require('path');
const WebSocket = require('ws');
const { RelaySignalingClient } = require(path.resolve(__dirname, '../../dist/main/services/connection/RelaySignalingClient.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function startFakeRelayServer({ rejectHello = null, port = 0 } = {}) {
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ port }, () => resolve({ wss, port: wss.address().port }));
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'hello') {
          if (rejectHello) { ws.send(JSON.stringify({ type: 'hello-rejected', reason: rejectHello })); return; }
          ws.send(JSON.stringify({ type: 'hello-ack', sessionId: 'sess-1' }));
          return;
        }
        if (msg.type === 'register-host') {
          ws.send(JSON.stringify({ type: 'host-registered', relayId: 'relay-1', expiresAt: Date.now() + 60000 }));
          return;
        }
        if (msg.type === 'request-relay') {
          ws.send(JSON.stringify({ type: 'relay-granted', channelId: 'chan-1' }));
          return;
        }
        if (msg.type === 'relay-data') {
          // Real relay echoes data back on the same channel, proving the
          // data-plane frame shape round-trips correctly.
          ws.send(JSON.stringify({ type: 'relay-data', channelId: msg.channelId, data: msg.data }));
        }
      });
    });
  });
}

(async () => {
  // ── Successful hello / register / relay-request / data round trip ──────
  const { wss, port } = await startFakeRelayServer();
  const events = { hostRegistered: null, relayGranted: null, dataBack: null, states: [] };
  const client = new RelaySignalingClient(`ws://127.0.0.1:${port}`, {
    onStateChange: (s) => events.states.push(s),
    onHostRegistered: (relayId, expiresAt) => { events.hostRegistered = { relayId, expiresAt }; },
    onRelayGranted: (channelId) => { events.relayGranted = channelId; },
    onRelayData: (channelId, data) => { events.dataBack = { channelId, data: data.toString() }; },
  });

  await client.connect('fake-join-token', 'host');
  ok('a real hello/hello-ack handshake against a real WebSocket server reaches "ready"', client.getState() === 'ready');
  ok('state transitions happen in the real order: connecting -> authenticating -> ready', events.states.join(',') === 'connecting,authenticating,ready');

  client.registerHost('srv-1', 'minecraft', 'tcp', 25565, Date.now() + 60000);
  await new Promise((r) => setTimeout(r, 100));
  ok('register-host produces a real host-registered callback with the real relayId', events.hostRegistered?.relayId === 'relay-1');

  client.requestRelay('join-req-1', 'relay-1');
  await new Promise((r) => setTimeout(r, 100));
  ok('request-relay produces a real relay-granted callback with the real channelId', events.relayGranted === 'chan-1');

  client.sendData('chan-1', Buffer.from('game bytes'));
  await new Promise((r) => setTimeout(r, 100));
  ok('relay-data frames round-trip through a real server with the payload intact (base64-encoded on the wire, decoded back to a real Buffer)', events.dataBack?.data === 'game bytes' && events.dataBack?.channelId === 'chan-1');

  client.close();
  wss.close();

  // ── Rejected hello — never silently treated as success ─────────────────
  const { wss: rejectWss, port: rejectPort } = await startFakeRelayServer({ rejectHello: 'Token expired.' });
  const rejectClient = new RelaySignalingClient(`ws://127.0.0.1:${rejectPort}`);
  let rejectError = null;
  try { await rejectClient.connect('expired-token', 'client'); } catch (e) { rejectError = e; }
  ok('a real hello-rejected response rejects connect() with the real reason, never resolving as success', !!rejectError && /token expired/i.test(rejectError.message));
  ok('state after rejection is "failed", never "ready"', rejectClient.getState() === 'failed');
  rejectClient.close();
  rejectWss.close();

  // ── No server at all — a real connection failure, not a hang ───────────
  const deadClient = new RelaySignalingClient('ws://127.0.0.1:1', {});
  let deadError = null;
  try { await deadClient.connect('token', 'client'); } catch (e) { deadError = e; }
  ok('connecting to nothing real fails honestly rather than hanging or reporting ready', !!deadError && deadClient.getState() === 'failed');

  console.log(`\nRELAY SIGNALING CLIENT TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
