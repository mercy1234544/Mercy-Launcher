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
  PORT: optionalInt('MERCY_API_PORT', 4201),
  LOG_LEVEL: process.env.MERCY_SIGNALING_LOG_LEVEL || 'info',

  // Local Postgres — dedicated non-superuser role/database, unrelated to
  // Supabase (which remains the identity provider only, never Friends/
  // Presence data storage after this migration).
  DATABASE_URL: process.env.MERCY_API_DATABASE_URL || '',
  DB_HOST: process.env.MERCY_API_DB_HOST || '127.0.0.1',
  DB_PORT: optionalInt('MERCY_API_DB_PORT', 5432),
  DB_NAME: process.env.MERCY_API_DB_NAME || 'mercy_backend',
  DB_USER: process.env.MERCY_API_DB_USER || 'mercy_backend',
  DB_PASSWORD: process.env.MERCY_API_DB_PASSWORD || '',
  DB_POOL_MAX: optionalInt('MERCY_API_DB_POOL_MAX', 10),

  PRESENCE_STALE_MS: optionalInt('MERCY_API_PRESENCE_STALE_MS', 90_000),
  JOIN_REQUEST_TTL_MS: optionalInt('MERCY_API_JOIN_REQUEST_TTL_MS', 2 * 60 * 1000),
  STALE_SWEEP_INTERVAL_MS: optionalInt('MERCY_API_STALE_SWEEP_INTERVAL_MS', 30_000),

  WS_PING_INTERVAL_MS: optionalInt('MERCY_API_WS_PING_INTERVAL_MS', 20_000),
  WS_PING_TIMEOUT_MS: optionalInt('MERCY_API_WS_PING_TIMEOUT_MS', 45_000),
  WS_HELLO_TIMEOUT_MS: optionalInt('MERCY_API_WS_HELLO_TIMEOUT_MS', 5_000),

  MAX_CONCURRENT_CONNECTIONS: optionalInt('MERCY_API_MAX_CONNECTIONS', 1000),
};
