'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', 'config', '.env') });

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name} (see config/.env.example)`);
  }
  return v;
}

function optionalInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  required,
  optionalInt,
  PORT: optionalInt('MERCY_RELAY_PORT', 4200),
  HEALTH_PORT: optionalInt('MERCY_HEALTH_PORT', 4150),
  LOG_LEVEL: process.env.MERCY_SIGNALING_LOG_LEVEL || 'info',
  MAX_CONCURRENT_CONNECTIONS: optionalInt('MERCY_RELAY_MAX_CONNECTIONS', 500),
  MAX_CONCURRENT_SESSIONS: optionalInt('MERCY_RELAY_MAX_CONCURRENT_SESSIONS', 200),
  MAX_MESSAGE_BYTES: optionalInt('MERCY_RELAY_MAX_MESSAGE_BYTES', 65536),

  // The SAME local Postgres `mercy_backend` database api/db.js connects to
  // (MERCY_API_DB_* vars, already present in config/.env — see
  // api/env.js). `servers` and `join_requests` are owned by mercy-api and
  // live ONLY here, never in Supabase (api/env.js's own header comment:
  // "unrelated to Supabase, which remains the identity provider only") —
  // the relay must read the same rows mercy-api writes, not a stale/absent
  // Supabase table of the same name. See shared/localDb.js.
  DB_DATABASE_URL: process.env.MERCY_API_DATABASE_URL || '',
  DB_HOST: process.env.MERCY_API_DB_HOST || '127.0.0.1',
  DB_PORT: optionalInt('MERCY_API_DB_PORT', 5432),
  DB_NAME: process.env.MERCY_API_DB_NAME || 'mercy_backend',
  DB_USER: process.env.MERCY_API_DB_USER || 'mercy_backend',
  DB_PASSWORD: process.env.MERCY_API_DB_PASSWORD || '',
  DB_POOL_MAX: optionalInt('MERCY_RELAY_DB_POOL_MAX', 5),
};
