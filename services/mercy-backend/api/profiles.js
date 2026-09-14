'use strict';

// Username <-> user id resolution — deliberately NOT mirrored into local
// Postgres. Usernames are identity data and identity stays owned by
// Supabase (profiles.id == auth.users.id); this file just reads that one
// table read-only via the service-role client, same credential already
// used for token verification and already used by mercy-relay for
// server-ownership checks.

const { getServiceClient } = require('../shared/supabase');
const { ApiError } = require('./errors');

async function getUsernamesByIds(ids) {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const supabase = getServiceClient();
  const { data, error } = await supabase.from('profiles').select('id, username').in('id', unique);
  if (error) throw new ApiError('SERVER_ERROR', error.message, 503);
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
  if (error) throw new ApiError('SERVER_ERROR', error.message, 503);
  return data ? data.id : null;
}

module.exports = { getUsernamesByIds, getIdByUsername };
