'use strict';

/**
 * Minimal fake of shared/localDb's `query(text, params)` surface, covering
 * only the two statements signaling/auth.js actually issues against the
 * local `mercy_backend` Postgres database: the `servers` ownership lookup
 * and the `join_requests` token lookup.
 */
function makeFakeLocalDb({ servers = [], joinRequests = [] } = {}) {
  return {
    async query(text, params) {
      const sql = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
      if (sql.startsWith('select owner_id from servers')) {
        const row = servers.find((s) => s.id === params[0]);
        return { rows: row ? [{ owner_id: row.owner_id }] : [] };
      }
      if (sql.startsWith('select id, host_id, requester_id, server_id, status, expires_at, token from join_requests')) {
        const row = joinRequests.find((r) => r.token === params[0]);
        return { rows: row ? [row] : [] };
      }
      throw new Error(`fakeLocalDb: unhandled query: ${text}`);
    },
  };
}

module.exports = { makeFakeLocalDb };
