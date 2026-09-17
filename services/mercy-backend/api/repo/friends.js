'use strict';

const db = require('../db');
const profiles = require('../profiles');
const pubsub = require('../pubsub');
const { ApiError } = require('../errors');
const env = require('../env');

async function getFriendIds(userId) {
  const { rows } = await db.query('select friend_id from friendships where user_id = $1', [userId]);
  return rows.map((r) => r.friend_id);
}

async function sendFriendRequest(userId, addresseeUsername) {
  const addresseeId = await profiles.getIdByUsername(String(addresseeUsername || '').trim());
  if (!addresseeId) {
    throw new ApiError('USER_NOT_FOUND', 'User not found.', 404);
  }
  if (addresseeId === userId) {
    throw new ApiError('SELF_REQUEST', 'Cannot send a friend request to yourself.', 400);
  }

  return db.withTransaction(async (client) => {
    const friends = await client.query(
      'select 1 from friendships where user_id = $1 and friend_id = $2',
      [userId, addresseeId]
    );
    if (friends.rowCount > 0) {
      throw new ApiError('ALREADY_FRIENDS', 'Already friends.', 409);
    }

    const pending = await client.query(
      `select 1 from friend_requests
       where status = 'pending'
         and least(requester_id, addressee_id) = least($1::uuid, $2::uuid)
         and greatest(requester_id, addressee_id) = greatest($1::uuid, $2::uuid)`,
      [userId, addresseeId]
    );
    if (pending.rowCount > 0) {
      throw new ApiError('REQUEST_PENDING', 'A pending friend request already exists between these users.', 409);
    }

    const { rows } = await client.query(
      `insert into friend_requests (requester_id, addressee_id)
       values ($1, $2) returning id, requester_id, addressee_id, status, created_at`,
      [userId, addresseeId]
    );
    pubsub.notify(addresseeId, 'requests');
    return rows[0];
  });
}

async function respondToFriendRequest(userId, requestId, approve) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'select * from friend_requests where id = $1 for update',
      [requestId]
    );
    const row = rows[0];
    if (!row) throw new ApiError('REQUEST_NOT_FOUND', 'Friend request not found.', 404);
    if (row.status !== 'pending') throw new ApiError('REQUEST_NOT_PENDING', 'Friend request is not pending.', 409);
    if (row.addressee_id !== userId) throw new ApiError('FORBIDDEN', 'Only the addressee can respond to this request.', 403);

    await client.query(
      `update friend_requests set status = $2, responded_at = now() where id = $1`,
      [requestId, approve ? 'accepted' : 'declined']
    );

    if (approve) {
      await client.query(
        `insert into friendships (user_id, friend_id) values ($1, $2)
         on conflict do nothing`,
        [row.requester_id, row.addressee_id]
      );
      await client.query(
        `insert into friendships (user_id, friend_id) values ($1, $2)
         on conflict do nothing`,
        [row.addressee_id, row.requester_id]
      );
    }

    pubsub.notifyMany([row.requester_id, row.addressee_id], 'friends');
    pubsub.notifyMany([row.requester_id, row.addressee_id], 'requests');
  });
}

async function removeFriend(userId, friendId) {
  if (friendId === userId) {
    throw new ApiError('SELF_REMOVE', 'Cannot remove yourself as a friend.', 400);
  }
  await db.query(
    `delete from friendships
     where (user_id = $1 and friend_id = $2) or (user_id = $2 and friend_id = $1)`,
    [userId, friendId]
  );
  pubsub.notifyMany([userId, friendId], 'friends');
}

async function listIncomingRequests(userId) {
  const { rows } = await db.query(
    `select id, requester_id, created_at from friend_requests
     where addressee_id = $1 and status = 'pending' order by created_at desc`,
    [userId]
  );
  const usernames = await profiles.getUsernamesByIds(rows.map((r) => r.requester_id));
  return rows.map((r) => ({
    id: r.id,
    fromUserId: r.requester_id,
    fromUsername: usernames.get(r.requester_id) || 'Unknown',
    createdAt: r.created_at,
  }));
}

async function listOutgoingRequests(userId) {
  const { rows } = await db.query(
    `select id, addressee_id, created_at from friend_requests
     where requester_id = $1 and status = 'pending' order by created_at desc`,
    [userId]
  );
  const usernames = await profiles.getUsernamesByIds(rows.map((r) => r.addressee_id));
  return rows.map((r) => ({
    id: r.id,
    toUserId: r.addressee_id,
    toUsername: usernames.get(r.addressee_id) || 'Unknown',
    createdAt: r.created_at,
  }));
}

