'use strict';

// Minimal dependency-free router (matches the codebase's existing style —
// see relay/server.js's own hand-rolled /health handler — rather than
// pulling in Express for a dozen routes).

const { requireAuth } = require('./auth');
const { ApiError } = require('./errors');
const friendsRepo = require('./repo/friends');
const presenceRepo = require('./repo/presence');
const serversRepo = require('./repo/servers');
const joinsRepo = require('./repo/joins');
const logger = require('../shared/logger');
const rateLimit = require('./rateLimit');
const db = require('./db');

// General per-IP ceiling across every route (protects the process itself).
const GENERAL_LIMIT = { maxHits: 300, windowMs: 5 * 60_000 };
// Tighter limit on username-enumeration-sensitive / Supabase-auth-triggering
// writes (every request here also costs one supabase.auth.getUser() call).
const SEND_REQUEST_LIMIT = { maxHits: 20, windowMs: 60_000 };

/** Trusts X-Real-IP only when the immediate TCP peer is the local nginx
 * (matches nginx's own `set_real_ip_from 127.0.0.1` trust boundary) — never
 * trusts a client-supplied header from a connection that reached this
 * process directly. */
function getClientIp(req) {
  const peer = req.socket.remoteAddress || 'unknown';
  const isLoopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (isLoopback && req.headers['x-real-ip']) return req.headers['x-real-ip'];
  return peer;
}

const ROUTES = [];
function route(method, pattern, handler) {
  const paramNames = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:[a-zA-Z]+/g, (m) => {
        paramNames.push(m.slice(1));
        return '([^/]+)';
      }) +
      '$'
  );
  ROUTES.push({ method, regex, paramNames, handler });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        reject(new ApiError('BAD_REQUEST', 'Request body too large.', 413));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError('BAD_REQUEST', 'Malformed JSON body.', 400));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

route('GET', '/v1/health', async () => {
  try {
    await db.query('select 1');
    return { status: 200, body: { status: 'ok', db: 'ok' } };
  } catch (e) {
    logger.error('health check db failure', { error: e.message });
    return { status: 503, body: { status: 'degraded', db: 'error' } };
  }
});

route('GET', '/v1/friends', async (req) => {
  const userId = await requireAuth(req);
  return { status: 200, body: { data: await friendsRepo.getFriendsPresence(userId) } };
});

route('GET', '/v1/everyone', async (req) => {
  const userId = await requireAuth(req);
  return { status: 200, body: { data: await friendsRepo.getEveryonePlaying(userId) } };
});

route('POST', '/v1/friends/requests', async (req) => {
  if (!rateLimit.hit(`send-request:${getClientIp(req)}`, SEND_REQUEST_LIMIT)) {
    throw new ApiError('RATE_LIMITED', 'Too many friend requests sent. Try again shortly.', 429);
  }
  const userId = await requireAuth(req);
  const body = await readBody(req);
  const row = await friendsRepo.sendFriendRequest(userId, body.username);
  return { status: 201, body: { data: row } };
});

route('GET', '/v1/friends/requests/incoming', async (req) => {
  const userId = await requireAuth(req);
  return { status: 200, body: { data: await friendsRepo.listIncomingRequests(userId) } };
});

route('GET', '/v1/friends/requests/outgoing', async (req) => {
  const userId = await requireAuth(req);
  return { status: 200, body: { data: await friendsRepo.listOutgoingRequests(userId) } };
});

route('POST', '/v1/friends/requests/:id/respond', async (req, params) => {
  const userId = await requireAuth(req);
  const body = await readBody(req);
  await friendsRepo.respondToFriendRequest(userId, params.id, !!body.approve);
  return { status: 200, body: { ok: true } };
});

route('DELETE', '/v1/friends/:friendId', async (req, params) => {
  const userId = await requireAuth(req);
  await friendsRepo.removeFriend(userId, params.friendId);
  return { status: 200, body: { ok: true } };
});

route('POST', '/v1/presence/heartbeat', async (req) => {
  const userId = await requireAuth(req);
  const body = await readBody(req);
  await presenceRepo.heartbeat(
    userId,
    {
      appearOnline: !!body.appearOnline,
      showCurrentGame: !!body.showCurrentGame,
      showCurrentServer: !!body.showCurrentServer,
    },
    body.activity || null
  );
  return { status: 200, body: { ok: true } };
});

route('PUT', '/v1/servers/:id', async (req, params) => {
  const userId = await requireAuth(req);
  const body = await readBody(req);
  await serversRepo.upsertServer(userId, { ...body, id: params.id });
  return { status: 200, body: { ok: true } };
});

route('POST', '/v1/joins', async (req) => {
  const userId = await requireAuth(req);
  const body = await readBody(req);
  const row = await joinsRepo.requestJoin(userId, body.serverId);
  return { status: 201, body: { data: { id: row.id } } };
});

route('POST', '/v1/joins/:id/respond', async (req, params) => {
  const userId = await requireAuth(req);
  const body = await readBody(req);
  await joinsRepo.respondToJoinRequest(userId, params.id, !!body.approve, body.token, body.endpoint);
  return { status: 200, body: { ok: true } };
});

route('GET', '/v1/joins', async (req) => {
  const userId = await requireAuth(req);
  return { status: 200, body: { data: await joinsRepo.listJoinRequests(userId) } };
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function handleRequest(req, res, pathname) {
  if (pathname !== '/v1/health' && !rateLimit.hit(`general:${getClientIp(req)}`, GENERAL_LIMIT)) {
    return send(res, 429, { error: 'RATE_LIMITED', message: 'Too many requests.' });
  }
  for (const r of ROUTES) {
    if (r.method !== req.method) continue;
    const match = pathname.match(r.regex);
    if (!match) continue;
    const params = {};
    r.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });
    try {
      const { status, body } = await r.handler(req, params);
      return send(res, status, body);
    } catch (e) {
      if (e instanceof ApiError) {
        return send(res, e.status, { error: e.code, message: e.message });
      }
      logger.error('unhandled route error', { error: e.message, path: pathname });
      return send(res, 500, { error: 'SERVER_ERROR', message: 'Internal server error.' });
    }
  }
  return send(res, 404, { error: 'NOT_FOUND', message: 'No such endpoint.' });
}

module.exports = { handleRequest, readBody, send };
