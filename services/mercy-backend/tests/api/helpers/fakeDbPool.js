'use strict';

/**
 * A fake `pg` pool for testing code that goes through db.withTransaction()
 * without a real Postgres available (see testDb.js's own header — real-DB
 * tests are gated on MERCY_API_DB_PASSWORD and skip otherwise).
 *
 * This fake genuinely enforces per-key mutual exclusion for
 * `pg_advisory_xact_lock($1)` (a standard FIFO promise-chain mutex, keyed
 * by the lock key) — a second query for the SAME lock key only resolves
 * after the transaction that acquired it first calls COMMIT or ROLLBACK.
 * That is the exact real-world property
 * discordIdentity.js:resolveDiscordIdentity() depends on for race-safety,
 * so this is a faithful enough simulation to prove the CODE's
 * check-lock-recheck-create sequence is correct, even without a real
 * Postgres server in this environment.
 *
 * It is intentionally narrow: it understands only the handful of
 * statements db.withTransaction()/resolveDiscordIdentity() actually issue
 * (BEGIN/COMMIT/ROLLBACK/pg_advisory_xact_lock) and throws on anything
 * else, so a test never silently passes against an unexpected query.
 */
function makeFakeDbPool() {
  const queueTail = new Map(); // lockKey -> promise resolving once the key is fully free

  function acquire(key) {
    const prev = queueTail.get(key) || Promise.resolve();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    queueTail.set(key, prev.then(() => held));
    return prev.then(() => release);
  }

  function makeClient() {
    const releasesToRunOnEnd = [];
    return {
      async query(text, params) {
        const sql = String(text).trim().toLowerCase();
        if (sql === 'begin') return { rows: [] };
        if (sql === 'commit' || sql === 'rollback') {
          for (const release of releasesToRunOnEnd.splice(0)) release();
          return { rows: [] };
        }
        if (sql.startsWith('select pg_advisory_xact_lock')) {
          const key = params[0];
          const release = await acquire(key);
          releasesToRunOnEnd.push(release);
          return { rows: [] };
        }
        throw new Error(`fakeDbPool: unexpected query in test: ${text}`);
      },
      release() {},
    };
  }

  return {
    async connect() {
      return makeClient();
    },
  };
}

module.exports = { makeFakeDbPool };
