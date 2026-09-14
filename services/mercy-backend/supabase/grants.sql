-- Mercy Launcher — role grants.
-- Not part of the original contract's two schema files (they don't mention grants
-- at all, and most Supabase projects auto-configure default privileges for the
-- public schema at provisioning time). On THIS project, that default privilege
-- setup did not happen: after running schema.sql + friends_presence_schema.sql,
-- every read against every table returned Postgres error 42501
-- ("permission denied for table <x>"), confirmed via read-only REST calls with
-- the service-role key — RLS was never reached because the role has no
-- table-level grant at all yet.
--
-- This does not weaken or replace RLS: `authenticated` still only sees/touches
-- rows the policies in friends_presence_schema.sql/schema.sql allow — this only
-- grants the coarse table-level access Postgres requires before RLS is even
-- evaluated. `anon` is deliberately not granted anything (no unauthenticated
-- access to any of this data).
--
-- Run this after both schema files.

grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on
  public.profiles,
  public.entitlements,
  public.friend_requests,
  public.friendships,
  public.presence,
  public.servers,
  public.join_requests
to authenticated, service_role;

grant execute on all functions in schema public to authenticated, service_role;

-- Make sure this applies to anything created later too (belt-and-suspenders —
-- the statements above already cover everything that exists right now).
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to authenticated, service_role;
