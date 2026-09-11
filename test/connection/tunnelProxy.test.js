// TunnelProxy tests — REAL TCP sockets end-to-end (a real local TCP "game
// server" stand-in, a real host-mode proxy, a real client-mode proxy, and a
// real TCP client), with only the relay hop itself faked via
// createLoopbackChannelPair() (there is no deployed relay to test against —
// see TunnelProxy.ts's own header). This proves the actual byte-forwarding
// logic is correct, not just that the types compile.
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const { TunnelProxy, createLoopbackChannelPair } = require(path.resolve(__dirname, '../../dist/main/services/connection/TunnelProxy.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function startEchoServer() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => { sock.on('data', (d) => sock.write(d)); });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  const { server: echoServer, port: echoPort } = await startEchoServer();
  const [hostChannel, clientChannel] = createLoopbackChannelPair();

  const hostProxy = new TunnelProxy({ mode: 'host', targetPort: echoPort, channel: hostChannel });
  await hostProxy.start();

  const clientListenPort = 38000 + Math.floor(Math.random() * 1000);
  const clientProxy = new TunnelProxy({ mode: 'client', listenPort: clientListenPort, channel: clientChannel });
  await clientProxy.start();

  // A real TCP client connects to the CLIENT proxy's local port, exactly as
  // a real game client would connect to what it believes is the server.
  const roundTrip = await new Promise((resolve, reject) => {
    const gameClient = net.createConnection({ host: '127.0.0.1', port: clientListenPort }, () => {
      gameClient.write(Buffer.from('hello mercy tunnel'));
    });
    let received = Buffer.alloc(0);
    gameClient.on('data', (d) => {
      received = Buffer.concat([received, d]);
      if (received.length >= Buffer.byteLength('hello mercy tunnel')) { gameClient.end(); resolve(received.toString()); }
    });
    gameClient.on('error', reject);
    setTimeout(() => reject(new Error('timed out waiting for round trip')), 5000);
  });

  ok('data written by a real TCP client reaches the real echo "game server" through both tunnel proxies and comes back unmodified', roundTrip === 'hello mercy tunnel');

  hostProxy.stop();
  clientProxy.stop();

  // Each relay-granted channel (see protocol.ts's RequestRelayMessage) is
  // its own independent connection — closing one tunnel must not affect a
  // fresh, independent pair for a SECOND real connection.
  const [hostChannel2, clientChannel2] = createLoopbackChannelPair();
  const hostProxy2 = new TunnelProxy({ mode: 'host', targetPort: echoPort, channel: hostChannel2 });
  await hostProxy2.start();
  const clientListenPort2 = clientListenPort + 1;
  const clientProxy2 = new TunnelProxy({ mode: 'client', listenPort: clientListenPort2, channel: clientChannel2 });
  await clientProxy2.start();

  const secondRoundTrip = await new Promise((resolve, reject) => {
    const gameClient2 = net.createConnection({ host: '127.0.0.1', port: clientListenPort2 }, () => {
      gameClient2.write(Buffer.from('second message'));
    });
    let received = Buffer.alloc(0);
    gameClient2.on('data', (d) => {
      received = Buffer.concat([received, d]);
      if (received.length >= Buffer.byteLength('second message')) { gameClient2.end(); resolve(received.toString()); }
    });
    gameClient2.on('error', reject);
    setTimeout(() => reject(new Error('timed out')), 5000);
  });
  ok('a second, independent tunnel pair (a separate relay channel) also round-trips correctly', secondRoundTrip === 'second message');

  hostProxy2.stop();
  clientProxy2.stop();
  echoServer.close();

  // ── UDP transport (Bedrock) — real dgram sockets end-to-end. Bedrock is
  // RakNet-over-UDP; a TCP-only proxy would be structurally incapable of
  // carrying it (see TunnelProxy.ts's own header) — this proves the UDP
  // reflector path actually forwards real datagrams both ways. ───────────
  const udpEchoServer = dgram.createSocket('udp4');
  udpEchoServer.on('message', (msg, rinfo) => udpEchoServer.send(msg, rinfo.port, rinfo.address));
  const udpEchoPort = await new Promise((resolve) => udpEchoServer.bind(0, '127.0.0.1', () => resolve(udpEchoServer.address().port)));

  const [udpHostChannel, udpClientChannel] = createLoopbackChannelPair();
  const udpHostProxy = new TunnelProxy({ mode: 'host', transport: 'udp', targetPort: udpEchoPort, channel: udpHostChannel });
  await udpHostProxy.start();
  const udpListenPort = 39000 + Math.floor(Math.random() * 1000);
  const udpClientProxy = new TunnelProxy({ mode: 'client', transport: 'udp', listenPort: udpListenPort, channel: udpClientChannel });
  await udpClientProxy.start();

  const udpRoundTrip = await new Promise((resolve, reject) => {
    const gameClient = dgram.createSocket('udp4');
    gameClient.on('message', (msg) => { gameClient.close(); resolve(msg.toString()); });
    gameClient.send(Buffer.from('bedrock raknet packet'), udpListenPort, '127.0.0.1');
    setTimeout(() => reject(new Error('timed out waiting for UDP round trip')), 5000);
  });
  ok('a real UDP datagram reaches the real echo "Bedrock server" through both UDP tunnel proxies and comes back unmodified', udpRoundTrip === 'bedrock raknet packet');

  udpHostProxy.stop();
  udpClientProxy.stop();
  udpEchoServer.close();

  console.log(`\nTUNNEL PROXY TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
