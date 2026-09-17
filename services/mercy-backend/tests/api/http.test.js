'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.SUPABASE_URL = 'http://localhost:0';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

const { hasTestDb, setupTestDb, truncateAll, teardownTestDb } = require('./helpers/testDb');
const { _setServiceClientForTesting } = require('../../shared/supabase');
const { makeFakeSupabase } = require('./helpers/fakeSupabaseApi');
const db = require('../../api/db');
const { handleRequest } = require('../../api/http');

const PROFILES = [
  { id: '00000000-0000-4000-8000-000000000001', username: 'hunter' },
  { id: '00000000-0000-4000-8000-000000000002', username: 'friendo' },
];

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    await handleRequest(req, res, url.pathname);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test(
  'REST API (real Postgres, real HTTP server)',
  { skip: !hasTestDb() && 'MERCY_API_DB_PASSWORD not set in env — skipping real-Postgres integration tests' },
  async (t) => {
    const pool = await setupTestDb();
    db._setPoolForTesting(pool);
    _setServiceClientForTesting(makeFakeSupabase({ profiles: PROFILES, authUsers: { 'tok-u1': { id: '00000000-0000-4000-8000-000000000001' }, 'tok-u2': { id: '00000000-0000-4000-8000-000000000002' } } }));

    const server = await startServer();
    const base = `http://127.0.0.1:${server.address().port}`;

    t.beforeEach(async () => {
      await truncateAll(pool);
    });
    t.after(async () => {
      server.close();
      await teardownTestDb(pool);
    });

    await t.test('GET /v1/friends with no token -> 401 AUTH_ERROR', async () => {
      const res = await fetch(`${base}/v1/friends`);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.error, 'AUTH_ERROR');
    });

    await t.test('GET /v1/friends with an invalid token -> 401 AUTH_ERROR (not 404/USER_NOT_FOUND)', async () => {
      const res = await fetch(`${base}/v1/friends`, { headers: { authorization: 'Bearer not-a-real-token' } });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.error, 'AUTH_ERROR');
    });

    await t.test('GET /v1/friends with a valid token -> 200, empty list', async () => {
      const res = await fetch(`${base}/v1/friends`, { headers: { authorization: 'Bearer tok-u1' } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.data, []);
    });

    await t.test('POST /v1/friends/requests for an unknown username -> 404 USER_NOT_FOUND', async () => {
      const res = await fetch(`${base}/v1/friends/requests`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-u1', 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'ghost' }),
      });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error, 'USER_NOT_FOUND');
    });

    await t.test('full friend-request round trip over HTTP: send -> incoming -> respond -> friends list', async () => {
      let res = await fetch(`${base}/v1/friends/requests`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-u1', 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'friendo' }),
      });
      assert.equal(res.status, 201);
      const created = (await res.json()).data;

      res = await fetch(`${base}/v1/friends/requests/incoming`, { headers: { authorization: 'Bearer tok-u2' } });
      const incoming = (await res.json()).data;
      assert.equal(incoming.length, 1);
      assert.equal(incoming[0].fromUsername, 'hunter');

      res = await fetch(`${base}/v1/friends/requests/${created.id}/respond`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-u2', 'content-type': 'application/json' },
        body: JSON.stringify({ approve: true }),
      });
      assert.equal(res.status, 200);

      res = await fetch(`${base}/v1/friends`, { headers: { authorization: 'Bearer tok-u1' } });
      const friendsList = (await res.json()).data;
      assert.equal(friendsList.length, 1);
      assert.equal(friendsList[0].username, 'friendo');
    });

    await t.test('presence heartbeat over HTTP, then reflected in /v1/friends', async () => {
      let res = await fetch(`${base}/v1/friends/requests`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-u1', 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'friendo' }),
      });
      const created = (await res.json()).data;
      await fetch(`${base}/v1/friends/requests/${created.id}/respond`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-u2', 'content-type': 'application/json' },
        body: JSON.stringify({ approve: true }),
      });

      res = await fetch(`${base}/v1/presence/heartbeat`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-u2', 'content-type': 'application/json' },
        body: JSON.stringify({
          appearOnline: true,
          showCurrentGame: true,
          showCurrentServer: false,
          activity: { mercyGameId: 'minecraft', kind: 'playing' },
        }),
      });
      assert.equal(res.status, 200);

      res = await fetch(`${base}/v1/friends`, { headers: { authorization: 'Bearer tok-u1' } });
      const friendsList = (await res.json()).data;
      assert.equal(friendsList[0].status, 'online');
    });

    await t.test('GET /v1/health reports db ok', async () => {
      const res = await fetch(`${base}/v1/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.db, 'ok');
    });

    await t.test('unknown route -> 404 NOT_FOUND', async () => {
      const res = await fetch(`${base}/v1/does-not-exist`);
      assert.equal(res.status, 404);
    });

    await t.test('malformed JSON body -> 400 BAD_REQUEST', async () => {
      const res = await fetch(`${base}/v1/friends/requests`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-u1', 'content-type': 'application/json' },
        body: '{not json',
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'BAD_REQUEST');
    });
  }
);
