// assessConnectivity() — the one real, pure function kept in
// PresenceManager.ts after the Friends & Presence feature (local activity
// tracking, join tokens, friends/presence settings) was removed from the
// app. ConnectionNegotiator.ts (used by Minecraft/Assetto Corsa/FiveM's own
// "Connect" tabs) still depends on this for its honest per-case reachability
// explanation.
const path = require('path');
const { assessConnectivity } = require(path.resolve(__dirname, '../../dist/main/services/PresenceManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const lan = assessConnectivity({ hasLanAddress: true, realtimeReachable: true });
ok('LAN-reachable server assesses as lan-direct', lan.strategy === 'lan-direct');
const publicDirect = assessConnectivity({ hasLanAddress: false, realtimeReachable: true });
ok('a real, already-reachable non-LAN server assesses as public-direct', publicDirect.strategy === 'public-direct');
const unreachable = assessConnectivity({ hasLanAddress: false, realtimeReachable: false });
ok('a confirmed-unreachable server assesses as not-joinable', unreachable.strategy === 'not-joinable');
const unknown = assessConnectivity({ hasLanAddress: false, realtimeReachable: null });
ok('an unconfirmed, non-LAN server honestly assesses as relay-required-unavailable (never a fabricated working relay)', unknown.strategy === 'relay-required-unavailable');
ok('the relay-required-unavailable explanation is honest about Mercy having no relay service today', /no relay/i.test(unknown.explanation));

console.log(`\nPRESENCE TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
