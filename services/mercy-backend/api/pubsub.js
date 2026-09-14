'use strict';

// In-process pub/sub driving the WebSocket presence channel's push
// notifications. Deliberately in-process (not Postgres LISTEN/NOTIFY):
// mercy-api runs as a single PM2 fork instance (see ecosystem.config.js),
// same single-process design already used by mercy-relay, so there is only
// ever one process that needs to know about a write.
//
// This is what replaces the Windows client's dead-on-arrival Supabase
// Realtime subscription: every write that matters to another user's screen
// pushes an explicit, typed "changed" event over that user's live WebSocket
// connection(s) (there can be more than one — see api/wsServer.js) telling
// it which REST endpoint to re-fetch. The client never has to guess whether
// Realtime silently died, because this connection has its own explicit
// hello-ack / ping-pong lifecycle (api/wsServer.js) instead of an
// unobserved subscribe().

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);

function eventName(userId) {
  return `user:${userId}`;
}

function notify(userId, kind) {
  bus.emit(eventName(userId), { kind, at: Date.now() });
}

function notifyMany(userIds, kind) {
  for (const id of userIds) notify(id, kind);
}

/** Returns an unsubscribe function. */
function subscribe(userId, handler) {
  const event = eventName(userId);
  bus.on(event, handler);
  return () => bus.off(event, handler);
}

module.exports = { notify, notifyMany, subscribe };
