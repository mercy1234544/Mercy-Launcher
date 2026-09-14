'use strict';

const crypto = require('crypto');
const logger = require('../shared/logger');
const {
  RELAY_HOST_REGISTRATION_TTL_MS,
  hostRegistered,
  relayGranted,
  relayDenied,
  relayData,
  relayClosed,
} = require('../shared/protocol');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Owns host registrations (relayId -> host session) and paired relay channels
 * (channelId -> {hostSession, clientSession}). Purely forwards opaque
 * relay-data frames between the two WebSocket sockets already authenticated by
 * signaling/ — never opens any outbound connection itself. See
 * docs/backend-architecture.md §2.
 */
class ChannelManager {
  constructor({ maxConcurrentSessions }) {
    this.hostRegistrations = new Map(); // relayId -> { session, serverId, game, transport, expiresAt }
    this.channels = new Map(); // channelId -> { hostSession, clientSession, createdAt, lastActivityAt }
    this.maxConcurrentSessions = maxConcurrentSessions;
  }

  registerHost(session, { serverId, game, transport, expiresAt }) {
    const relayId = newId('relay');
    const ttlExpiresAt = Math.min(expiresAt || Infinity, Date.now() + RELAY_HOST_REGISTRATION_TTL_MS);
    this.hostRegistrations.set(relayId, {
      session,
      serverId,
      game,
      transport,
      expiresAt: ttlExpiresAt,
    });
    session.hostedRelayIds.add(relayId);
    logger.info('host registered', { relayId, serverId, game, transport, sessionId: session.sessionId });
    session.send(hostRegistered(relayId, ttlExpiresAt));
    return relayId;
  }

  unregisterHost(relayId, sessionId) {
    const reg = this.hostRegistrations.get(relayId);
    if (!reg || reg.session.sessionId !== sessionId) return false;
    this.hostRegistrations.delete(relayId);
    logger.info('host unregistered', { relayId, sessionId });
    return true;
  }

  /** Frees every registration/channel owned by a disconnecting session. */
  cleanupSession(session) {
    for (const relayId of session.hostedRelayIds) {
      this.hostRegistrations.delete(relayId);
      logger.info('host registration freed on disconnect', { relayId, sessionId: session.sessionId });
    }
    for (const channelId of session.activeChannelIds) {
      this.closeChannel(channelId, 'peer disconnected');
    }
  }

  pruneExpiredRegistrations() {
    const now = Date.now();
    for (const [relayId, reg] of this.hostRegistrations) {
      if (reg.expiresAt < now) {
        this.hostRegistrations.delete(relayId);
        reg.session.hostedRelayIds.delete(relayId);
        logger.info('host registration expired', { relayId });
      }
    }
  }

  totalActiveChannels() {
    return this.channels.size;
  }

  /**
   * clientSession has already been authorized for this exact joinRequestId by
   * signaling/auth.js at hello time (docs/backend-architecture.md §5). This
   * method re-checks relayId validity and server match, then pairs the channel.
   */
  requestRelay(clientSession, { joinRequestId, relayId }) {
    if (clientSession.joinRequestId !== joinRequestId) {
      return { granted: false, reason: 'Join request not authorized on this connection.' };
    }
    const reg = this.hostRegistrations.get(relayId);
    if (!reg || reg.expiresAt < Date.now()) {
      return { granted: false, reason: 'Unknown or expired relay id.' };
    }
    if (reg.serverId !== clientSession.serverId) {
      return { granted: false, reason: 'Relay id does not match authorized server.' };
    }
    if (this.channels.size >= this.maxConcurrentSessions) {
      return { granted: false, reason: 'Relay is at capacity.' };
    }

    const channelId = newId('chan');
    const now = Date.now();
    this.channels.set(channelId, {
      hostSession: reg.session,
      clientSession,
      createdAt: now,
      lastActivityAt: now,
    });
    reg.session.activeChannelIds.add(channelId);
    clientSession.activeChannelIds.add(channelId);

    logger.info('relay channel granted', {
      channelId,
      relayId,
      joinRequestId,
      hostSessionId: reg.session.sessionId,
      clientSessionId: clientSession.sessionId,
    });

    reg.session.send(relayGranted(channelId));
    clientSession.send(relayGranted(channelId));
    return { granted: true, channelId };
  }

  denyRelay(clientSession, reason) {
    clientSession.send(relayDenied(reason));
  }

  /** Forwards a relay-data frame to the other side of the channel, if the
   * sending session is actually a participant (prevents channel hijacking). */
  forwardData(fromSession, channelId, dataBase64) {
    const chan = this.channels.get(channelId);
    if (!chan) return false;
    if (chan.hostSession !== fromSession && chan.clientSession !== fromSession) {
      logger.warn('rejected relay-data from non-participant session', {
        channelId,
        sessionId: fromSession.sessionId,
      });
      return false;
    }
    const other = chan.hostSession === fromSession ? chan.clientSession : chan.hostSession;
    chan.lastActivityAt = Date.now();
    other.send({ type: 'relay-data', channelId, data: dataBase64 });
    return true;
  }

  closeChannel(channelId, reason) {
    const chan = this.channels.get(channelId);
    if (!chan) return;
    this.channels.delete(channelId);
    chan.hostSession.activeChannelIds.delete(channelId);
    chan.clientSession.activeChannelIds.delete(channelId);
    chan.hostSession.send(relayClosed(channelId, reason));
    chan.clientSession.send(relayClosed(channelId, reason));
    logger.info('relay channel closed', { channelId, reason });
  }
}

module.exports = { ChannelManager };
