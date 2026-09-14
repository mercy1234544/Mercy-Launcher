-- Mercy Launcher — friends / presence / servers / join-request schema.
-- Reconstructed verbatim from reference/client/linux-backend-client-contract.md
-- §18.2–§18.5 (transcription of the Windows client repo's
-- supabase/friends_presence_schema.sql, never previously run against a live project).
-- Requires schema.sql to have been run first (references public.profiles).
--
-- Do not add/rename/remove tables, columns, indexes, policies, or functions here
-- without updating that contract first.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint no_self_request check (requester_id <> addressee_id)
);

-- Unordered-pair uniqueness: at most one *pending* request between any two users,
-- regardless of who sent it.
create unique index if not exists one_pending_request_per_pair
  on public.friend_requests (least(requester_id, addressee_id), greatest(requester_id, addressee_id))
  where status = 'pending';

create table if not exists public.friendships (
  user_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  constraint no_self_friendship check (user_id <> friend_id)
);

create table if not exists public.presence (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  appear_online boolean not null default false,
  show_current_game boolean not null default false,
  show_current_server boolean not null default false,
  -- shape: {mercyGameId, kind:'playing'|'hosting', serverId?, serverName?, edition?}
  activity jsonb,
  last_heartbeat timestamptz
);

create table if not exists public.servers (
  id text primary key, -- host's own local server id, client-supplied, not a UUID
  owner_id uuid not null references public.profiles(id) on delete cascade,
  mercy_game_id text not null check (mercy_game_id in ('fivem', 'minecraft', 'assettocorsa')),
  edition text check (edition in ('java', 'bedrock') or edition is null),
  display_name text not null,
  is_online boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.join_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  host_id uuid not null references public.profiles(id) on delete cascade,
  server_id text not null references public.servers(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'authorized', 'denied', 'expired')),
  token text, -- opaque HMAC credential, set only on approval
  endpoint jsonb, -- {strategy, address}, set only on approval
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  constraint no_self_join check (requester_id <> host_id)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.presence enable row level security;
alter table public.servers enable row level security;
alter table public.join_requests enable row level security;

drop policy if exists "parties read requests" on public.friend_requests;
create policy "parties read requests" on public.friend_requests
  for select
  using (requester_id = auth.uid() or addressee_id = auth.uid());

drop policy if exists "requester creates request" on public.friend_requests;
create policy "requester creates request" on public.friend_requests
  for insert
  with check (requester_id = auth.uid());

drop policy if exists "see own friendships" on public.friendships;
create policy "see own friendships" on public.friendships
  for select
  using (user_id = auth.uid());

drop policy if exists "own presence" on public.presence;
create policy "own presence" on public.presence
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "owner manages own servers" on public.servers;
create policy "owner manages own servers" on public.servers
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists "friends see online servers" on public.servers;
create policy "friends see online servers" on public.servers
  for select
  using (is_online = true and public.is_friend_of(owner_id));

drop policy if exists "parties read join requests" on public.join_requests;
create policy "parties read join requests" on public.join_requests
  for select
  using (requester_id = auth.uid() or host_id = auth.uid());

-- Deliberately no update/delete policies on friend_requests, friendships, or
-- join_requests: every state transition happens through the security-definer
-- functions below, which bypass RLS internally and re-check auth.uid() manually.

-- ---------------------------------------------------------------------------
-- Functions (all security definer, all set search_path = public)
-- ---------------------------------------------------------------------------

create or replace function public.is_friend_of(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships
    where user_id = auth.uid() and friend_id = other
  );
$$;

create or replace function public.send_friend_request(addressee_username text)
returns public.friend_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_addressee_id uuid;
  v_row public.friend_requests;
