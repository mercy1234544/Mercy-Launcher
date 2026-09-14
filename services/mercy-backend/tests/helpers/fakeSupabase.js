'use strict';

/**
 * Minimal fake of the subset of the supabase-js query builder that
 * signaling/auth.js actually uses: .from(table).select(cols).eq(col, val).maybeSingle()
 */
function makeFakeSupabase({ servers = [], joinRequests = [], authUsers = {}, authErrors = {} } = {}) {
  const tables = { servers, join_requests: joinRequests };

  return {
    from(table) {
      const rows = tables[table] || [];
      let filtered = rows;
      const builder = {
        select() {
          return builder;
        },
        eq(col, val) {
          filtered = filtered.filter((r) => r[col] === val);
          return builder;
        },
        async maybeSingle() {
          if (filtered.length === 0) return { data: null, error: null };
          return { data: filtered[0], error: null };
        },
      };
      return builder;
    },
    auth: {
      /** Fakes supabase.auth.getUser(token) — the real call validates the token
       * against Supabase Auth itself; here it's keyed by the token string. */
      async getUser(token) {
        if (Object.prototype.hasOwnProperty.call(authErrors, token)) {
          return { data: { user: null }, error: { message: authErrors[token] } };
        }
        const user = authUsers[token];
        if (!user) {
          return { data: { user: null }, error: { message: 'Invalid token.' } };
        }
        return { data: { user }, error: null };
      },
    },
  };
}

module.exports = { makeFakeSupabase };
