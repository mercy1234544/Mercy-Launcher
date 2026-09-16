'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://localhost:0';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

const { _setServiceClientForTesting } = require('../../shared/supabase');
const db = require('../../api/db');
const { makeFakeSupabaseWithProfiles } = require('./helpers/fakeSupabaseWithProfiles');
const { makeFakeDbPool } = require('./helpers/fakeDbPool');
const { resolveDiscordIdentity, findByDiscordId } = require('../../api/discordIdentity');
const { ApiError } = require('../../api/errors');

function setup(profiles = []) {
  const fake = makeFakeSupabaseWithProfiles({ profiles });
  _setServiceClientForTesting(fake);
  db._setPoolForTesting(makeFakeDbPool());
  return fake;
}

test('resolveDiscordIdentity: an existing mapping is reused, never re-provisioned', async () => {
  setup([{ id: 'user-abc', username: 'ExistingUser', discord_id: '111' }]);
  const id = await resolveDiscordIdentity('111', 'ExistingUser');
  assert.equal(id, 'user-abc');
});

test('resolveDiscordIdentity: a first-seen Discord user gets a new profile mapping created', async () => {
  const fake = setup([]);
  const id = await resolveDiscordIdentity('222', 'NewPerson');
  assert.ok(id, 'a new profiles.id was returned');
  assert.equal(fake._createUserCallCount(), 1);
  const row = fake._rows.find((r) => r.id === id);
  assert.equal(row.discord_id, '222', 'the new profile is backfilled with the verified discordId');
});

test('resolveDiscordIdentity: the new profile\'s username is derived from the verified Discord display name when available', async () => {
  const fake = setup([]);
  const id = await resolveDiscordIdentity('333', 'CoolRacer99');
  const row = fake._rows.find((r) => r.id === id);
  assert.equal(row.username, 'coolracer99');
});

test('resolveDiscordIdentity: a taken username candidate falls back to a discordId-suffixed variant, never colliding', async () => {
  const fake = setup([{ id: 'someone-else', username: 'coolracer99', discord_id: null }]);
  const id = await resolveDiscordIdentity('444', 'CoolRacer99');
  const row = fake._rows.find((r) => r.id === id);
  assert.notEqual(row.username, 'coolracer99');
  assert.ok(row.username.startsWith('coolracer99_'));
});

test('resolveDiscordIdentity: repeated first-seen requests for the SAME discordId create exactly one profile (race-safe)', async () => {
  const fake = setup([]);
  const [a, b] = await Promise.all([
    resolveDiscordIdentity('555', 'RaceySameId'),
    resolveDiscordIdentity('555', 'RaceySameId'),
  ]);
  assert.equal(a, b, 'both concurrent callers resolve to the SAME profiles.id');
  assert.equal(fake._createUserCallCount(), 1, 'only ONE Supabase user was ever created for this discordId');
});

test('resolveDiscordIdentity: concurrent requests for DIFFERENT discordIds are not serialized against each other', async () => {
  const fake = setup([]);
  const [a, b] = await Promise.all([
    resolveDiscordIdentity('666', 'PersonSix'),
    resolveDiscordIdentity('777', 'PersonSeven'),
  ]);
  assert.notEqual(a, b);
  assert.equal(fake._createUserCallCount(), 2);
});

test('findByDiscordId: returns null (not an error) when no mapping exists yet', async () => {
  setup([]);
  const id = await findByDiscordId('does-not-exist');
  assert.equal(id, null);
});

// ── B1: the .invalid placeholder email must never end up on the profiles
//    row that AdminPanel/user-facing code reads. ────────────────────────────
test('resolveDiscordIdentity: the placeholder email used to satisfy Supabase Auth never lands in profiles.email', async () => {
  const fake = setup([]);
  const id = await resolveDiscordIdentity('888', 'EmailCheck');
  const row = fake._rows.find((r) => r.id === id);
  assert.equal(row.email, null, 'profiles.email is cleared in the same backfill that sets discord_id');
});

// ── B2: if the discord_id backfill fails after createUser() already
//    succeeded, the orphaned auth user must be cleaned up, not left behind
//    holding a username. ────────────────────────────────────────────────────
test('resolveDiscordIdentity: a failed discord_id backfill deletes the just-created orphaned user', async () => {
  const fake = setup([]);
  fake._forceNextUpdateError({ message: 'connection reset' });

  await assert.rejects(
    () => resolveDiscordIdentity('999', 'OrphanCase'),
    (e) => e instanceof ApiError && e.status === 503
  );

  assert.equal(fake._createUserCallCount(), 1, 'the user was created before the backfill failed');
  assert.equal(fake._deleteUserCallCount(), 1, 'the orphaned user was cleaned up');
  assert.equal(fake._rows.length, 0, 'no orphaned profile is left behind holding the username');
});

test('resolveDiscordIdentity: a later retry for the SAME discordId succeeds after a prior backfill failure was cleaned up', async () => {
  const fake = setup([]);
  fake._forceNextUpdateError({ message: 'connection reset' });
  await assert.rejects(() => resolveDiscordIdentity('1010', 'RetryAfterOrphan'));

  const id = await resolveDiscordIdentity('1010', 'RetryAfterOrphan');
  assert.ok(id, 'the retry provisions a fresh identity since the orphan was removed');
  const row = fake._rows.find((r) => r.id === id);
  assert.equal(row.discord_id, '1010');
});

// ── B3: losing the username TOCTOU race against a DIFFERENT discordId must
//    fall back to the trigger's default username, never fail the login. ────
test('resolveDiscordIdentity: losing the username uniqueness race retries with the default username instead of failing the login', async () => {
  let createUserCalls = 0;
  let fake;
  fake = makeFakeSupabaseWithProfiles({
    profiles: [],
    createUserImpl(opts) {
      createUserCalls++;
      if (createUserCalls === 1) {
        // Simulates another discordId's concurrent request winning the
        // race and taking this username between our availability check
        // and this createUser() call.
        assert.equal(opts.user_metadata.username, 'racedname');
        return Promise.resolve({
          data: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint "profiles_username_key"' },
        });
      }
      assert.deepEqual(opts.user_metadata, {}, 'the retry sends no chosen username, letting the trigger default it');
      const id = 'fallback-id';
      fake._rows.push({ id, username: 'user_fallback', discord_id: null });
      return Promise.resolve({ data: { user: { id } }, error: null });
    },
  });
  _setServiceClientForTesting(fake);
  db._setPoolForTesting(makeFakeDbPool());

  const id = await resolveDiscordIdentity('1111', 'RacedName');
  assert.equal(id, 'fallback-id', 'provisioning succeeds via the retry rather than failing the login');
  assert.equal(createUserCalls, 2, 'exactly one retry was attempted after the uniqueness collision');
});
