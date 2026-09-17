'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const http = require('node:http');

process.env.SUPABASE_URL = 'http://localhost:0';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'e2e-key';
process.env.MERCY_RELAY_PORT = '0'; // ask the OS for a free ephemeral port

const { _setServiceClientForTesting } = require('../shared/supabase');
const { makeFakeSupabase } = require('./helpers/fakeSupabase');
const { makeFakeLocalDb } = require('./helpers/fakeLocalDb');
const { _setPoolForTesting } = require('../shared/localDb');
const { buildJoinToken } = require('./helpers/joinToken');

const HOST_USER_ID = 'user-host-1';
const SERVER_ID = 'srv-e2e-1';
const HOST_ACCESS_TOKEN = 'e2e-host-access-token';

const joinToken = buildJoinToken({
  serverId: SERVER_ID,
  mercyGameId: 'minecraft',
  issuedAt: Date.now(),
  expiresAt: Date.now() + 120_000,
  nonce: 'e2e-nonce-1',
});

// Identity (host token) stays on the Supabase fake; servers/join_requests
// are mercy-api's local-Postgres data (see signaling/auth.js).
_setServiceClientForTesting(
  makeFakeSupabase({
    authUsers: { [HOST_ACCESS_TOKEN]: { id: HOST_USER_ID } },
  })
);
_setPoolForTesting(
  makeFakeLocalDb({
    servers: [{ id: SERVER_ID, owner_id: HOST_USER_ID }],
    joinRequests: [
      {
        id: 'jr-e2e-1',
        host_id: HOST_USER_ID,
        requester_id: 'user-client-1',
        server_id: SERVER_ID,
        status: 'authorized',
        expires_at: new Date(Date.now() + 120_000).toISOString(),
        token: joinToken,
      },
    ],
  })
);

const { httpServer, channelManager } = require('../relay/server.js');

function waitForListening() {
  if (httpServer.listening) return Promise.resolve();
  return new Promise((resolve) => httpServer.once('listening', resolve));
}

function waitForMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

let port;

test('e2e: server starts and health endpoint reports ok', async () => {
  await waitForListening();
  port = httpServer.address().port;
  assert.ok(port > 0);

  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  assert.equal(body.status, 'ok');
});

test('e2e: invalid hello token is rejected and socket closes', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token: 'garbage', role: 'host' }));
  const rejected = await waitForMessage(ws, (m) => m.type === 'hello-rejected');
  assert.ok(rejected.reason);
  await new Promise((resolve) => ws.once('close', resolve));
});

test('e2e: malformed JSON is silently dropped, connection stays open', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send('{not valid json');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
});

test('e2e: full host+client relay pairing forwards real bytes both directions', async () => {
  const hostToken = HOST_ACCESS_TOKEN;

  const hostWs = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => hostWs.once('open', resolve));
  hostWs.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token: hostToken, role: 'host' }));
  const hostAck = await waitForMessage(hostWs, (m) => m.type === 'hello-ack');
  assert.ok(hostAck.sessionId);

  hostWs.send(
    JSON.stringify({
      type: 'register-host',
      serverId: SERVER_ID,
      game: 'minecraft',
      transport: 'tcp',
      localPort: 25565,
      expiresAt: Date.now() + 600_000,
    })
  );
  const registered = await waitForMessage(hostWs, (m) => m.type === 'host-registered');
  assert.ok(registered.relayId);

  const clientWs = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => clientWs.once('open', resolve));
  clientWs.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token: joinToken, role: 'client' }));
  const clientAck = await waitForMessage(clientWs, (m) => m.type === 'hello-ack');
  assert.ok(clientAck.sessionId);

  clientWs.send(
    JSON.stringify({ type: 'request-relay', joinRequestId: 'jr-e2e-1', relayId: registered.relayId })
  );
  const [clientGrant, hostGrant] = await Promise.all([
    waitForMessage(clientWs, (m) => m.type === 'relay-granted'),
    waitForMessage(hostWs, (m) => m.type === 'relay-granted'),
  ]);
  assert.equal(clientGrant.channelId, hostGrant.channelId);
  const channelId = clientGrant.channelId;

  // Real bytes, client -> host
  const payloadToHost = Buffer.from('hello from client, actual bytes');
  clientWs.send(
    JSON.stringify({ type: 'relay-data', channelId, data: payloadToHost.toString('base64') })
  );
  const receivedAtHost = await waitForMessage(hostWs, (m) => m.type === 'relay-data' && m.channelId === channelId);
  assert.equal(Buffer.from(receivedAtHost.data, 'base64').toString(), payloadToHost.toString());

  // Real bytes, host -> client
  const payloadToClient = Buffer.from('hello from host, actual bytes');
  hostWs.send(
    JSON.stringify({ type: 'relay-data', channelId, data: payloadToClient.toString('base64') })
  );
  const receivedAtClient = await waitForMessage(
    clientWs,
    (m) => m.type === 'relay-data' && m.channelId === channelId
  );
  assert.equal(Buffer.from(receivedAtClient.data, 'base64').toString(), payloadToClient.toString());

  // Host disconnect cleans up the registration and the active channel.
  hostWs.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(channelManager.hostRegistrations.has(registered.relayId), false);
  assert.equal(channelManager.channels.has(channelId), false);

  clientWs.close();
});

test('e2e: ping/pong roundtrip', async () => {
  const hostToken = HOST_ACCESS_TOKEN;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token: hostToken, role: 'host' }));
  await waitForMessage(ws, (m) => m.type === 'hello-ack');
  const at = Date.now();
  ws.send(JSON.stringify({ type: 'ping', at }));
  const pong = await waitForMessage(ws, (m) => m.type === 'pong');
  assert.equal(pong.at, at);
  ws.close();
});

test.after(() => {
  httpServer.close();
});
