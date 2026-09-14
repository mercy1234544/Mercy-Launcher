'use strict';

const crypto = require('crypto');
const logger = require('../shared/logger');
const { RateLimiter } = require('../shared/rateLimiter');
const { RELAY_ALLOCATION_RATE_LIMIT, JOIN_REQUEST_RATE_LIMIT } = require('../shared/protocol');

/** One per WebSocket connection. Tracks auth state and ownership for cleanup/authz checks. */
class Session {
  constructor(ws, remoteAddr) {
    this.ws = ws;
    this.remoteAddr = remoteAddr;
    this.sessionId = `sess_${crypto.randomBytes(12).toString('hex')}`;
    this.state = 'pre-hello'; // pre-hello | ready | failed | closed
    this.role = null; // 'host' | 'client'
    this.userId = null; // host role: Supabase auth user id
    this.serverId = null; // authorized serverId for this connection
    this.joinRequestId = null; // client role only
    this.hostedRelayIds = new Set();
    this.activeChannelIds = new Set();
    this.lastActivityAt = Date.now();
    this.registerHostLimiter = new RateLimiter(RELAY_ALLOCATION_RATE_LIMIT);
    this.requestRelayLimiter = new RateLimiter(JOIN_REQUEST_RATE_LIMIT);
  }

  send(message) {
    if (this.ws.readyState !== this.ws.constructor.OPEN) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch (e) {
      logger.error('send failed', { sessionId: this.sessionId, error: e.message });
    }
  }

  touch() {
    this.lastActivityAt = Date.now();
  }
}

module.exports = { Session };
