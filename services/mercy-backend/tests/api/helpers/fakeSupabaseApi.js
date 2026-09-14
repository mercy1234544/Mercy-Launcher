'use strict';

/**
 * Fake of the subset of supabase-js used by api/auth.js + api/profiles.js:
 * auth.getUser(token), and .from('profiles').select(...).in('id', ids) /
 * .eq('username', u).maybeSingle().
 */
function makeFakeSupabase({ profiles = [], authUsers = {}, authErrors = {} } = {}) {
  return {
    from(table) {
      if (table !== 'profiles') throw new Error(`fake supabase: unexpected table ${table}`);
      let filtered = profiles;
      const builder = {
        select() {
          return builder;
        },
        eq(col, val) {
          filtered = filtered.filter((r) => r[col] === val);
          return builder;
        },
        in(col, vals) {
          const set = new Set(vals);
          filtered = filtered.filter((r) => set.has(r[col]));
          return builder;
        },
        async maybeSingle() {
          return { data: filtered[0] || null, error: null };
        },
        then(resolve) {
          // supports `await supabase.from(...).select().in(...)` without a
          // terminal call, matching real supabase-js's thenable builder.
          resolve({ data: filtered, error: null });
        },
      };
      return builder;
    },
    auth: {
      async getUser(token) {
        if (Object.prototype.hasOwnProperty.call(authErrors, token)) {
          return { data: { user: null }, error: { message: authErrors[token] } };
        }
        const user = authUsers[token];
        if (!user) return { data: { user: null }, error: { message: 'Invalid token.' } };
        return { data: { user }, error: null };
      },
    },
  };
}

module.exports = { makeFakeSupabase };
