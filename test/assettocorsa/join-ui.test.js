// The compact Mercy's Servers browser: the view-model executed for real (states, row facts, join button, outcomes), and
// static-source structure checks for the page and row (this repo has no jsdom / React Testing Library). These prove logic
// and structure; how the screen LOOKS is verified separately in a running browser.
const fs = require('fs'), path = require('path'), Module = require('module'), ts = require('typescript');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
function loadTs(rel) {
  const prev = Module._extensions['.ts'];
  Module._extensions['.ts'] = (mod, filename) => { mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true } }).outputText, filename); };
  try { const p = path.resolve(__dirname, '../..', rel); delete require.cache[p]; return require(p); } finally { Module._extensions['.ts'] = prev; }
}
const J = loadTs('src/renderer/lib/acJoinView.ts');

const profile = (o = {}) => ({ id: 'main', name: 'SRP Daishi PA', engine: 'kunos-stock', purpose: '', layoutName: 'Shutoko Revival Project 0.9.3 - Daishi PA', trackVersion: '0.9.3', maxPlayers: 14, aiTraffic: 0, requiredContent: [], hud: { delivered: false, version: '0' }, companionApp: false, endpoint: { publicConfigured: false, publicSource: 'none', lanConfigured: false, problems: [] }, ...o });
const traffic = profile({ id: 'server2', name: 'SRP Traffic', engine: 'assettoserver', maxPlayers: 32, aiTraffic: 138, layoutName: 'Shutoko Revival Project 0.9.3 - Main Layout' });
const check = (state, o = {}) => ({ serverId: 'main', state, headline: '', checkedAt: 'x', connection: { configured: true, scope: 'lan', infoOnline: true, identity: 'match', gamePortTcp: 'open', players: 2, maxPlayers: 14, reason: '' }, issues: [], missing: [], canJoin: state === 'ready', unverified: true, canAdoptHost: false, ...o });
const issue = (id, kind, o = {}) => ({ id, kind, severity: 'blocker', title: id + ' title', detail: id + ' detail. More.', ...o });

// ── states ─────────────────────────────────────────────────────────────────────
ok('states: exactly Ready to Join / Missing Content / Connection Unavailable, plus a neutral Checking while loading', J.ROW_STATE_VIEW.ready.label === 'Ready to Join' && J.ROW_STATE_VIEW.missing.label === 'Missing Content' && J.ROW_STATE_VIEW.unavailable.label === 'Connection Unavailable' && J.ROW_STATE_VIEW.checking.tone === 'neutral');
ok('states: tones — ready good, missing warning, unavailable bad', J.ROW_STATE_VIEW.ready.tone === 'good' && J.ROW_STATE_VIEW.missing.tone === 'warn' && J.ROW_STATE_VIEW.unavailable.tone === 'bad');
ok('states: no check yet → checking (never ready by default)', J.rowState(null) === 'checking' && J.rowState(check('ready')) === 'ready' && J.rowState(check('unavailable')) === 'unavailable');

