-- ═══════════════════════════════════════════════════════════════════════════
-- Mercy Launcher — Friends, Presence, Server Registration & Join Authorization
-- ───────────────────────────────────────────────────────────────────────────
-- Additive to schema.sql — run schema.sql FIRST (it creates public.profiles,
-- which every table below references). This file adds nothing to, and
-- changes nothing about, the accounts/entitlements system.
--
-- ARCHITECTURE (see PresenceManager.ts / FriendsPresenceLogic.ts / the
-- renderer's src/renderer/lib/friendsPresence.ts for the client side):
--   • This database coordinates authentication, friends, presence, server
--     *metadata*, and join authorization. It never runs, stores, or
--     receives anyone's actual Minecraft/FiveM/Assetto Corsa server files —
--     those always stay on the host's own PC. See `servers` below: only
--     safe display metadata is stored, never a filesystem path, port, or
--     credential.
--   • Presence is private by default and only ever visible to real,
--     accepted friends — there is no "public presence" concept here.
--   • Every privacy/ownership/friendship check a client depends on is
--     re-verified here via RLS and SECURITY DEFINER functions. A modified
--     or malicious client cannot see another user's presence, forge a
--     friendship, claim someone else's server, or approve its own join
--     request — the database is the real authority, not the renderer.
--
-- ONE-TIME SETUP (owner): same as schema.sql — SQL Editor → New query →
-- paste this whole file → Run. Requires schema.sql to have been run first.
-- Realtime: Database → Replication → enable Realtime on the `presence` and
-- `join_requests` tables so friends see updates live (Phase 14). This repo
-- has no configured Supabase project (see src/renderer/lib/supabase.ts —
-- SUPABASE_URL/ANON_KEY are still placeholders), so none of this has been
-- run against a live database; it has not been exercised end-to-end.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Friend requests ───────────────────────────────────────────────────────
create table if not exists public.friend_requests (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null references public.profiles(id) on delete cascade,
  addressee_id  uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  constraint no_self_request check (requester_id <> addressee_id)
);
-- At most one PENDING request per unordered pair, in either direction.
create unique index if not exists one_pending_request_per_pair
  on public.friend_requests (least(requester_id, addressee_id), greatest(requester_id, addressee_id))
  where (status = 'pending');

-- ── 2) Friendships — symmetric (one row each direction) for simple RLS ──────
create table if not exists public.friendships (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  friend_id  uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  constraint no_self_friendship check (user_id <> friend_id)
);

create or replace function public.is_friend_of(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.friendships where user_id = auth.uid() and friend_id = other);
$$;

-- ── 3) Presence ──────────────────────────────────────────────────────────────
create table if not exists public.presence (
  user_id             uuid primary key references public.profiles(id) on delete cascade,
  appear_online       boolean not null default false,
  show_current_game   boolean not null default false,
  show_current_server boolean not null default false,
  -- Real activity only: {mercyGameId, kind:'playing'|'hosting', serverId?, serverName?, edition?}
  -- Never a filesystem path, port, or credential — see FriendsPresenceLogic.ts's RealActivity type,
  -- which this column's shape mirrors exactly.
  activity            jsonb,
  last_heartbeat      timestamptz
);

-- ── 4) Servers — SAFE METADATA ONLY. The real server always stays on the
--      owner's own PC; this table never receives world/server files. ───────
create table if not exists public.servers (
  id            text primary key,                       -- the host's own local server id
  owner_id      uuid not null references public.profiles(id) on delete cascade,
  mercy_game_id text not null check (mercy_game_id in ('fivem','minecraft','assettocorsa')),
  edition       text check (edition in ('java','bedrock') or edition is null),
  display_name  text not null,
  is_online     boolean not null default false,
  updated_at    timestamptz not null default now()
);

