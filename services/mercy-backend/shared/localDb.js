'use strict';

const { Pool } = require('pg');
const env = require('./env');
const logger = require('./logger');

/**
 * The relay's read-only view of mercy-api's local Postgres `mercy_backend`
 * database — `servers` (ownership) and `join_requests` (client-token
 * lookup) live only here (see env.js's DB_* header comment), never in
 * Supabase. Deliberately a SEPARATE `pg.Pool` from api/db.js's: these are
 * two independent pm2 processes (mercy-relay, mercy-api) with unrelated
 * failure domains (ecosystem.config.js's own header comment), so each
 * keeps its own connection pool to the same database rather than sharing
 * one across a process boundary.
 */

let pool = null;
let testOverride = null;

function getPool() {
  if (testOverride) return testOverride;
  if (pool) return pool;
  pool = env.DB_DATABASE_URL
    ? new Pool({ connectionString: env.DB_DATABASE_URL, max: env.DB_POOL_MAX })
    : new Pool({
        host: env.DB_HOST,
        port: env.DB_PORT,
        database: env.DB_NAME,
        user: env.DB_USER,
        password: env.DB_PASSWORD,
        max: env.DB_POOL_MAX,
      });
  pool.on('error', (err) => logger.error('local db pool error', { error: err.message }));
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

/** Test-only: point every query at a disposable pool/fake instead of the
 * production one. */
function _setPoolForTesting(fakePool) {
  testOverride = fakePool;
}

async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { query, _setPoolForTesting, closePool };
