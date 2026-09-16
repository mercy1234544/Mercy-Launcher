'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://localhost:0';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
// Never let a test accidentally reach the real, live production Discord
// auth service — every test that exercises the Discord path scripts
// global.fetch instead (see discordAuth.test.js for the dedicated
// verifyDiscordSession unit tests; this file covers the dual-mode
// resolveAuthenticatedUser/requireAuth entry point).
process.env.VEHICLE_STUDIO_AUTH_URL = 'http://127.0.0.1:0';

const { _setServiceClientForTesting } = require('../../shared/supabase');
const { makeFakeSupabase } = require('./helpers/fakeSupabaseApi');
const { makeFakeSupabaseWithProfiles } = require('./helpers/fakeSupabaseWithProfiles');
const { makeFakeDbPool } = require('./helpers/fakeDbPool');
const db = require('../../api/db');
const { verifyAccessToken, resolveAuthenticatedUser, requireAuth } = require('../../api/auth');
const { ApiError } = require('../../api/errors');

function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve(fn()).finally(() => { global.fetch = original; });
}

function unreachableFetch() {
  return async () => { throw new TypeError('fetch failed'); };
}

// ── verifyAccessToken (Supabase path) — unchanged behavior, still covered
//    directly to prove this migration did not alter it. ────────────────────
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
});

// ── requireAuth / resolveAuthenticatedUser — the dual-mode entry point every
//    route and the WS hello handler actually call. ──────────────────────────
test('requireAuth: a valid Supabase Bearer token resolves userId exactly as before', async () => {
  _setServiceClientForTesting(makeFakeSupabase({ authUsers: { 'tok-1': { id: 'user-1' } } }));
  const userId = await requireAuth({ headers: { authorization: 'Bearer tok-1' } });
  assert.equal(userId, 'user-1');
});

test('requireAuth: a valid Supabase token never even attempts Discord verification (no wasted call, no behavior change for existing callers)', async () => {
  _setServiceClientForTesting(makeFakeSupabase({ authUsers: { 'tok-1': { id: 'user-1' } } }));
  await withFetch(
    async () => { throw new Error('must not be called for a valid Supabase token'); },
    async () => {
      const userId = await requireAuth({ headers: { authorization: 'Bearer tok-1' } });
      assert.equal(userId, 'user-1');
    }
  );
});

test('requireAuth: missing Authorization header throws 401 AUTH_ERROR without any network call', async () => {
  await withFetch(
    async () => { throw new Error('must not be called'); },
    () => assert.rejects(
      () => requireAuth({ headers: {} }),
      (e) => e instanceof ApiError && e.status === 401 && e.code === 'AUTH_ERROR'
    )
  );
});

test('requireAuth: BOTH auth backends unreachable throws 503 SERVER_ERROR, not 401', async () => {
  _setServiceClientForTesting({
    auth: {
      async getUser() {
        throw new Error('ECONNREFUSED');
      },
    },
  });
  await withFetch(
    unreachableFetch(),
    () => assert.rejects(
      () => requireAuth({ headers: { authorization: 'Bearer whatever' } }),
      (e) => e instanceof ApiError && e.status === 503 && e.code === 'SERVER_ERROR'
    )
  );
});

test('resolveAuthenticatedUser: a token invalid for Supabase falls through to Discord-session verification', async () => {
  // Supabase rejects it outright (not a Supabase token at all); the Discord
  // auth service accepts it.
  _setServiceClientForTesting(makeFakeSupabase({ authErrors: { 'discord-session-token': 'Invalid token.' } }));
  db._setPoolForTesting(makeFakeDbPool());
  const fakeProfiles = makeFakeSupabaseWithProfiles({ profiles: [{ id: 'mapped-uuid', username: 'DiscordUser', discord_id: '999' }] });
  // resolveDiscordIdentity uses the SAME service client seam as
  // verifyAccessToken above — the last _setServiceClientForTesting call
  // wins, so point it at the profiles-aware fake for this test.
  _setServiceClientForTesting(fakeProfiles);

  await withFetch(
    async () => ({ ok: true, status: 200, async json() { return { user: { id: '999', discordUsername: 'DiscordUser' } }; } }),
    async () => {
      const result = await resolveAuthenticatedUser('discord-session-token');
      assert.equal(result.valid, true);
      assert.equal(result.authMethod, 'discord');
      assert.equal(result.userId, 'mapped-uuid', 'resolves to the existing profiles.id, never the raw discordId');
    }
  );
});

test('resolveAuthenticatedUser: an expired Discord session is rejected with 401 AUTH_ERROR', async () => {
  _setServiceClientForTesting(makeFakeSupabase({ authErrors: { tok: 'Invalid token.' } }));
  await withFetch(
    async () => ({ ok: false, status: 401, async json() { return {}; } }),
    async () => {
      const result = await resolveAuthenticatedUser('tok');
      assert.equal(result.valid, false);
      assert.equal(result.code, 'AUTH_ERROR');
    }
  );
});

test('resolveAuthenticatedUser: an invalid (never-issued) session is rejected with 401 AUTH_ERROR', async () => {
  _setServiceClientForTesting(makeFakeSupabase({ authErrors: { tok: 'Invalid token.' } }));
  await withFetch(
    async () => ({ ok: false, status: 403, async json() { return {}; } }),
    async () => {
      const result = await resolveAuthenticatedUser('tok');
      assert.equal(result.valid, false);
      assert.equal(result.code, 'AUTH_ERROR');
    }
  );
});

test('resolveAuthenticatedUser: missing bearer token is rejected with 401 AUTH_ERROR', async () => {
  const result = await resolveAuthenticatedUser(null);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'AUTH_ERROR');
});

test('resolveAuthenticatedUser: a first-seen Discord user is provisioned and the mapping is used for this request', async () => {
  _setServiceClientForTesting(makeFakeSupabase({ authErrors: { tok: 'Invalid token.' } }));
  db._setPoolForTesting(makeFakeDbPool());
  const fakeProfiles = makeFakeSupabaseWithProfiles({ profiles: [] });
  _setServiceClientForTesting(fakeProfiles);
  await withFetch(
    async () => ({ ok: true, status: 200, async json() { return { user: { id: '123456', discordUsername: 'BrandNew' } }; } }),
    async () => {
      const result = await resolveAuthenticatedUser('tok');
      assert.equal(result.valid, true);
      assert.equal(result.authMethod, 'discord');
      assert.equal(fakeProfiles._createUserCallCount(), 1);
      const row = fakeProfiles._rows.find((r) => r.id === result.userId);
      assert.equal(row.discord_id, '123456');
    }
  );
});