function isFresh(lastHeartbeat) {
  if (!lastHeartbeat) return false;
  return Date.now() - new Date(lastHeartbeat).getTime() <= env.PRESENCE_STALE_MS;
}

function activityLabel(activity) {
  if (!activity || !activity.mercyGameId) return null;
  const game = String(activity.mercyGameId);
  const name = game.charAt(0).toUpperCase() + game.slice(1);
  return activity.kind === 'hosting' ? `Playing/Hosting ${name}` : `Playing ${name}`;
}

async function getFriendsPresence(userId) {
  const { rows } = await db.query(
    `select f.friend_id as user_id, pr.appear_online, pr.last_heartbeat,
            pr.show_current_game, pr.show_current_server, pr.activity
     from friendships f
     left join presence pr on pr.user_id = f.friend_id
     where f.user_id = $1`,
    [userId]
  );
  const usernames = await profiles.getUsernamesByIds(rows.map((r) => r.user_id));
  return rows.map((r) => {
    const online = !!r.appear_online && isFresh(r.last_heartbeat);
    const showGame = online && r.show_current_game && r.activity;
    const showServer = showGame && r.show_current_server && r.activity && r.activity.kind === 'hosting';
    return {
      friendId: r.user_id,
      username: usernames.get(r.user_id) || 'Unknown',
      status: online ? 'online' : 'offline',
      activityLabel: showGame ? activityLabel(r.activity) : null,
      mercyGameId: showGame ? r.activity.mercyGameId : null,
      serverId: showServer ? r.activity.serverId ?? null : null,
      serverName: showServer ? r.activity.serverName ?? null : null,
    };
  });
}

async function getEveryonePlaying(userId) {
  // appearOnline and showCurrentGame are two SEPARATE privacy controls, not
  // one combined gate — this mirrors getFriendsPresence() above exactly
  // (`online` there is derived from appear_online alone; show_current_game/
  // show_current_server separately gate only whether activity details are
  // exposed, never whether the row is returned at all). This function used
  // to require show_current_game = true and activity is not null in the
  // WHERE clause, which meant a user with Appear Online ON but Show Current
  // Mercy Server OFF was excluded from Everyone Playing entirely, rather
  // than showing up without their activity — the real, confirmed cause of
  // "Everyone Playing" reporting nobody visible even when other users were
  // genuinely online with Appear Online on. Visibility (row returned at
  // all) is governed ONLY by appear_online + heartbeat freshness now;
  // show_current_game continues to gate the activity fields exactly like
  // it already does for friends.
  const { rows } = await db.query(
    `select pr.user_id, pr.show_current_game, pr.activity
     from presence pr
     where pr.user_id <> $1
       and pr.appear_online = true
       and pr.last_heartbeat > now() - ($2 || ' milliseconds')::interval`,
    [userId, env.PRESENCE_STALE_MS]
  );
  if (rows.length === 0) return [];

  const userIds = rows.map((r) => r.user_id);
  const usernames = await profiles.getUsernamesByIds(userIds);
  const friendIds = new Set(await getFriendIds(userId));
  const { rows: pendingRows } = await db.query(
    `select requester_id, addressee_id from friend_requests
     where status = 'pending' and (requester_id = $1 or addressee_id = $1)`,
    [userId]
  );
  const pendingWith = new Set(
    pendingRows.map((r) => (r.requester_id === userId ? r.addressee_id : r.requester_id))
  );

  return rows.map((r) => {
    const showActivity = !!r.show_current_game && !!r.activity;
    return {
      userId: r.user_id,
      username: usernames.get(r.user_id) || 'Unknown',
      activityLabel: showActivity ? activityLabel(r.activity) : null,
      mercyGameId: showActivity ? r.activity.mercyGameId : null,
      isFriend: friendIds.has(r.user_id),
      requestPending: pendingWith.has(r.user_id),
    };
  });
}

module.exports = {
  getFriendIds,
  sendFriendRequest,
  respondToFriendRequest,
  removeFriend,
  listIncomingRequests,
  listOutgoingRequests,
  getFriendsPresence,
  getEveryonePlaying,
  isFresh,
};
