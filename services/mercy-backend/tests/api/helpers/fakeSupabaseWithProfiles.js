'use strict';

/**
 * A fuller fake of the supabase-js subset used by api/discordIdentity.js:
 * .from('profiles').select().eq().maybeSingle(), .from('profiles').update().eq(),
 * .auth.admin.createUser(), and .auth.admin.deleteUser(). Separate from
 * helpers/fakeSupabaseApi.js (which only covers the narrower read-only
 * surface api/auth.js + api/profiles.js use) so each stays simple and
 * honest about what it fakes.
 *
 * Keeps an in-memory `profiles` array so createUser + the discord_id
 * backfill update are both observable and reflected in later lookups,
 * exactly like the real handle_new_user() trigger + a follow-up update
 * would behave. The default createUser enforces the SAME unique constraint
 * on username that handle_new_user()'s insert would hit in real Postgres,
 * returning a 23505 unique_violation-shaped error — this is what lets a
 * test simulate the username TOCTOU race (B3) by seeding a colliding row
 * between the availability check and createUser(), same as a genuinely
 * concurrent request would.
 *
 * `authUsers`/`authErrors` (optional) make this fake ALSO answer
 * `.auth.getUser(token)` like helpers/fakeSupabaseApi.js does, so a single
 * fake client can stand in for the ONE real service-role client every
 * caller in a request actually shares — see auth.test.js, which needs both
 * verifyAccessToken's getUser() call and discordIdentity's profiles/createUser
 * calls to hit the same client, exactly like production.
 */
function makeFakeSupabaseWithProfiles({ profiles = [], createUserImpl, deleteUserImpl, authUsers = {}, authErrors = {} } = {}) {
  const rows = profiles.map((p) => ({ ...p }));
  let nextId = 1000;
  let createUserCalls = 0;
  let deleteUserCalls = 0;
  const deletedIds = [];
  let forceNextUpdateError = null;

  function selectBuilder() {
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
        if (forceNextUpdateError) {
          const err = forceNextUpdateError;
          forceNextUpdateError = null;
          return Promise.resolve({ data: null, error: err });
        }
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
      async getUser(token) {
        if (Object.prototype.hasOwnProperty.call(authErrors, token)) {
          return { data: { user: null }, error: { message: authErrors[token] } };
        }
        const user = authUsers[token];
        if (!user) return { data: { user: null }, error: { message: 'Invalid token.' } };
        return { data: { user }, error: null };
      },
      admin: {
        async createUser(opts) {
          createUserCalls++;
          if (createUserImpl) return createUserImpl(opts);
          const username = opts?.user_metadata?.username;
          if (username && rows.some((r) => r.username === username)) {
            return {
              data: null,
              error: { code: '23505', message: 'duplicate key value violates unique constraint "profiles_username_key"' },
            };
          }
          const id = `auto-${nextId++}`;
          rows.push({ id, username: username || `user_${id.slice(0, 8)}`, email: opts?.email ?? null, discord_id: null });
          return { data: { user: { id } }, error: null };
        },
        async deleteUser(userId) {
          deleteUserCalls++;
          deletedIds.push(userId);
          if (deleteUserImpl) return deleteUserImpl(userId);
          const idx = rows.findIndex((r) => r.id === userId);
          if (idx !== -1) rows.splice(idx, 1);
          return { data: {}, error: null };
        },
      },
    },
    _rows: rows,
    _createUserCallCount: () => createUserCalls,
    _deleteUserCallCount: () => deleteUserCalls,
    _deletedIds: deletedIds,
    _forceNextUpdateError(err) {
      forceNextUpdateError = err;
    },
  };
}

module.exports = { makeFakeSupabaseWithProfiles };