// ── the two SRP servers are easy to tell apart ──────────────────────────────────
ok('distinguish: the AI-traffic server has a different accent and icon class from the stock one', J.accentOf(profile()) === 'sky' && J.accentOf(traffic) === 'amber' && J.ACCENT_CLASSES.sky.bar !== J.ACCENT_CLASSES.amber.bar);
const f1 = J.rowFacts(profile(), null, null), f2 = J.rowFacts(traffic, null, null);
ok('facts: name, track/layout, server type, slots and AI traffic come from the profile', f1.name === 'SRP Daishi PA' && f1.trackLine === 'Shutoko Revival Project · Daishi PA' && f1.typeLabel === 'Standard server' && f1.slots === '14 slots' && f1.ai === 'No AI traffic' && f2.name === 'SRP Traffic' && f2.typeLabel === 'AssettoServer' && f2.slots === '32 slots' && f2.ai === '138 AI traffic' && f2.trackLine === 'Shutoko Revival Project · Main Layout');
ok('facts: the player count is shown ONLY when the server really answered (never invented)', f1.players === null && J.rowFacts(profile(), { state: 'offline', reason: 'x' }, check('unavailable', { connection: { configured: true, scope: 'lan', infoOnline: false, identity: 'unknown', gamePortTcp: 'untested', reason: '' } })).players === null);
ok('facts: with a live answer it shows "players/slots online"', J.rowFacts(profile(), { state: 'online', players: 3, maxPlayers: 14, reason: '' }, null).players === '3/14 online' && J.rowFacts(profile(), null, check('ready')).players === '2/14 online');
ok('facts: catalog servers use the catalog\'s own track name', J.rowFacts(profile({ fromCatalog: true, tracks: [{ id: 't', name: 'Hill Climb', layouts: [''] }], layoutName: 'Hill Climb' }), null, null).trackLine === 'Hill Climb');
ok('facts: a server with unknown slots / AI shows nothing rather than a guess', (() => { const f = J.rowFacts(profile({ maxPlayers: null, aiTraffic: null }), null, null); return f.slots === null && f.ai === null; })());

// ── Join button ───────────────────────────────────────────────────────────────
ok('join button: enabled ONLY for Ready and idle', J.joinButtonModel(check('ready'), 'idle').enabled === true && J.joinButtonModel(check('ready'), 'working').enabled === false && J.joinButtonModel(null, 'idle').enabled === false);
ok('join button: disabled for Missing Content and for Connection Unavailable, with the first blocker as its tooltip', (() => { const m = J.joinButtonModel(check('missing', { issues: [issue('content', 'content', { title: '2 required items are missing' })] }), 'idle'); const u = J.joinButtonModel(check('unavailable', { issues: [issue('server-offline', 'connection')] }), 'idle'); return !m.enabled && /2 required items are missing/.test(m.title) && !u.enabled && /server-offline title/.test(u.title); })());
ok('join button: shows progress while working, and "Join again" after an attempt', J.joinButtonModel(check('ready'), 'working').label === 'Joining…' && J.joinButtonModel(check('ready'), 'handed-off').label === 'Join again' && J.joinButtonModel(check('ready'), 'idle').label === 'Join Server');

// ── outcomes: honest, with retry ─────────────────────────────────────────────
const ok1 = J.joinOutcome({ success: true, stage: 'handed-off', note: 'x' });
ok('outcome: a successful hand-off says Content Manager is opening — and does NOT claim the game connected', /Opening Content Manager/.test(ok1.headline) && /cannot see whether the connection then succeeds/.test(ok1.detail) && !/connected successfully|you are connected/i.test(ok1.headline + ok1.detail) && ok1.retry === true);
const bad1 = J.joinOutcome({ success: false, stage: 'launch', error: 'Content Manager could not be opened (x).' });
ok('outcome: a failed hand-off is an error with a retry', bad1.tone === 'bad' && /could not be opened/.test(bad1.headline) && bad1.retry === true);
const bad2 = J.joinOutcome({ success: false, stage: 'blocked', error: 'The server is not answering. details' });
ok('outcome: a blocked join shows the reason and a retry', bad2.tone === 'bad' && /Not ready to join/.test(bad2.headline) && /not answering/.test(bad2.detail) && bad2.retry === true);

// ── issue lines + the one next action ────────────────────────────────────────
const mixed = check('unavailable', { issues: [issue('game-port-closed', 'connection', { fix: { kind: 'retry', label: 'Check again' } }), issue('content', 'content', { fix: { kind: 'install', label: 'Get what is missing', planItemIds: ['car:a'] } }), { id: 'track-differs', kind: 'connection', severity: 'note', title: 'note', detail: 'n' }] });
const lines = J.issueLines(mixed);
ok('issues: connection problem is bad (red), content is a warning, notes are info', lines[0].tone === 'bad' && lines[1].tone === 'warn' && lines[2].tone === 'info');
ok('next action: the first blocker, never a note', J.primaryAction(mixed).title === 'game-port-closed title' && J.primaryAction(mixed).action.kind === 'retry' && J.primaryAction(check('ready')) === null && J.primaryAction(null) === null);
ok('connection lines: plain language, and always says UDP cannot be tested from here', J.connectionLines(check('ready')).some((t) => /UDP/.test(t) && /real join/.test(t)) && !J.connectionLines(check('ready')).join(' ').match(/\d+\.\d+\.\d+\.\d+/));
ok('connection lines: no address configured', J.connectionLines(check('unavailable', { connection: { configured: false, scope: null, infoOnline: null, identity: 'unknown', gamePortTcp: 'untested', reason: '' } }))[0] === 'No server address is available.');

