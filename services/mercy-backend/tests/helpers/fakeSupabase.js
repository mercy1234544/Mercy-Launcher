'use strict';

/**
 * Minimal fake of the subset of the supabase-js client signaling/auth.js
 * actually uses today: `auth.getUser(token)` for `verifyHostToken`.
 * `servers`/`join_requests` are NOT queried through Supabase (they live in
 * the local `mercy_backend` Postgres database — see tests/helpers/fakeLocalDb.js
 * and shared/localDb.js), so this fake no longer fronts a `.from()` builder.
 */
function makeFakeSupabase({ authUsers = {}, authErrors = {} } = {}) {
  return {
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
