// Friends / Presence / Join — pure decision logic.
//
// Deliberately framework-free: no Node builtins (no `fs`, `crypto`, `path`,
// no Electron APIs), so this file compiles and runs identically under
// tsconfig.main.json (main-process build, tested with plain Node against
// dist/main/services/FriendsPresenceLogic.js — see
// test/presence/friends-logic.test.js) AND when imported directly from
// renderer source (src/renderer/lib/friendsPresence.ts), which is where the
// real Supabase network calls actually happen (see that file's own header
// for why the network layer lives in the renderer rather than main).
//
// Every rule in here is mirrored, not replaced, by the real server-side
// enforcement in supabase/friends_presence_schema.sql's RLS policies and
// security-definer functions. This file exists so those exact rules (no
// self-friending, no duplicate requests, only the recipient may
// accept/decline, only real friends may see presence, only the server's
// real owner can be joined, etc.) are deterministically testable without a
// live Supabase project — never so the renderer can act as its own
// authority. The backend re-checks everything; the renderer never trusts
// itself to enforce security.

export type FriendRequestStatus = 'pending' | 'accepted' | 'declined';

export interface FriendRequestRecord {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: FriendRequestStatus;
}

export interface RequestDecision {
  allowed: boolean;
  reason?: string;
}

/** No self-requests, no duplicate pending requests (either direction), no
 *  re-requesting an existing friend. */
export function canSendFriendRequest(args: {
  requesterId: string;
  addresseeId: string;
  existingRequests: FriendRequestRecord[];
  alreadyFriends: boolean;
}): RequestDecision {
  const { requesterId, addresseeId, existingRequests, alreadyFriends } = args;
  if (!requesterId || !addresseeId) return { allowed: false, reason: 'Invalid request.' };
  if (requesterId === addresseeId) return { allowed: false, reason: 'You cannot send a friend request to yourself.' };
  if (alreadyFriends) return { allowed: false, reason: 'You are already friends.' };
  const duplicate = existingRequests.some((r) => r.status === 'pending'
    && ((r.requesterId === requesterId && r.addresseeId === addresseeId) || (r.requesterId === addresseeId && r.addresseeId === requesterId)));
  if (duplicate) return { allowed: false, reason: 'A friend request is already pending between you two.' };
  return { allowed: true };
}

/** Only the real addressee of a still-pending request may accept/decline it
 *  — never the requester, never an unrelated user, never a resolved request. */
export function canRespondToFriendRequest(args: { request: FriendRequestRecord; respondingUserId: string }): RequestDecision {
  const { request, respondingUserId } = args;
  if (request.status !== 'pending') return { allowed: false, reason: 'This request is no longer pending.' };
  if (request.addresseeId !== respondingUserId) return { allowed: false, reason: 'Only the recipient of a friend request may respond to it.' };
  return { allowed: true };
}

export function canRemoveFriend(args: { userId: string; friendId: string; isFriend: boolean }): RequestDecision {
  const { userId, friendId, isFriend } = args;
  if (userId === friendId) return { allowed: false, reason: 'Invalid.' };
  if (!isFriend) return { allowed: false, reason: 'You are not friends with this user.' };
  return { allowed: true };
}

// ── Heartbeat / online-timeout ─────────────────────────────────────────────
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000;

/** A user counts as online only while their real client has heartbeat
 *  recently — never permanently, and never just because they logged in once. */
export function isHeartbeatFresh(lastHeartbeatMs: number | null | undefined, nowMs: number, timeoutMs: number = HEARTBEAT_TIMEOUT_MS): boolean {
  if (lastHeartbeatMs == null) return false;
  return nowMs - lastHeartbeatMs < timeoutMs;
}

// ── Real game/server activity ──────────────────────────────────────────────
export type ActivityKind = 'playing' | 'hosting';
export type ActivityGameId = 'fivem' | 'minecraft' | 'assettocorsa';

export interface RealActivity {
  mercyGameId: ActivityGameId;
  kind: ActivityKind;
  /** Only present for kind:'hosting' — a real Mercy-managed server. */
  serverId?: string;
  serverName?: string;
  /** Minecraft only — real, detected edition, never guessed. */
  edition?: 'java' | 'bedrock';
}

const GAME_LABELS: Record<ActivityGameId, string> = { fivem: 'FiveM', minecraft: 'Minecraft', assettocorsa: 'Assetto Corsa' };

export function formatActivityLabel(activity: RealActivity | null): string | null {
  if (!activity) return null;
  const label = GAME_LABELS[activity.mercyGameId] || activity.mercyGameId;
  return activity.kind === 'hosting' ? `Playing/Hosting ${label}` : `Playing ${label}`;
}

// ── Privacy ─────────────────────────────────────────────────────────────────
export interface PresenceSettings {
  /** Master switch — off (default) means fully invisible to everyone. */
  appearOnline: boolean;
  /** Whether "Playing X" is shown at all, once appearOnline is true. */
  showCurrentGame: boolean;
  /** Whether a Mercy-managed server's own identity (id/name) is shown, once
   *  showCurrentGame is true and the activity is actually hosting. */
  showCurrentServer: boolean;
}

export const DEFAULT_PRESENCE_SETTINGS: PresenceSettings = { appearOnline: false, showCurrentGame: false, showCurrentServer: false };

export type PublicPresenceStatus = 'online' | 'offline';

export interface PublicPresence {
  status: PublicPresenceStatus;
  activityLabel: string | null;
  mercyGameId: ActivityGameId | null;
  serverId: string | null;
  serverName: string | null;
}

