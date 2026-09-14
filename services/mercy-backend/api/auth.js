'use strict';

const { getServiceClient } = require('../shared/supabase');
const { ApiError } = require('./errors');
const logger = require('../shared/logger');

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

/** Express-less HTTP middleware: throws ApiError, caller (api/http.js)
 * converts to the right status/code. */
async function requireAuth(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const result = await verifyAccessToken(token);
  if (!result.valid) {
    const status = result.code === 'SERVER_ERROR' ? 503 : 401;
    throw new ApiError(result.code, result.reason, status);
  }
  return result.userId;
}

module.exports = { verifyAccessToken, requireAuth };
