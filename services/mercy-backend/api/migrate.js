'use strict';

// Idempotent schema apply — safe to re-run (every statement in schema.sql is
// `create ... if not exists`). Run manually: `node api/migrate.js`.

const fs = require('fs');
const path = require('path');
const { getPool } = require('./db');
const logger = require('../shared/logger');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const pool = getPool();
  await pool.query(sql);
  logger.info('mercy-api schema applied');
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error('migration failed', { error: e.message });
      process.exit(1);
    });
}

module.exports = { migrate };
