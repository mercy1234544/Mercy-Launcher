'use strict';

/**
 * Two live processes, deliberately separate PM2 apps:
 *
 * - mercy-relay: the NAT-relay/signaling WebSocket for game join connections
 *   (Minecraft/FiveM/Assetto Corsa) — unchanged, see relay/server.js.
 * - mercy-api: the authenticated REST + WebSocket presence service for
 *   Friends/Presence/Everyone-Playing/servers/join-requests, backed by the
 *   local PostgreSQL database `mercy_backend` (see api/server.js). Identity
 *   is still Supabase Auth (api/auth.js verifies the caller's existing
 *   Supabase access token, same pattern as mercy-relay's own
 *   signaling/auth.js:verifyHostToken) — this process owns Mercy
 *   application data, never authentication.
 *
 * Separate apps (not one process, unlike mercy-relay's own single-surface
 * design) because they have unrelated failure domains: a mercy-api restart
 * (e.g. a Postgres blip) must never drop an in-flight game relay session,
 * and vice versa.
 */
module.exports = {
  apps: [
    {
      name: 'mercy-relay',
      script: './relay/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      out_file: './logs/mercy-relay.out.log',
      error_file: './logs/mercy-relay.err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'mercy-api',
      script: './api/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      out_file: './logs/mercy-api.out.log',
      error_file: './logs/mercy-api.err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