ok('first sentence: exactly one full stop, never a double period', J.firstSentence('Car A, Car B, and 2 more.') === 'Car A, Car B, and 2 more.' && J.firstSentence('The server is not answering. More text.') === 'The server is not answering.' && J.firstSentence('No full stop') === 'No full stop.' && J.firstSentence('Ends with dots...') === 'Ends with dots.');

// ── the slim list header ──────────────────────────────────────────────────────
const rel = (iso) => (iso ? '2 min ago' : 'never');
const S = (o) => ({ configured: true, source: 'catalog', expired: false, lastError: null, stale: false, lastSuccessAt: 'x', ...o });
ok('strip: healthy → one quiet line, no setup link', (() => { const v = J.stripView(S({}), rel); return v.tone === 'good' && /updated 2 min ago/.test(v.text) && !v.showSetup; })());
ok('strip: nothing configured → says it is the built-in list and offers to connect (the ONLY Setup link on the page)', (() => { const v = J.stripView(S({ configured: false, source: 'builtin' }), rel); return v.tone === 'neutral' && /came with this version/.test(v.text) && v.showSetup; })());
ok('strip: catalog configured but not loaded → warning that the built-in list is older', (() => { const v = J.stripView(S({ source: 'builtin', lastError: { code: 'network', message: 'x', at: 'x' } }), rel); return v.tone === 'warn' && /older built-in list/.test(v.text) && v.showSetup; })());
ok('strip: refresh failed → keeps the last list but says so; expired is red', J.stripView(S({ lastError: { code: 'http', message: 'x', at: 'x' } }), rel).tone === 'warn' && J.stripView(S({ expired: true }), rel).tone === 'bad' && J.stripView(S({ stale: true }), rel).tone === 'warn');