const OFFLINE_PRESENCE: PublicPresence = { status: 'offline', activityLabel: null, mercyGameId: null, serverId: null, serverName: null };

/** The single real gate presence data passes through before it's ever shown
 *  to another person. Never leaks a filesystem path, port, or credential —
 *  those never enter RealActivity/PresenceSettings in the first place.
 *  Mirrored server-side by get_friends_presence() in the SQL schema, which
 *  is the ACTUAL authority; this is what makes that authority's behavior
 *  testable here without a live database. */
export function buildPresenceForViewer(args: {
  settings: PresenceSettings;
  lastHeartbeatMs: number | null;
  nowMs: number;
  activity: RealActivity | null;
  isFriend: boolean;
  isSelf: boolean;
}): PublicPresence {
  const { settings, lastHeartbeatMs, nowMs, activity, isFriend, isSelf } = args;
  // Never enumerable by a non-friend, no matter what the owner's settings are.
  if (!isSelf && !isFriend) return OFFLINE_PRESENCE;
  if (!isSelf && !settings.appearOnline) return OFFLINE_PRESENCE;
  const online = isSelf ? true : isHeartbeatFresh(lastHeartbeatMs, nowMs);
  if (!online) return OFFLINE_PRESENCE;
  const showGame = isSelf || settings.showCurrentGame;
  if (!activity || !showGame) return { status: 'online', activityLabel: null, mercyGameId: null, serverId: null, serverName: null };
  const showServer = isSelf || settings.showCurrentServer;
  const exposed: RealActivity = (activity.kind === 'hosting' && !showServer)
    ? { mercyGameId: activity.mercyGameId, kind: 'playing' } // still honest that they're playing the game, just not that (or which) server
    : activity;
  return {
    status: 'online',
    activityLabel: formatActivityLabel(exposed),
    mercyGameId: exposed.mercyGameId,
    serverId: exposed.kind === 'hosting' ? exposed.serverId ?? null : null,
    serverName: exposed.kind === 'hosting' ? exposed.serverName ?? null : null,
  };
}

// ── Everyone Playing ────────────────────────────────────────────────────────
export interface EveryonePlayingEntry {
  visible: boolean;
  activityLabel: string | null;
  mercyGameId: ActivityGameId | null;
}

/** "Everyone Playing" — real presence discovery across ALL users, not just
 *  friends, so people can find and befriend other real players (never a
 *  fabricated/sample list). Same privacy gate as buildPresenceForViewer
 *  above, EXCEPT it never requires friendship and — regardless of the
 *  owner's own showCurrentServer setting — never exposes server id/name at
 *  all; that stays a friends-only, join-relevant detail shown only via
 *  Friends/Friends Playing. Mirrored server-side by get_everyone_playing()
 *  in the SQL schema, which is the actual authority this makes testable. */
export function buildEveryonePlayingEntry(args: {
  settings: PresenceSettings;
  lastHeartbeatMs: number | null;
  nowMs: number;
  activity: RealActivity | null;
  isSelf: boolean;
}): EveryonePlayingEntry {
  const { settings, lastHeartbeatMs, nowMs, activity, isSelf } = args;
  const hidden: EveryonePlayingEntry = { visible: false, activityLabel: null, mercyGameId: null };
  if (isSelf) return hidden; // never lists yourself
  if (!settings.appearOnline || !settings.showCurrentGame) return hidden;
  if (!isHeartbeatFresh(lastHeartbeatMs, nowMs)) return hidden;
  if (!activity) return hidden;
  return { visible: true, activityLabel: formatActivityLabel(activity), mercyGameId: activity.mercyGameId };
}

// ── Join authorization ──────────────────────────────────────────────────────
export interface JoinAuthorizationInput {
  requesterId: string;
  hostId: string;
  serverOwnerId: string;
  serverIsOnline: boolean;
  isFriend: boolean;
}

export interface JoinAuthorizationResult {
  authorized: boolean;
  reason?: string;
}

/** Every check Phase 13 requires, in one place: real ownership, real
 *  friendship, real online state — never trusting a renderer-supplied claim
 *  about any of them. Mirrored by request_join()/respond_to_join_request()
 *  in the SQL schema, which perform the actual, authoritative version of
 *  these same checks against real rows the caller cannot forge. */
export function authorizeJoinRequest(input: JoinAuthorizationInput): JoinAuthorizationResult {
  const { requesterId, hostId, serverOwnerId, serverIsOnline, isFriend } = input;
  if (requesterId === hostId) return { authorized: false, reason: 'You cannot request to join your own server through the friend join flow.' };
  if (serverOwnerId !== hostId) return { authorized: false, reason: 'This server does not belong to that host.' };
  if (!isFriend) return { authorized: false, reason: 'You must be friends with the host to request to join their server.' };
  if (!serverIsOnline) return { authorized: false, reason: 'This server is not currently online.' };
  return { authorized: true };
}

// ── Rate limiting ────────────────────────────────────────────────────────────
/** A plain sliding-window limiter — real, deterministic with an injected
 *  clock, no external dependency. Used to bound friend-request spam and join
 *  request spam per user; the SQL schema additionally rate-limits at the
 *  database level via a request-count check inside each security-definer
 *  function, so a malicious client bypassing the renderer entirely is still
 *  bound by the real backend, not just this client-side copy. */
export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly maxHits: number, private readonly windowMs: number) {}

  tryConsume(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) || []).filter((t) => nowMs - t < this.windowMs);
    if (recent.length >= this.maxHits) { this.hits.set(key, recent); return false; }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return true;
  }
}
