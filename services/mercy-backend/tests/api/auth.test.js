'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://localhost:0';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

const { _setServiceClientForTesting } = require('../../shared/supabase');
const { makeFakeSupabase } = require('./helpers/fakeSupabaseApi');
const { verifyAccessToken, requireAuth } = require('../../api/auth');
const { ApiError } = require('../../api/errors');

test('verifyAccessToken: valid Supabase access token resolves to auth.users.id', async () => {
  _setServiceClientForTesting(makeFakeSupabase({ authUsers: { 'valid-token': { id: 'user-abc' } } }));
  const result = await verifyAccessToken('valid-token');
  assert.equal(result.valid, true);
  assert.equal(result.userId, 'user-abc');
});

test('verifyAccessToken: expired/invalid token is rejected with AUTH_ERROR', async () => {
  _setServiceClientForTesting(makeFakeSupabase({ authErrors: { 'expired-token': 'JWT expired' } }));
  const result = await verifyAccessToken('expired-token');
  assert.equal(result.valid, false);
  assert.equal(result.code, 'AUTH_ERROR');
});

test('verifyAccessToken: missing token is rejected without calling Supabase', async () => {
  const result = await verifyAccessToken(undefined);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'AUTH_ERROR');
});

test('verifyAccessToken: Supabase itself unreachable is reported as SERVER_ERROR, not AUTH_ERROR', async () => {
  _setServiceClientForTesting({
    auth: {
      async getUser() {
        throw new Error('fetch failed');
      },
    },
  });
  const result = await verifyAccessToken('some-token');
  assert.equal(result.valid, false);
  assert.equal(result.code, 'SERVER_ERROR');
  // This is exactly the distinction the original bug collapsed: a transient
  // network/backend failure must never look like an auth rejection to the
  // caller, let alone a "user not found".
});

test('requireAuth: valid Bearer token resolves userId', async () => {
  _setServiceClientForTesting(makeFakeSupabase({ authUsers: { 'tok-1': { id: 'user-1' } } }));
  const userId = await requireAuth({ headers: { authorization: 'Bearer tok-1' } });
  assert.equal(userId, 'user-1');
});

test('requireAuth: missing Authorization header throws 401 AUTH_ERROR', async () => {
  await assert.rejects(
    () => requireAuth({ headers: {} }),
    (e) => e instanceof ApiError && e.status === 401 && e.code === 'AUTH_ERROR'
  );
});

test('requireAuth: backend outage throws 503 SERVER_ERROR, not 401', async () => {
  _setServiceClientForTesting({
    auth: {
      async getUser() {
        throw new Error('ECONNREFUSED');
      },
    },
  });
  await assert.rejects(
    () => requireAuth({ headers: { authorization: 'Bearer whatever' } }),
    (e) => e instanceof ApiError && e.status === 503 && e.code === 'SERVER_ERROR'
  );
});