begin
  select id into v_addressee_id from public.profiles where username = addressee_username;

  if v_addressee_id is null then
    raise exception 'User not found.';
  end if;

  if v_addressee_id = auth.uid() then
    raise exception 'Cannot send a friend request to yourself.';
  end if;

  if exists (
    select 1 from public.friendships
    where user_id = auth.uid() and friend_id = v_addressee_id
  ) then
    raise exception 'Already friends.';
  end if;

  if exists (
    select 1 from public.friend_requests
    where status = 'pending'
      and least(requester_id, addressee_id) = least(auth.uid(), v_addressee_id)
      and greatest(requester_id, addressee_id) = greatest(auth.uid(), v_addressee_id)
  ) then
    raise exception 'A pending friend request already exists between these users.';
  end if;

  insert into public.friend_requests (requester_id, addressee_id)
  values (auth.uid(), v_addressee_id)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.respond_to_friend_request(request_id uuid, approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.friend_requests;
begin
  select * into v_row from public.friend_requests where id = request_id for update;

  if v_row is null then
    raise exception 'Friend request not found.';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'Friend request is not pending.';
  end if;

  if v_row.addressee_id <> auth.uid() then
    raise exception 'Only the addressee can respond to this request.';
  end if;

  update public.friend_requests
    set status = case when approve then 'accepted' else 'declined' end,
        responded_at = now()
    where id = request_id;

  if approve then
    insert into public.friendships (user_id, friend_id)
      values (v_row.requester_id, v_row.addressee_id)
      on conflict do nothing;
    insert into public.friendships (user_id, friend_id)
      values (v_row.addressee_id, v_row.requester_id)
      on conflict do nothing;
  end if;
end;
$$;

create or replace function public.remove_friend(friend_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if friend_id = auth.uid() then
    raise exception 'Cannot remove yourself as a friend.';
  end if;

  delete from public.friendships
    where (user_id = auth.uid() and friend_id = remove_friend.friend_id)
       or (user_id = remove_friend.friend_id and friend_id = auth.uid());
end;
$$;

create or replace function public.heartbeat(
  p_appear_online boolean,
  p_show_current_game boolean,
  p_show_current_server boolean,
  p_activity jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.presence (user_id, appear_online, show_current_game, show_current_server, activity, last_heartbeat)
  values (auth.uid(), p_appear_online, p_show_current_game, p_show_current_server, p_activity, now())
  on conflict (user_id) do update
    set appear_online = excluded.appear_online,
        show_current_game = excluded.show_current_game,
        show_current_server = excluded.show_current_server,
        activity = excluded.activity,
        last_heartbeat = now();
end;
$$;

create or replace function public.get_friends_presence()
returns table (
  friend_id uuid,
  username text,
  status text,
  activity_label text,
  mercy_game_id text,
  server_id text,
  server_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    f.friend_id,
    p.username,
    case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds'
         then 'online' else 'offline' end as status,
    case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds'
           and pr.show_current_game and pr.activity is not null
         then case when (pr.activity->>'kind') = 'hosting'
                then 'Playing/Hosting ' || initcap(pr.activity->>'mercyGameId')
                else 'Playing ' || initcap(pr.activity->>'mercyGameId') end
         else null end as activity_label,
    case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds'
           and pr.show_current_game
         then pr.activity->>'mercyGameId' else null end as mercy_game_id,
    case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds'
           and pr.show_current_game and pr.show_current_server
           and (pr.activity->>'kind') = 'hosting'
         then pr.activity->>'serverId' else null end as server_id,
    case when pr.appear_online and pr.last_heartbeat > now() - interval '90 seconds'
           and pr.show_current_game and pr.show_current_server
           and (pr.activity->>'kind') = 'hosting'
         then pr.activity->>'serverName' else null end as server_name
  from public.friendships f
  join public.profiles p on p.id = f.friend_id
  left join public.presence pr on pr.user_id = f.friend_id
  where f.user_id = auth.uid();
$$;

create or replace function public.upsert_server(
  p_id text,
  p_mercy_game_id text,
  p_edition text,
  p_display_name text,
  p_is_online boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.servers (id, owner_id, mercy_game_id, edition, display_name, is_online, updated_at)
  values (p_id, auth.uid(), p_mercy_game_id, p_edition, p_display_name, p_is_online, now())
  on conflict (id) do update
    set mercy_game_id = excluded.mercy_game_id,
        edition = excluded.edition,
        display_name = excluded.display_name,
        is_online = excluded.is_online,
        updated_at = now()
    where public.servers.owner_id = auth.uid();
end;
$$;

create or replace function public.request_join(p_server_id text)
returns public.join_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_server public.servers;
  v_row public.join_requests;
begin
  select * into v_server from public.servers where id = p_server_id;

  if v_server is null then
    raise exception 'Server not found.';
  end if;

  if v_server.owner_id = auth.uid() then
    raise exception 'Cannot join your own server.';
  end if;

  if not public.is_friend_of(v_server.owner_id) then
    raise exception 'You are not friends with this server''s host.';
  end if;

  if not v_server.is_online then
    raise exception 'Server is offline.';
  end if;

  insert into public.join_requests (requester_id, host_id, server_id, expires_at)
  values (auth.uid(), v_server.owner_id, p_server_id, now() + interval '2 minutes')
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.respond_to_join_request(
  request_id uuid,
  approve boolean,
  p_token text default null,
  p_endpoint jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.join_requests;
begin
  select * into v_row from public.join_requests where id = request_id for update;

  if v_row is null then
    raise exception 'Join request not found.';
  end if;

  if v_row.host_id <> auth.uid() then
    raise exception 'Only the host can respond to this join request.';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'Join request is not pending.';
  end if;

  update public.join_requests
    set status = case when approve then 'authorized' else 'denied' end,
        token = case when approve then p_token else null end,
        endpoint = case when approve then p_endpoint else null end
    where id = request_id;
end;
$$;

create or replace function public.expire_stale_join_requests()
returns void
language sql
security definer
set search_path = public
as $$
  update public.join_requests
    set status = 'expired'
    where status = 'pending' and expires_at < now();
$$;