// ── structure ─────────────────────────────────────────────────────────────────
const page = read('src/renderer/pages/AssettoCorsaMercyServers.tsx'), row = read('src/renderer/components/ac/AcServerRow.tsx'), bar = read('src/renderer/components/ac/AcCatalogBar.tsx');
const setup = read('src/renderer/pages/AssettoCorsaSetup.tsx'), nav = read('src/renderer/components/AcSectionNav.tsx');
const strip = (s) => s.replace(/\/\/.*$/gm, '');
ok('PAGE: a compact list of rows, one per server, from the catalog/built-in profiles', /profiles\.map\(\(p\) => <AcServerRow key=\{p\.id\} profile=\{p\} \/>\)/.test(page) && /listSrpServers/.test(page));
ok('PAGE: the redundant banners are gone (no "These are Mercy\'s own servers" panel, no My Servers promo, no per-card Setup link)', !/These are Mercy's own servers/.test(page) && !/<Panel padding="sm" className="flex items-center gap-3 text-xs/.test(page) && !/onOpenSetup/.test(page + row) && !/Open Setup & Diagnostics/.test(page + row));
ok('PAGE: Setup is reachable only through the section tabs and one contextual link when the server list needs fixing', /Setup & Diagnostics/.test(nav) && (strip(page + row + bar).match(/navigate\('\/assetto-corsa\/setup'/g) || []).length === 2);
ok('PAGE: there is no My Servers tab in the strip; the hosting pages and their routes still exist (reached from the game\'s card on Home)', !/label: 'My Servers'/.test(nav) && /path="\/assetto-corsa" element=/.test(read('src/renderer/App.tsx')) && /path="\/assetto-corsa\/create"/.test(read('src/renderer/App.tsx')));
ok('ROW: exactly one Join Server button per row, status pill and live counts', (row.match(/data-testid="join-button"/g) || []).length === 1 && /data-testid="row-state"/.test(row) && /facts\.players/.test(row));
ok('ROW: Join goes through the main-process join (which re-checks everything) and shows progress, errors and a retry', /api\.srpJoin\(profile\.id\)/.test(row) && /joinOutcome\(r\)/.test(row) && /data-testid="join-outcome"/.test(row) && /Join again|joinButtonModel/.test(row) && /case|runFix/.test(row));
ok('ROW: the fix buttons map to real actions — download dialog, home-network connect, Setup, re-check', /planSrpInstall\(profile\.id\)/.test(row) && /srpAdoptCatalogHost\(\)/.test(row) && /navigate\('\/assetto-corsa\/setup'\)/.test(row) && /a\.kind === 'retry'/.test(row));
ok('ROW: a fresh check clears the message from the previous Join press (no stale "Opening Content Manager…" next to a row that is no longer ready)', /if \(!joining\.current\) \{ setOutcome\(null\); setPhase\('idle'\); \}/.test(row));
ok('ROW: the install dialog is only opened from a fix button (nothing installs on its own)', /setModal\(\{ plan: p\.plan/.test(row) && !/useEffect\([^)]*planSrpInstall/.test(row));
ok('ROW: details hold the technical lines (connection facts, exact missing items, HUD/companion) — collapsed by default', /useState\(false\)/.test(row) && /data-testid="row-details"/.test(row) && /connectionLines\(check\)/.test(row));
ok('ROW: an address is never rendered', !/\.host\b/.test(strip(row)) && !/httpPort|tcpPort/.test(strip(row)));
ok('SETUP: the full technical report and the readiness checklist moved to Setup & Diagnostics', /data-testid="full-report"/.test(setup) && /AcReadinessPanel/.test(setup) && /AcRequirementsPanel/.test(setup));
ok('no server name, id, port or track is hardcoded in the new UI files', [page, row, bar, read('src/renderer/lib/acJoinView.ts')].every((s) => !/SRP Daishi|SRP Traffic|\b9600\b|\b9650\b|shuto_revival/.test(strip(s))));
ok('the old oversized card component is gone', !fs.existsSync(path.resolve(__dirname, '../../src/renderer/components/ac/AcServerCard.tsx')));

// ── IPC: new channels exist end to end ────────────────────────────────────────
const preload = read('src/main/preload.ts'), mainTs = read('src/main/main.ts'), types = read('src/renderer/types/electron.d.ts');
ok('IPC: joinCheck and adoptCatalogHost are exposed, typed and handled in main', ['srpJoinCheck', 'srpAdoptCatalogHost'].every((n) => new RegExp(`\\b${n}:`).test(preload) && new RegExp(`\\b${n}:`).test(types)) && /ipcMain\.handle\('assettocorsa:srp:joinCheck'/.test(mainTs) && /ipcMain\.handle\('assettocorsa:srp:adoptCatalogHost'/.test(mainTs));
ok('IPC: join returns the stage (blocked / launch / handed-off) and the check', /stage: 'blocked' \| 'launch' \| 'handed-off'/.test(types) && /check: AcJoinCheck \| null/.test(types));
ok('MAIN: Content Manager\'s real registered file is read from the registry so a stale registration is caught', /contentManagerExe:/.test(mainTs) && /acmanager/.test(mainTs.split('contentManagerExe')[1].slice(0, 400)));
ok('SAFETY: no new channel can start/stop/restart a game server or touch a firewall', !/assettocorsa:srp:(joinCheck|adoptCatalogHost)'[^\n]*(startServer|stopServer|restartServer|updateServer|ufw|firewall)/i.test(mainTs));

console.log(`\nAC JOIN UI TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
