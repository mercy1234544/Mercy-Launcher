// Real Friends/Presence/Join client — talks to the SAME Supabase backend
// already used for accounts (see supabase.ts/useAuth.ts). Every rule this
// file relies on (no self-friending, no duplicate requests, only real
// friends see presence, only a server's real owner can authorize a join,
// etc.) is actually enforced server-side by
// supabase/friends_presence_schema.sql's RLS policies and SECURITY DEFINER
// functions — this file is a thin, honest client, never its own authority.
//
// Every method below is safe to call whether or not Supabase is configured:
// with no project configured (the state of this repo today — see
// isSupabaseConfigured() in supabase.ts), calls resolve with
// `notConfigured: true` rather than throwing or fabricating data. A real
// project that's configured but unreachable resolves with a real `error`
// instead — callers (see useFriendsPresence.ts) must tell these two states
// apart, since "unreachable" is not "you have no friends yet".
import { supabase } from './supabase';
import type { RealActivity, PresenceSettings } from '../../main/services/FriendsPresenceLogic';

export interface FriendPresenceRow {
  friendId: string;
  username: string;
  status: 'online' | 'offline';
  activityLabel: string | null;
  mercyGameId: string | null;
  serverId: string | null;
  serverName: string | null;
}

export interface IncomingFriendRequest { id: string; fromUserId: string; fromUsername: string; createdAt: string; }
export interface OutgoingFriendRequest { id: string; toUserId: string; toUsername: string; createdAt: string; }

export interface ServiceResult<T> { data: T; error?: string; notConfigured?: boolean; }

const UNREACHABLE = 'Unable to connect to Mercy services.';

function friendlyError(e: any): string {
  const msg = (e?.message || String(e || '')).toLowerCase();
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('timeout')) return UNREACHABLE;
  return e?.message || UNREACHABLE;
}

export async function sendFriendRequest(username: string): Promise<{ error?: string; notConfigured?: boolean }> {
  if (!supabase) return { notConfigured: true };
  try {
    const { error } = await supabase.rpc('send_friend_request', { addressee_username: username.trim() });
    if (error) return { error: error.message };
    return {};
  } catch (e) { return { error: friendlyError(e) }; }
}

export async function respondToFriendRequest(requestId: string, approve: boolean): Promise<{ error?: string; notConfigured?: boolean }> {
  if (!supabase) return { notConfigured: true };
  try {
    const { error } = await supabase.rpc('respond_to_friend_request', { request_id: requestId, approve });
    if (error) return { error: error.message };
    return {};
  } catch (e) { return { error: friendlyError(e) }; }
}

export async function removeFriend(friendId: string): Promise<{ error?: string; notConfigured?: boolean }> {
  if (!supabase) return { notConfigured: true };
  try {
    const { error } = await supabase.rpc('remove_friend', { friend_id: friendId });
    if (error) return { error: error.message };
    return {};
  } catch (e) { return { error: friendlyError(e) }; }
}

export async function listIncomingRequests(): Promise<ServiceResult<IncomingFriendRequest[]>> {
  if (!supabase) return { data: [], notConfigured: true };
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: [] };
    const { data, error } = await supabase.from('friend_requests')
      .select('id, created_at, requester_id, profiles!friend_requests_requester_id_fkey(username)')
      .eq('addressee_id', user.id).eq('status', 'pending');
    if (error) return { data: [], error: friendlyError(error) };
    return { data: (data || []).map((r: any) => ({ id: r.id, fromUserId: r.requester_id, fromUsername: r.profiles?.username || 'Unknown', createdAt: r.created_at })) };
  } catch (e) { return { data: [], error: friendlyError(e) }; }
}

