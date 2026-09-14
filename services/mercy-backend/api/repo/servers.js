'use strict';

const db = require('../db');
const { ApiError } = require('../errors');

const GAMES = new Set(['fivem', 'minecraft', 'assettocorsa']);
const EDITIONS = new Set(['java', 'bedrock']);

async function upsertServer(userId, server) {
  if (!server || typeof server.id !== 'string' || !server.id) {
    throw new ApiError('BAD_REQUEST', 'Missing server id.', 400);
  }
  if (!GAMES.has(server.mercyGameId)) {
    throw new ApiError('BAD_REQUEST', 'Invalid mercyGameId.', 400);
  }
  const edition = server.edition && EDITIONS.has(server.edition) ? server.edition : null;

  const { rowCount } = await db.query(
    `insert into servers (id, owner_id, mercy_game_id, edition, display_name, is_online, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (id) do update
       set mercy_game_id = excluded.mercy_game_id,
           edition = excluded.edition,
           display_name = excluded.display_name,
           is_online = excluded.is_online,
           updated_at = now()
       where servers.owner_id = $2`,
    [server.id, userId, server.mercyGameId, edition, server.displayName || server.id, !!server.isOnline]
  );
  if (rowCount === 0) {
    // Either a brand-new row insert that somehow matched 0 rows (shouldn't
    // happen) or — the real case — an existing server owned by someone
    // else: the WHERE clause on the update branch blocked it.
    const existing = await db.query('select owner_id from servers where id = $1', [server.id]);
    if (existing.rowCount > 0 && existing.rows[0].owner_id !== userId) {
      throw new ApiError('FORBIDDEN', 'You do not own this server.', 403);
    }
  }
}

async function getServer(serverId) {
  const { rows } = await db.query('select * from servers where id = $1', [serverId]);
  return rows[0] || null;
}

module.exports = { upsertServer, getServer };
