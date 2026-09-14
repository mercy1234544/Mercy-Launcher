'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://localhost:0';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

const { hasTestDb, setupTestDb, truncateAll, teardownTestDb } = require('./helpers/testDb');
const { _setServiceClientForTesting } = require('../../shared/supabase');
const { makeFakeSupabase } = require('./helpers/fakeSupabaseApi');
const db = require('../../api/db');
const friends = require('../../api/repo/friends');
const presence = require('../../api/repo/presence');

const PROFILES = [
  { id: 'u1', username: 'hunter' },
  { id: 'u2', username: 'friendo' },
  { id: 'u3', username: 'stranger' },
];

test(
  'friends repo (real Postgres)',
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

    await t.test('sendFriendRequest: unknown username -> USER_NOT_FOUND (never a network/auth error)', async () => {
      await assert.rejects(
        () => friends.sendFriendRequest('u1', 'ghost'),
        (e) => e.code === 'USER_NOT_FOUND' && e.status === 404
      );
    });

    await t.test('sendFriendRequest: self -> SELF_REQUEST', async () => {
      await assert.rejects(
        () => friends.sendFriendRequest('u1', 'hunter'),
        (e) => e.code === 'SELF_REQUEST'
      );
    });

    await t.test('sendFriendRequest: happy path creates a pending row and notifies addressee', async () => {
      const row = await friends.sendFriendRequest('u1', 'friendo');
      assert.equal(row.requester_id, 'u1');
      assert.equal(row.addressee_id, 'u2');
      assert.equal(row.status, 'pending');
    });

    await t.test('sendFriendRequest: duplicate pending request between same pair -> REQUEST_PENDING', async () => {
      await friends.sendFriendRequest('u1', 'friendo');
      await assert.rejects(
        () => friends.sendFriendRequest('u2', 'hunter'), // reversed direction, same unordered pair
        (e) => e.code === 'REQUEST_PENDING'
      );
    });

    await t.test('sendFriendRequest: already friends -> ALREADY_FRIENDS', async () => {
      const req = await friends.sendFriendRequest('u1', 'friendo');
      await friends.respondToFriendRequest('u2', req.id, true);
      await assert.rejects(
        () => friends.sendFriendRequest('u1', 'friendo'),
        (e) => e.code === 'ALREADY_FRIENDS'
      );
    });

    await t.test('respondToFriendRequest: only the addressee may respond', async () => {
      const req = await friends.sendFriendRequest('u1', 'friendo');
      await assert.rejects(
        () => friends.respondToFriendRequest('u3', req.id, true), // stranger, not addressee
        (e) => e.code === 'FORBIDDEN' && e.status === 403
      );
    });

    await t.test('respondToFriendRequest: approve creates a bidirectional friendship', async () => {
      const req = await friends.sendFriendRequest('u1', 'friendo');
      await friends.respondToFriendRequest('u2', req.id, true);
      const { rows } = await pool.query('select * from friendships order by user_id');
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.user_id).sort(), ['u1', 'u2']);
    });

    await t.test('respondToFriendRequest: cannot respond twice (not pending)', async () => {
      const req = await friends.sendFriendRequest('u1', 'friendo');
      await friends.respondToFriendRequest('u2', req.id, false);
      await assert.rejects(
        () => friends.respondToFriendRequest('u2', req.id, true),
        (e) => e.code === 'REQUEST_NOT_PENDING'
      );
    });

    await t.test('removeFriend: removes both directions', async () => {
      const req = await friends.sendFriendRequest('u1', 'friendo');
      await friends.respondToFriendRequest('u2', req.id, true);
      await friends.removeFriend('u1', 'u2');
      const { rows } = await pool.query('select * from friendships');
      assert.equal(rows.length, 0);
    });

    await t.test('removeFriend: cannot remove yourself', async () => {
      await assert.rejects(() => friends.removeFriend('u1', 'u1'), (e) => e.code === 'SELF_REMOVE');
    });

    await t.test('listIncoming/listOutgoing reflect the two sides of a pending request', async () => {
      await friends.sendFriendRequest('u1', 'friendo');
      const incoming = await friends.listIncomingRequests('u2');
      const outgoing = await friends.listOutgoingRequests('u1');
      assert.equal(incoming.length, 1);
      assert.equal(incoming[0].fromUsername, 'hunter');
      assert.equal(outgoing.length, 1);
      assert.equal(outgoing[0].toUsername, 'friendo');
    });

    await t.test('getFriendsPresence: offline by default, online+fresh after heartbeat, offline again once stale', async () => {
      const req = await friends.sendFriendRequest('u1', 'friendo');
      await friends.respondToFriendRequest('u2', req.id, true);

      let rows = await friends.getFriendsPresence('u1');
      assert.equal(rows[0].status, 'offline');

      await presence.heartbeat(
        'u2',
        { appearOnline: true, showCurrentGame: true, showCurrentServer: true },
        { mercyGameId: 'minecraft', kind: 'hosting', serverId: 'srv-1', serverName: 'My Server' }
      );
      rows = await friends.getFriendsPresence('u1');
      assert.equal(rows[0].status, 'online');
      assert.equal(rows[0].activityLabel, 'Playing/Hosting Minecraft');
      assert.equal(rows[0].serverId, 'srv-1');

      // Force the heartbeat to look stale (older than PRESENCE_STALE_MS).
      await pool.query("update presence set last_heartbeat = now() - interval '10 minutes' where user_id = 'u2'");
      rows = await friends.getFriendsPresence('u1');
      assert.equal(rows[0].status, 'offline');
      assert.equal(rows[0].activityLabel, null);
    });

    await t.test('getFriendsPresence: never returns non-friends, regardless of their presence', async () => {
      await presence.heartbeat('u3', { appearOnline: true, showCurrentGame: true, showCurrentServer: true }, {
        mercyGameId: 'fivem',
        kind: 'hosting',
      });
      const rows = await friends.getFriendsPresence('u1');
      assert.equal(rows.length, 0);
    });

    await t.test('getEveryonePlaying: shows online, playing, appear_online strangers; flags isFriend/requestPending correctly', async () => {
      await presence.heartbeat('u2', { appearOnline: true, showCurrentGame: true, showCurrentServer: false }, {
        mercyGameId: 'minecraft',
        kind: 'playing',
      });
      await presence.heartbeat('u3', { appearOnline: true, showCurrentGame: true, showCurrentServer: false }, {
        mercyGameId: 'fivem',
        kind: 'playing',
      });
      await friends.sendFriendRequest('u1', 'friendo'); // pending with u2

      const rows = await friends.getEveryonePlaying('u1');
      const byId = Object.fromEntries(rows.map((r) => [r.userId, r]));
      assert.equal(byId.u2.requestPending, true);
      assert.equal(byId.u2.isFriend, false);
      assert.equal(byId.u3.requestPending, false);
      assert.equal(byId.u3.isFriend, false);
    });

    await t.test('getEveryonePlaying: excludes users with appear_online=false or showCurrentGame=false', async () => {
      await presence.heartbeat('u2', { appearOnline: false, showCurrentGame: true, showCurrentServer: false }, {
        mercyGameId: 'minecraft',
        kind: 'playing',
      });
      await presence.heartbeat('u3', { appearOnline: true, showCurrentGame: false, showCurrentServer: false }, {
        mercyGameId: 'minecraft',
        kind: 'playing',
      });
      const rows = await friends.getEveryonePlaying('u1');
      assert.equal(rows.length, 0);
    });

    await t.test('getEveryonePlaying: never includes the caller themselves', async () => {
      await presence.heartbeat('u1', { appearOnline: true, showCurrentGame: true, showCurrentServer: false }, {
        mercyGameId: 'minecraft',
        kind: 'playing',
      });
      const rows = await friends.getEveryonePlaying('u1');
      assert.equal(rows.length, 0);
    });
  }
);
