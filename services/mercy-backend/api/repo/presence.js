'use strict';

const db = require('../db');
const pubsub = require('../pubsub');
const friends = require('./friends');

async function heartbeat(userId, settings, activity) {
  await db.query(
    `insert into presence (user_id, appear_online, show_current_game, show_current_server, activity, last_heartbeat, updated_at)
     values ($1, $2, $3, $4, $5, now(), now())
     on conflict (user_id) do update
       set appear_online = excluded.appear_online,
           show_current_game = excluded.show_current_game,
           show_current_server = excluded.show_current_server,
           activity = excluded.activity,
           last_heartbeat = now(),
           updated_at = now()`,
    [userId, !!settings.appearOnline, !!settings.showCurrentGame, !!settings.showCurrentServer, activity ? JSON.stringify(activity) : null]
  );
  const friendIds = await friends.getFriendIds(userId);
  pubsub.notifyMany(friendIds, 'friends');
}

/** Server-side heartbeat timeout: every read already treats a stale
 * last_heartbeat as offline (friends.isFresh), but a dead client's row
 * would otherwise sit with appear_online=true forever. This sweep (run on
 * env.STALE_SWEEP_INTERVAL_MS from api/server.js) flips it false once it
 * passes the same staleness threshold, and pushes a final "went offline"
 * notification to friends instead of leaving them to notice only on their
 * next own heartbeat-triggered refresh. */
async function sweepStalePresence(staleMs) {
  const { rows } = await db.query(
    `update presence
       set appear_online = false, updated_at = now()
       where appear_online = true
         and last_heartbeat < now() - ($1 || ' milliseconds')::interval
       returning user_id`,
    [staleMs]
  );
  for (const row of rows) {
    const friendIds = await friends.getFriendIds(row.user_id);
    pubsub.notifyMany(friendIds, 'friends');
  }
  return rows.length;
}

module.exports = { heartbeat, sweepStalePresence };
