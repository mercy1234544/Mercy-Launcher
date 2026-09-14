'use strict';

// Real Postgres, isolated in its own schema (`mercy_test`) inside the same
// `mercy_backend` database the role already owns — so tests never touch
// production data and never need a second database/role. Tests that need a
// real DB check `hasTestDb()` first and skip (not fail) when credentials
// aren't configured in this environment, so `npm test` stays runnable
// without a live Postgres everywhere this repo is checked out.

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

function hasTestDb() {
  return !!process.env.MERCY_API_DB_PASSWORD;
}

function buildPool() {
  const schema = 'mercy_test';
  const pool = new Pool({
    host: process.env.MERCY_API_DB_HOST || '127.0.0.1',
    port: Number(process.env.MERCY_API_DB_PORT || 5432),
    database: process.env.MERCY_API_DB_NAME || 'mercy_backend',
    user: process.env.MERCY_API_DB_USER || 'mercy_backend',
    password: process.env.MERCY_API_DB_PASSWORD || '',
    options: `-c search_path=${schema},public`,
  });
  return { pool, schema };
}

async function setupTestDb() {
  const { pool, schema } = buildPool();
  await pool.query(`create schema if not exists ${schema}`);
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'api', 'schema.sql'), 'utf8');
  await pool.query(sql);
  return pool;
}

async function truncateAll(pool) {
  await pool.query(
    'truncate join_requests, servers, presence, friendships, friend_requests restart identity cascade'
  );
}

async function teardownTestDb(pool) {
  await pool.end();
}

module.exports = { hasTestDb, setupTestDb, truncateAll, teardownTestDb };
