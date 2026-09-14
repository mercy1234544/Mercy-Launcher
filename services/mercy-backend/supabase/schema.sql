-- Mercy Launcher — accounts schema (profiles/entitlements).
-- Reconstructed verbatim from reference/client/linux-backend-client-contract.md §18.1
-- (itself a transcription of the Windows client repo's supabase/schema.sql, which has
-- never been run against a live project before now). Do not add/rename/remove anything
-- here without updating that contract first — this file must stay a faithful mirror.
--
-- Intended to be pasted into the Supabase SQL Editor (this project uses no migration
-- tooling, per the contract's own §18.6 note).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  email text,
  role text not null default 'user' check (role in ('user', 'admin', 'owner')),
  created_at timestamptz not null default now()
);

create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  script_id text not null,
  granted_by uuid references public.profiles(id),
  granted_at timestamptz not null default now(),
  unique (user_id, script_id)
);

-- ---------------------------------------------------------------------------
-- New-user provisioning: auto-create a profiles row on signup
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || left(new.id::text, 8)),
    new.email
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Role-check helper functions (used by RLS policies below and in the friends/
-- presence schema)
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role in ('admin', 'owner')
  );
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'owner'
  );
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.entitlements enable row level security;

drop policy if exists "profiles select" on public.profiles;
create policy "profiles select" on public.profiles
  for select
  using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles update" on public.profiles;
create policy "profiles update" on public.profiles
  for update
  using (public.is_owner());

drop policy if exists "entitlements select" on public.entitlements;
create policy "entitlements select" on public.entitlements
  for select
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "entitlements insert" on public.entitlements;
create policy "entitlements insert" on public.entitlements
  for insert
  with check (public.is_admin());

drop policy if exists "entitlements delete" on public.entitlements;
create policy "entitlements delete" on public.entitlements
  for delete
  using (public.is_admin());
