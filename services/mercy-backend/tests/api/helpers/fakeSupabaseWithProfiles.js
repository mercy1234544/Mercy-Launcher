'use strict';

/**
 * A fuller fake of the supabase-js subset used by api/discordIdentity.js:
 * .from('profiles').select().eq().maybeSingle(), .from('profiles').update().eq(),
 * and .auth.admin.createUser(). Separate from helpers/fakeSupabaseApi.js
 * (which only covers the narrower read-only surface api/auth.js +
 * api/profiles.js use) so each stays simple and honest about what it fakes.
 *
 * Keeps an in-memory `profiles` array so createUser + the discord_id
 * backfill update are both observable and reflected in later lookups,
 * exactly like the real handle_new_user() trigger + a follow-up update
 * would behave.
 */
function makeFakeSupabaseWithProfiles({ profiles = [], createUserImpl } = {}) {
  const rows = profiles.map((p) => ({ ...p }));
  let nextId = 1000;
  let createUserCalls = 0;

  function selectBuilder(filterFn) {
    let filtered = rows;
    const builder = {
      eq(col, val) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      async maybeSingle() {
        return { data: filtered[0] || null, error: null };
      },
    };
    return builder;
  }

  function updateBuilder(patch) {
    return {
      eq(col, val) {
        const row = rows.find((r) => r[col] === val);
        if (row) Object.assign(row, patch);
        return Promise.resolve({ data: row ? [row] : [], error: row ? null : { message: 'not found' } });
      },
    };
  }

  return {
    from(table) {
      if (table !== 'profiles') throw new Error(`fake supabase: unexpected table ${table}`);
      return {
        select() {
          return selectBuilder();
        },
        update(patch) {
          return updateBuilder(patch);
        },
      };
    },
    auth: {
      admin: {
        async createUser(opts) {
          createUserCalls++;
          if (createUserImpl) return createUserImpl(opts);
          const id = `auto-${nextId++}`;
          rows.push({ id, username: opts?.user_metadata?.username || `user_${id.slice(0, 8)}`, discord_id: null });
          return { data: { user: { id } }, error: null };
        },
      },
    },
    _rows: rows,
    _createUserCallCount: () => createUserCalls,
  };
}

module.exports = { makeFakeSupabaseWithProfiles };