export async function listOutgoingRequests(): Promise<ServiceResult<OutgoingFriendRequest[]>> {
  if (!supabase) return { data: [], notConfigured: true };
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: [] };
    const { data, error } = await supabase.from('friend_requests')
      .select('id, created_at, addressee_id, profiles!friend_requests_addressee_id_fkey(username)')
      .eq('requester_id', user.id).eq('status', 'pending');
    if (error) return { data: [], error: friendlyError(error) };
    return { data: (data || []).map((r: any) => ({ id: r.id, toUserId: r.addressee_id, toUsername: r.profiles?.username || 'Unknown', createdAt: r.created_at })) };
  } catch (e) { return { data: [], error: friendlyError(e) }; }
}

export interface EveryonePlayingRow {
  userId: string;
  username: string;
  activityLabel: string | null;
  mercyGameId: string | null;
  isFriend: boolean;
  requestPending: boolean;
}

/** Real presence discovery across ALL users, not just friends — see
 *  get_everyone_playing() in friends_presence_schema.sql, the actual
 *  authority: it never requires friendship, but never exposes server id/
 *  name either way (that stays a friends-only, join-relevant detail). */
export async function getEveryonePlaying(): Promise<ServiceResult<EveryonePlayingRow[]>> {
  if (!supabase) return { data: [], notConfigured: true };
  try {
    const { data, error } = await supabase.rpc('get_everyone_playing');
    if (error) return { data: [], error: friendlyError(error) };
    return {
      data: (data || []).map((r: any) => ({
        userId: r.user_id, username: r.username, activityLabel: r.activity_label,
        mercyGameId: r.mercy_game_id, isFriend: r.is_friend, requestPending: r.request_pending,
      })),
    };
  } catch (e) { return { data: [], error: friendlyError(e) }; }
}

export async function getFriendsPresence(): Promise<ServiceResult<FriendPresenceRow[]>> {
  if (!supabase) return { data: [], notConfigured: true };
  try {
    const { data, error } = await supabase.rpc('get_friends_presence');
    if (error) return { data: [], error: friendlyError(error) };
    return {
      data: (data || []).map((r: any) => ({
        friendId: r.friend_id, username: r.username, status: r.status,
        activityLabel: r.activity_label, mercyGameId: r.mercy_game_id, serverId: r.server_id, serverName: r.server_name,
      })),
    };
  } catch (e) { return { data: [], error: friendlyError(e) }; }
}

export async function sendHeartbeat(settings: PresenceSettings, activity: RealActivity | null): Promise<{ error?: string; notConfigured?: boolean }> {
  if (!supabase) return { notConfigured: true };
  try {
    const { error } = await supabase.rpc('heartbeat', {
      p_appear_online: settings.appearOnline, p_show_current_game: settings.showCurrentGame,
      p_show_current_server: settings.showCurrentServer, p_activity: activity,
    });
    if (error) return { error: friendlyError(error) };
    return {};
  } catch (e) { return { error: friendlyError(e) }; }
}

export async function upsertServer(server: { id: string; mercyGameId: string; edition?: string | null; displayName: string; isOnline: boolean }): Promise<{ error?: string; notConfigured?: boolean }> {
  if (!supabase) return { notConfigured: true };
  try {
    const { error } = await supabase.rpc('upsert_server', {
      p_id: server.id, p_mercy_game_id: server.mercyGameId, p_edition: server.edition ?? null,
      p_display_name: server.displayName, p_is_online: server.isOnline,
    });
    if (error) return { error: friendlyError(error) };
    return {};
  } catch (e) { return { error: friendlyError(e) }; }
}

/** Real join-authorization request — presence only ever tells a friend
 *  "Hunter is running My Survival Server"; this is the separate, actual
 *  authorization step. It stops at authorization: there is no cross-network
 *  game transport implemented yet (see PresenceManager.ts's connectivity
 *  audit), so a caller must not treat `authorized` as "connected". */
export async function requestJoin(serverId: string): Promise<{ data?: { id: string }; error?: string; notConfigured?: boolean }> {
  if (!supabase) return { notConfigured: true };
  try {
    const { data, error } = await supabase.rpc('request_join', { p_server_id: serverId });
    if (error) return { error: friendlyError(error) };
    return { data: { id: data?.id } };
  } catch (e) { return { error: friendlyError(e) }; }
}

