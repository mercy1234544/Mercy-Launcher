'use strict';

// Username <-> user id resolution — deliberately NOT mirrored into local
// Postgres. Usernames are identity data and identity stays owned by
// Supabase (profiles.id == auth.users.id); this file just reads that one
// table read-only via the service-role client, same credential already
// used for token verification and already used by mercy-relay for
// server-ownership checks.

const { getServiceClient } = require('../shared/supabase');
const { ApiError } = require('./errors');
const logger = require('../shared/logger');

// Errors from the Supabase client (error.message) are logged server-side
// only, never handed to the caller as-is — they can include internal
// details (table/column names, driver-level text) that have no business
// reaching an API response. The client only ever sees a generic
// SERVER_ERROR, matching the SERVER_ERROR vs AUTH_ERROR vs USER_NOT_FOUND
// distinction api/auth.js already makes.

async function getUsernamesByIds(ids) {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const supabase = getServiceClient();
  const { data, error } = await supabase.from('profiles').select('id, username').in('id', unique);
  if (error) {
    logger.error('profiles lookup failed', { error: error.message });
    throw new ApiError('SERVER_ERROR', 'Profile lookup failed.', 503);
  }
  const map = new Map();
  for (const row of data || []) map.set(row.id, row.username);
  return map;
}

async function getIdByUsername(username) {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (error) {
    logger.error('profiles lookup failed', { error: error.message });
    throw new ApiError('SERVER_ERROR', 'Profile lookup failed.', 503);
  }
  return data ? data.id : null;
}

module.exports = { getUsernamesByIds, getIdByUsername };
