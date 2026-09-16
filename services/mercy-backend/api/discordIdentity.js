'use strict';

const { getServiceClient } = require('../shared/supabase');
const db = require('./db');
const { ApiError } = require('./errors');
const logger = require('../shared/logger');

// RFC 2606 reserved TLD — guaranteed never to resolve or receive mail.
// Placeholder emails exist ONLY because Supabase Auth requires an
// auth.users row (and this schema's profiles.id references it) — no email
// is ever sent to this address, no user ever sees it, and it is never
// surfaced in any client UI (the renderer shows the verified Discord
// username/avatar instead — see Library.tsx's Friends & Presence identity
// display).
const PLACEHOLDER_EMAIL_DOMAIN = 'discord.mercy.invalid';

function placeholderEmail(discordId) {
  return `discord-${discordId}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

function sanitizeUsernameCandidate(discordUsername) {
  const base = String(discordUsername || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 20);
  return base || null;
}

async function findByDiscordId(discordId) {
  const supabase = getServiceClient();
  const { data, error } = await supabase.from('profiles').select('id').eq('discord_id', discordId).maybeSingle();
  if (error) {
    logger.error('discord identity lookup failed', { error: error.message });
    throw new ApiError('SERVER_ERROR', 'Identity lookup failed.', 503);
  }
  return data ? data.id : null;
}

async function usernameTaken(username) {
  const supabase = getServiceClient();
  const { data, error } = await supabase.from('profiles').select('id').eq('username', username).maybeSingle();
  if (error) {
    logger.error('username availability check failed', { error: error.message });
    throw new ApiError('SERVER_ERROR', 'Identity lookup failed.', 503);
  }
  return !!data;
}

/** Picks a friendly, available username derived from the verified Discord
 *  display name where possible (so friends can find/add this person by a
 *  recognizable name — see the approved migration plan's "Friends can
 *  appear as Discord-backed identities"), falling back to letting the
 *  existing handle_new_user() trigger generate its usual `user_<id8>`
 *  default (by returning undefined) when no usable candidate is free. */
async function pickUsername(discordId, discordUsername) {
  const base = sanitizeUsernameCandidate(discordUsername);
  if (!base) return undefined;
  if (!(await usernameTaken(base))) return base;
  const suffixed = `${base}_${discordId.slice(-4)}`.slice(0, 24);
  if (!(await usernameTaken(suffixed))) return suffixed;
  return undefined;
}

async function provisionDiscordProfile(discordId, discordUsername) {
  const supabase = getServiceClient();
  const username = await pickUsername(discordId, discordUsername);
  const { data, error } = await supabase.auth.admin.createUser({
    email: placeholderEmail(discordId),
    email_confirm: true, // never sends anything — service-role Admin API call, no SMTP involved
    user_metadata: username ? { username } : {},
  });
  if (error || !data || !data.user || typeof data.user.id !== 'string') {
    logger.error('discord profile provisioning failed', { error: error && error.message });
    throw new ApiError('SERVER_ERROR', 'Could not create your Mercy identity.', 503);
  }
  const newId = data.user.id;
  // handle_new_user()'s trigger creates the profiles row but has no concept
  // of discord_id — backfill it in the same request, before anything else
  // can observe this identity as "resolved".
  const { error: updateError } = await supabase.from('profiles').update({ discord_id: discordId }).eq('id', newId);
  if (updateError) {
    logger.error('discord_id backfill failed', { error: updateError.message, userId: newId });
    throw new ApiError('SERVER_ERROR', 'Could not finish creating your Mercy identity.', 503);
  }
  return newId;
}

/**
 * Resolves a VERIFIED discordId (never a client-supplied one — see
 * api/discordAuth.js's verifyDiscordSession, the only source of this value)
 * to a stable profiles.id, auto-provisioning a placeholder identity on
 * first sight.
 *
 * Race-safety: two simultaneous first-sight requests for the same Discord
 * account must not create two profiles. This uses a Postgres advisory lock
 * in the LOCAL mercy-api database (the same connection pool every other
 * repo/*.js already uses via db.withTransaction) keyed on the discordId, so
 * the check-then-create sequence is serialized across every concurrent
 * request for that SAME discordId — a genuinely different discordId never
 * contends for the same lock. The lock is released automatically when the
 * wrapping transaction ends (db.withTransaction's own COMMIT/ROLLBACK).
 *
 * The fast, overwhelmingly common path (an already-provisioned identity)
 * never takes the lock at all.
 */
async function resolveDiscordIdentity(discordId, discordUsername) {
  const existing = await findByDiscordId(discordId);
  if (existing) return existing;

  return db.withTransaction(async (client) => {
    // hashtext() folds the key to 32 bits; pg_advisory_xact_lock's single-
    // argument overload takes a bigint, and Postgres implicitly widens the
    // int4 result — this only needs to serialize concurrent requests for
    // the SAME discordId, not guarantee a globally unique lock key, so a
    // rare 32-bit hash collision with an unrelated discordId just means two
    // unrelated first-sight provisions briefly wait on each other, never
    // that their identities merge.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`discord:${discordId}`]);
    // Re-check now that we hold the lock — another request may have
    // finished provisioning this exact discordId while we were waiting.
    const recheck = await findByDiscordId(discordId);
    if (recheck) return recheck;
    return provisionDiscordProfile(discordId, discordUsername);
  });
}

module.exports = { resolveDiscordIdentity, findByDiscordId, _placeholderEmail: placeholderEmail };
