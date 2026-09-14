'use strict';

// Per-IP fixed-window limiter for the REST API. mercy-relay already has
// shared/rateLimiter.js, but that's one RateLimiter instance per WebSocket
// session — the REST API has no persistent per-caller connection to hang a
// limiter off, so this keys by remote address instead and expires idle
// entries so the map can't grow unbounded under a scan/DoS.

const buckets = new Map(); // key -> { hits: number[], lastSeen: number }

function hit(key, { maxHits, windowMs }) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }
  bucket.lastSeen = now;
  const cutoff = now - windowMs;
  bucket.hits = bucket.hits.filter((t) => t > cutoff);
  if (bucket.hits.length >= maxHits) return false;
  bucket.hits.push(now);
  return true;
}

// Periodic cleanup so long-idle IPs don't sit in memory forever.
const sweepInterval = setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, bucket] of buckets) {
    if (bucket.lastSeen < cutoff) buckets.delete(key);
  }
}, 60_000);
sweepInterval.unref();

function _resetForTesting() {
  buckets.clear();
}

module.exports = { hit, _resetForTesting };
