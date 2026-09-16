'use strict';

const { getServiceClient } = require('../shared/supabase');
const { ApiError } = require('./errors');
const logger = require('../shared/logger');
const discordAuth = require('./discordAuth');
const discordIdentity = require('./discordIdentity');

/**
 * Resolves an existing Mercy user's EXISTING Supabase Auth access token
 * (the same one already sitting in supabase.auth.getSession() in the
 * renderer) to their stable identity — auth.users.id, which is also
 * profiles.id. This is the exact pattern mercy-relay's own
 * signaling/auth.js:verifyHostToken already uses in production.
 *
 * No password, no Discord credential, no second login: this call only ever
 * verifies a credential Supabase already issued.
 */
async function verifyAccessToken(token) {
  if (typeof token !== 'string' || !token) {
    return { valid: false, code: 'AUTH_ERROR', reason: 'Missing or malformed token.' };
  }
  const supabase = getServiceClient();
  let data, error;
  try {
    ({ data, error } = await supabase.auth.getUser(token));
  } catch (e) {
    logger.error('token verification error', { error: e.message });
    return { valid: false, code: 'SERVER_ERROR', reason: 'Auth service unreachable.' };
  }
  if (error) {
    // Supabase returning an error object (rather than throwing) can still
    // mean "its own backend is down", not "this token is invalid" — a
    // 5xx/429 from GoTrue must not be reported as AUTH_ERROR, the exact
    // collapse the original bug report was about (a transient failure
    // rendered as if the user or their credential were the problem).
    const status = error.status || error.statusCode;
    if (typeof status === 'number' && (status >= 500 || status === 429)) {
      logger.error('auth backend error', { status, error: error.message });
      return { valid: false, code: 'SERVER_ERROR', reason: 'Auth service unreachable.' };
    }
    return { valid: false, code: 'AUTH_ERROR', reason: 'Invalid or expired token.' };
  }
  if (!data || !data.user || typeof data.user.id !== 'string') {
    return { valid: false, code: 'AUTH_ERROR', reason: 'Invalid or expired token.' };
  }
  return { valid: true, userId: data.user.id };
}

/**
 * The single authentication entry point for every Mercy API route AND the
 * presence WebSocket's `hello` message (api/http.js / api/wsServer.js both
 * call this instead of verifyAccessToken directly).
 *
 * Tries the EXISTING Supabase Auth access token path first — unchanged in
 * every respect for a caller presenting one (same cost, same result),
 * preserving backward compatibility for any client build that has not
 * migrated to Discord-session auth yet (this API has live production
 * traffic today; old and new client builds are expected to call it
 * simultaneously during rollout). Only when that fails does this attempt
 * the new Discord-session verification path — Windows clients on the
 * Discord-identity migration send the launcher's existing Discord/Vehicle
 * Studio session token here instead of a Supabase token; it's verified
 * server-to-server against that service's own /session endpoint, then the
 * verified discordId is resolved to the SAME profiles.id identity
 * Friends/Presence has always used (see discordIdentity.js).
 *
 * A discordId is NEVER trusted unless it came back from that server-to-
 * server verification call — there is no code path anywhere in this API
 * that reads a client-supplied discordId from a request body or WebSocket
 * message.
 */
async function resolveAuthenticatedUser(token) {
  const supabaseResult = await verifyAccessToken(token);
  if (supabaseResult.valid) {
    return { valid: true, userId: supabaseResult.userId, authMethod: 'supabase' };
  }

  const discordResult = await discordAuth.verifyDiscordSession(token);
  if (!discordResult.valid) {
    // The token matched neither auth mechanism. Only report SERVER_ERROR
    // when BOTH checks failed because their respective backend was
    // unreachable — anything else (a token that is simply invalid/expired,
    // or valid for neither system) is an honest AUTH_ERROR, never
    // mis-blamed on an outage.
    const bothUnreachable = supabaseResult.code === 'SERVER_ERROR' && discordResult.code === 'SERVER_ERROR';
    return { valid: false, code: bothUnreachable ? 'SERVER_ERROR' : 'AUTH_ERROR', reason: discordResult.reason };
  }

  const userId = await discordIdentity.resolveDiscordIdentity(discordResult.discordId, discordResult.discordUsername);
  return { valid: true, userId, authMethod: 'discord' };
}

/** Express-less HTTP middleware: throws ApiError, caller (api/http.js)
 * converts to the right status/code. */
async function requireAuth(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const result = await resolveAuthenticatedUser(token);
  if (!result.valid) {
    const status = result.code === 'SERVER_ERROR' ? 503 : 401;
    throw new ApiError(result.code, result.reason, status);
  }
  return result.userId;
}

module.exports = { verifyAccessToken, resolveAuthenticatedUser, requireAuth };
