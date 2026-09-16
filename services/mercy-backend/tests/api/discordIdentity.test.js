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