export async function respondToJoinRequest(
  requestId: string, approve: boolean, token?: string, endpoint?: { strategy: string; address: string; relayId?: string; relayIdUdp?: string } | null,
): Promise<{ error?: string; notConfigured?: boolean }> {
  if (!supabase) return { notConfigured: true };
  try {
    const { error } = await supabase.rpc('respond_to_join_request', {
      request_id: requestId, approve, p_token: token ?? null, p_endpoint: endpoint ?? null,
    });
    if (error) return { error: friendlyError(error) };
    return {};
  } catch (e) { return { error: friendlyError(e) }; }
}

export interface JoinRequestRow {
  id: string; requesterId: string; requesterUsername: string; hostId: string; serverId: string;
  status: 'pending' | 'authorized' | 'denied' | 'expired';
  endpoint: { strategy: string; address: string; relayId?: string; relayIdUdp?: string } | null;
  /** Only meaningful to the REQUESTER (RLS scopes the row to the two real
   *  parties either way) — the opaque HMAC credential the host minted,
   *  needed to authenticate to the relay when endpoint.strategy is
   *  'relay'. Never decoded/inspected client-side (see PresenceManager.ts). */
  token: string | null;
  /** The real server's own registered game/edition (joined from `servers`)
   *  — needed so the requester knows whether a relay connection must use
   *  TCP or UDP (Bedrock) transport, without guessing. */
  mercyGameId: string | null;
  edition: 'java' | 'bedrock' | null;
  createdAt: string;
}

/** Real join requests where I'm the HOST (people asking to join MY server)
 *  and where I'm the REQUESTER (my own outstanding/resolved requests) — a
 *  single query since RLS's own "parties read join requests" policy
 *  already scopes rows to exactly these two roles for the caller. */
export async function listJoinRequests(): Promise<ServiceResult<{ incoming: JoinRequestRow[]; outgoing: JoinRequestRow[] }>> {
  if (!supabase) return { data: { incoming: [], outgoing: [] }, notConfigured: true };
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: { incoming: [], outgoing: [] } };
    const { data, error } = await supabase.from('join_requests')
      .select('id, status, endpoint, token, created_at, requester_id, host_id, server_id, profiles!join_requests_requester_id_fkey(username), servers(mercy_game_id, edition)')
      .order('created_at', { ascending: false }).limit(20);
    if (error) return { data: { incoming: [], outgoing: [] }, error: friendlyError(error) };
    const rows: JoinRequestRow[] = (data || []).map((r: any) => ({
      id: r.id, requesterId: r.requester_id, requesterUsername: r.profiles?.username || 'Unknown', hostId: r.host_id,
      serverId: r.server_id, status: r.status, endpoint: r.endpoint, token: r.token,
      mercyGameId: r.servers?.mercy_game_id ?? null, edition: r.servers?.edition ?? null, createdAt: r.created_at,
    }));
    return {
      data: {
        incoming: rows.filter((r) => r.hostId === user.id && r.status === 'pending'),
        outgoing: rows.filter((r) => r.requesterId === user.id),
      },
    };
  } catch (e) { return { data: { incoming: [], outgoing: [] }, error: friendlyError(e) }; }
}

/** Real-time friend updates (Phase 14) — subscribes to changes on the
 *  presence table and re-fetches via get_friends_presence() (which is where
 *  the actual privacy filtering happens) rather than trusting the raw
 *  change payload, which would bypass that filtering. Requires the owner to
 *  have enabled Realtime replication on `presence` in the Supabase
 *  dashboard (see friends_presence_schema.sql's setup note) — unverified
 *  against a live project, since none is configured in this repo. */
export function subscribeToFriendsUpdates(onChange: () => void): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel('mercy-friends-presence')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'presence' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'servers' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friend_requests' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'join_requests' }, onChange)
    .subscribe();
  return () => { supabase?.removeChannel(channel); };
}
