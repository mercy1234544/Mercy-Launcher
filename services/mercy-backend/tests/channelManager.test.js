'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelManager } = require('../relay/channelManager');

function fakeSession(id) {
  const sent = [];
  return {
    sessionId: id,
    hostedRelayIds: new Set(),
    activeChannelIds: new Set(),
    send: (msg) => sent.push(msg),
    sent,
  };
}

test('host registration produces a relayId and sends host-registered', () => {
  const cm = new ChannelManager({ maxConcurrentSessions: 10 });
  const host = fakeSession('host-1');
  const relayId = cm.registerHost(host, {
    serverId: 'srv-1',
    game: 'minecraft',
    transport: 'tcp',
    expiresAt: Date.now() + 60_000,
  });
  assert.ok(relayId.startsWith('relay_'));
  assert.equal(host.sent[0].type, 'host-registered');
  assert.equal(host.sent[0].relayId, relayId);
  assert.ok(host.hostedRelayIds.has(relayId));
});

test('request-relay: unknown relayId is denied', () => {
  const cm = new ChannelManager({ maxConcurrentSessions: 10 });
  const client = fakeSession('client-1');
  client.joinRequestId = 'jr-1';
  client.serverId = 'srv-1';
  const result = cm.requestRelay(client, { joinRequestId: 'jr-1', relayId: 'relay_nonexistent' });
  assert.equal(result.granted, false);
});

test('request-relay: joinRequestId not matching session is denied', () => {
  const cm = new ChannelManager({ maxConcurrentSessions: 10 });
  const host = fakeSession('host-1');
  const relayId = cm.registerHost(host, {
    serverId: 'srv-1',
    game: 'minecraft',
    transport: 'tcp',
    expiresAt: Date.now() + 60_000,
  });
  const client = fakeSession('client-1');
  client.joinRequestId = 'jr-actual';
  client.serverId = 'srv-1';
  const result = cm.requestRelay(client, { joinRequestId: 'jr-spoofed', relayId });
  assert.equal(result.granted, false);
});

test('request-relay: server mismatch between relayId and authorized token is denied', () => {
  const cm = new ChannelManager({ maxConcurrentSessions: 10 });
  const host = fakeSession('host-1');
  const relayId = cm.registerHost(host, {
    serverId: 'srv-A',
    game: 'minecraft',
    transport: 'tcp',
    expiresAt: Date.now() + 60_000,
  });
  const client = fakeSession('client-1');
  client.joinRequestId = 'jr-1';
  client.serverId = 'srv-B'; // authorized for a different server
  const result = cm.requestRelay(client, { joinRequestId: 'jr-1', relayId });
  assert.equal(result.granted, false);
});

test('request-relay: valid pairing grants a channel to both sides', () => {
  const cm = new ChannelManager({ maxConcurrentSessions: 10 });
  const host = fakeSession('host-1');
  const relayId = cm.registerHost(host, {
    serverId: 'srv-1',
    game: 'minecraft',
    transport: 'tcp',
    expiresAt: Date.now() + 60_000,
  });
  const client = fakeSession('client-1');
  client.joinRequestId = 'jr-1';
  client.serverId = 'srv-1';
  const result = cm.requestRelay(client, { joinRequestId: 'jr-1', relayId });
  assert.equal(result.granted, true);
  assert.ok(result.channelId.startsWith('chan_'));
  assert.ok(host.activeChannelIds.has(result.channelId));
  assert.ok(client.activeChannelIds.has(result.channelId));
});

test('concurrent session cap is enforced', () => {
  const cm = new ChannelManager({ maxConcurrentSessions: 1 });
  const host = fakeSession('host-1');
  const relayId = cm.registerHost(host, {
    serverId: 'srv-1',
    game: 'minecraft',
    transport: 'tcp',
    expiresAt: Date.now() + 60_000,
  });
  const clientA = fakeSession('client-A');
  clientA.joinRequestId = 'jr-a';
  clientA.serverId = 'srv-1';
  const okA = cm.requestRelay(clientA, { joinRequestId: 'jr-a', relayId });
  assert.equal(okA.granted, true);

  const clientB = fakeSession('client-B');
  clientB.joinRequestId = 'jr-b';
  clientB.serverId = 'srv-1';
  const okB = cm.requestRelay(clientB, { joinRequestId: 'jr-b', relayId });
  assert.equal(okB.granted, false);
});

test('relay-data is only forwarded between actual channel participants', () => {
  const cm = new ChannelManager({ maxConcurrentSessions: 10 });
  const host = fakeSession('host-1');
  const relayId = cm.registerHost(host, {
    serverId: 'srv-1',
    game: 'minecraft',
    transport: 'tcp',
    expiresAt: Date.now() + 60_000,
  });
  const client = fakeSession('client-1');
  client.joinRequestId = 'jr-1';
  client.serverId = 'srv-1';
  const { channelId } = cm.requestRelay(client, { joinRequestId: 'jr-1', relayId });

  host.sent.length = 0;
  const ok = cm.forwardData(client, channelId, Buffer.from('hi').toString('base64'));
  assert.equal(ok, true);
  const forwarded = host.sent.find((m) => m.type === 'relay-data');
  assert.equal(Buffer.from(forwarded.data, 'base64').toString(), 'hi');

  const intruder = fakeSession('intruder');
  const rejected = cm.forwardData(intruder, channelId, Buffer.from('evil').toString('base64'));
  assert.equal(rejected, false);
});

test('cleanupSession frees host registrations and closes active channels', () => {
  const cm = new ChannelManager({ maxConcurrentSessions: 10 });
  const host = fakeSession('host-1');
  const relayId = cm.registerHost(host, {
    serverId: 'srv-1',
    game: 'minecraft',
    transport: 'tcp',
    expiresAt: Date.now() + 60_000,
  });
  const client = fakeSession('client-1');
  client.joinRequestId = 'jr-1';
  client.serverId = 'srv-1';
  const { channelId } = cm.requestRelay(client, { joinRequestId: 'jr-1', relayId });

  cm.cleanupSession(host);
  assert.equal(cm.hostRegistrations.has(relayId), false);
  assert.equal(cm.channels.has(channelId), false);
  assert.ok(client.sent.some((m) => m.type === 'relay-closed'));
});

test('pruneExpiredRegistrations removes stale relayIds', () => {
  const cm = new ChannelManager({ maxConcurrentSessions: 10 });
  const host = fakeSession('host-1');
  const relayId = cm.registerHost(host, {
    serverId: 'srv-1',
    game: 'minecraft',
    transport: 'tcp',
    expiresAt: Date.now() - 1000, // already expired
  });
  cm.pruneExpiredRegistrations();
  assert.equal(cm.hostRegistrations.has(relayId), false);
});
