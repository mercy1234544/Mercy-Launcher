// FriendsPresenceLogic tests — deterministic, pure-function tests for the
// exact rules the real backend (supabase/friends_presence_schema.sql)
// enforces server-side. No network, no Supabase project, no Electron.
const path = require('path');
const {
  canSendFriendRequest, canRespondToFriendRequest, canRemoveFriend,
  isHeartbeatFresh, formatActivityLabel, buildPresenceForViewer,
  authorizeJoinRequest, SlidingWindowRateLimiter, DEFAULT_PRESENCE_SETTINGS,
} = require(path.resolve(__dirname, '../../dist/main/services/FriendsPresenceLogic.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ── Friend requests ──────────────────────────────────────────────────────
ok('self-friend-request is rejected', canSendFriendRequest({ requesterId: 'a', addresseeId: 'a', existingRequests: [], alreadyFriends: false }).allowed === false);
ok('a normal request between two different users is allowed', canSendFriendRequest({ requesterId: 'a', addresseeId: 'b', existingRequests: [], alreadyFriends: false }).allowed === true);
ok('a request to an existing friend is rejected', canSendFriendRequest({ requesterId: 'a', addresseeId: 'b', existingRequests: [], alreadyFriends: true }).allowed === false);
ok('a duplicate pending request (same direction) is rejected', canSendFriendRequest({
  requesterId: 'a', addresseeId: 'b', alreadyFriends: false,
  existingRequests: [{ id: '1', requesterId: 'a', addresseeId: 'b', status: 'pending' }],
}).allowed === false);
ok('a duplicate pending request (REVERSE direction) is also rejected — no double-pending in either direction', canSendFriendRequest({
  requesterId: 'a', addresseeId: 'b', alreadyFriends: false,
  existingRequests: [{ id: '1', requesterId: 'b', addresseeId: 'a', status: 'pending' }],
}).allowed === false);
ok('a previously DECLINED request does not block a new one', canSendFriendRequest({
  requesterId: 'a', addresseeId: 'b', alreadyFriends: false,
  existingRequests: [{ id: '1', requesterId: 'a', addresseeId: 'b', status: 'declined' }],
}).allowed === true);

ok('only the real addressee may accept a pending request', canRespondToFriendRequest({ request: { id: '1', requesterId: 'a', addresseeId: 'b', status: 'pending' }, respondingUserId: 'b' }).allowed === true);
ok('the REQUESTER may not accept their own outgoing request', canRespondToFriendRequest({ request: { id: '1', requesterId: 'a', addresseeId: 'b', status: 'pending' }, respondingUserId: 'a' }).allowed === false);
ok('an unrelated user may not respond to someone else\'s request', canRespondToFriendRequest({ request: { id: '1', requesterId: 'a', addresseeId: 'b', status: 'pending' }, respondingUserId: 'c' }).allowed === false);
ok('an already-resolved request cannot be responded to again', canRespondToFriendRequest({ request: { id: '1', requesterId: 'a', addresseeId: 'b', status: 'accepted' }, respondingUserId: 'b' }).allowed === false);

ok('removing a real friend is allowed', canRemoveFriend({ userId: 'a', friendId: 'b', isFriend: true }).allowed === true);
ok('removing a non-friend is rejected', canRemoveFriend({ userId: 'a', friendId: 'b', isFriend: false }).allowed === false);
ok('removing yourself is rejected', canRemoveFriend({ userId: 'a', friendId: 'a', isFriend: true }).allowed === false);

// ── Heartbeat / online timeout ──────────────────────────────────────────
const now = 1_000_000;
ok('a heartbeat 10s ago is fresh (online)', isHeartbeatFresh(now - 10_000, now) === true);
ok('a heartbeat 89.9s ago is still fresh', isHeartbeatFresh(now - 89_900, now) === true);
ok('a heartbeat 90s+ ago is stale (offline) — the real 90s timeout', isHeartbeatFresh(now - 90_001, now) === false);
ok('never having heartbeat at all is offline, not fabricated online', isHeartbeatFresh(null, now) === false);
ok('never having heartbeat at all (undefined) is offline', isHeartbeatFresh(undefined, now) === false);

// ── Activity labels ───────────────────────────────────────────────────────
ok('no activity has no label', formatActivityLabel(null) === null);
ok('playing (not hosting) formats as "Playing X"', formatActivityLabel({ mercyGameId: 'minecraft', kind: 'playing' }) === 'Playing Minecraft');
ok('hosting formats as "Playing/Hosting X"', formatActivityLabel({ mercyGameId: 'fivem', kind: 'hosting', serverId: 's1', serverName: 'My Server' }) === 'Playing/Hosting FiveM');

// ── Privacy filtering — the real gate before ANYTHING is shown to a viewer ─
const hostingActivity = { mercyGameId: 'minecraft', kind: 'hosting', serverId: 'srv-1', serverName: 'My Survival Server' };
const fullSettings = { appearOnline: true, showCurrentGame: true, showCurrentServer: true };

ok('a non-friend NEVER sees presence, no matter the owner\'s settings — prevents arbitrary presence enumeration', buildPresenceForViewer({
  settings: fullSettings, lastHeartbeatMs: now, nowMs: now, activity: hostingActivity, isFriend: false, isSelf: false,
}).status === 'offline');
ok('appearOnline=false (the real default) hides presence even from real friends', buildPresenceForViewer({
  settings: DEFAULT_PRESENCE_SETTINGS, lastHeartbeatMs: now, nowMs: now, activity: hostingActivity, isFriend: true, isSelf: false,
}).status === 'offline');
ok('a friend with appearOnline=true but a stale heartbeat is shown offline', buildPresenceForViewer({
  settings: fullSettings, lastHeartbeatMs: now - 200_000, nowMs: now, activity: hostingActivity, isFriend: true, isSelf: false,
}).status === 'offline');
const onlineNoGame = buildPresenceForViewer({
  settings: { appearOnline: true, showCurrentGame: false, showCurrentServer: true }, lastHeartbeatMs: now, nowMs: now, activity: hostingActivity, isFriend: true, isSelf: false,
});
ok('showCurrentGame=false shows online with NO activity/game/server leaked', onlineNoGame.status === 'online' && onlineNoGame.activityLabel === null && onlineNoGame.mercyGameId === null);
const gameButNoServer = buildPresenceForViewer({
  settings: { appearOnline: true, showCurrentGame: true, showCurrentServer: false }, lastHeartbeatMs: now, nowMs: now, activity: hostingActivity, isFriend: true, isSelf: false,
});
ok('showCurrentServer=false still honestly shows "Playing Minecraft" but hides which/whether server', gameButNoServer.activityLabel === 'Playing Minecraft' && gameButNoServer.serverId === null && gameButNoServer.serverName === null);
const fullyVisible = buildPresenceForViewer({
  settings: fullSettings, lastHeartbeatMs: now, nowMs: now, activity: hostingActivity, isFriend: true, isSelf: false,
});
ok('with everything enabled, a real friend sees the real server name', fullyVisible.serverName === 'My Survival Server' && fullyVisible.activityLabel === 'Playing/Hosting Minecraft');
const selfView = buildPresenceForViewer({
  settings: DEFAULT_PRESENCE_SETTINGS, lastHeartbeatMs: null, nowMs: now, activity: hostingActivity, isFriend: false, isSelf: true,
});
ok('viewing your OWN presence always shows full detail regardless of your own privacy settings/heartbeat staleness', selfView.status === 'online' && selfView.serverName === 'My Survival Server');

// ── Join authorization ───────────────────────────────────────────────────
const validJoin = { requesterId: 'friend-1', hostId: 'host-1', serverOwnerId: 'host-1', serverIsOnline: true, isFriend: true };
ok('a valid join request (real friend, real owner, real online server) is authorized', authorizeJoinRequest(validJoin).authorized === true);
ok('joining your own server via the friend flow is rejected', authorizeJoinRequest({ ...validJoin, requesterId: 'host-1' }).authorized === false);
ok('a server that does not actually belong to the claimed host is rejected — never trusts renderer-supplied ownership', authorizeJoinRequest({ ...validJoin, serverOwnerId: 'someone-else' }).authorized === false);
ok('a non-friend is rejected even with correct ownership/online state', authorizeJoinRequest({ ...validJoin, isFriend: false }).authorized === false);
ok('an offline server is rejected even for a real friend/real owner', authorizeJoinRequest({ ...validJoin, serverIsOnline: false }).authorized === false);

// ── Rate limiting ─────────────────────────────────────────────────────────
const limiter = new SlidingWindowRateLimiter(3, 1000);
let t = 0;
ok('rate limiter allows the first N requests in the window', limiter.tryConsume('user-1', t) && limiter.tryConsume('user-1', t + 10) && limiter.tryConsume('user-1', t + 20));
ok('rate limiter blocks the (N+1)th request within the same window', limiter.tryConsume('user-1', t + 30) === false);
ok('a DIFFERENT key has its own independent budget', limiter.tryConsume('user-2', t + 30) === true);
ok('after the window passes, the original key is allowed again', limiter.tryConsume('user-1', t + 1001) === true);

console.log(`\nFRIENDS/PRESENCE LOGIC TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