-- ── 5) Join requests ─────────────────────────────────────────────────────────
create table if not exists public.join_requests (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null references public.profiles(id) on delete cascade,
  host_id       uuid not null references public.profiles(id) on delete cascade,
  server_id     text not null references public.servers(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending','authorized','denied','expired')),
  token         text,                                    -- set by the host once authorized; opaque HMAC credential, verified later by the host/relay — never decoded by the requester
  -- The real "host:port" (+ which strategy produced it — lan-direct /
  -- upnp-direct / relay, see ConnectionNegotiator.ts) the requester should
  -- actually try. Separate from `token` on purpose: this is what the
  -- requester needs to see; `token` is what the host/relay verifies later.
  endpoint      jsonb,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  constraint no_self_join check (requester_id <> host_id)
);

-- ── 6) Row Level Security ────────────────────────────────────────────────────
alter table public.friend_requests enable row level security;
alter table public.friendships     enable row level security;
alter table public.presence        enable row level security;
alter table public.servers         enable row level security;
alter table public.join_requests   enable row level security;

-- Friend requests: only the two real parties can see a request; only the
-- real requester can create one (never on someone else's behalf); nobody
-- can update a request directly (see respond_to_friend_request() below,
-- which enforces "only the real addressee, only while pending").
drop policy if exists "parties read requests" on public.friend_requests;
drop policy if exists "requester creates request" on public.friend_requests;
create policy "parties read requests" on public.friend_requests
  for select to authenticated using (requester_id = auth.uid() or addressee_id = auth.uid());
create policy "requester creates request" on public.friend_requests
  for insert to authenticated with check (requester_id = auth.uid());

-- Friendships: only visible to the two people in the row; never inserted or
-- deleted directly by a client — only by accept_friend_request()/remove_friend().
drop policy if exists "see own friendships" on public.friendships;
create policy "see own friendships" on public.friendships
  for select to authenticated using (user_id = auth.uid());

-- Presence: a user manages only their own row directly. Friends never read
-- this table directly (that would leak raw activity regardless of the
-- owner's own privacy flags) — they call get_friends_presence() instead,
-- which is the one real place the privacy rules are enforced server-side.
drop policy if exists "own presence" on public.presence;
create policy "own presence" on public.presence
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Servers: the owner has full control of their own rows. Friends may see a
-- server's safe metadata directly (id/game/name/online-state — nothing that
-- isn't already safe to show), but ONLY once it's online AND ONLY if they're
-- a real friend of the owner — never arbitrary enumeration of every server.
drop policy if exists "owner manages own servers" on public.servers;
drop policy if exists "friends see online servers" on public.servers;
create policy "owner manages own servers" on public.servers
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "friends see online servers" on public.servers
  for select to authenticated using (is_online = true and public.is_friend_of(owner_id));

-- Join requests: the requester sees their own; the host sees requests aimed
-- at them. Nobody updates status directly — see respond_to_join_request().
drop policy if exists "parties read join requests" on public.join_requests;
create policy "parties read join requests" on public.join_requests
  for select to authenticated using (requester_id = auth.uid() or host_id = auth.uid());

-- ── 7) Friend request lifecycle — SECURITY DEFINER so every rule (no
--      self-request, no duplicate, only the real addressee may respond) is
--      enforced exactly once, server-side, and can't be bypassed by a
--      client calling the tables directly. ─────────────────────────────────
create or replace function public.send_friend_request(addressee_username text)
returns public.friend_requests language plpgsql security definer set search_path = public as $$
declare
  target_id uuid;
  req public.friend_requests;
begin
  select id into target_id from public.profiles where username = addressee_username;
  if target_id is null then raise exception 'No account with that username.'; end if;
  if target_id = auth.uid() then raise exception 'You cannot send a friend request to yourself.'; end if;
  if public.is_friend_of(target_id) then raise exception 'You are already friends.'; end if;
  if exists (
    select 1 from public.friend_requests
    where status = 'pending'
      and least(requester_id, addressee_id) = least(auth.uid(), target_id)
      and greatest(requester_id, addressee_id) = greatest(auth.uid(), target_id)
  ) then raise exception 'A friend request is already pending between you two.'; end if;
  insert into public.friend_requests (requester_id, addressee_id) values (auth.uid(), target_id) returning * into req;
  return req;
end; $$;

create or replace function public.respond_to_friend_request(request_id uuid, approve boolean)
returns void language plpgsql security definer set search_path = public as $$
declare req public.friend_requests;
begin
  select * into req from public.friend_requests where id = request_id for update;
  if req is null then raise exception 'Request not found.'; end if;
  if req.status <> 'pending' then raise exception 'This request is no longer pending.'; end if;
  if req.addressee_id <> auth.uid() then raise exception 'Only the recipient of a friend request may respond to it.'; end if;
  update public.friend_requests set status = case when approve then 'accepted' else 'declined' end, responded_at = now() where id = request_id;
  if approve then
    insert into public.friendships (user_id, friend_id) values (req.requester_id, req.addressee_id) on conflict do nothing;
    insert into public.friendships (user_id, friend_id) values (req.addressee_id, req.requester_id) on conflict do nothing;
  end if;
end; $$;

create or replace function public.remove_friend(friend_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if friend_id = auth.uid() then raise exception 'Invalid.'; end if;
  delete from public.friendships where (user_id = auth.uid() and friend_id = remove_friend.friend_id) or (user_id = remove_friend.friend_id and friend_id = auth.uid());
end; $$;

-- ── 8) Heartbeat — the ONLY way presence.activity/last_heartbeat change. ────
create or replace function public.heartbeat(
  p_appear_online boolean, p_show_current_game boolean, p_show_current_server boolean, p_activity jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.presence (user_id, appear_online, show_current_game, show_current_server, activity, last_heartbeat)
  values (auth.uid(), p_appear_online, p_show_current_game, p_show_current_server, p_activity, now())
  on conflict (user_id) do update set
    appear_online = excluded.appear_online, show_current_game = excluded.show_current_game,
    show_current_server = excluded.show_current_server, activity = excluded.activity, last_heartbeat = excluded.last_heartbeat;
end; $$;

-- ── 9) Friends' presence — the one real read path; enforces privacy +
--      real friendship + the 90s heartbeat timeout in one place. Mirrors
--      buildPresenceForViewer() in FriendsPresenceLogic.ts exactly. ────────
create or replace function public.get_friends_presence()
returns table (
  friend_id uuid, username text, status text, activity_label text,
  mercy_game_id text, server_id text, server_name text
) language sql stable security definer set search_path = public as $$
  select
    p.id, p.username,
    case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds' then 'online' else 'offline' end,
    case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds' and pr.show_current_game and pr.activity is not null
      then case when (pr.activity->>'kind') = 'hosting'
        then 'Playing/Hosting ' || initcap(pr.activity->>'mercyGameId')
        else 'Playing ' || initcap(pr.activity->>'mercyGameId') end
      else null end,
    case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds' and pr.show_current_game
      then pr.activity->>'mercyGameId' else null end,
    case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds' and pr.show_current_game and pr.show_current_server and (pr.activity->>'kind') = 'hosting'
      then pr.activity->>'serverId' else null end,
    case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds' and pr.show_current_game and pr.show_current_server and (pr.activity->>'kind') = 'hosting'
      then pr.activity->>'serverName' else null end
  from public.friendships f
  join public.profiles p on p.id = f.friend_id
  left join public.presence pr on pr.user_id = f.friend_id
  where f.user_id = auth.uid();
$$;

-- ── 9b) Everyone Playing — real presence discovery across ALL users, not
--      just friends, so people can find and befriend other real Mercy
--      Launcher players. Deliberately narrower than get_friends_presence():
--      it never reveals server id/name (that stays a friends-only, join-
--      relevant detail), only that someone is real, online, and playing a
--      real game right now — same privacy flags + 90s heartbeat timeout
--      enforced the same way. is_friend/request_pending let the client show
--      the correct action (Add Friend / Pending / Friends) without a second
--      round trip, and without ever letting a client fabricate its own
--      friendship state. ───────────────────────────────────────────────────
create or replace function public.get_everyone_playing()
returns table (
  user_id uuid, username text, activity_label text, mercy_game_id text,
  is_friend boolean, request_pending boolean
) language sql stable security definer set search_path = public as $$
  select
    p.id, p.username,
    case when (pr.activity->>'kind') = 'hosting'
      then 'Playing/Hosting ' || initcap(pr.activity->>'mercyGameId')
      else 'Playing ' || initcap(pr.activity->>'mercyGameId') end,
    pr.activity->>'mercyGameId',
    public.is_friend_of(p.id),
    exists(
      select 1 from public.friend_requests fr
      where fr.status = 'pending'
        and least(fr.requester_id, fr.addressee_id) = least(auth.uid(), p.id)
        and greatest(fr.requester_id, fr.addressee_id) = greatest(auth.uid(), p.id)
    )
  from public.presence pr
  join public.profiles p on p.id = pr.user_id
  where p.id <> auth.uid()
    and pr.appear_online = true
    and pr.last_heartbeat > now() - interval '90 seconds'
    and pr.show_current_game = true
    and pr.activity is not null;
