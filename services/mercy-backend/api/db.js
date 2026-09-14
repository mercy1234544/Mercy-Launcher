'use strict';

const { Pool } = require('pg');
const env = require('./env');
const logger = require('../shared/logger');

let pool = null;
let testOverride = null;

function getPool() {
  if (testOverride) return testOverride;
  if (pool) return pool;
  pool = env.DATABASE_URL
    ? new Pool({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX })
    : new Pool({
        host: env.DB_HOST,
        port: env.DB_PORT,
        database: env.DB_NAME,
        user: env.DB_USER,
        password: env.DB_PASSWORD,
        max: env.DB_POOL_MAX,
      });
  pool.on('error', (err) => logger.error('pg pool error', { error: err.message }));
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

/** Runs fn(client) inside a transaction with row locking available; rolls
 * back on any thrown error (including ApiError validation failures). */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Test-only: point every query/transaction at a disposable pool (e.g. a
 * real Postgres test database) instead of the production one. */
function _setPoolForTesting(fakePool) {
  testOverride = fakePool;
}

async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { getPool, query, withTransaction, _setPoolForTesting, closePool };
