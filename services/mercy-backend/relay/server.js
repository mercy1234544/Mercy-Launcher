'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const env = require('../shared/env');
const logger = require('../shared/logger');
const protocol = require('../shared/protocol');
const { Session } = require('../signaling/session');
const { NonceStore } = require('../signaling/nonceStore');
const { verifyHostToken, verifyServerOwnership, verifyClientToken } = require('../signaling/auth');
const { ChannelManager } = require('./channelManager');

const nonceStore = new NonceStore();
const channelManager = new ChannelManager({ maxConcurrentSessions: env.MAX_CONCURRENT_SESSIONS });

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
        activeConnections: wss.clients.size,
        hostRegistrations: channelManager.hostRegistrations.size,
        activeChannels: channelManager.totalActiveChannels(),
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: env.MAX_MESSAGE_BYTES,
});

function rejectAndClose(session, reason) {
  session.state = 'failed';
  session.send(protocol.helloRejected(reason));
  logger.warn('hello rejected', { sessionId: session.sessionId, reason });
  session.ws.close();
}

async function handleHello(session, msg) {
  if (session.state !== 'pre-hello') return; // only one hello per connection
  if (typeof msg.token !== 'string' || !protocol.ROLES.has(msg.role)) {
    return rejectAndClose(session, 'Malformed hello.');
  }
  if (msg.protocolVersion !== protocol.RELAY_PROTOCOL_VERSION) {
    return rejectAndClose(session, `Unsupported protocol version ${msg.protocolVersion}.`);
  }

  if (msg.role === 'host') {
    const result = await verifyHostToken(msg.token);
    if (!result.valid) return rejectAndClose(session, result.reason);
    session.role = 'host';
    session.userId = result.userId;
  } else {
    const result = await verifyClientToken(msg.token);
    if (!result.valid) return rejectAndClose(session, result.reason);
    if (!nonceStore.consume(result.nonce, result.nonceExpiresAt)) {
      return rejectAndClose(session, 'Token has already been used.');
    }
    session.role = 'client';
    session.userId = result.requesterId;
    session.serverId = result.serverId;
    session.joinRequestId = result.joinRequestId;
  }

  session.state = 'ready';
  session.touch();
  logger.info('hello accepted', { sessionId: session.sessionId, role: session.role, userId: session.userId });
  session.send(protocol.helloAck(session.sessionId));
}

async function handleRegisterHost(session, msg) {
  if (session.state !== 'ready' || session.role !== 'host') {
    return rejectAndClose(session, 'Must complete host hello first.');
  }
  if (!session.registerHostLimiter.hit()) {
    session.send(protocol.helloRejected('Rate limit exceeded for register-host.'));
    return;
  }
  const { serverId, game, transport, localPort, expiresAt } = msg;
  if (
    typeof serverId !== 'string' ||
    !protocol.GAMES.has(game) ||
    !protocol.TRANSPORTS.has(transport) ||
    !Number.isInteger(localPort) ||
    typeof expiresAt !== 'number'
  ) {
    logger.warn('malformed register-host', { sessionId: session.sessionId });
    return;
  }
  const owns = await verifyServerOwnership(session.userId, serverId);
  if (!owns) {
    logger.warn('register-host rejected: not server owner', { sessionId: session.sessionId, serverId });
    return session.send(protocol.helloRejected('You do not own this server.'));
  }
  session.serverId = serverId;
  channelManager.registerHost(session, { serverId, game, transport, expiresAt });
}

function handleUnregisterHost(session, msg) {
  if (session.state !== 'ready' || session.role !== 'host') return;
  if (typeof msg.relayId !== 'string') return;
  channelManager.unregisterHost(msg.relayId, session.sessionId);
}

function handleRequestRelay(session, msg) {
  if (session.state !== 'ready' || session.role !== 'client') return;
  if (!session.requestRelayLimiter.hit()) {
    return channelManager.denyRelay(session, 'Rate limit exceeded for request-relay.');
  }
  const { joinRequestId, relayId } = msg;
  if (typeof joinRequestId !== 'string' || typeof relayId !== 'string') {
    return channelManager.denyRelay(session, 'Malformed request-relay.');
  }
  const result = channelManager.requestRelay(session, { joinRequestId, relayId });
  if (!result.granted) {
    channelManager.denyRelay(session, result.reason);
  }
}

function handleRelayData(session, msg) {
  if (session.state !== 'ready') return;
  const { channelId, data } = msg;
  if (typeof channelId !== 'string' || typeof data !== 'string') return;
  channelManager.forwardData(session, channelId, data);
}

function handlePing(session, msg) {
  session.send(protocol.pong(typeof msg.at === 'number' ? msg.at : Date.now()));
}

wss.on('connection', (ws, req) => {
  if (wss.clients.size > env.MAX_CONCURRENT_CONNECTIONS) {
    ws.close(1013, 'Server at capacity');
    return;
  }

  const session = new Session(ws, req.socket.remoteAddress);
  ws.__mercySession = session;
  logger.info('connection opened', { sessionId: session.sessionId, remoteAddr: session.remoteAddr });

  const helloTimer = setTimeout(() => {
    if (session.state === 'pre-hello') {
      logger.warn('hello timeout', { sessionId: session.sessionId });
      ws.close(1008, 'Hello timeout');
    }
  }, protocol.RELAY_HELLO_TIMEOUT_MS);

  ws.on('message', (raw) => {
    session.touch();
    const msg = protocol.parseClientMessage(raw.toString());
    if (!msg) return; // malformed/unknown: silently dropped, matches client behavior

    switch (msg.type) {
      case 'hello':
        handleHello(session, msg).catch((e) => {
          logger.error('hello handler error', { sessionId: session.sessionId, error: e.message });
          rejectAndClose(session, 'Server error.');
        });
        break;
      case 'register-host':
        handleRegisterHost(session, msg).catch((e) => {
          logger.error('register-host handler error', { sessionId: session.sessionId, error: e.message });
        });
        break;
      case 'unregister-host':
        handleUnregisterHost(session, msg);
        break;
      case 'request-relay':
        handleRequestRelay(session, msg);
        break;
      case 'relay-data':
        handleRelayData(session, msg);
        break;
      case 'ping':
        handlePing(session, msg);
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    channelManager.cleanupSession(session);
    logger.info('connection closed', { sessionId: session.sessionId });
  });

  ws.on('error', (e) => {
    logger.error('socket error', { sessionId: session.sessionId, error: e.message });
  });
});

// Idle timeout sweep — RELAY_IDLE_TIMEOUT_MS is a relay-side responsibility
// per the client audit (§16.B); no client-side timer implements it.
const idleSweepInterval = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    const session = ws.__mercySession;
    if (session && now - session.lastActivityAt > protocol.RELAY_IDLE_TIMEOUT_MS) {
      logger.warn('idle timeout', { sessionId: session.sessionId });
      ws.close(1008, 'Idle timeout');
    }
  }
}, 15_000);
idleSweepInterval.unref();

const registrationPruneInterval = setInterval(() => {
  channelManager.pruneExpiredRegistrations();
}, 30_000);
registrationPruneInterval.unref();

httpServer.listen(env.PORT, () => {
  logger.info('mercy-relay listening', { port: env.PORT });
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  wss.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  wss.close(() => process.exit(0));
});

module.exports = { httpServer, wss, channelManager };
