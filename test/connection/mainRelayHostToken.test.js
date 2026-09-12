// Verifies main.ts's two relay-registration IPC handlers use the caller's
// real Supabase access token as the HOST-role relay session token, never
// PresenceManager.createJoinToken()'s HMAC join token (that token authorizes
// one approved join_requests row for the CLIENT role — a separate credential
// — see docs/backend-architecture.md §3/§4 on the Linux relay and
// signaling/auth.js's verifyHostToken, which now verifies role:'host' hellos
// against a real Supabase session via supabase.auth.getUser()).
//
// main.ts isn't unit-testable in isolation (it wires the whole Electron app
// at import time — no BrowserWindow/app mocking exists in this repo, see
// test/library/ui-structure.test.js's own header for why source-text
// assertions are this codebase's established fallback for exactly this
// situation). RelayConnectionManager/ConnectionNegotiator's actual behavior
// once given a token is already fully covered by
// relayConnectionManager.test.js / connectionNegotiator.test.js and is
// unchanged by this fix.
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const mainSrc = fs.readFileSync(path.resolve(__dirname, '../../src/main/main.ts'), 'utf-8');

function handlerBody(ipcName) {
  const start = mainSrc.indexOf(`ipcMain.handle('${ipcName}'`);
  if (start === -1) return null;
  // Grab a generous slice — enough to contain the whole handler body without
  // needing a real brace parser for a text-based check.
  return mainSrc.slice(start, start + 2000);
}

const mcHandler = handlerBody('connection:negotiateMinecraftEndpoint');
const acHandler = handlerBody('connection:negotiateAssettoCorsaEndpoint');
const relayHandler = handlerBody('connection:connectViaRelay');
const joinTokenHandler = handlerBody('presence:createJoinToken');

ok('negotiateMinecraftEndpoint handler exists', !!mcHandler);
ok('negotiateAssettoCorsaEndpoint handler exists', !!acHandler);

ok('negotiateMinecraftEndpoint accepts a supabaseAccessToken parameter', /supabaseAccessToken\??:\s*string/.test(mcHandler || ''));
ok('negotiateAssettoCorsaEndpoint accepts a supabaseAccessToken parameter', /supabaseAccessToken\??:\s*string/.test(acHandler || ''));

ok(
  'negotiateMinecraftEndpoint uses supabaseAccessToken as the relay sessionToken, not createJoinToken',
  /sessionToken:\s*supabaseAccessToken/.test(mcHandler || '') && !/sessionToken:\s*presenceManager\.createJoinToken/.test(mcHandler || '')
);
ok(
  'negotiateAssettoCorsaEndpoint uses supabaseAccessToken for ensureHostRegistered, not createJoinToken',
  /const sessionToken = supabaseAccessToken/.test(acHandler || '') && !/presenceManager\.createJoinToken/.test(acHandler || '')
);

ok('negotiateMinecraftEndpoint never registers a relay attempt without a real token', /relayConnectionManager\.isConfigured\(\) && supabaseAccessToken/.test(mcHandler || ''));
ok('negotiateAssettoCorsaEndpoint fails honestly (no relay attempt) when the token is missing', /if \(!supabaseAccessToken\)/.test(acHandler || ''));

ok(
  'PresenceManager.createJoinToken() is still exposed for its real purpose (join_requests.token) — not removed',
  !!joinTokenHandler && /presenceManager\.createJoinToken\(serverId, mercyGameId, ttlMs, endpoint\)/.test(joinTokenHandler)
);

ok(
  'connectViaRelay (CLIENT role) is untouched — still forwards args.token as-is (the HMAC join token), no Supabase token threaded in',
  !!relayHandler && /relayConnectionManager\.connectViaRelay\(args\.joinRequestId, args\.relayId, args\.token, args\.transport, args\.listenPort\)/.test(relayHandler)
);

console.log(`\nMAIN RELAY HOST TOKEN TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
