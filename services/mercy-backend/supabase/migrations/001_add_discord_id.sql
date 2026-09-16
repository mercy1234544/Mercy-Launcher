-- Mercy Launcher — Discord-identity migration, step 1 of 1 (additive only).
--
-- PROPOSED, NOT YET APPLIED to any environment. Do not run this against
-- production until explicitly approved separately from the code review.
--
-- Verified against the LIVE production Supabase project before writing
-- this file (read-only, anon-key-only PostgREST column probe — no
-- service-role key used, no row data read): public.profiles has no
-- discord_id, discordid, or discord_snowflake column today, so this is not
-- a duplicate identity store.
--
-- Additive only: adds one nullable, unique column plus its index. Existing
-- password-authenticated accounts get discord_id = null and are completely
-- unaffected. No existing column in profiles, entitlements,
-- friend_requests, friendships, presence, servers, or join_requests is
-- retyped, renamed, or dropped, and no existing row anywhere is rewritten
-- by this statement.
alter table public.profiles
  add column if not exists discord_id text unique;

create index if not exists profiles_discord_id_idx
  on public.profiles (discord_id);
