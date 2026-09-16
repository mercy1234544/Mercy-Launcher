'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://localhost:0';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
// An invalid-Supabase-token request now falls through to Discord-session
// verification (see api/auth.js's resolveAuthenticatedUser) — point it at
// a non-routable address so this suite never makes a real network call to
// the live production auth service.
process.env.VEHICLE_STUDIO_AUTH_URL = 'http://127.0.0.1:0';

const { hasTestDb, setupTestDb, truncateAll, teardownTestDb } = require('./helpers/testDb');
const { _setServiceClientForTesting } = require('../../shared/supabase');
const { makeFakeSupabase } = require('./helpers/fakeSupabaseApi');
const db = require('../../api/db');
const friends = require('../../api/repo/friends');
const servers = require('../../api/repo/servers');
const joins = require('../../api/repo/joins');

const PROFILES = [
  { id: 'host-1', username: 'hoster' },
  { id: 'friend-1', username: 'friendo' },
  { id: 'stranger-1', username: 'rando' },
];

async function makeFriends(host, friend) {
  const req = await friends.sendFriendRequest(host, PROFILES.find((p) => p.id === friend).username);
  await friends.respondToFriendRequest(friend, req.id, true);
}

test(
  'servers + join-requests repos (real Postgres)',
  { skip: !hasTestDb() && 'MERCY_API_DB_PASSWORD not set in env — skipping real-Postgres integration tests' },
  async (t) => {
    const pool = await setupTestDb();
    db._setPoolForTesting(pool);
    _setServiceClientForTesting(makeFakeSupabase({ profiles: PROFILES }));

    t.beforeEach(async () => {
      await truncateAll(pool);
    });
    t.after(async () => {
      await teardownTestDb(pool);
    });

    await t.test('upsertServer: creates then updates in place', async () => {
      await servers.upsertServer('host-1', {
        id: 'srv-1',
        mercyGameId: 'minecraft',
        edition: 'java',
        displayName: 'My Server',
        isOnline: true,
      });
      let row = await servers.getServer('srv-1');
      assert.equal(row.is_online, true);

      await servers.upsertServer('host-1', {
        id: 'srv-1',
        mercyGameId: 'minecraft',
        edition: 'java',
        displayName: 'My Server',
        isOnline: false,
      });
      row = await servers.getServer('srv-1');
      assert.equal(row.is_online, false);
    });

    await t.test('upsertServer: rejects overwriting a server owned by someone else', async () => {
      await servers.upsertServer('host-1', {
        id: 'srv-1',
        mercyGameId: 'minecraft',
        displayName: 'My Server',
        isOnline: true,
      });
      await assert.rejects(
        () =>
          servers.upsertServer('stranger-1', {
            id: 'srv-1',
            mercyGameId: 'minecraft',
            displayName: 'Hijacked',
            isOnline: true,
          }),
        (e) => e.code === 'FORBIDDEN' && e.status === 403
      );
    });

    await t.test('requestJoin: server not found -> SERVER_NOT_FOUND', async () => {
      await assert.rejects(
        () => joins.requestJoin('friend-1', 'nope'),
        (e) => e.code === 'SERVER_NOT_FOUND' && e.status === 404
      );
    });

    await t.test('requestJoin: cannot join your own server', async () => {
      await servers.upsertServer('host-1', { id: 'srv-1', mercyGameId: 'minecraft', displayName: 'S', isOnline: true });
      await assert.rejects(
        () => joins.requestJoin('host-1', 'srv-1'),
        (e) => e.code === 'SELF_JOIN'
      );
    });

    await t.test('requestJoin: must be friends with the host', async () => {
      await servers.upsertServer('host-1', { id: 'srv-1', mercyGameId: 'minecraft', displayName: 'S', isOnline: true });
      await assert.rejects(
        () => joins.requestJoin('stranger-1', 'srv-1'),
        (e) => e.code === 'NOT_FRIENDS' && e.status === 403
      );
    });

    await t.test('requestJoin: server must be online', async () => {
      await makeFriends('host-1', 'friend-1');
      await servers.upsertServer('host-1', { id: 'srv-1', mercyGameId: 'minecraft', displayName: 'S', isOnline: false });
      await assert.rejects(
        () => joins.requestJoin('friend-1', 'srv-1'),
        (e) => e.code === 'SERVER_OFFLINE'
      );
    });

    await t.test('respondToJoinRequest: only the host may respond', async () => {
      await makeFriends('host-1', 'friend-1');
      await servers.upsertServer('host-1', { id: 'srv-1', mercyGameId: 'minecraft', displayName: 'S', isOnline: true });
      const row = await joins.requestJoin('friend-1', 'srv-1');
      await assert.rejects(
        () => joins.respondToJoinRequest('stranger-1', row.id, true, 'tok', null),
        (e) => e.code === 'FORBIDDEN'
      );
    });

    await t.test('respondToJoinRequest: approve sets token/endpoint and status; deny clears them', async () => {
      await makeFriends('host-1', 'friend-1');
      await servers.upsertServer('host-1', { id: 'srv-1', mercyGameId: 'minecraft', displayName: 'S', isOnline: true });
      const row = await joins.requestJoin('friend-1', 'srv-1');
      await joins.respondToJoinRequest('host-1', row.id, true, 'opaque-hmac-token', { strategy: 'relay', relayId: 'r1' });

      const { rows } = await pool.query('select * from join_requests where id = $1', [row.id]);
      assert.equal(rows[0].status, 'authorized');
      assert.equal(rows[0].token, 'opaque-hmac-token');
      assert.equal(rows[0].endpoint.strategy, 'relay');
    });

    await t.test('respondToJoinRequest: cannot respond to an already-resolved request', async () => {
      await makeFriends('host-1', 'friend-1');
      await servers.upsertServer('host-1', { id: 'srv-1', mercyGameId: 'minecraft', displayName: 'S', isOnline: true });
      const row = await joins.requestJoin('friend-1', 'srv-1');
      await joins.respondToJoinRequest('host-1', row.id, false);
      await assert.rejects(
        () => joins.respondToJoinRequest('host-1', row.id, true, 'tok', null),
        (e) => e.code === 'REQUEST_NOT_PENDING'
      );
    });

    await t.test('listJoinRequests: splits into incoming (as host) and outgoing (as requester)', async () => {
      await makeFriends('host-1', 'friend-1');
      await servers.upsertServer('host-1', { id: 'srv-1', mercyGameId: 'minecraft', displayName: 'S', isOnline: true });
      await joins.requestJoin('friend-1', 'srv-1');

      const hostView = await joins.listJoinRequests('host-1');
      assert.equal(hostView.incoming.length, 1);
      assert.equal(hostView.incoming[0].requesterUsername, 'friendo');

      const requesterView = await joins.listJoinRequests('friend-1');
      assert.equal(requesterView.outgoing.length, 1);
    });

    await t.test('expireStaleJoinRequests: expires only pending requests past their expiry', async () => {
      await makeFriends('host-1', 'friend-1');
      await servers.upsertServer('host-1', { id: 'srv-1', mercyGameId: 'minecraft', displayName: 'S', isOnline: true });
      const row = await joins.requestJoin('friend-1', 'srv-1');
      await pool.query("update join_requests set expires_at = now() - interval '1 minute' where id = $1", [row.id]);

      const count = await joins.expireStaleJoinRequests();
      assert.equal(count, 1);
      const { rows } = await pool.query('select status from join_requests where id = $1', [row.id]);
      assert.equal(rows[0].status, 'expired');
    });
  }
);
