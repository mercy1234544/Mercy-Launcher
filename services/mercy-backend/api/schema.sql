-- Mercy API — Linux-owned Friends/Presence/Servers/Join-requests schema.
--
-- Identity: every *_id column here is a Supabase Auth `auth.users.id` UUID
-- (== the existing `profiles.id`), resolved server-side by verifying the
-- caller's Supabase access token (api/auth.js:verifyAccessToken), exactly
-- like mercy-relay's existing signaling/auth.js:verifyHostToken. This
-- database never authenticates anyone and never stores a password or
-- Discord credential — it only stores Mercy application data keyed to an
-- identity Supabase already vouches for. Usernames are NOT mirrored here;
-- they're resolved live from Supabase's `profiles` table (api/profiles.js)
-- so this schema never drifts from the real identity source.
--
-- Run via `node api/migrate.js` (idempotent — safe to re-run).

create extension if not exists pgcrypto;

create table if not exists friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null,
  addressee_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint no_self_request check (requester_id <> addressee_id)
);

create unique index if not exists one_pending_request_per_pair
  on friend_requests (least(requester_id, addressee_id), greatest(requester_id, addressee_id))
  where status = 'pending';

create index if not exists friend_requests_addressee_pending
  on friend_requests (addressee_id) where status = 'pending';
create index if not exists friend_requests_requester_pending
  on friend_requests (requester_id) where status = 'pending';

create table if not exists friendships (
  user_id uuid not null,
  friend_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  constraint no_self_friendship check (user_id <> friend_id)
);

create table if not exists presence (
  user_id uuid primary key,
  appear_online boolean not null default false,
  show_current_game boolean not null default false,
  show_current_server boolean not null default false,
  -- shape: {mercyGameId, kind:'playing'|'hosting', serverId?, serverName?, edition?}
  activity jsonb,
  last_heartbeat timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists presence_online_fresh
  on presence (last_heartbeat) where appear_online = true;

create table if not exists servers (
  id text primary key, -- host's own local server id, client-supplied, not a UUID
  owner_id uuid not null,
  mercy_game_id text not null check (mercy_game_id in ('fivem', 'minecraft', 'assettocorsa')),
  edition text check (edition in ('java', 'bedrock') or edition is null),
  display_name text not null,
  is_online boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists servers_owner on servers (owner_id);

create table if not exists join_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null,
  host_id uuid not null,
  server_id text not null references servers(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'authorized', 'denied', 'expired')),
  token text, -- opaque HMAC credential, set only on approval (mercy-relay CLIENT-role token)
  endpoint jsonb, -- {strategy, address, relayId?, relayIdUdp?}, set only on approval
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  constraint no_self_join check (requester_id <> host_id)
);

create index if not exists join_requests_host_pending
  on join_requests (host_id) where status = 'pending';
create index if not exists join_requests_requester
  on join_requests (requester_id);
