'use strict';

const { getServiceClient } = require('../shared/supabase');
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
 * existing `servers` table (audit §18.2) — no schema change.
 */
async function verifyServerOwnership(userId, serverId) {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('servers')
    .select('id, owner_id')
    .eq('id', serverId)
    .maybeSingle();
  if (error) {
    logger.error('server ownership lookup failed', { error: error.message });
    return false;
  }
  if (!data) return false;
  return data.owner_id === userId;
}

/**
 * Client auth: HelloMessage.token for role:'client' is the join-token minted by
 * PresenceManager.createJoinToken() and stored verbatim on join_requests.token
 * at approval time. The relay has no way to verify the HMAC signature (it never
 * receives the host's per-install secret), so it authorizes by exact-string
 * lookup against the row Supabase itself recorded. See
 * docs/backend-architecture.md §4.
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

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('join_requests')
    .select('id, host_id, requester_id, server_id, status, expires_at, token')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error('join_requests lookup failed', { error: error.message });
    return { valid: false, reason: 'Server error.' };
  }
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
