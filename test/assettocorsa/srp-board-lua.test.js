// Executes the REAL shipped srp_board.lua (the embedded template, stamped by the launcher's own stamping code) under
// a real Lua interpreter, inside a mock of the CSP API. This proves the server-matching / fail-closed / restore LOGIC
// for specific address strings.
//
// What it does NOT prove: what ac.getServerIP() actually returns inside Assetto Corsa for a hostname, public-IP,
// hairpin or IPv6 join — that has never been observed (see the owner's package, OPEN_ISSUES.md) and still needs the
// real in-game test. Lua 5.4 here is also not the LuaJIT build CSP embeds. Skipped (never faked) if no Lua exists.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const F = require('./_acFixtures');
const ep = F.dist('ac/endpoints.js');

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗', name); } };

function findLua() {
  const cands = [process.env.MERCY_LUA, path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Lua', 'bin', 'lua.exe')].filter(Boolean);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) for (const n of ['lua.exe', 'lua', 'lua5.4', 'luajit']) cands.push(path.join(dir, n));
  for (const c of cands) { try { if (fs.statSync(c).isFile()) { const r = spawnSync(c, ['-v'], { encoding: 'utf8' }); if (r.status === 0 || /Lua/.test(r.stdout + r.stderr)) return c; } } catch {} }
  return null;
}

const luaStr = (s) => JSON.stringify(s);
const DRIVER = (files, scenarios) => `
local results = {}
local function run(name, file, o)
  local board = { displayMode = o.mode or 3, verticalLayout = false }
  local logs, storage, cur = {}, {}, { ip = o.ip, port = o.port }
  if o.marker then storage['srp_board_restore_v1'] = o.marker end
  ac = {
    log = function(m) logs[#logs + 1] = m end,
    getServerIP = function() if o.ipError then error('mock: unreadable') end return cur.ip end,
    getServerPortTCP = function() return cur.port end,
    storage = storage, onRelease = function() end,
  }
  if not o.noApi then ac.accessOverlayLeaderboardParams = function() return board end end
  script = {}; ui = { text = function() end }
  dofile(file)
  script.update(1)
  local step1 = { mode = board.displayMode, gate = script.__srpBoardState().inGate }
  local step2
  if o.then_ip ~= nil or o.then_port ~= nil then cur.ip = o.then_ip; cur.port = o.then_port or cur.port; script.update(1); step2 = { mode = board.displayMode, gate = script.__srpBoardState().inGate } end
  local joined = table.concat(logs, ' || ')
  print(table.concat({ 'SCEN', name, tostring(step1.mode), tostring(step1.gate), step2 and tostring(step2.mode) or '-', step2 and tostring(step2.gate) or '-', joined }, '\\t'))
end
${scenarios.map((s) => `run(${luaStr(s.name)}, ${luaStr(files[s.file])}, { ip = ${s.ip === undefined ? 'nil' : luaStr(s.ip)}, port = ${s.port ?? 'nil'}, mode = ${s.mode ?? 3}, ipError = ${!!s.ipError}, noApi = ${!!s.noApi}, marker = ${s.marker ? luaStr(s.marker) : 'nil'}, then_ip = ${s.then_ip === undefined ? 'nil' : luaStr(s.then_ip)}, then_port = ${s.then_port ?? 'nil'} })`).join('\n')}
`;

(async () => {
  const lua = findLua();
  if (!lua) { skipped++; console.log('  - SKIPPED: no Lua interpreter found (set MERCY_LUA to run the SRP Board logic tests)'); console.log(`\nSRP BOARD LUA LOGIC TESTS: ${pass} passed, ${fail} failed, ${skipped} skipped`); process.exit(0); }

  const work = F.mkTmp('mercy-lua-');
  const PUB = 'play.example.com', PUBIP = '203.0.113.7', LAN = '192.168.77.5';
  const ownerEntries = [`${PUB}:9650`, `${PUBIP}:9650`, `${LAN}:9650`], playerEntries = [`${PUB}:9650`, `${PUBIP}:9650`];
  const write = (name, buf) => { const d = path.join(work, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'srp_board.lua'), buf); return path.join(d, 'srp_board.lua').replace(/\\/g, '/'); };
  const files = {
    owner: write('owner', ep.buildSrpBoardFiles(ownerEntries)['srp_board.lua']),
    player: write('player', ep.buildSrpBoardFiles(playerEntries)['srp_board.lua']),
    template: write('template', Buffer.from(F.dist('ac/srpBoardTemplate.js').SRP_BOARD_TEMPLATE_B64['srp_board.lua'], 'base64')),
  };
  const S = [
    { name: 'owner:hostname', file: 'owner', ip: PUB, port: 9650 },
    { name: 'owner:public-ip', file: 'owner', ip: PUBIP, port: 9650 },
    { name: 'owner:LAN', file: 'owner', ip: LAN, port: 9650 },
    { name: 'owner:UPPERCASE-host', file: 'owner', ip: PUB.toUpperCase(), port: 9650 },
    { name: 'owner:wrong-port', file: 'owner', ip: PUB, port: 9600 },
    { name: 'owner:unknown-host', file: 'owner', ip: '10.0.0.9', port: 9650 },
    { name: 'player:LAN-not-in-stamp', file: 'player', ip: LAN, port: 9650 },
    { name: 'player:public', file: 'player', ip: PUB, port: 9650 },
    { name: 'owner:unreadable-ip', file: 'owner', ipError: true, port: 9650 },
    { name: 'owner:nil-ip', file: 'owner', port: 9650 },
    { name: 'template:inert', file: 'template', ip: PUB, port: 9650 },
    { name: 'owner:restore-on-leave', file: 'owner', ip: PUB, port: 9650, then_ip: '10.0.0.9' },
    { name: 'owner:other-server-after', file: 'owner', ip: '10.0.0.9', port: 9650, then_ip: PUB },
    { name: 'owner:crash-marker-restore', file: 'owner', ip: '10.0.0.9', port: 9650, mode: 0, marker: '3|1' },
    { name: 'owner:api-missing', file: 'owner', ip: PUB, port: 9650, noApi: true },
    { name: 'owner:ipv6-mapped-form', file: 'owner', ip: `::ffff:${PUBIP}`, port: 9650 },
  ];
  const drv = path.join(work, 'driver.lua'); fs.writeFileSync(drv, DRIVER(files, S));
  const r = spawnSync(lua, [drv], { encoding: 'utf8', timeout: 30000 });
  ok('the Lua harness itself ran cleanly under a real Lua interpreter', r.status === 0 && !r.stderr);
  if (r.status !== 0) console.log('     lua stderr:', r.stderr.slice(0, 300));
  const out = {}; for (const line of r.stdout.split(/\r?\n/)) { const p = line.split('\t'); if (p[0] === 'SCEN') out[p[1]] = { mode: p[2], gate: p[3] === 'true', mode2: p[4], gate2: p[5] === 'true', logs: p[6] || '' }; }

  ok('MATCH: the public host name (as stamped) opens the gate and hides the F9 strip (mode 3 → 0)', out['owner:hostname'].gate && out['owner:hostname'].mode === '0');
  ok('MATCH: the resolved public IP (as stamped) also matches', out['owner:public-ip'].gate && out['owner:public-ip'].mode === '0');
  ok('MATCH: the owner\'s LAN entry matches on the owner\'s stamp', out['owner:LAN'].gate && out['owner:LAN'].mode === '0');
  ok('MATCH: comparison is case-insensitive (a host reported in capitals still matches)', out['owner:UPPERCASE-host'].gate && out['owner:UPPERCASE-host'].mode === '0');
  ok('FAIL CLOSED: the right host on the WRONG port never matches (two servers share a machine) and the player\'s setting is untouched', !out['owner:wrong-port'].gate && out['owner:wrong-port'].mode === '3');
  ok('FAIL CLOSED: an unrelated server never matches; the strip is untouched', !out['owner:unknown-host'].gate && out['owner:unknown-host'].mode === '3');
  ok('PRIVACY BY DESIGN: a remote player\'s stamp (no LAN entry) does NOT match the owner\'s LAN address', !out['player:LAN-not-in-stamp'].gate && out['player:LAN-not-in-stamp'].mode === '3');
  ok('MATCH: a remote player\'s stamp matches the public address', out['player:public'].gate && out['player:public'].mode === '0');
  ok('FAIL CLOSED: an unreadable server address (the API raises) leaves everything alone and does not crash', !out['owner:unreadable-ip'].gate && out['owner:unreadable-ip'].mode === '3');
  ok('FAIL CLOSED: a missing server address leaves everything alone', !out['owner:nil-ip'].gate && out['owner:nil-ip'].mode === '3');
  ok('INERT: the unstamped template matches nothing, even a "correct" address', !out['template:inert'].gate && out['template:inert'].mode === '3' && /\(none - inert\)/.test(out['template:inert'].logs));
  ok('RESTORE: leaving the server puts the player\'s own display mode back (0 → 3) and logs it', out['owner:restore-on-leave'].mode === '0' && out['owner:restore-on-leave'].mode2 === '3' && !out['owner:restore-on-leave'].gate2 && /restored to mode 3/.test(out['owner:restore-on-leave'].logs));
  ok('MATCH: it engages when the player later moves onto a stamped server', out['owner:other-server-after'].mode === '3' && out['owner:other-server-after'].mode2 === '0' && out['owner:other-server-after'].gate2);
  ok('CRASH RECOVERY: a restore marker left by a crashed session is applied at the next start (strip comes back)', out['owner:crash-marker-restore'].mode === '3' && /crash recovery/.test(out['owner:crash-marker-restore'].logs));
  ok('API MISSING: on a CSP without the accessor it logs that and leaves the strip alone instead of erroring', out['owner:api-missing'].mode === '3' && /does not exist in this CSP/.test(out['owner:api-missing'].logs));
  ok('KNOWN LIMITATION (documented, not a pass for the real game): an IPv6-mapped form of the same address does NOT match — only exact host:port strings do, so the launcher stamps both the name and its IPv4 addresses', !out['owner:ipv6-mapped-form'].gate);
  const stamped = fs.readFileSync(files.owner.replace(/\//g, path.sep), 'latin1');
  ok('the stamped file differs from the template only in its SERVERS line', stamped.replace(/^local SERVERS = \{.*\}/m, 'local SERVERS = { }') === fs.readFileSync(files.template.replace(/\//g, path.sep), 'latin1'));

  F.rm(work);
  console.log(`\nSRP BOARD LUA LOGIC TESTS (real Lua ${(spawnSync(lua, ['-v'], { encoding: 'utf8' }).stdout || '').trim().split(' ').slice(0, 2).join(' ')}, mock CSP): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
