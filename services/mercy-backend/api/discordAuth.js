'use strict';

const env = require('./env');
const logger = require('../shared/logger');

/**
 * Verifies a bearer token by calling the SAME public /session endpoint the
 * Windows desktop client already calls (the existing Vehicle Studio/Discord
 * auth service at VEHICLE_STUDIO_AUTH_URL) — server-to-server, mirroring
 * exactly how api/auth.js's verifyAccessToken already delegates Supabase
 * token verification to Supabase itself rather than re-implementing JWT
 * verification locally.
 *
 * This service never receives, holds, or needs the Discord OAuth client
 * secret, the Discord bot token, or any shared signing secret with the auth
 * service — it only ever forwards an opaque token to the SAME server that
 * issued it, and trusts only what that server hands back. A discordId is
 * NEVER accepted from anywhere else (not a request body field, not a
 * WebSocket message field) — see api/auth.js's resolveAuthenticatedUser,
 * the only caller of this function.
 */
async function verifyDiscordSession(token) {
  if (typeof token !== 'string' || !token) {
    return { valid: false, code: 'AUTH_ERROR', reason: 'Missing or malformed token.' };
  }
  if (!env.VEHICLE_STUDIO_AUTH_URL) {
    // Not configured in this environment — never silently treat every
    // token as a valid Discord session just because the check can't run.
    logger.error('VEHICLE_STUDIO_AUTH_URL is not configured; Discord session verification is disabled');
    return { valid: false, code: 'SERVER_ERROR', reason: 'Discord session verification is not configured.' };
  }

  let res;
  try {
    res = await fetch(`${env.VEHICLE_STUDIO_AUTH_URL}/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (e) {
    logger.error('discord session verification unreachable', { error: e.message });
    return { valid: false, code: 'SERVER_ERROR', reason: 'Auth service unreachable.' };
  }

  if (res.status >= 500 || res.status === 429) {
    logger.error('discord session verification backend error', { status: res.status });
    return { valid: false, code: 'SERVER_ERROR', reason: 'Auth service unreachable.' };
  }
  if (!res.ok) {
    return { valid: false, code: 'AUTH_ERROR', reason: 'Invalid or expired session.' };
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    logger.error('discord session verification returned malformed JSON', { error: e.message });
    return { valid: false, code: 'SERVER_ERROR', reason: 'Auth service returned a malformed response.' };
  }

  // Deployed shape (confirmed by a live diagnostic call during the
  // Discord-identity audit — see the Windows client's VehicleStudioAuth.ts
  // header): { user: { id, discordUsername, discordAvatar, roleVerified },
  // session: { expiresAt } }. `user.id` is already the verified Discord
  // snowflake ID.
  //
  // The "local reference" implementation checked into
  // services/vehicle-studio-auth/src/app.ts returns a DIFFERENT, older
  // shape ({ ok, authorized, username, expiresAt }) with no discordId field
  // at all — it is not what is actually deployed. If VEHICLE_STUDIO_AUTH_URL
  // ever points at that shape instead, this intentionally falls through to
  // the "no verified identity" branch below rather than fabricating one.
  const discordId = body && body.user && typeof body.user.id === 'string' ? body.user.id : null;
  if (!discordId) {
    return { valid: false, code: 'AUTH_ERROR', reason: 'Session did not include a verified Discord identity.' };
  }
  const discordUsername = body.user && typeof body.user.discordUsername === 'string' ? body.user.discordUsername : undefined;
  return { valid: true, discordId, discordUsername };
}

module.exports = { verifyDiscordSession };
