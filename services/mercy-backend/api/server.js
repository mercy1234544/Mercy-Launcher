'use strict';

const http = require('http');
const env = require('./env');
const logger = require('../shared/logger');
const { handleRequest } = require('./http');
const { attachWsServer } = require('./wsServer');
const { getPool } = require('./db');
const presenceRepo = require('./repo/presence');
const joinsRepo = require('./repo/joins');

let activeConnections = 0;

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/v1/health') {
    let dbOk = true;
    try {
      await getPool().query('select 1');
    } catch {
      dbOk = false;
    }
    res.writeHead(dbOk ? 200 : 503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: dbOk ? 'ok' : 'degraded',
        uptimeSeconds: Math.floor(process.uptime()),
        db: dbOk ? 'ok' : 'unreachable',
        activeConnections,
      })
    );
    return;
  }

  await handleRequest(req, res, url.pathname);
});

httpServer.on('connection', (socket) => {
  activeConnections += 1;
  socket.on('close', () => {
    activeConnections -= 1;
  });
});

attachWsServer(httpServer, '/v1/presence/ws');

// Server-side timeout handling — heartbeat expiration and stale
// join-request expiry never depend on any client behaving well.
const sweepInterval = setInterval(() => {
  presenceRepo.sweepStalePresence(env.PRESENCE_STALE_MS).catch((e) => {
    logger.error('presence sweep failed', { error: e.message });
  });
  joinsRepo.expireStaleJoinRequests().catch((e) => {
    logger.error('join request expiry sweep failed', { error: e.message });
  });
}, env.STALE_SWEEP_INTERVAL_MS);
sweepInterval.unref();

httpServer.listen(env.PORT, () => {
  logger.info('mercy-api listening', { port: env.PORT });
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  httpServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  httpServer.close(() => process.exit(0));
});

module.exports = { httpServer };
