'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NonceStore } = require('../signaling/nonceStore');
const { RateLimiter } = require('../shared/rateLimiter');

test('nonce store: first use is accepted, replay is rejected', () => {
  const store = new NonceStore();
  assert.equal(store.consume('n1', Date.now() + 60_000), true);
  assert.equal(store.consume('n1', Date.now() + 60_000), false);
});

test('nonce store: different nonces are independent', () => {
  const store = new NonceStore();
  assert.equal(store.consume('n1', Date.now() + 60_000), true);
  assert.equal(store.consume('n2', Date.now() + 60_000), true);
});

test('rate limiter: allows up to maxHits then blocks', () => {
  const rl = new RateLimiter({ maxHits: 3, windowMs: 60_000 });
  assert.equal(rl.hit(), true);
  assert.equal(rl.hit(), true);
  assert.equal(rl.hit(), true);
  assert.equal(rl.hit(), false);
});
