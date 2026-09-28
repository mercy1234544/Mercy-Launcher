// Verifies main.ts's relay-registration IPC handlers (Minecraft/Assetto
// Corsa's own "Connect" tab negotiation) use the caller's real Supabase
// access token as the HOST-role relay session token — never a fabricated or
// wrong credential. These handlers are unrelated to the removed Friends &
// Presence feature (they're independent per-game "how would someone connect
// to my server" info); Friends & Presence was the only caller that ever
// supplied a real token here, so the relay branch is currently unreachable
// in practice, but the logic itself stays correct and tested for whenever a
// caller supplies one again.
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
  // needing a real brace parser for a text-based check. negotiateAssettoCorsaEndpoint
  // is the largest handler here (~4KB with the real 3-way TCP+UDP+HTTP relay
  // registration) so this must stay comfortably above that.
  return mainSrc.slice(start, start + 5000);
}

const mcHandler = handlerBody('connection:negotiateMinecraftEndpoint');
const acHandler = handlerBody('connection:negotiateAssettoCorsaEndpoint');

ok('negotiateMinecraftEndpoint handler exists', !!mcHandler);
ok('negotiateAssettoCorsaEndpoint handler exists', !!acHandler);

ok('negotiateMinecraftEndpoint accepts a supabaseAccessToken parameter', /supabaseAccessToken\??:\s*string/.test(mcHandler || ''));
ok('negotiateAssettoCorsaEndpoint accepts a supabaseAccessToken parameter', /supabaseAccessToken\??:\s*string/.test(acHandler || ''));

ok(
  'negotiateMinecraftEndpoint uses supabaseAccessToken as the relay sessionToken',
  /sessionToken:\s*supabaseAccessToken/.test(mcHandler || '')
);
ok(
  'negotiateAssettoCorsaEndpoint uses supabaseAccessToken for ensureHostRegistered',
  /const sessionToken = supabaseAccessToken/.test(acHandler || '')
);

ok('negotiateMinecraftEndpoint never registers a relay attempt without a real token', /relayConnectionManager\.isConfigured\(\) && supabaseAccessToken/.test(mcHandler || ''));
ok('negotiateAssettoCorsaEndpoint fails honestly (no relay attempt) when the token is missing', /if \(!supabaseAccessToken\)/.test(acHandler || ''));

// ── Assetto Corsa needs a THIRD relay registration for the real, separate
// HTTP query port (a real AC client, Content Manager especially, queries it
// as part of a normal connection). ─────────────────────────────────────
ok(
  'negotiateAssettoCorsaEndpoint registers a THIRD relay channel for info.httpPort, not just the game-port TCP+UDP pair',
  /ensureHostRegistered\(serverId, 'assettocorsa', 'tcp', info\.httpPort, sessionToken\)/.test(acHandler || '')
);
ok(
  'the relay candidate is only offered once ALL THREE registrations (TCP, UDP, HTTP) succeed — never a half-working candidate',
  /httpReg\.success && httpReg\.relayId/.test(acHandler || '')
);
ok(
  'the returned candidate exposes relayIdHttp for the renderer to connect a third tunnel',
  /relayIdHttp:\s*httpReg\.relayId/.test(acHandler || '')
);
ok(
  'a failure on ANY of the three registrations tears down whichever succeeded, never leaking a partial relay registration',
  /if \(tcpReg\.success \|\| udpReg\.success \|\| httpReg\.success\) relayConnectionManager\.teardownHost/.test(acHandler || '')
);

console.log(`\nMAIN RELAY HOST TOKEN TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
