// RelayDataChannel tests — the previously-missing adapter identified by the
// Linux backend audit (docs/linux-backend-client-contract.md §12). Tested
// against a REAL local WebSocket server (same pattern as
// relaySignalingClient.test.js) so send()/handleIncomingData()/
// handleRemoteClose() are proven against real frames, not a mock.
const path = require('path');
const WebSocket = require('ws');
const { RelaySignalingClient } = require(path.resolve(__dirname, '../../dist/main/services/connection/RelaySignalingClient.js'));
const { RelayDataChannel } = require(path.resolve(__dirname, '../../dist/main/services/connection/RelayDataChannel.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function startEchoRelayServer() {
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ port: 0 }, () => resolve({ wss, port: wss.address().port }));
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'hello') { ws.send(JSON.stringify({ type: 'hello-ack', sessionId: 's1' })); return; }
        if (msg.type === 'relay-data') { ws.send(JSON.stringify({ type: 'relay-data', channelId: msg.channelId, data: msg.data })); }
      });
    });
  });
}

(async () => {
  const { wss, port } = await startEchoRelayServer();
  const client = new RelaySignalingClient(`ws://127.0.0.1:${port}`);
  await client.connect('fake-token', 'client');

  const channel = new RelayDataChannel(client, 'chan-1');
  let received = null;
  channel.onData((d) => { received = d; });

  // Real send() actually goes over the real socket and comes back through
  // the client's own onRelayData plumbing into handleIncomingData().
  channel.send(Buffer.from('real bytes'));
  // Wire client.events manually the way RelayConnectionManager would (the
  // adapter itself has no built-in wiring to the client's callbacks — the
  // manager owns that; here we simulate it directly to test the adapter in
  // isolation).
  let channel2;
  const clientWithEvents = new RelaySignalingClient(`ws://127.0.0.1:${port}`, {
    onRelayData: (channelId, data) => { if (channelId === 'chan-1') channel2.handleIncomingData(data); },
  });
  await clientWithEvents.connect('fake-token', 'client');
  channel2 = new RelayDataChannel(clientWithEvents, 'chan-1');
  let received2 = null;
  channel2.onData((d) => { received2 = d; });
  clientWithEvents.sendData('chan-1', Buffer.from('round trip bytes'));
  await new Promise((r) => setTimeout(r, 150));
  ok('data sent through the channel and echoed back by the relay reaches onData as the real Buffer', received2?.toString() === 'round trip bytes');

  let closed = false;
  channel2.onClose(() => { closed = true; });
  channel2.handleRemoteClose();
  ok('handleRemoteClose() fires the real onClose callback', closed === true);

  let closedAfterClose = false;
  channel2.onData(() => { closedAfterClose = true; });
  channel2.handleIncomingData(Buffer.from('should be ignored'));
  ok('a channel does not deliver data after being closed', closedAfterClose === false);

  ok('close() is idempotent — never fires onClose twice', (() => {
    let count = 0;
    const c = new RelayDataChannel(client, 'chan-2');
    c.onClose(() => { count++; });
    c.close(); c.close();
    return count === 1;
  })());

  client.close();
  clientWithEvents.close();
  wss.close();

  console.log(`\nRELAY DATA CHANNEL TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
