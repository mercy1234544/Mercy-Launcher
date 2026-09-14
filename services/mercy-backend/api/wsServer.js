'use strict';

// Authenticated presence WebSocket. This is the direct fix for the reported
// bug: the Windows client's Supabase Realtime subscription had no observed
// SUBSCRIBED/CHANNEL_ERROR/TIMED_OUT/CLOSED states and no reconnect path
// (audit weaknesses #1-#3). Here the lifecycle is explicit end to end:
//
//   client connects -> must send {type:'hello', token} within
//   WS_HELLO_TIMEOUT_MS -> server replies hello-ack{userId} (subscribed) or
//   hello-rejected{code,reason} (an honest, typed failure, never a silent
//   drop) -> server pushes {type:'changed', kind} whenever something this
//   user cares about changes (see api/pubsub.js) -> server ping-frames the
//   socket every WS_PING_INTERVAL_MS and terminates it if no pong arrives
//   within WS_PING_TIMEOUT_MS, so a dead connection is detected and closed
//   (with a real 'close' event the client CAN observe and reconnect on)
//   instead of hanging silently for the ~20 minutes the client used to see.
//
// Multiple simultaneous connections per user are allowed on purpose (e.g. a
// reconnect racing the old socket's death) — each gets its own independent
// hello/ping lifecycle and its own push feed; closing one never affects
// another.

const { WebSocketServer } = require('ws');
const { verifyAccessToken } = require('./auth');
const pubsub = require('./pubsub');
const logger = require('../shared/logger');
const env = require('./env');

function attachWsServer(httpServer, path) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    let userId = null;
    let unsubscribe = null;
    let isAlive = true;

    const helloTimer = setTimeout(() => {
      if (!userId) {
        send(ws, { type: 'hello-rejected', code: 'AUTH_ERROR', reason: 'Hello timeout.' });
        ws.close(1008, 'Hello timeout');
      }
    }, env.WS_HELLO_TIMEOUT_MS);
    helloTimer.unref();

    const pingTimer = setInterval(() => {
      if (!isAlive) {
        logger.warn('ws ping timeout', { userId });
        ws.terminate();
        return;
      }
      isAlive = false;
      try {
        ws.ping();
      } catch {
        // socket already closing
      }
    }, env.WS_PING_INTERVAL_MS);
    pingTimer.unref();

    ws.on('pong', () => {
      isAlive = true;
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // malformed/unknown: silently dropped, matches mercy-relay behavior
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'hello') {
        if (userId) return; // only one hello per connection
        const result = await verifyAccessToken(msg.token);
        if (!result.valid) {
          send(ws, { type: 'hello-rejected', code: result.code, reason: result.reason });
          ws.close(1008, 'Auth failed');
          return;
        }
        userId = result.userId;
        clearTimeout(helloTimer);
        unsubscribe = pubsub.subscribe(userId, (event) => {
          send(ws, { type: 'changed', kind: event.kind, at: event.at });
        });
        send(ws, { type: 'hello-ack', userId });
        logger.info('ws hello accepted', { userId });
        return;
      }

      if (msg.type === 'ping') {
        send(ws, { type: 'pong', at: typeof msg.at === 'number' ? msg.at : Date.now() });
        return;
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(pingTimer);
      if (unsubscribe) unsubscribe();
      logger.info('ws connection closed', { userId });
    });

    ws.on('error', (e) => {
      logger.error('ws socket error', { userId, error: e.message });
    });
  });

  return wss;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

module.exports = { attachWsServer };
