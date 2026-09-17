'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://localhost:0';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

const { _setServiceClientForTesting } = require('../shared/supabase');
const { makeFakeSupabase } = require('./helpers/fakeSupabase');
const { makeFakeLocalDb } = require('./helpers/fakeLocalDb');
const { _setPoolForTesting } = require('../shared/localDb');
const { buildJoinToken } = require('./helpers/joinToken');
const auth = require('../signaling/auth');

test('host token: valid Supabase access token is accepted and user id extracted', async () => {
  _setServiceClientForTesting(
    makeFakeSupabase({ authUsers: { 'valid-token': { id: 'user-123' } } })
  );
  const result = await auth.verifyHostToken('valid-token');
  assert.equal(result.valid, true);
  assert.equal(result.userId, 'user-123');
});

test('host token: expired token is rejected', async () => {
  _setServiceClientForTesting(
    makeFakeSupabase({ authErrors: { 'expired-token': 'JWT expired' } })
  );
  const result = await auth.verifyHostToken('expired-token');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'Invalid or expired token.');
});

test('host token: unknown/invalid token is rejected', async () => {
  _setServiceClientForTesting(makeFakeSupabase({}));
  const result = await auth.verifyHostToken('not-a-real-token');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'Invalid or expired token.');
});

test('host token: rejected when Supabase Auth returns no user (defense in depth)', async () => {
  _setServiceClientForTesting({
    auth: { async getUser() { return { data: { user: null }, error: null }; } },
  });
  const result = await auth.verifyHostToken('some-token');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'Invalid or expired token.');
});

test('host token: malformed (non-string) token is rejected without calling Supabase', async () => {
  const result = await auth.verifyHostToken(undefined);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'Malformed token.');
});

// server ownership and client-token lookups read the LOCAL `mercy_backend`
// Postgres database (shared/localDb.js) — mercy-api owns `servers` and
// `join_requests` there, not in Supabase. See signaling/auth.js's own
// header comments on verifyServerOwnership/verifyClientToken.

test('server ownership: true when owner matches', async () => {
  _setPoolForTesting(makeFakeLocalDb({ servers: [{ id: 'srv-1', owner_id: 'user-123' }] }));
  const owns = await auth.verifyServerOwnership('user-123', 'srv-1');
  assert.equal(owns, true);
});

test('server ownership: false for a different user', async () => {
  _setPoolForTesting(makeFakeLocalDb({ servers: [{ id: 'srv-1', owner_id: 'user-123' }] }));
  const owns = await auth.verifyServerOwnership('user-999', 'srv-1');
  assert.equal(owns, false);
});

test('server ownership: false when server does not exist', async () => {
  _setPoolForTesting(makeFakeLocalDb({ servers: [] }));
  const owns = await auth.verifyServerOwnership('user-123', 'nope');
  assert.equal(owns, false);
});

test('client token: valid, authorized join_requests row is accepted', async () => {
  const token = buildJoinToken({
    serverId: 'srv-1',
    mercyGameId: 'minecraft',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    nonce: 'nonce-abc',
  });
  _setPoolForTesting(
    makeFakeLocalDb({
      joinRequests: [
        {
          id: 'jr-1',
          host_id: 'host-1',
          requester_id: 'req-1',
          server_id: 'srv-1',
          status: 'authorized',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          token,
        },
      ],
    })
  );
  const result = await auth.verifyClientToken(token);
  assert.equal(result.valid, true);
  assert.equal(result.joinRequestId, 'jr-1');
  assert.equal(result.serverId, 'srv-1');
});

test('client token: malformed (no dot) is rejected', async () => {
  const result = await auth.verifyClientToken('not-a-token');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'Malformed token.');
});

test('client token: payload expiresAt in the past is rejected', async () => {
  const token = buildJoinToken({
    serverId: 'srv-1',
    mercyGameId: 'minecraft',
    issuedAt: Date.now() - 120_000,
    expiresAt: Date.now() - 60_000,
    nonce: 'nonce-old',
  });
  const result = await auth.verifyClientToken(token);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'Token expired.');
});

test('client token: no matching join_requests row is rejected', async () => {
  const token = buildJoinToken({
    serverId: 'srv-1',
    mercyGameId: 'minecraft',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    nonce: 'nonce-missing',
  });
  _setPoolForTesting(makeFakeLocalDb({ joinRequests: [] }));
  const result = await auth.verifyClientToken(token);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'Invalid token.');
});

test('client token: join_requests row not yet authorized (pending) is rejected', async () => {
  const token = buildJoinToken({
    serverId: 'srv-1',
    mercyGameId: 'minecraft',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    nonce: 'nonce-pending',
  });
  _setPoolForTesting(
    makeFakeLocalDb({
      joinRequests: [
        {
          id: 'jr-2',
          host_id: 'host-1',
          requester_id: 'req-1',
          server_id: 'srv-1',
          status: 'pending',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          token,
        },
      ],
    })
  );
  const result = await auth.verifyClientToken(token);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'Join request is not authorized.');
});

test('client token: server_id mismatch between token payload and row is rejected', async () => {
  const token = buildJoinToken({
    serverId: 'srv-1',
    mercyGameId: 'minecraft',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    nonce: 'nonce-mismatch',
  });
  _setPoolForTesting(
    makeFakeLocalDb({
      joinRequests: [
        {
          id: 'jr-3',
          host_id: 'host-1',
          requester_id: 'req-1',
          server_id: 'srv-DIFFERENT',
          status: 'authorized',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          token,
        },
      ],
    })
  );
  const result = await auth.verifyClientToken(token);
  assert.equal(result.valid, false);
});
