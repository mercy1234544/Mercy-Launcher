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
];

test(
  'presence repo — heartbeat/timeout/sweep (real Postgres)',
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

    await t.test('heartbeat: upserts a presence row and is idempotent on repeat calls', async () => {
      await presence.heartbeat('u1', { appearOnline: true, showCurrentGame: false, showCurrentServer: false }, null);
      await presence.heartbeat('u1', { appearOnline: true, showCurrentGame: true, showCurrentServer: false }, {
        mercyGameId: 'minecraft',
        kind: 'playing',
      });
      const { rows } = await pool.query('select * from presence where user_id = $1', ['u1']);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].show_current_game, true);
    });

    await t.test('sweepStalePresence: flips appear_online false once the heartbeat is older than the stale threshold', async () => {
      await presence.heartbeat('u1', { appearOnline: true, showCurrentGame: false, showCurrentServer: false }, null);
      await pool.query("update presence set last_heartbeat = now() - interval '5 minutes' where user_id = 'u1'");

      const flipped = await presence.sweepStalePresence(90_000);
      assert.equal(flipped, 1);

      const { rows } = await pool.query('select appear_online from presence where user_id = $1', ['u1']);
      assert.equal(rows[0].appear_online, false);
    });

    await t.test('sweepStalePresence: leaves a fresh heartbeat untouched', async () => {
      await presence.heartbeat('u1', { appearOnline: true, showCurrentGame: false, showCurrentServer: false }, null);
      const flipped = await presence.sweepStalePresence(90_000);
      assert.equal(flipped, 0);
      const { rows } = await pool.query('select appear_online from presence where user_id = $1', ['u1']);
      assert.equal(rows[0].appear_online, true);
    });

    await t.test('sweepStalePresence: notifies the stale user\'s friends (so they see "went offline")', async () => {
      const req = await friends.sendFriendRequest('u1', 'friendo');
      await friends.respondToFriendRequest('u2', req.id, true);
      await presence.heartbeat('u1', { appearOnline: true, showCurrentGame: false, showCurrentServer: false }, null);
      await pool.query("update presence set last_heartbeat = now() - interval '5 minutes' where user_id = 'u1'");

      const pubsub = require('../../api/pubsub');
      let notified = null;
      const unsub = pubsub.subscribe('u2', (evt) => {
        notified = evt;
      });
      await presence.sweepStalePresence(90_000);
      unsub();
      assert.ok(notified);
      assert.equal(notified.kind, 'friends');
    });
  }
);
