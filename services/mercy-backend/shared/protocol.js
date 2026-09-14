'use strict';

/**
 * Mirrors src/main/services/connection/protocol.ts exactly (see
 * reference/client/linux-backend-client-contract.md §1). Do not add fields or
 * message types here that aren't in that source — this file is the wire contract.
 */

const RELAY_PROTOCOL_VERSION = 1;

const RELAY_HOST_REGISTRATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RELAY_IDLE_TIMEOUT_MS = 90 * 1000; // 90 seconds
const RELAY_HELLO_TIMEOUT_MS = 5000; // 5 seconds
const RELAY_ALLOCATION_RATE_LIMIT = { maxHits: 5, windowMs: 60_000 };
const JOIN_REQUEST_RATE_LIMIT = { maxHits: 10, windowMs: 60_000 };

const GAMES = new Set(['minecraft', 'fivem', 'assettocorsa']);
const TRANSPORTS = new Set(['tcp', 'udp']);
const ROLES = new Set(['host', 'client']);

const CLIENT_MESSAGE_TYPES = new Set([
  'hello',
  'register-host',
  'unregister-host',
  'request-relay',
  'relay-data',
  'ping',
]);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates the outer shape only — deep field validation happens per-handler. */
function parseClientMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(msg) || typeof msg.type !== 'string') return null;
  if (!CLIENT_MESSAGE_TYPES.has(msg.type)) return null;
  return msg;
}

function helloAck(sessionId) {
  return { type: 'hello-ack', sessionId };
}
function helloRejected(reason) {
  return { type: 'hello-rejected', reason };
}
function hostRegistered(relayId, expiresAt) {
  return { type: 'host-registered', relayId, expiresAt };
}
function relayGranted(channelId) {
  return { type: 'relay-granted', channelId };
}
function relayDenied(reason) {
  return { type: 'relay-denied', reason };
}
function relayData(channelId, dataBuffer) {
  return { type: 'relay-data', channelId, data: dataBuffer.toString('base64') };
}
function relayClosed(channelId, reason) {
  return { type: 'relay-closed', channelId, reason };
}
function pong(at) {
  return { type: 'pong', at };
}

module.exports = {
  RELAY_PROTOCOL_VERSION,
  RELAY_HOST_REGISTRATION_TTL_MS,
  RELAY_IDLE_TIMEOUT_MS,
  RELAY_HELLO_TIMEOUT_MS,
  RELAY_ALLOCATION_RATE_LIMIT,
  JOIN_REQUEST_RATE_LIMIT,
  GAMES,
  TRANSPORTS,
  ROLES,
  parseClientMessage,
  helloAck,
  helloRejected,
  hostRegistered,
  relayGranted,
  relayDenied,
  relayData,
  relayClosed,
  pong,
};
