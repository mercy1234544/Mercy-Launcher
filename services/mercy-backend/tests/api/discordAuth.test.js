'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://localhost:0';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
// Never let a test accidentally reach the real, live production auth
// service — every test here scripts global.fetch instead.
process.env.VEHICLE_STUDIO_AUTH_URL = 'http://127.0.0.1:0';

const { verifyDiscordSession } = require('../../api/discordAuth');

function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve(fn()).finally(() => { global.fetch = original; });
}

test('verifyDiscordSession: a valid session resolves the verified discordId (the deployed response shape)', async () => {
  await withFetch(
    async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:0/session');
      assert.equal(init.headers.authorization, 'Bearer real-session-token');
      return {
        ok: true,
        status: 200,
        async json() {
          return { user: { id: '1498783247562309803', discordUsername: 'unlikely_youdied', discordAvatar: 'abc123', roleVerified: true }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
        },
      };
    },
    async () => {
      const result = await verifyDiscordSession('real-session-token');
      assert.equal(result.valid, true);
      assert.equal(result.discordId, '1498783247562309803');
      assert.equal(result.discordUsername, 'unlikely_youdied');
    }
  );
});

test('verifyDiscordSession: missing token is rejected without ever calling fetch', async () => {
  let called = false;
  await withFetch(
    async () => { called = true; throw new Error('must not be called'); },
    async () => {
      const result = await verifyDiscordSession(undefined);
      assert.equal(result.valid, false);
      assert.equal(result.code, 'AUTH_ERROR');
      assert.equal(called, false);
    }
  );
});

test('verifyDiscordSession: an expired/invalid session (401) is rejected with AUTH_ERROR', async () => {
  await withFetch(
    async () => ({ ok: false, status: 401, async json() { return { error: 'expired' }; } }),
    async () => {
      const result = await verifyDiscordSession('expired-token');
      assert.equal(result.valid, false);
      assert.equal(result.code, 'AUTH_ERROR');
    }
  );
});

test('verifyDiscordSession: a 403 (invalid session, distinct from expired) is also AUTH_ERROR', async () => {
  await withFetch(
    async () => ({ ok: false, status: 403, async json() { return { error: 'forbidden' }; } }),
    async () => {
      const result = await verifyDiscordSession('bad-token');
      assert.equal(result.valid, false);
      assert.equal(result.code, 'AUTH_ERROR');
    }
  );
});

test('verifyDiscordSession: the auth service rate-limiting us (429) is SERVER_ERROR, never confused with the caller\'s own credential being invalid', async () => {
  await withFetch(
    async () => ({ ok: false, status: 429, async json() { return { error: 'rate limited' }; } }),
    async () => {
      const result = await verifyDiscordSession('whatever');
      assert.equal(result.valid, false);
      assert.equal(result.code, 'SERVER_ERROR', 'a 429 from the auth service is an outage/backpressure signal, not proof this token is bad');
    }
  );
});

test('verifyDiscordSession: the auth service being down (5xx) is SERVER_ERROR, never confused with AUTH_ERROR', async () => {
  await withFetch(
    async () => ({ ok: false, status: 503, async json() { return {}; } }),
    async () => {
      const result = await verifyDiscordSession('whatever');
      assert.equal(result.valid, false);
      assert.equal(result.code, 'SERVER_ERROR');
    }
  );
});

test('verifyDiscordSession: a network exception (unreachable) is SERVER_ERROR', async () => {
  await withFetch(
    async () => { throw new TypeError('fetch failed'); },
    async () => {
      const result = await verifyDiscordSession('whatever');
      assert.equal(result.valid, false);
      assert.equal(result.code, 'SERVER_ERROR');
    }
  );
});

test('verifyDiscordSession: a malformed JSON response is SERVER_ERROR, not a fabricated identity', async () => {
  await withFetch(
    async () => ({ ok: true, status: 200, async json() { throw new SyntaxError('Unexpected token'); } }),
    async () => {
      const result = await verifyDiscordSession('whatever');
      assert.equal(result.valid, false);
      assert.equal(result.code, 'SERVER_ERROR');
    }
  );
});

test('verifyDiscordSession: a 200 response with no user.id is rejected, never fabricates an identity', async () => {
  await withFetch(
    async () => ({ ok: true, status: 200, async json() { return { ok: true, authorized: true, username: 'someone', expiresAt: 123 }; } }),
    async () => {
      // This is exactly the "local reference" services/vehicle-studio-auth
      // shape, which has no discordId at all — proving this never silently
      // authenticates just because the HTTP call itself succeeded.
      const result = await verifyDiscordSession('whatever');
      assert.equal(result.valid, false);
      assert.equal(result.code, 'AUTH_ERROR');
    }
  );
});

test('verifyDiscordSession: a client-shaped body with a non-string user.id is rejected', async () => {
  await withFetch(
    async () => ({ ok: true, status: 200, async json() { return { user: { id: 12345 } }; } }),
    async () => {
      const result = await verifyDiscordSession('whatever');
      assert.equal(result.valid, false);
      assert.equal(result.code, 'AUTH_ERROR');
    }
  );
});