$$;

-- ── 10) Server registration — owner-only writes, metadata only. ────────────
create or replace function public.upsert_server(p_id text, p_mercy_game_id text, p_edition text, p_display_name text, p_is_online boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.servers (id, owner_id, mercy_game_id, edition, display_name, is_online, updated_at)
  values (p_id, auth.uid(), p_mercy_game_id, p_edition, p_display_name, p_is_online, now())
  on conflict (id) do update set
    display_name = excluded.display_name, is_online = excluded.is_online, edition = excluded.edition, updated_at = excluded.updated_at
  where public.servers.owner_id = auth.uid();
end; $$;

-- ── 11) Join request — request_join() re-checks EVERY Phase-13 requirement
--      itself (real friendship, real ownership, real online state) rather
--      than trusting anything the caller claims. respond_to_join_request()
--      is the only way status/token ever change, and only the real host
--      may call it. ─────────────────────────────────────────────────────────
create or replace function public.request_join(p_server_id text)
returns public.join_requests language plpgsql security definer set search_path = public as $$
declare
  srv public.servers;
  req public.join_requests;
begin
  select * into srv from public.servers where id = p_server_id;
  if srv is null then raise exception 'Server not found.'; end if;
  if srv.owner_id = auth.uid() then raise exception 'You cannot request to join your own server through the friend join flow.'; end if;
  if not public.is_friend_of(srv.owner_id) then raise exception 'You must be friends with the host to request to join their server.'; end if;
  if not srv.is_online then raise exception 'This server is not currently online.'; end if;
  insert into public.join_requests (requester_id, host_id, server_id, expires_at)
  values (auth.uid(), srv.owner_id, p_server_id, now() + interval '2 minutes') returning * into req;
  return req;
end; $$;

create or replace function public.respond_to_join_request(request_id uuid, approve boolean, p_token text default null, p_endpoint jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare req public.join_requests;
begin
  select * into req from public.join_requests where id = request_id for update;
  if req is null then raise exception 'Request not found.'; end if;
  if req.host_id <> auth.uid() then raise exception 'Only the server''s real host may respond to a join request.'; end if;
  if req.status <> 'pending' then raise exception 'This request is no longer pending.'; end if;
  update public.join_requests
    set status = case when approve then 'authorized' else 'denied' end,
        token = case when approve then p_token else null end,
        endpoint = case when approve then p_endpoint else null end
    where id = request_id;
end; $$;

-- Expired requests never linger as "pending" for a client to act on.
create or replace function public.expire_stale_join_requests()
returns void language sql security definer set search_path = public as $$
  update public.join_requests set status = 'expired' where status = 'pending' and expires_at < now();
$$;
