'use strict';

/**
 * Structured JSON logger. Never pass tokens, secrets, auth headers, or raw
 * credentials into `fields` — per Step 9/Step 5, only opaque IDs (sessionId,
 * relayId, channelId, userId) belong in logs.
 */

const REDACT_KEYS = new Set(['token', 'secret', 'authorization', 'password', 'jwt', 'key']);

function safeFields(fields) {
  if (!fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

function line(level, msg, fields) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...safeFields(fields),
  };
  const out = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

module.exports = {
  info: (msg, fields) => line('info', msg, fields),
  warn: (msg, fields) => line('warn', msg, fields),
  error: (msg, fields) => line('error', msg, fields),
  debug: (msg, fields) => {
    if (process.env.MERCY_SIGNALING_LOG_LEVEL === 'debug') line('debug', msg, fields);
  },
};
