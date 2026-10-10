// Mercy's Servers UI — (A) the view-model executed for real against genuine checker + install-plan output,
// and (B) static-source structure tests (this repo has no jsdom/React Testing Library — see
// test/library/ui-structure.test.js's header), covering navigation, server cards, results display, join
// gating, install-dialog safety wording, and that every IPC channel the renderer can call really has a
// main-process handler. NOTE: these prove structure and logic; they do not prove how the screens look —
// that is verified separately in a running browser against a fixture-backed bridge (see the final report).
const fs = require('fs'), path = require('path'), Module = require('module'), ts = require('typescript');
const F = require('./_acFixtures');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗', name); } };
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

// Load the renderer's pure view-model (TypeScript) through the same transpile-on-require hook other tests use.
function loadTs(rel) {
  const prev = Module._extensions['.ts'];
  Module._extensions['.ts'] = (mod, filename) => { mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true } }).outputText, filename); };
  try { const p = path.resolve(__dirname, '../..', rel); delete require.cache[p]; return require(p); } finally { Module._extensions['.ts'] = prev; }
}

(async () => {
  const V = loadTs('src/renderer/lib/acMercyView.ts');
  const { checkAcRequirements } = F.dist('AcRequirementsChecker.js');
  const { buildInstallPlan } = F.dist('ac/installer.js');
  const { resolveEndpoints, EMPTY_LOCAL } = F.dist('ac/endpoints.js');
  const bundle = F.fixtureBundle('http://127.0.0.1:1/pack.7z');
  bundle.sources.sources[1].localArchive = { bytes: 1000, sha256: 'a'.repeat(64) };
  const eps = resolveEndpoints(bundle.servers[0], { servers: { t2: { host: 'play.example.com', tcpPort: null, httpPort: null } } }, EMPTY_LOCAL);
  const cleanup = [];
  const install = (opts) => { const fx = F.emptyAcInstall(opts); cleanup.push(fx.base); return fx; };
  const report = (fx, o = {}) => checkAcRequirements({ acRoot: fx.ac, bundle, serverId: 't2', deep: true, documentsAcDir: fx.docs, ...o });
  const planFor = (fx, r) => buildInstallPlan({ acRoot: fx.ac, bundle, serverId: 't2', endpoints: eps, documentsAcDir: fx.docs, report: r, resolver: async () => ['203.0.113.7'], allowLoopbackHttp: true, tool: { kind: '7z', exe: 'x' } });

  // ── A. view-model ─────────────────────────────────────────────────────────
  ok('VIEW: no report → "Not checked yet" (neutral), never a fake green', V.summarizeReport(null).state === 'unchecked' && V.summarizeReport(null).tone === 'neutral');

  const empty = install(); const rEmpty = await report(empty); const pEmpty = await planFor(empty, rEmpty);
  const sEmpty = V.summarizeReport(rEmpty);
  ok('VIEW: missing content → blocked, with a count in plain words', sEmpty.state === 'blocked' && sEmpty.tone === 'bad' && /\d+ things? to fix before you can join/.test(sEmpty.headline));
  const groups = V.groupReport(rEmpty);
  ok('VIEW: results are grouped in a fixed, sensible order and empty groups are dropped', groups.map((g) => g.id).join() === 'install,csp,track,cars,companion,conflicts');
  ok('VIEW: inside a group problems come first so passing items never bury them', (() => { const c = groups.find((g) => g.id === 'cars'); const r = ['pass', 'info', 'unknown', 'warn', 'fail']; return c.items.every((it, i) => i === 0 || r.indexOf(c.items[i - 1].status) >= r.indexOf(it.status)); })());
  ok('VIEW: each group carries accurate counts and a worst-status for its header dot', (() => { const c = groups.find((g) => g.id === 'cars'); return c.counts.fail === 3 && c.worst === 'fail'; })());

  const act = (id, r = rEmpty, p = pEmpty) => V.itemAction(r.sections[Object.keys(r.sections).find((k) => r.sections[k].some((i) => i.id === id))].find((i) => i.id === id), p);
  ok('ACTION: a missing car from a live source → the launcher can install it', act('car:car_a').kind === 'auto' && act('car:car_a').label === 'Install' && act('car:car_a').planItemIds.includes('car:car_a'));
  ok('ACTION: a missing BASE-GAME car → "do this yourself" with the Steam verify steps, never an install button', act('car:base_car').kind === 'manual' && /Verify integrity/.test((act('car:base_car').steps || []).join(' ')));
  ok('ACTION: the SRP track (no live download) → "choose the downloaded archive"', act('track').kind === 'needs-file' && /archive/.test(act('track').label));
  ok('ACTION: the optional SRP Board → installable', act('app:srp_board').kind === 'auto');

  const noCsp = install({ csp: false }); const rNoCsp = await report(noCsp); const pNoCsp = await planFor(noCsp, rNoCsp);
  const cspAct = act('csp-installed', rNoCsp, pNoCsp);
  ok('ACTION: Custom Shaders Patch problems are ALWAYS "yours" — the UI never offers to install or update CSP', cspAct.kind === 'yours' && /never installs or updates Custom Shaders Patch/.test(cspAct.steps.join(' ')) && act('csp-installed', rNoCsp, null).kind === 'yours');
  ok('ACTION: no AC install → "install the game / set its folder", nothing automatic', V.itemAction({ id: 'ac-install', label: 'x', status: 'fail', detail: 'x' }, null).kind === 'yours');

  const mixed = install({ hud: true });
  F.writeCar(path.join(mixed.ac, 'content', 'cars'), 'car_a', { acd: 'WRONG' });
  F.writeCar(path.join(mixed.ac, 'content', 'cars'), 'car_b', { ui: JSON.stringify({ version: '0.1' }), skins: [] });
  const rMixed = await report(mixed); const pMixed = await planFor(mixed, rMixed);
  ok('ACTION: wrong physics → "Repair"; old version → "Update"; both flagged destructive in the plan', act('car:car_a', rMixed, pMixed).label === 'Repair' && act('car:car_b', rMixed, pMixed).label === 'Update' && pMixed.items.find((i) => i.id === 'car:car_a').destructive && pMixed.items.find((i) => i.id === 'car:car_b').destructive);
  ok('ACTION: the old dev HUD → "Move aside" (a backup, not a delete)', act('conflict-srp-hud', rMixed, pMixed).label === 'Move aside');
  ok('ACTION: passing and informational lines have no button', V.itemAction({ id: 'car:x', label: 'x', status: 'pass', detail: '' }, pMixed).kind === 'none' && V.itemAction({ id: 'x', label: 'x', status: 'info', detail: '' }, pMixed).kind === 'none');

  const choices = V.planChoices(pEmpty);
  ok('PLAN VIEW: items are split into automatic / needs-a-file / do-it-yourself with nothing in two places', choices.auto.some((i) => i.id === 'car:car_a') && choices.needsFile.map((i) => i.id).join() === 'track' && choices.manual.map((i) => i.id).includes('car:base_car') && !choices.auto.some((i) => i.id === 'track' || i.id === 'car:base_car'));
  const defaults = V.defaultApproved(pMixed);
  ok('APPROVALS: only required, non-destructive, automatic items start ticked — repairs, replacements and optional apps need a deliberate tick', !defaults.includes('car:car_a') && !defaults.includes('car:car_b') && !defaults.includes('conflict:srp_hud') && !defaults.includes('companion:srp_board'));
  ok('APPROVALS: a plain missing car IS pre-ticked, a blocked item never is', V.defaultApproved(pEmpty).includes('car:car_a') && !V.defaultApproved(pEmpty).includes('track'));
  ok('FORMAT: byte sizes read naturally (4.8 GB / 120 MB) and unknown is honest', V.formatBytes(4811088129) === '4.8 GB' && V.formatBytes(120e6) === '120 MB' && V.formatBytes(null) === 'unknown size');
  ok('FORMAT: the download total counts only archives needed by ticked items', V.totalDownloadBytes(pEmpty, ['car:car_a']) === 1000 && V.totalDownloadBytes(pEmpty, ['track']) === 0 && V.totalDownloadBytes(pEmpty, []) === 0);

  const readyFx = install();
  F.writeCar(path.join(readyFx.ac, 'content', 'cars'), 'car_a'); F.writeCar(path.join(readyFx.ac, 'content', 'cars'), 'car_b'); F.w(path.join(readyFx.ac, 'content', 'cars', 'base_car', 'ui', 'ui_car.json'), '{}'); F.writeTrack(path.join(readyFx.ac, 'content', 'tracks', 'test_track'));
  const rReady = await report(readyFx);
  ok('VIEW: everything installed but the optional SRP Board → "Ready to join · 1 suggestion" (warn tone), not a blocker', V.summarizeReport(rReady).state === 'suggestions' && /Ready to join · 1 suggestion$/.test(V.summarizeReport(rReady).headline));
  const noLog = install(); fs.rmSync(path.join(noLog.docs, 'logs'), { recursive: true });
  F.writeCar(path.join(noLog.ac, 'content', 'cars'), 'car_a'); F.writeCar(path.join(noLog.ac, 'content', 'cars'), 'car_b'); F.w(path.join(noLog.ac, 'content', 'cars', 'base_car', 'ui', 'ui_car.json'), '{}'); F.writeTrack(path.join(noLog.ac, 'content', 'tracks', 'test_track'));
  ok('VIEW: an undeterminable CSP version → "Some checks could not be completed" (never silently green)', V.summarizeReport(await report(noLog)).state === 'incomplete');
  fs.mkdirSync(path.join(readyFx.ac, 'apps', 'lua', 'srp_board'), { recursive: true });

  ok('STATUS CHIP: online shows real player numbers; offline shows "Not reachable"; unconfigured shows "Status unknown" — each with the reason as its tooltip', V.liveStatusChip({ state: 'online', players: 5, maxPlayers: 32, reason: 'r' }).label === 'Online · 5/32' && V.liveStatusChip({ state: 'offline', reason: 'refused' }).label === 'Not reachable' && V.liveStatusChip({ state: 'unconfigured', reason: 'PUBLIC_HOST_TBD' }).label === 'Status unknown' && V.liveStatusChip({ state: 'unconfigured', reason: 'PUBLIC_HOST_TBD' }).title === 'PUBLIC_HOST_TBD' && V.liveStatusChip(null).label === 'Checking status…');
  const goodJoin = { canJoin: true, blockers: [], via: 'public', port: 9650, reason: 'Using the public address.', unverified: true };
  ok('JOIN BUTTON: enabled only with a report AND a green join status AND nothing running', V.joinButton(goodJoin, rReady, false).enabled && !V.joinButton(goodJoin, null, false).enabled && !V.joinButton(null, rReady, false).enabled && !V.joinButton(goodJoin, rReady, true).enabled);
  ok('JOIN BUTTON: when blocked it says why, using the first blocker', V.joinButton({ ...goodJoin, canJoin: false, blockers: ['Fixture Car B: Not installed.'] }, rReady, false).why === 'Fixture Car B: Not installed.');

  // ── B. structure ──────────────────────────────────────────────────────────
  const app = read('src/renderer/App.tsx'), mercy = read('src/renderer/pages/MercyServers.tsx'), nav = read('src/renderer/components/AcSectionNav.tsx');
  const hub = read('src/renderer/pages/AssettoCorsaHub.tsx'), card = read('src/renderer/components/ac/AcServerCard.tsx'), modal = read('src/renderer/components/ac/AcInstallModal.tsx');
  const setup = read('src/renderer/pages/AssettoCorsaSetup.tsx'), mpage = read('src/renderer/pages/AssettoCorsaMercyServers.tsx'), title = read('src/renderer/components/TitleBar.tsx');

  ok('NAV: three tabs — My Servers, Mercy\'s Servers, Setup & Diagnostics — with the right routes', /label: 'My Servers'[\s\S]{0,80}path: '\/assetto-corsa'/.test(nav) && /label: "Mercy's Servers"[\s\S]{0,80}path: '\/mercy-servers\/assettocorsa'/.test(nav) && /label: 'Setup & Diagnostics'[\s\S]{0,80}path: '\/assetto-corsa\/setup'/.test(nav));
  ok('NAV: "My Servers" stays highlighted on create / content / server-panel pages but not on setup', /startsWith\('\/assetto-corsa'\) && !p\.startsWith\('\/assetto-corsa\/setup'\)/.test(nav));
  ok('NAV: the shared strip is on every Assetto Corsa page (hub, create, content library, server panel, Mercy\'s Servers, setup)', ['AssettoCorsaHub', 'AssettoCorsaServerWizard', 'AssettoCorsaContent', 'AssettoCorsaServerPanel', 'AssettoCorsaMercyServers', 'AssettoCorsaSetup'].every((n) => /<AcSectionNav \/>/.test(read(`src/renderer/pages/${n}.tsx`))));
  ok('ROUTES: the setup page is registered; the existing AC routes are all still there', /path="\/assetto-corsa\/setup" element=\{<AssettoCorsaSetup \/>\}/.test(app) && ['/assetto-corsa"', '/assetto-corsa/create', '/assetto-corsa/server/:id', '/assetto-corsa/content', '/mercy-servers/:game'].every((r) => app.includes(`path="${r.replace(/"$/, '')}`)));
  ok('MERCY PAGE: only Assetto Corsa gets the new experience; every other game keeps the unchanged "Coming Soon" page', /game === 'assettocorsa' \? <AssettoCorsaMercyServers \/> : <GenericMercyServers \/>/.test(mercy) && /Coming Soon/.test(mercy) && /function GenericMercyServers/.test(mercy));
  ok('MY vs MERCY\'S: the hub says its servers are ones YOU host and points to Mercy\'s Servers; the Mercy page says they are Mercy\'s own and points back', /My Servers are servers you host yourself/.test(hub) && /Servers You Host/.test(hub) && /These are Mercy's own servers/.test(mpage) && /My Servers/.test(mpage));
  ok('MY vs MERCY\'S: each official server card carries an "Official · Mercy" badge', /Official · Mercy/.test(card));
  ok('HUB: the existing hosting tools are all still reachable (create, content library, import, server list, server panel route)', ['/assetto-corsa/create', '/assetto-corsa/content', 'Import Server', '/assetto-corsa/server/${s.id}'].every((s) => hub.includes(s)));
  ok('HUB: the wording earlier tests pin (Content Manager subtitle) is unchanged', /subtitle="Create and manage your Assetto Corsa dedicated servers — launched through Content Manager"/.test(hub) && /tagline: 'Manage your Assetto Corsa servers, launched through Content Manager\.'/.test(read('src/renderer/config/games.ts')));
  ok('TITLE BAR: Assetto Corsa pages no longer say "Coming soon" and have page-specific subtitles', !/assetto-corsa'\), title: 'Assetto Corsa', subtitle: 'Coming soon'/.test(title) && /subtitle: 'Setup & Diagnostics'/.test(title) && /subtitle: 'My Servers'/.test(title));
  ok('CARD: shows name, purpose, required content, live status, a Check requirements button and a Join Server button', /profile\.name/.test(card) && /profile\.purpose/.test(card) && /profile\.requiredContent\.map/.test(card) && /liveStatusChip\(status\)/.test(card) && /Check requirements/.test(card) && /jb\.label/.test(card));
  ok('CARD: requirements are checked automatically on load, and EVERY card re-checks when any install finishes (an install for one server can change what another needs)', /useEffect\(\(\) => \{ check\(\); loadStatus\(\); \}/.test(card) && /onFinished=\{\(\) => window\.dispatchEvent\(new Event\(CONTENT_CHANGED_EVENT\)\)\}/.test(card) && /addEventListener\(CONTENT_CHANGED_EVENT, onChanged\)/.test(card) && /removeEventListener\(CONTENT_CHANGED_EVENT, onChanged\)/.test(card));
  ok('CARD: Join is disabled with its reason unless the view-model says it is enabled, and the "not verified" caveat is shown', /disabled=\{!jb\.enabled\}/.test(card) && /title=\{jb\.why\}/.test(card) && /has not been verified by Mercy Launcher/.test(card));
  ok('CARD: with no public endpoint it shows the honest amber notice and links to Setup (no invented address)', /No public address is configured for this server yet/.test(card) && /onOpenSetup/.test(card));
  ok('RESULTS: each problem line offers an action (auto install / choose file / how-to) and CSP is explained as the player\'s own job', /itemAction\(item, plan\)/.test(read('src/renderer/components/ac/AcRequirementsPanel.tsx')) && /Install \/ update Custom Shaders Patch yourself/.test(read('src/renderer/lib/acMercyView.ts')));
  ok('INSTALL DIALOG: nothing runs on open — installSrpContent is called only from the button handler, never from an effect', (modal.match(/installSrpContent/g) || []).length === 1 && /const go = async \(\) =>/.test(modal) && !/useEffect\([^)]*installSrpContent/.test(modal));
  ok('INSTALL DIALOG: says "Nothing happens until you press Install", marks replacements as backup-kept, and explains CSP is never installed for you', /Nothing happens until you press Install/.test(modal) && /replaces existing · backup kept/.test(modal) && /Custom Shaders Patch is yours to manage/.test(modal));
  ok('INSTALL DIALOG: shows what will be downloaded (size + host + verification), supports the player\'s own archive, lets them cancel, and can show the backup', /verified before anything is installed/.test(modal) && /pickSrpArchive/.test(modal) && /cancelSrpInstall/.test(modal) && /revealSrpBackup/.test(modal) && /previous state restored/.test(modal));
  ok('TRACK UI: a chosen archive is validated read-only FIRST and can only be approved if every check passed — the track is never ticked before that', /validateSrpTrackArchive\(f(, [^)]*)?\)/.test(modal) && /if \(v\.ok\) \{ setTrackFile\(f\); setApproved\(\(s\) => new Set\(s\)\.add\('track'\)\); \}/.test(modal) && !/setTrackFile\(f\); setApproved\(\(s\) => new Set\(s\)\.add\('track'\)\); \}\s*\n\s*};\s*\n\s*const choosePack/.test(modal));
  ok('TRACK UI: shows the verdict with a reason for each check, tells the player where to get the file legitimately, and says the launcher never downloads/hosts it', /data-testid="track-validation"/.test(modal) && /trackCheck\.checks\.map/.test(modal) && /Shutoko Revival Project's own channels/.test(modal) && /never downloads, hosts or substitutes/.test(modal) && /byte-for-byte the same as the copy the servers were built from/.test(modal));
  ok('SETUP: has "Test public endpoint" / "Test LAN endpoint" with per-check results, and an honest "not configured" message when nothing is set', /Test public endpoint/.test(setup) && /Test LAN endpoint/.test(setup) && /testSrpEndpoint\(profile\.id, scope\)/.test(setup) && /data-testid=\{`endpoint-test-\$\{scope\}`\}/.test(setup) && /tests\[scope\]!\.message/.test(setup));
  ok('SETUP: a Storage panel shows the downloaded archive and each backup (newest first) with delete buttons, and unfinished installs\' backups cannot be deleted', /Storage used by the installer/.test(setup) && /deleteSrpDownloads\(\)/.test(setup) && /deleteSrpBackup\(b\.id\)/.test(setup) && /disabled=\{!!busy \|\| b\.inProgress\}/.test(setup) && /<StoragePanel onChanged=\{load\} \/>/.test(setup));
  ok('SETUP: states that a passing test is not proof a remote player can join', /That is not proof a remote player can join/.test(setup));
  ok('SETUP: shows whether the installed SRP Board stamp matches the saved endpoints and tells the player how to fix a mismatch', /Stamp vs\. endpoints/.test(setup) && /NOT in the stamp/.test(setup) && /Reinstall the SRP Board/.test(setup));
  ok('INSTALL DIALOG: cannot be dismissed by clicking away while installing', /onClick=\{\(\) => stage !== 'running' && onClose\(\)\}/.test(modal));
  ok('SETUP: shows game path + source, CSP version, Content Manager, archive tool, content verification, companion app, endpoints and troubleshooting', ['Assetto Corsa folder', 'Custom Shaders Patch', 'Content Manager', 'Archive tool', 'Content verification', 'Companion app &amp; HUD', 'Connection endpoints', 'Troubleshooting'].every((s) => setup.includes(s)));
  ok('SETUP (privacy): the LAN field is labelled "this PC only", says it is never in the app/release/log, and public connectivity is stated as untested', /LAN address — this PC only/.test(setup) && /never in the app, a release, a log, or sent anywhere/.test(setup) && /not been tested/.test(setup) && /PUBLIC_HOST_TBD/.test(setup));
  ok('SETUP: troubleshooting output is labelled as address-free and can be copied', /safe to paste into a support message/.test(setup) && /Copy diagnostics/.test(setup));

  // every renderer-callable channel is handled in main; preload ↔ types ↔ main agree
  const preload = read('src/main/preload.ts'), mainTs = read('src/main/main.ts'), types = read('src/renderer/types/electron.d.ts');
  const chans = [...preload.matchAll(/ipcRenderer\.invoke\('(assettocorsa:srp:[A-Za-z]+)'/g)].map((m) => m[1]);
  ok('IPC: the preload exposes the full set of SRP channels (at least 18, including track validation and endpoint testing)', chans.length >= 18 && new Set(chans).size === chans.length && chans.includes('assettocorsa:srp:validateTrackArchive') && chans.includes('assettocorsa:srp:testEndpoint'));
  ok('IPC: EVERY preload channel has a matching ipcMain handler (no dead buttons)', chans.every((c) => mainTs.includes(`ipcMain.handle('${c}'`)));
  const names = [...preload.matchAll(/^\s{4}([A-Za-z]+): .*ipcRenderer\.invoke\('assettocorsa:srp:/gm)].map((m) => m[1]);
  ok('IPC: every preload method is declared in the renderer\'s electron.d.ts', names.length >= 18 && names.every((n) => new RegExp(`\\b${n}:`).test(types)));
  ok('IPC: the dialog handlers only return a chosen path, and backup reveal is restricted to the game\'s .mercy-backups folder', /\.mercy-backups'\) \+ path\.sep/.test(mainTs) && /startsWith\(allowed\)/.test(mainTs));
  ok('MAIN: no handler ever starts/stops/restarts a game server for the player side (the SRP block calls only the player service)', (() => { const block = mainTs.slice(mainTs.indexOf("assettocorsa:srp:listServers"), mainTs.indexOf("// Game Library")); return !/assettoCorsaManager\.(start|stop|restart)/.test(block) && /acPlayerService/.test(block); })());

  for (const d of cleanup) F.rm(d);
  console.log(`\nAC MERCY'S SERVERS UI TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
