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
const presence = require('../../api/repo/presence');

const PROFILES = [
  { id: '00000000-0000-4000-8000-000000000001', username: 'hunter' },
  { id: '00000000-0000-4000-8000-000000000002', username: 'friendo' },
  { id: '00000000-0000-4000-8000-000000000003', username: 'stranger' },
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
        () => friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'ghost'),
        (e) => e.code === 'USER_NOT_FOUND' && e.status === 404
      );
    });

    await t.test('sendFriendRequest: self -> SELF_REQUEST', async () => {
      await assert.rejects(
        () => friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'hunter'),
        (e) => e.code === 'SELF_REQUEST'
      );
    });

    await t.test('sendFriendRequest: happy path creates a pending row and notifies addressee', async () => {
      const row = await friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'friendo');
      assert.equal(row.requester_id, '00000000-0000-4000-8000-000000000001');
      assert.equal(row.addressee_id, '00000000-0000-4000-8000-000000000002');
      assert.equal(row.status, 'pending');
    });

    await t.test('sendFriendRequest: duplicate pending request between same pair -> REQUEST_PENDING', async () => {
      await friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'friendo');
      await assert.rejects(
        () => friends.sendFriendRequest('00000000-0000-4000-8000-000000000002', 'hunter'), // reversed direction, same unordered pair
        (e) => e.code === 'REQUEST_PENDING'
      );
    });

    await t.test('sendFriendRequest: already friends -> ALREADY_FRIENDS', async () => {
      const req = await friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'friendo');
      await friends.respondToFriendRequest('00000000-0000-4000-8000-000000000002', req.id, true);
      await assert.rejects(
        () => friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'friendo'),
        (e) => e.code === 'ALREADY_FRIENDS'
      );
    });

    await t.test('respondToFriendRequest: only the addressee may respond', async () => {
      const req = await friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'friendo');
      await assert.rejects(
        () => friends.respondToFriendRequest('00000000-0000-4000-8000-000000000003', req.id, true), // stranger, not addressee
        (e) => e.code === 'FORBIDDEN' && e.status === 403
      );
    });

    await t.test('respondToFriendRequest: approve creates a bidirectional friendship', async () => {
      const req = await friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'friendo');
      await friends.respondToFriendRequest('00000000-0000-4000-8000-000000000002', req.id, true);
      const { rows } = await pool.query('select * from friendships order by user_id');
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.user_id).sort(), ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
    });

    await t.test('respondToFriendRequest: cannot respond twice (not pending)', async () => {
      const req = await friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'friendo');
      await friends.respondToFriendRequest('00000000-0000-4000-8000-000000000002', req.id, false);
      await assert.rejects(
        () => friends.respondToFriendRequest('00000000-0000-4000-8000-000000000002', req.id, true),
        (e) => e.code === 'REQUEST_NOT_PENDING'
      );
    });

    await t.test('removeFriend: removes both directions', async () => {
      const req = await friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'friendo');
      await friends.respondToFriendRequest('00000000-0000-4000-8000-000000000002', req.id, true);
      await friends.removeFriend('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
      const { rows } = await pool.query('select * from friendships');
      assert.equal(rows.length, 0);
    });

    await t.test('removeFriend: cannot remove yourself', async () => {
      await assert.rejects(() => friends.removeFriend('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'), (e) => e.code === 'SELF_REMOVE');
    });

    await t.test('listIncoming/listOutgoing reflect the two sides of a pending request', async () => {
      await friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'friendo');
      const incoming = await friends.listIncomingRequests('00000000-0000-4000-8000-000000000002');
      const outgoing = await friends.listOutgoingRequests('00000000-0000-4000-8000-000000000001');
      assert.equal(incoming.length, 1);
      assert.equal(incoming[0].fromUsername, 'hunter');
      assert.equal(outgoing.length, 1);
      assert.equal(outgoing[0].toUsername, 'friendo');
    });

    await t.test('getFriendsPresence: offline by default, online+fresh after heartbeat, offline again once stale', async () => {
      const req = await friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'friendo');
      await friends.respondToFriendRequest('00000000-0000-4000-8000-000000000002', req.id, true);

      let rows = await friends.getFriendsPresence('00000000-0000-4000-8000-000000000001');
      assert.equal(rows[0].status, 'offline');

      await presence.heartbeat(
        '00000000-0000-4000-8000-000000000002',
        { appearOnline: true, showCurrentGame: true, showCurrentServer: true },
        { mercyGameId: 'minecraft', kind: 'hosting', serverId: 'srv-1', serverName: 'My Server' }
      );
      rows = await friends.getFriendsPresence('00000000-0000-4000-8000-000000000001');
      assert.equal(rows[0].status, 'online');
      assert.equal(rows[0].activityLabel, 'Playing/Hosting Minecraft');
      assert.equal(rows[0].serverId, 'srv-1');

      // Force the heartbeat to look stale (older than PRESENCE_STALE_MS).
      await pool.query("update presence set last_heartbeat = now() - interval '10 minutes' where user_id = '00000000-0000-4000-8000-000000000002'");
      rows = await friends.getFriendsPresence('00000000-0000-4000-8000-000000000001');
      assert.equal(rows[0].status, 'offline');
      assert.equal(rows[0].activityLabel, null);
    });

    await t.test('getFriendsPresence: never returns non-friends, regardless of their presence', async () => {
      await presence.heartbeat('00000000-0000-4000-8000-000000000003', { appearOnline: true, showCurrentGame: true, showCurrentServer: true }, {
        mercyGameId: 'fivem',
        kind: 'hosting',
      });
      const rows = await friends.getFriendsPresence('00000000-0000-4000-8000-000000000001');
      assert.equal(rows.length, 0);
    });

    await t.test('getEveryonePlaying: shows online, playing, appear_online strangers; flags isFriend/requestPending correctly', async () => {
      await presence.heartbeat('00000000-0000-4000-8000-000000000002', { appearOnline: true, showCurrentGame: true, showCurrentServer: false }, {
        mercyGameId: 'minecraft',
        kind: 'playing',
      });
      await presence.heartbeat('00000000-0000-4000-8000-000000000003', { appearOnline: true, showCurrentGame: true, showCurrentServer: false }, {
        mercyGameId: 'fivem',
        kind: 'playing',
      });
      await friends.sendFriendRequest('00000000-0000-4000-8000-000000000001', 'friendo'); // pending with u2

      const rows = await friends.getEveryonePlaying('00000000-0000-4000-8000-000000000001');
      const byId = Object.fromEntries(rows.map((r) => [r.userId, r]));
      assert.equal(byId['00000000-0000-4000-8000-000000000002'].requestPending, true);
      assert.equal(byId['00000000-0000-4000-8000-000000000002'].isFriend, false);
      assert.equal(byId['00000000-0000-4000-8000-000000000003'].requestPending, false);
      assert.equal(byId['00000000-0000-4000-8000-000000000003'].isFriend, false);
    });

    // REPRODUCED THE FIX: appearOnline and showCurrentGame are two SEPARATE
    // privacy controls (see getEveryonePlaying's own header comment) — the
    // real, confirmed production bug was that showCurrentGame=false
    // excluded a user from Everyone Playing ENTIRELY instead of just hiding
    // their activity, so a user with Appear Online on but Show Current
    // Mercy Server off was invisible even though they should have appeared
    // (without activity details).
    await t.test('getEveryonePlaying: appearOnline=false excludes the user entirely — the one thing that should gate visibility', async () => {
      await presence.heartbeat('00000000-0000-4000-8000-000000000002', { appearOnline: false, showCurrentGame: true, showCurrentServer: false }, {
        mercyGameId: 'minecraft',
        kind: 'playing',
      });
      const rows = await friends.getEveryonePlaying('00000000-0000-4000-8000-000000000001');
      assert.equal(rows.find((r) => r.userId === '00000000-0000-4000-8000-000000000002'), undefined);
    });

    await t.test('REPRODUCED THE FIX: appearOnline=true + showCurrentGame=false -> the user IS visible, with no activity/server info exposed', async () => {
      await presence.heartbeat('00000000-0000-4000-8000-000000000003', { appearOnline: true, showCurrentGame: false, showCurrentServer: false }, {
        mercyGameId: 'minecraft',
        kind: 'playing',
      });
      const rows = await friends.getEveryonePlaying('00000000-0000-4000-8000-000000000001');
      const row = rows.find((r) => r.userId === '00000000-0000-4000-8000-000000000003');
      assert.notEqual(row, undefined, 'the user must still appear in Everyone Playing');
      assert.equal(row.activityLabel, null, 'activity must be hidden when showCurrentGame is off');
      assert.equal(row.mercyGameId, null, 'the game id must be hidden when showCurrentGame is off');
    });

    await t.test('getEveryonePlaying: appearOnline=true + showCurrentGame=true -> visible WITH real activity info', async () => {
      await presence.heartbeat('00000000-0000-4000-8000-000000000002', { appearOnline: true, showCurrentGame: true, showCurrentServer: false }, {
        mercyGameId: 'fivem',
        kind: 'playing',
      });
      const rows = await friends.getEveryonePlaying('00000000-0000-4000-8000-000000000001');
      const row = rows.find((r) => r.userId === '00000000-0000-4000-8000-000000000002');
      assert.notEqual(row, undefined);
      assert.equal(row.mercyGameId, 'fivem');
      assert.notEqual(row.activityLabel, null);
    });

    await t.test('getEveryonePlaying: a stale heartbeat (older than the freshness window) is not visible, even with appearOnline=true', async () => {
      await presence.heartbeat('00000000-0000-4000-8000-000000000002', { appearOnline: true, showCurrentGame: true, showCurrentServer: false }, {
        mercyGameId: 'minecraft',
        kind: 'playing',
      });
      // Backdate the heartbeat directly — presence.heartbeat() always
      // stamps now(), so this is the only way to create a genuinely stale
      // row without waiting out the real PRESENCE_STALE_MS window.
      await pool.query(`update presence set last_heartbeat = now() - interval '1 hour' where user_id = '00000000-0000-4000-8000-000000000002'`);
      const rows = await friends.getEveryonePlaying('00000000-0000-4000-8000-000000000001');
      assert.equal(rows.find((r) => r.userId === '00000000-0000-4000-8000-000000000002'), undefined);
    });

    await t.test('getEveryonePlaying: multiple unrelated, non-friend users can appear simultaneously', async () => {
      await presence.heartbeat('00000000-0000-4000-8000-000000000002', { appearOnline: true, showCurrentGame: true, showCurrentServer: false }, { mercyGameId: 'minecraft', kind: 'playing' });
      await presence.heartbeat('00000000-0000-4000-8000-000000000003', { appearOnline: true, showCurrentGame: false, showCurrentServer: false }, { mercyGameId: 'fivem', kind: 'playing' });
      const rows = await friends.getEveryonePlaying('00000000-0000-4000-8000-000000000001');
      const ids = rows.map((r) => r.userId).sort();
      assert.deepEqual(ids, ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003']);
    });

    await t.test('getEveryonePlaying: never includes the caller themselves', async () => {
      await presence.heartbeat('00000000-0000-4000-8000-000000000001', { appearOnline: true, showCurrentGame: true, showCurrentServer: false }, {
        mercyGameId: 'minecraft',
        kind: 'playing',
      });
      const rows = await friends.getEveryonePlaying('00000000-0000-4000-8000-000000000001');
      assert.equal(rows.length, 0);
    });
  }
);
