'use strict';

/**
 * Mirrors PresenceManager.ts's consumedNonces pattern (audit §5, §17): an
 * in-memory Map<nonce, expiresAt>, pruned lazily. Per-process, per-relay-instance —
 * matches the client's own equivalent scope (per-PresenceManager-instance).
 */
class NonceStore {
  constructor() {
    this.consumed = new Map();
  }

  prune() {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.consumed) {
      if (expiresAt < now) this.consumed.delete(nonce);
    }
  }

  /** Returns true if the nonce was fresh and is now marked consumed; false if already used. */
  consume(nonce, expiresAt) {
    this.prune();
    if (this.consumed.has(nonce)) return false;
    this.consumed.set(nonce, expiresAt);
    return true;
  }
}

module.exports = { NonceStore };
