'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');

process.env.SUPABASE_URL = 'http://localhost:0';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
// Fast ping cycle so the timeout test doesn't take 45s+ real time.
process.env.MERCY_API_WS_PING_INTERVAL_MS = '150';
process.env.MERCY_API_WS_PING_TIMEOUT_MS = '250';
process.env.MERCY_API_WS_HELLO_TIMEOUT_MS = '300';

const { _setServiceClientForTesting } = require('../../shared/supabase');
const { makeFakeSupabase } = require('./helpers/fakeSupabaseApi');
const { attachWsServer } = require('../../api/wsServer');
const pubsub = require('../../api/pubsub');

_setServiceClientForTesting(
  makeFakeSupabase({ authUsers: { 'tok-u1': { id: 'u1' }, 'tok-u2': { id: 'u2' } } })
);

function startServer() {
  const server = http.createServer();
  const wss = attachWsServer(server, '/v1/presence/ws');
  server.__wss = wss;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function wsUrl(server) {
  return `ws://127.0.0.1:${server.address().port}/v1/presence/ws`;
}

function once(ws, event) {
  return new Promise((resolve) => ws.once(event, resolve));
}

async function nextMessage(ws) {
  const raw = await once(ws, 'message');
  return JSON.parse(raw.toString());
}

test('presence WebSocket — hello/auth/push/reconnect', async (t) => {
  await t.test('hello with a valid token is accepted', async () => {
    const server = await startServer();
    const ws = new WebSocket(wsUrl(server));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token: 'tok-u1' }));
    const msg = await nextMessage(ws);
    assert.equal(msg.type, 'hello-ack');
    assert.equal(msg.userId, 'u1');
    ws.close();
    await stopServer(server);
  });

  await t.test('hello with an invalid token is explicitly rejected (not silently dropped)', async () => {
    const server = await startServer();
    const ws = new WebSocket(wsUrl(server));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token: 'garbage' }));
    const msg = await nextMessage(ws);
    assert.equal(msg.type, 'hello-rejected');
    assert.equal(msg.code, 'AUTH_ERROR');
    const code = await once(ws, 'close');
    assert.equal(code, 1008);
    await stopServer(server);
  });

  await t.test('missing hello within the hello timeout closes the connection with an explicit reject', async () => {
    const server = await startServer();
    const ws = new WebSocket(wsUrl(server));
    await once(ws, 'open');
    const msg = await nextMessage(ws); // hello-rejected, sent before close
    assert.equal(msg.type, 'hello-rejected');
    await once(ws, 'close');
    await stopServer(server);
  });

  await t.test('client ping/pong echo works independent of the hello state', async () => {
    const server = await startServer();
    const ws = new WebSocket(wsUrl(server));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token: 'tok-u1' }));
    await nextMessage(ws); // hello-ack
    ws.send(JSON.stringify({ type: 'ping', at: 123 }));
    const msg = await nextMessage(ws);
    assert.equal(msg.type, 'pong');
    assert.equal(msg.at, 123);
    ws.close();
    await stopServer(server);
  });

  await t.test('a write elsewhere pushes a typed "changed" event over the live connection', async () => {
    const server = await startServer();
    const ws = new WebSocket(wsUrl(server));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token: 'tok-u1' }));
    await nextMessage(ws); // hello-ack

    pubsub.notify('u1', 'friends');
    const msg = await nextMessage(ws);
    assert.equal(msg.type, 'changed');
    assert.equal(msg.kind, 'friends');
    ws.close();
    await stopServer(server);
  });

  await t.test('a dead connection (no pong) is detected and closed by the server-side ping timeout', async () => {
    const server = await startServer();
    const ws = new WebSocket(wsUrl(server));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token: 'tok-u1' }));
    await nextMessage(ws); // hello-ack
    assert.equal(server.__wss.clients.size, 1);

    // Never answer server pings — simulates a network black hole (the exact
    // ~20-minute failure mode this service exists to detect quickly).
    // Pausing the raw socket stops the client from processing (and
    // auto-answering) any further frames from the server, including pings.
    ws._socket.pause();

    // Poll server-side bookkeeping (not the client, which can no longer see
    // anything) until the dead connection is actually reaped.
    const deadline = Date.now() + 5000;
    while (server.__wss.clients.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(server.__wss.clients.size, 0, 'server must reap a connection that stops answering pings');
    await stopServer(server);
  });

  await t.test('a fresh connection after a close (reconnect) gets its own working hello/push lifecycle', async () => {
    const server = await startServer();
    const first = new WebSocket(wsUrl(server));
    await once(first, 'open');
    first.send(JSON.stringify({ type: 'hello', token: 'tok-u1' }));
    await nextMessage(first);
    first.close();
    await once(first, 'close');

    const second = new WebSocket(wsUrl(server));
    await once(second, 'open');
    second.send(JSON.stringify({ type: 'hello', token: 'tok-u1' }));
    const ack = await nextMessage(second);
    assert.equal(ack.type, 'hello-ack');

    pubsub.notify('u1', 'requests');
    const pushed = await nextMessage(second);
    assert.equal(pushed.kind, 'requests');
    second.close();
    await stopServer(server);
  });

  await t.test('two simultaneous connections for the same user both receive pushes; closing one leaves the other alive', async () => {
    const server = await startServer();
    const a = new WebSocket(wsUrl(server));
    const b = new WebSocket(wsUrl(server));
    await Promise.all([once(a, 'open'), once(b, 'open')]);
    a.send(JSON.stringify({ type: 'hello', token: 'tok-u2' }));
    b.send(JSON.stringify({ type: 'hello', token: 'tok-u2' }));
    await Promise.all([nextMessage(a), nextMessage(b)]);

    a.close();
    await once(a, 'close');

    pubsub.notify('u2', 'everyone');
    const msg = await nextMessage(b);
    assert.equal(msg.kind, 'everyone');
    b.close();
    await stopServer(server);
  });
});
