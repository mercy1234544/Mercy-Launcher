'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', 'config', '.env') });

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name} (see config/.env.example)`);
  }
  return v;
}

function optionalInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  required,
  optionalInt,
  PORT: optionalInt('MERCY_RELAY_PORT', 4200),
  HEALTH_PORT: optionalInt('MERCY_HEALTH_PORT', 4150),
  LOG_LEVEL: process.env.MERCY_SIGNALING_LOG_LEVEL || 'info',
  MAX_CONCURRENT_CONNECTIONS: optionalInt('MERCY_RELAY_MAX_CONNECTIONS', 500),
  MAX_CONCURRENT_SESSIONS: optionalInt('MERCY_RELAY_MAX_CONCURRENT_SESSIONS', 200),
  MAX_MESSAGE_BYTES: optionalInt('MERCY_RELAY_MAX_MESSAGE_BYTES', 65536),
};
