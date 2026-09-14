'use strict';

const db = require('../db');
const pubsub = require('../pubsub');
const profiles = require('../profiles');
const { ApiError } = require('../errors');
const env = require('../env');

async function requestJoin(userId, serverId) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query('select * from servers where id = $1', [serverId]);
    const server = rows[0];
    if (!server) throw new ApiError('SERVER_NOT_FOUND', 'Server not found.', 404);
    if (server.owner_id === userId) throw new ApiError('SELF_JOIN', 'Cannot join your own server.', 400);

    const isFriend = await client.query(
      'select 1 from friendships where user_id = $1 and friend_id = $2',
      [userId, server.owner_id]
    );
    if (isFriend.rowCount === 0) {
      throw new ApiError('NOT_FRIENDS', "You are not friends with this server's host.", 403);
    }
    if (!server.is_online) throw new ApiError('SERVER_OFFLINE', 'Server is offline.', 409);

    const expiresAt = new Date(Date.now() + env.JOIN_REQUEST_TTL_MS);
    const { rows: inserted } = await client.query(
      `insert into join_requests (requester_id, host_id, server_id, expires_at)
       values ($1, $2, $3, $4) returning *`,
      [userId, server.owner_id, serverId, expiresAt]
    );
    pubsub.notify(server.owner_id, 'joins');
    return inserted[0];
  });
}

async function respondToJoinRequest(userId, requestId, approve, token, endpoint) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query('select * from join_requests where id = $1 for update', [requestId]);
    const row = rows[0];
    if (!row) throw new ApiError('REQUEST_NOT_FOUND', 'Join request not found.', 404);
    if (row.host_id !== userId) throw new ApiError('FORBIDDEN', 'Only the host can respond to this join request.', 403);
    if (row.status !== 'pending') throw new ApiError('REQUEST_NOT_PENDING', 'Join request is not pending.', 409);

    await client.query(
      `update join_requests
         set status = $2, token = $3, endpoint = $4
       where id = $1`,
      [
        requestId,
        approve ? 'authorized' : 'denied',
        approve ? token || null : null,
        approve ? (endpoint ? JSON.stringify(endpoint) : null) : null,
      ]
    );
    pubsub.notify(row.requester_id, 'joins');
  });
}

async function listJoinRequests(userId) {
  const { rows } = await db.query(
    `select * from join_requests
     where requester_id = $1 or host_id = $1
     order by created_at desc limit 20`,
    [userId]
  );
  const userIds = rows.map((r) => r.requester_id);
  const usernames = await profiles.getUsernamesByIds(userIds);
  const serverIds = [...new Set(rows.map((r) => r.server_id))];
  const servers = serverIds.length
    ? (await db.query('select id, mercy_game_id, edition from servers where id = any($1)', [serverIds])).rows
    : [];
  const serverById = new Map(servers.map((s) => [s.id, s]));

  const mapRow = (r) => ({
    id: r.id,
    requesterId: r.requester_id,
    requesterUsername: usernames.get(r.requester_id) || 'Unknown',
    hostId: r.host_id,
    serverId: r.server_id,
    status: r.status,
    endpoint: r.endpoint,
    token: r.token,
    mercyGameId: serverById.get(r.server_id)?.mercy_game_id ?? null,
    edition: serverById.get(r.server_id)?.edition ?? null,
    createdAt: r.created_at,
  });

  return {
    incoming: rows.filter((r) => r.host_id === userId && r.status === 'pending').map(mapRow),
    outgoing: rows.filter((r) => r.requester_id === userId).map(mapRow),
  };
}

async function expireStaleJoinRequests() {
  const { rowCount } = await db.query(
    `update join_requests set status = 'expired' where status = 'pending' and expires_at < now()`
  );
  return rowCount;
}

module.exports = { requestJoin, respondToJoinRequest, listJoinRequests, expireStaleJoinRequests };
