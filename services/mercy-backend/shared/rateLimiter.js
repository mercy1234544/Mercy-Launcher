'use strict';

/** Simple fixed-window counter, one instance per connection per limited action. */
class RateLimiter {
  constructor({ maxHits, windowMs }) {
    this.maxHits = maxHits;
    this.windowMs = windowMs;
    this.hits = [];
  }

  /** Returns true if this hit is allowed (and records it); false if over the limit. */
  hit() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.hits = this.hits.filter((t) => t > cutoff);
    if (this.hits.length >= this.maxHits) return false;
    this.hits.push(now);
    return true;
  }
}

module.exports = { RateLimiter };
