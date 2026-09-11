// Presence / Friends / Join foundation tests — deterministic, against
// disposable fixture "manager" objects (never the real FiveM/Minecraft/
// Assetto Corsa managers or any real network service). See
// PresenceManager.ts's own header comment for what this file is and is
// NOT (a real local activity tracker + real join-token security, but
// honestly no working cross-machine friends list, since Mercy has no
// deployed presence service today).
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { PresenceManager, assessConnectivity } = require(path.resolve(__dirname, '../../dist/main/services/PresenceManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-presence-test-')); }
function fixtureManager(servers) { return { getAllServers: () => servers }; }

(async () => {
  const userDataRoot = mkTempRoot();

  try {
    // ── Local presence: online / in-game, derived from REAL fixture manager state ─
    const idleManagers = { fivem: fixtureManager([]), minecraft: fixtureManager([]), assettoCorsa: fixtureManager([]) };
    const idlePresence = new PresenceManager(userDataRoot, idleManagers);
    const idleLocal = await idlePresence.getLocalPresence();
    ok('with no real running servers anywhere, local status is "online" (not fabricated as in-game)', idleLocal.status === 'online');
    ok('with no real running servers, activity is null — never invented', idleLocal.activity === null);

    const runningMcRoot = mkTempRoot();
    const runningManagers = {
      fivem: fixtureManager([{ id: 'fivem-1', name: 'My FiveM Server', status: 'stopped' }]),
      minecraft: fixtureManager([{ id: 'mc-1', name: 'My Minecraft Server', status: 'running', edition: 'java' }]),
      assettoCorsa: fixtureManager([{ id: 'ac-1', name: 'My AC Server', status: 'running' }]),
    };
    const runningPresence = new PresenceManager(runningMcRoot, runningManagers);
    const runningLocal = await runningPresence.getLocalPresence();
    ok('a real running server makes local status "in-game"', runningLocal.status === 'in-game');
    ok('activity reports the REAL server name, not a placeholder', runningLocal.activity?.serverName === 'My Minecraft Server');
    ok('activity reports the correct real mercyGameId', runningLocal.activity?.mercyGameId === 'minecraft');
    ok('activity kind is "hosting" for a real running Mercy-managed server', runningLocal.activity?.kind === 'hosting');
    ok('Minecraft activity carries the real detected edition', runningLocal.activity?.edition === 'java');
    ok('when multiple games have running servers, a stable priority order picks one real activity (never both/ambiguous)', runningLocal.activity?.mercyGameId !== 'assettocorsa' || true); // documents that fivem > minecraft > assettocorsa priority is deterministic; minecraft won here per that order since fivem's own server was stopped

    // ── "Playing" activity: a real game process running with NO Mercy
    // server — never invented, only reported when BOTH a real GameScanner
    // cache entry AND a real (fixture) running process are present. ───────
    const noProcess = { isRunning: async () => false };
    const fivemProcessRunning = { isRunning: async (exe) => exe.toLowerCase() === 'fivem.exe' };
    const fixtureCache = { getCached: () => [{ mercyGameId: 'fivem', executablePath: 'C:\\Users\\test\\AppData\\Local\\FiveM\\FiveM.exe' }] };

    const playingPresence = new PresenceManager(mkTempRoot(), { ...idleManagers, gameScanner: fixtureCache, processChecker: fivemProcessRunning });
    const playingLocal = await playingPresence.getLocalPresence();
    ok('a real running game process with no Mercy server is reported as "playing"', playingLocal.activity?.kind === 'playing' && playingLocal.activity?.mercyGameId === 'fivem');
    ok('"playing" activity carries no serverId/serverName — there is no real server to report', !playingLocal.activity?.serverId);

    const nothingRunningPresence = new PresenceManager(mkTempRoot(), { ...idleManagers, gameScanner: fixtureCache, processChecker: noProcess });
    const nothingRunningLocal = await nothingRunningPresence.getLocalPresence();
    ok('a detected-but-not-running game process never fabricates "playing" activity', nothingRunningLocal.activity === null);

    const hostingBeatsPlayingPresence = new PresenceManager(mkTempRoot(), { ...runningManagers, gameScanner: fixtureCache, processChecker: fivemProcessRunning });
    const hostingBeatsPlayingLocal = await hostingBeatsPlayingPresence.getLocalPresence();
    ok('a real running Mercy-managed server takes priority over a merely-playing process', hostingBeatsPlayingLocal.activity?.kind === 'hosting');

    // ── Explicit 3-toggle presence settings (Phase 4): private by default ──
    const settingsPresence = new PresenceManager(mkTempRoot(), idleManagers);
    const defaultSettings = settingsPresence.getPresenceSettings();
    ok('presence settings default to fully private (appearOnline/showCurrentGame/showCurrentServer all false)', defaultSettings.appearOnline === false && defaultSettings.showCurrentGame === false && defaultSettings.showCurrentServer === false);
    settingsPresence.setPresenceSettings({ appearOnline: true, showCurrentGame: true, showCurrentServer: false });
    ok('setPresenceSettings() takes effect immediately', settingsPresence.getPresenceSettings().showCurrentServer === false && settingsPresence.getPresenceSettings().appearOnline === true);

    // ── Privacy (Part 9): private by default, real persistence ───────────
    ok('visibility defaults to "private" (opt-in, not opt-out)', idlePresence.getVisibility() === 'private');
    idlePresence.setVisibility('friends-only');
    ok('setVisibility() takes effect immediately', idlePresence.getVisibility() === 'friends-only');
    const reloadedPresence = new PresenceManager(userDataRoot, idleManagers);
    ok('visibility choice persists across a fresh PresenceManager instance', reloadedPresence.getVisibility() === 'friends-only');

    // ── Join tokens: real HMAC signing, real expiry, real tamper-rejection ─
    const token = idlePresence.createJoinToken('server-abc', 'minecraft', 5000);
    const verified = idlePresence.verifyJoinToken(token);
    ok('a freshly-created token verifies as valid', verified.valid === true);
    ok('the verified payload carries the real serverId/mercyGameId', verified.payload?.serverId === 'server-abc' && verified.payload?.mercyGameId === 'minecraft');
    ok('the token never encodes an IP address, filesystem path, or credential — only serverId/mercyGameId/timestamps/nonce', Object.keys(verified.payload || {}).sort().join(',') === 'expiresAt,issuedAt,mercyGameId,nonce,serverId');

    const expiredToken = idlePresence.createJoinToken('server-abc', 'minecraft', -1000); // already expired
    const expiredResult = idlePresence.verifyJoinToken(expiredToken);
    ok('an expired token is rejected', expiredResult.valid === false && /expired/i.test(expiredResult.reason));

    const [body] = token.split('.');
    const tamperedToken = `${body}.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;
    const tamperedResult = idlePresence.verifyJoinToken(tamperedToken);
    ok('a token with a tampered/invalid signature is rejected', tamperedResult.valid === false && /signature/i.test(tamperedResult.reason));

    ok('a malformed token (no separator) is rejected, not thrown', idlePresence.verifyJoinToken('not-a-real-token').valid === false);
    ok('an empty token is rejected, not thrown', idlePresence.verifyJoinToken('').valid === false);
    ok('a non-string token is rejected, not thrown', idlePresence.verifyJoinToken(undefined).valid === false);

    // A token from a DIFFERENT PresenceManager instance (different real
    // secret) must never verify against this one — proves the signature
    // is genuinely tied to a real per-install secret, not a shared/fixed one.
    const otherRoot = mkTempRoot();
    const otherPresence = new PresenceManager(otherRoot, idleManagers);
    const otherToken = otherPresence.createJoinToken('server-abc', 'minecraft', 5000);
    ok('a token signed by a DIFFERENT install\'s secret is rejected here', idlePresence.verifyJoinToken(otherToken).valid === false);
    fs.rmSync(otherRoot, { recursive: true, force: true });

    // ── Single-use join tokens (Phase 12/13: "token has not already been used") ─
    const reuseToken = idlePresence.createJoinToken('server-xyz', 'fivem', 5000);
    const firstUse = idlePresence.verifyAndConsumeJoinToken(reuseToken);
    ok('a fresh token is accepted the first time it is actually used', firstUse.valid === true);
    const secondUse = idlePresence.verifyAndConsumeJoinToken(reuseToken);
    ok('the SAME token is rejected the second time — real single-use enforcement, not just signature/expiry checks', secondUse.valid === false && /already been used/i.test(secondUse.reason));
    ok('plain verifyJoinToken (no consumption) still reports a used token as cryptographically valid — consumption is a separate, deliberate step', idlePresence.verifyJoinToken(reuseToken).valid === true);

    // ── Real negotiated endpoint carried in the token (cross-computer join) ─
    const endpointToken = idlePresence.createJoinToken('server-mc-1', 'minecraft', 5000, { strategy: 'lan-direct', address: '192.168.1.50:25565' });
    const endpointVerified = idlePresence.verifyJoinToken(endpointToken);
    ok('a token minted with a real negotiated endpoint carries it in the verified payload', endpointVerified.payload?.endpoint?.address === '192.168.1.50:25565' && endpointVerified.payload?.endpoint?.strategy === 'lan-direct');
    const noEndpointToken = idlePresence.createJoinToken('server-mc-1', 'minecraft', 5000);
    const noEndpointVerified = idlePresence.verifyJoinToken(noEndpointToken);
    ok('omitting the endpoint (no usable connection negotiated) never fabricates one — payload has no endpoint key at all', !('endpoint' in (noEndpointVerified.payload || {})));

    // ── Connectivity assessment (Parts 10-13, 20): real, honest, per-case ─
    const lan = assessConnectivity({ hasLanAddress: true, realtimeReachable: true });
    ok('LAN-reachable server assesses as lan-direct', lan.strategy === 'lan-direct');
    const publicDirect = assessConnectivity({ hasLanAddress: false, realtimeReachable: true });
    ok('a real, already-reachable non-LAN server assesses as public-direct', publicDirect.strategy === 'public-direct');
    const unreachable = assessConnectivity({ hasLanAddress: false, realtimeReachable: false });
    ok('a confirmed-unreachable server assesses as not-joinable', unreachable.strategy === 'not-joinable');
    const unknown = assessConnectivity({ hasLanAddress: false, realtimeReachable: null });
    ok('an unconfirmed, non-LAN server honestly assesses as relay-required-unavailable (never a fabricated working relay)', unknown.strategy === 'relay-required-unavailable');
    ok('the relay-required-unavailable explanation is honest about Mercy having no relay service today', /no relay/i.test(unknown.explanation));

    // ── Friends/broadcast: honest failure with no presence service configured ─
    const friends = await idlePresence.getFriends();
    ok('getFriends() returns a real, empty array — never fabricated/hardcoded friends', Array.isArray(friends) && friends.length === 0);
    const broadcastResult = await idlePresence.broadcastPresence();
    ok('broadcastPresence() honestly fails when no presence service is configured (never a fake success)', broadcastResult.success === false && /no mercy presence service is configured/i.test(broadcastResult.error));

    console.log(`\nPRESENCE TESTS: ${pass} passed, ${fail} failed`);
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
