// Verifies useFriendsPresence.ts's approveJoin() obtains the real Supabase
// access token and threads it into the relay-registration IPC calls, fails
// honestly (no undefined/null token sent, no silent HMAC fallback) when
// there's no live session, and leaves the join-token (HMAC) and
// connectViaRelay (CLIENT role) paths untouched.
//
// This store uses zustand + import.meta.env, which this repo has no
// jsdom/Vite test runner for (see test/library/ui-structure.test.js's own
// header — static source-text assertion is this codebase's established
// fallback for renderer code exactly like this).
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const storeSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/stores/useFriendsPresence.ts'), 'utf-8');

const approveStart = storeSrc.indexOf('approveJoin: async (request)');
const connectStart = storeSrc.indexOf('connectToApprovedJoin: async (request)');
const approveJoinBody = approveStart !== -1 ? storeSrc.slice(approveStart, connectStart !== -1 ? connectStart : approveStart + 3000) : '';

ok('approveJoin exists', approveStart !== -1);

ok('approveJoin imports the real supabase client (not just isSupabaseConfigured)', /import \{ isSupabaseConfigured, supabase \} from '\.\.\/lib\/supabase'/.test(storeSrc));

ok('approveJoin calls supabase.auth.getSession() to get the real access token', /supabase\.auth\.getSession\(\)/.test(approveJoinBody));
ok('approveJoin reads session?.access_token', /sessionData\?\.session\?\.access_token/.test(approveJoinBody));

ok(
  'approveJoin returns an honest auth-failure error, not undefined/null, when there is no session',
  /if \(sessionError \|\| !supabaseAccessToken\)/.test(approveJoinBody) &&
  /return \{ error: .*[Nn]ot signed in/.test(approveJoinBody)
);

ok(
  'approveJoin never silently falls back to createJoinToken as the relay auth token',
  !/negotiateMinecraftEndpoint\?\.\(request\.serverId\)\.catch/.test(approveJoinBody) &&
  !/negotiateAssettoCorsaEndpoint\?\.\(request\.serverId\)\.catch/.test(approveJoinBody)
);

ok(
  'approveJoin passes the real Supabase access token into both negotiate*Endpoint IPC calls',
  /negotiateAssettoCorsaEndpoint\?\.\(request\.serverId, supabaseAccessToken\)/.test(approveJoinBody) &&
  /negotiateMinecraftEndpoint\?\.\(request\.serverId, supabaseAccessToken\)/.test(approveJoinBody)
);

ok(
  'PresenceManager.createJoinToken() (HMAC) is still minted for the join_requests row — not removed',
  /window\.electronAPI\?\.presence\?\.createJoinToken\?\.\(request\.serverId, mercyGameId, JOIN_TOKEN_TTL_MS, endpoint\)/.test(approveJoinBody)
);

const connectBody = connectStart !== -1 ? storeSrc.slice(connectStart) : '';
ok(
  'connectToApprovedJoin (CLIENT role) is untouched — still uses request.token (the HMAC join token) for connectViaRelay, not a Supabase access token',
  /token: request\.token/.test(connectBody) && !/supabaseAccessToken/.test(connectBody)
);

console.log(`\nAPPROVE JOIN AUTH TOKEN TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
