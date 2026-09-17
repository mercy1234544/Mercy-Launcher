'use strict';

const { getServiceClient } = require('../shared/supabase');
const localDb = require('../shared/localDb');
const logger = require('../shared/logger');

/**
 * Host auth: HelloMessage.token for role:'host' is the caller's Supabase Auth
 * access token. See docs/backend-architecture.md §3 for why — the client has
 * no join-token before any join request exists.
 *
 * Verified via supabase.auth.getUser(token) rather than a local HS256 check:
 * this project signs session tokens with an asymmetric (ES256/JWKS) key, which
 * a hardcoded `jwt.verify(token, secret, {algorithms:['HS256']})` cannot
 * validate (jsonwebtoken rejects on algorithm mismatch, it does not fall
 * back). Delegating to Supabase Auth itself verifies the token against
 * whatever the project's current signing key actually is, without the relay
 * needing to hold or track that key at all.
 */
async function verifyHostToken(token) {
  if (typeof token !== 'string' || !token) {
    return { valid: false, reason: 'Malformed token.' };
  }
  const supabase = getServiceClient();
  let data, error;
  try {
    ({ data, error } = await supabase.auth.getUser(token));
  } catch (e) {
    logger.error('host token verification error', { error: e.message });
    return { valid: false, reason: 'Server error.' };
  }
  if (error || !data || !data.user || typeof data.user.id !== 'string') {
    return { valid: false, reason: 'Invalid or expired token.' };
  }
  return { valid: true, userId: data.user.id };
}

/**
 * Confirms the authenticated host user actually owns serverId, using the
 * `servers` table `mercy-api` owns (api/repo/servers.js) in the local
 * `mercy_backend` Postgres database — NOT Supabase. `servers` was migrated
 * off Supabase when mercy-api's local-Postgres Friends/Presence/servers
 * schema was introduced (see shared/env.js's DB_* header comment); Supabase
 * has no `servers` table for this app anymore, so a lookup against it here
 * would silently find nothing and reject every real host registration.
 */
async function verifyServerOwnership(userId, serverId) {
  try {
    const { rows } = await localDb.query('select owner_id from servers where id = $1', [serverId]);
    if (rows.length === 0) return false;
    return rows[0].owner_id === userId;
  } catch (e) {
    logger.error('server ownership lookup failed', { error: e.message });
    return false;
  }
}

/**
 * Client auth: HelloMessage.token for role:'client' is the join-token minted by
 * PresenceManager.createJoinToken() and stored verbatim on join_requests.token
 * at approval time. The relay has no way to verify the HMAC signature (it never
 * receives the host's per-install secret), so it authorizes by exact-string
 * lookup against the row the backend itself recorded. See
 * docs/backend-architecture.md §4. `join_requests` lives in the same local
 * `mercy_backend` Postgres database as `servers` above — mercy-api's
 * api/repo/joins.js writes it there via `db.query`/`withTransaction`, never
 * through Supabase, so this must read from the same place, not Supabase.
 */
function decodeJoinTokenPayload(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body] = token.split('.');
  if (!body) return null;
  try {
    const json = Buffer.from(body, 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    if (
      typeof payload.serverId !== 'string' ||
      typeof payload.mercyGameId !== 'string' ||
      typeof payload.expiresAt !== 'number' ||
      typeof payload.nonce !== 'string'
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function verifyClientToken(token) {
  const payload = decodeJoinTokenPayload(token);
  if (!payload) return { valid: false, reason: 'Malformed token.' };

  if (Date.now() > payload.expiresAt) {
    return { valid: false, reason: 'Token expired.' };
  }

  let rows;
  try {
    ({ rows } = await localDb.query(
      'select id, host_id, requester_id, server_id, status, expires_at, token from join_requests where token = $1',
      [token]
    ));
  } catch (e) {
    logger.error('join_requests lookup failed', { error: e.message });
    return { valid: false, reason: 'Server error.' };
  }
  const data = rows[0] || null;
  if (!data || data.token !== token) {
    return { valid: false, reason: 'Invalid token.' };
  }
  if (data.status !== 'authorized') {
    return { valid: false, reason: 'Join request is not authorized.' };
  }
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    return { valid: false, reason: 'Token expired.' };
  }
  if (data.server_id !== payload.serverId) {
    return { valid: false, reason: 'Token/server mismatch.' };
  }

  return {
    valid: true,
    joinRequestId: data.id,
    hostId: data.host_id,
    requesterId: data.requester_id,
    serverId: data.server_id,
    nonce: payload.nonce,
    nonceExpiresAt: payload.expiresAt,
  };
}

module.exports = {
  verifyHostToken,
  verifyServerOwnership,
  verifyClientToken,
  decodeJoinTokenPayload,
};
