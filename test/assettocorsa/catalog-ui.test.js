// Server-catalog UI: (A) the pure view-model executed for real, and (B) static-source structure tests (this repo has no
// jsdom / React Testing Library — see mercy-ui.test.js). Structure and logic are proven here; how the screens LOOK is
// checked separately in a running browser.
const fs = require('fs'), path = require('path'), Module = require('module'), ts = require('typescript');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
function loadTs(rel) {
  const prev = Module._extensions['.ts'];
  Module._extensions['.ts'] = (mod, filename) => { mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true } }).outputText, filename); };
  try { const p = path.resolve(__dirname, '../..', rel); delete require.cache[p]; return require(p); } finally { Module._extensions['.ts'] = prev; }
}

const V = loadTs('src/renderer/lib/acMercyView.ts');
const NOW = Date.parse('2030-06-01T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const status = (o = {}) => ({
  configured: true, source: 'catalog', syncing: false, environment: 'production', catalogId: 'c', revision: 7, generatedAt: ago(1000), expiresAt: null, keyId: 'k1', signatureVerified: true, unsignedDev: false,
  lastSuccessAt: ago(60_000), lastAttemptAt: ago(60_000), nextAttemptAt: null, failures: 0, lastError: null, stale: false, expired: false, lastChange: null, notices: [], installsAllowed: true, installBlockedReason: null, autoInstallAllowed: false, ...o,
});

// ── relativeTime ──────────────────────────────────────────────────────────────
ok('relativeTime: never / unknown', V.relativeTime(null, NOW) === 'never' && V.relativeTime('garbage', NOW) === 'unknown');
ok('relativeTime: just now / minutes / hours / days', V.relativeTime(ago(10_000), NOW) === 'just now' && V.relativeTime(ago(5 * 60_000), NOW) === '5 min ago' && V.relativeTime(ago(3 * 3600_000), NOW) === '3 h ago' && V.relativeTime(ago(2 * 86400_000), NOW) === '2 d ago');
ok('relativeTime: a future timestamp never goes negative', V.relativeTime(new Date(NOW + 5000).toISOString(), NOW) === 'just now');

// ── catalogBar: every state tells the truth ───────────────────────────────────
ok('bar: loading', V.catalogBar(null, NOW).detail === 'Loading…' && V.catalogBar(null, NOW).canRefresh === false);
{
  const b = V.catalogBar(status({ configured: false, source: 'builtin' }), NOW);
  ok('bar: unconfigured => built-in list, no refresh button, says it will not update by itself', /Built-in/.test(b.title) && b.canRefresh === false && /will not update by itself/.test(b.detail));
}
{
  const b = V.catalogBar(status({ source: 'builtin', lastError: { code: 'network', message: 'Could not reach the catalog server (ECONNREFUSED).', at: ago(1000) } }), NOW);
  ok('bar: configured but never loaded => built-in + the reason + refresh allowed', b.tone === 'warn' && b.canRefresh && b.warnings[0].includes('ECONNREFUSED'));
}
{
  const b = V.catalogBar(status(), NOW);
  ok('bar: healthy signed production catalog', b.tone === 'good' && /revision 7/.test(b.title) && /1 min ago/.test(b.detail) && b.badges.some((x) => x.label === 'Signature verified' && x.tone === 'good') && b.warnings.length === 0);
}
{
  const b = V.catalogBar(status({ lastError: { code: 'http', message: 'The catalog server answered HTTP 503.', at: ago(1000) }, lastSuccessAt: ago(2 * 3600_000) }), NOW);
  ok('bar: failed refresh keeps the old data but says so and when it last worked', b.tone === 'warn' && /503/.test(b.warnings[0]) && /2 h ago/.test(b.warnings[0]));
}
ok('bar: stale (no recent success) warns', V.catalogBar(status({ stale: true }), NOW).tone === 'warn' && V.catalogBar(status({ stale: true }), NOW).warnings.length === 1);
{
  const b = V.catalogBar(status({ expired: true }), NOW);
  ok('bar: expired => bad, installs paused', b.tone === 'bad' && /expired/.test(b.warnings[0]) && /paused/.test(b.warnings[0]));
}
{
  const b = V.catalogBar(status({ environment: 'development', signatureVerified: false, unsignedDev: true, keyId: null }), NOW);
  ok('bar: unsigned development catalog is loudly labelled', b.badges.some((x) => x.label === 'DEVELOPMENT') && b.badges.some((x) => x.label === 'UNSIGNED' && x.tone === 'bad') && !b.badges.some((x) => x.label === 'Signature verified'));
}
ok('bar: auto-install badge only in auto mode', V.catalogBar(status(), NOW, { installMode: 'auto' }).badges.some((x) => /Auto-install/.test(x.label)) && !V.catalogBar(status(), NOW, { installMode: 'review' }).badges.some((x) => /Auto-install/.test(x.label)));
ok('bar: syncing shows progress text', V.catalogBar(status({ syncing: true }), NOW).detail === 'Refreshing…');

// ── content rows ──────────────────────────────────────────────────────────────
{
  const rows = [
    { id: 'a', kind: 'car', name: 'A', required: true, state: 'installed', detail: '' }, { id: 'b', kind: 'car', name: 'B', required: false, state: 'missing', detail: '' },
    { id: 'c', kind: 'car', name: 'C', required: true, state: 'missing', detail: '' }, { id: 'd', kind: 'car', name: 'D', required: true, state: 'incompatible', detail: '' },
    { id: 'e', kind: 'car', name: 'E', required: true, state: 'manual', detail: '' }, { id: 'f', kind: 'car', name: 'F', required: true, state: 'outdated', detail: '' }, { id: 'g', kind: 'car', name: 'G', required: true, state: 'unknown', detail: '' },
  ];
  const order = V.sortContentRows(rows).map((r) => r.id).join('');
  ok('content rows: problems first, required before optional, installed last', order === 'dcbefga' || order === 'dcebfga' || order.startsWith('dc') && order.endsWith('a'));
  ok('content rows: required-before-optional inside a state', order.indexOf('c') < order.indexOf('b'));
  ok('content rows: input not mutated', rows[0].id === 'a');
  ok('content summary line', V.contentSummaryLine({ installed: 3, missing: 1, outdated: 2, incompatible: 0, manual: 1, unknown: 0 }) === '3 installed · 1 missing · 2 outdated · 1 needs you');
  ok('content summary line: nothing', V.contentSummaryLine({ installed: 0, missing: 0, outdated: 0, incompatible: 0, manual: 0, unknown: 0 }) === 'Nothing to check');
  ok('every content state has a label + tone', ['installed', 'missing', 'outdated', 'incompatible', 'manual', 'unknown'].every((s) => V.CONTENT_STATE_VIEW[s].label && V.CONTENT_STATE_VIEW[s].tone));
  ok('incompatible and missing are both "bad", manual is a warning', V.CONTENT_STATE_VIEW.incompatible.tone === 'bad' && V.CONTENT_STATE_VIEW.missing.tone === 'bad' && V.CONTENT_STATE_VIEW.manual.tone === 'warn');
}

// ── install-mode text + unit helpers ──────────────────────────────────────────
{
  const r = V.installModeExplanation('review', false, 1024 ** 3);
  ok('review mode text: nothing installs until approved', /installs nothing until you approve/.test(r));
  const a = V.installModeExplanation('auto', false, 1024 ** 3);
  ok('auto mode text: states every guard', /keep ready/.test(a) && /1\.1 GB|1\.0 GB|1 GB/.test(a) && /game is closed/.test(a) && /signed and current/.test(a) && /never replaces existing content/.test(a) && /Custom Shaders Patch/.test(a));
  ok('auto + update existing text mentions backup', /backup/.test(V.installModeExplanation('auto', true, 1024 ** 3)));
  ok('GB conversions round trip and clamp', V.bytesToGb(V.mbToBytes(2.5)) === 2.5 && V.mbToBytes(0) === Math.round(0.1 * 1024 ** 3) && V.mbToBytes(99) === 16 * 1024 ** 3);
}

// ── itemAction understands multi-track ids ────────────────────────────────────
{
  const plan = { serverId: 's', acRoot: 'x', downloads: [], csp: { status: 'ok', message: '' }, archiveTool: '7z', summary: {}, warnings: [], items: [
    { id: 'track', kind: 'track', label: 'T1', action: 'install', destructive: false, optional: false, reason: '', needsLocalFile: true, blocked: 'x', manualSteps: ['a'] },
    { id: 'track:mt_two', kind: 'track', label: 'T2', action: 'install', destructive: false, optional: false, reason: '', needsLocalFile: true, blocked: 'x', manualSteps: ['b'] },
  ] };
  const act = (id) => V.itemAction({ id, label: id, status: 'fail', detail: '' }, plan);
  ok('primary track still maps to "choose the downloaded archive"', act('track').kind === 'needs-file' && act('track').planItemIds.join() === 'track');
  ok('extra track maps to its own plan item', act('track:mt_two').kind === 'needs-file' && act('track:mt_two').planItemIds.join() === 'track:mt_two');
  ok('extra track layout maps to its track item', act('track-layout:mt_two:alt').planItemIds.join() === 'track:mt_two');
  ok('section title is generic', V.SECTION_TITLES.track === 'Track');
}

// ── (B) static structure ──────────────────────────────────────────────────────
const page = read('src/renderer/pages/AssettoCorsaMercyServers.tsx'), bar = read('src/renderer/components/ac/AcCatalogBar.tsx');
const card = read('src/renderer/components/ac/AcServerRow.tsx'), modal = read('src/renderer/components/ac/AcInstallModal.tsx');
const setup = read('src/renderer/pages/AssettoCorsaSetup.tsx'), panel = read('src/renderer/components/ac/AcCatalogSettingsPanel.tsx'), ready = read('src/renderer/components/ac/AcReadinessPanel.tsx');
const preload = read('src/main/preload.ts'), mainTs = read('src/main/main.ts'), types = read('src/renderer/types/electron.d.ts');

ok('PAGE: shows the catalog bar, refreshes on open and reloads the list when the catalog changes', /<AcCatalogBar refreshOnOpen onCatalogChanged=\{onCatalogChanged\}/.test(page) && /listSrpServers/.test(page) && /mercy:ac-content-changed/.test(page));
ok('BAR: manual Refresh, last-synced text, change list, and it follows catalog events', /refreshCatalog\('manual'\)/.test(bar) && /refreshCatalog\('section-open'\)/.test(bar) && /onCatalogEvent/.test(bar) && /data-testid="catalog-changes"/.test(bar) && /stripView\(status/.test(bar));
ok('BAR: tells the player nothing was removed when content leaves the catalog', /Nothing on your computer was removed/.test(bar));
ok('BAR: automatic installs are announced and trigger a re-check', /onCatalogAutoInstall/.test(bar) && /mercy:ac-content-changed/.test(bar));
ok('SETUP: the automatic-install opt-in is a per-server tick list in the catalog panel (only shown in automatic mode)', /data-testid="keep-ready-list"/.test(panel) && /autoServers/.test(panel) && /settings\.installMode === 'auto' && servers\.length > 0/.test(panel));
ok('ROW: shows the maintenance badge and takes track names from the catalog', /Maintenance/.test(card) && /serverState === 'maintenance'/.test(card) && /rowFacts\(profile, live, check\)/.test(card));
ok('READINESS: separates catalog / content / game port / status page / join and never claims a verified join', /readiness-facts/.test(ready) && /Join: not verified/.test(ready) && /Game port:/.test(ready) && /Status page:/.test(ready));
ok('READINESS: reloads when content changes', /mercy:ac-content-changed/.test(ready));
ok('MODAL: extra tracks have their own validated picker and files are sent per track', /function ExtraTrackPicker/.test(modal) && /trackArchivePaths/.test(modal) && /validateSrpTrackArchive\(f, trackId\)/.test(modal));
ok('MODAL: an extra track is only approvable after its archive passed every check', /if \(v\.ok\) \{ setFile\(f\); onApprove\(true, f\); \}/.test(modal));
ok('MODAL: nothing installs on open (still exactly one installSrpContent call, from the button handler)', (modal.match(/installSrpContent/g) || []).length === 1 && /const go = async \(\) =>/.test(modal));
ok('MODAL: the "use my file" shortcut is only offered when there is a single car source', /carDownloads\.length === 1/.test(modal));
ok('SETUP: the catalog panel is on the Setup page and reloads the page when saved', /<AcCatalogSettingsPanel onChanged=\{load\} \/>/.test(setup));
ok('PANEL: address, pinned keys, install mode, auto-update, size limit, interval, unsigned-dev, reset', ['Catalog address', 'Trusted signing keys', 'Review before install', 'Install automatically', 'Also update content I already have', 'Largest automatic download', 'Check for changes every', 'unsigned development', 'Reset catalog'].every((t) => panel.includes(t)));
ok('PANEL: warns never to paste a private key and explains https-only', /Never paste a private key/.test(panel) && /Must start with https:\/\//.test(panel));
ok('PANEL: review mode is the default selection path and auto needs a deliberate choice', /\(\['review', 'auto'\] as const\)/.test(panel) && /Review before install \(default\)/.test(panel));
ok('PANEL: reset needs a second click and says installed content is not touched', /Click again to forget the catalog/.test(panel) && /Your installed content was not touched/.test(panel));
ok('PANEL: a catalog address is never rendered back into logs or toasts', !/console\./.test(panel) && !/toast[^;]*url/i.test(panel));
ok('NO private address or fixture host is hardcoded in any new catalog UI', [bar, panel, ready].every((src) => !/\b(?:192\.168|10\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])|127\.0\.0\.1|localhost)\b/.test(src)));

// ── IPC: every new channel is exposed, typed and handled ──────────────────────
const chans = [...preload.matchAll(/ipcRenderer\.invoke\('(assettocorsa:catalog:[A-Za-z]+)'/g)].map((m) => m[1]);
ok('IPC: the catalog channels are exposed (status, refresh, get/set settings, reset, content status, readiness)', ['status', 'refresh', 'getSettings', 'setSettings', 'reset', 'contentStatus', 'readiness'].every((c) => chans.includes(`assettocorsa:catalog:${c}`)));
ok('IPC: every catalog channel has a main-process handler', chans.every((c) => mainTs.includes(`ipcMain.handle('${c}'`)));
ok('IPC: events (catalog + auto-install) are subscribable and unsubscribable', /assettocorsa:catalog:event/.test(preload) && /assettocorsa:catalog:auto-install/.test(preload) && (preload.match(/removeListener\('assettocorsa:catalog:/g) || []).length === 2);
const names = ['catalogStatus', 'refreshCatalog', 'getCatalogSettings', 'setCatalogSettings', 'resetCatalog', 'srpContentStatus', 'srpReadiness', 'onCatalogEvent', 'onCatalogAutoInstall'];
ok('IPC: every new preload method is declared in electron.d.ts', names.every((n) => new RegExp(`\\b${n}:`).test(preload) && new RegExp(`\\b${n}:`).test(types)));
ok('IPC: the renderer can only ask for a manual or section-open refresh (startup/periodic are main-only)', /reason === 'section-open' \? 'section-open' : 'manual'/.test(mainTs));
ok('IPC: install inputs from the renderer are reduced to plain archive paths', /cleanInstallInputs/.test(mainTs) && /\^\[A-Za-z0-9\._:-\]\{1,100\}\$/.test(mainTs));
ok('MAIN: the catalog starts once the player service exists', /acPlayerService\.startCatalog\(\)/.test(mainTs));
ok('MAIN: no catalog channel can start/stop/restart a server or touch server config', !/assettocorsa:catalog:[A-Za-z]+'[^\n]*(?:startServer|stopServer|restartServer|updateServer|writeFile)/.test(mainTs));

// ── error help: driven by the REAL messages the verifier / client / policy produce ───────────────────────
{
  const crypto = require('crypto'); const Sg = require('../../dist/main/services/ac/catalogSigning.js');
  const a = crypto.generateKeyPairSync('ed25519'), b = crypto.generateKeyPairSync('ed25519');
  const body = Buffer.from('{"x":1}\n');
  const sig = (o = {}, key = a.privateKey, id = 'k1') => JSON.stringify({ alg: 'ed25519', keyId: id, signedAt: '2030-01-01T00:00:00Z', catalogSha256: Sg.sha256Hex(body), signature: crypto.sign(null, body, key).toString('base64'), ...o });
  const pinned = [{ keyId: 'k1', publicKey: a.publicKey.export({ type: 'spki', format: 'pem' }) }];
  const help = (r) => V.catalogErrorHelp({ code: 'signature', message: r.message });
  const unknown = Sg.verifyCatalogSignature(body, sig({}, a.privateKey, 'other'), pinned);
  const mismatch = Sg.verifyCatalogSignature(body, sig({ catalogSha256: '0'.repeat(64) }), pinned);
  const forged = Sg.verifyCatalogSignature(body, sig({}, b.privateKey), pinned);
  const nokeys = Sg.verifyCatalogSignature(body, sig(), []);
  const badkey = Sg.verifyCatalogSignature(body, sig(), [{ keyId: 'k1', publicKey: 'nonsense' }]);
  const malformed = Sg.verifyCatalogSignature(body, 'not json', pinned);
  ok('error help: signed with an unpinned key tells the player to add that key id + public key', /not pinned/i.test(help(unknown).title) && /key id/.test(help(unknown).hint));
  ok('error help: catalog/signature mismatch says the files do not match and to press Refresh', /do not match/.test(help(mismatch).title) && /Refresh/.test(help(mismatch).hint));
  ok('error help: a signature from the wrong key says do not trust it', /not valid for the pinned key/.test(help(forged).title) && /Do not trust/.test(help(forged).hint));
  ok('error help: no pinned key, bad pinned key and malformed signature each get their own message', /No signing key/.test(help(nokeys).title) && /not a valid Ed25519/.test(help(badkey).title) && /malformed/.test(help(malformed).title));
  const H = (code, message = '') => V.catalogErrorHelp({ code, message });
  ok('error help: connection failure explains reachability and that nothing changed', /Cannot reach/.test(H('network', 'Could not reach the catalog server (ECONNREFUSED).').title) && /Nothing on your computer was changed/.test(H('network').hint));
  ok('error help: timeout, 404, 503, redirect, oversize, unsigned, malformed, schema are all distinct', new Set([H('timeout').title, H('http', 'The server has no catalog at that address (HTTP 404).').title, H('http', 'The catalog server answered HTTP 503.').title, H('redirect').title, H('too-large').title, H('unsigned').title, H('malformed').title, H('schema', 'The catalog failed validation (1 problem): archives[0].sha256: bad').title]).size === 8);
  ok('error help: schema errors surface the first problem', /archives\[0\]\.sha256: bad/.test(H('schema', 'The catalog failed validation (1 problem): archives[0].sha256: bad').hint));
  ok('error help: rollback / conflict / identity / expired / future / environment all have help', ['rollback', 'conflict', 'identity', 'expired', 'future', 'environment'].every((c) => !!H(c).title && H(c).hint.length > 20));
  ok('error help: nothing → null, unknown code still shows the raw message', V.catalogErrorHelp(null) === null && /something odd/.test(H('weird', 'something odd').hint));
}

// ── card summaries ───────────────────────────────────────────────────────────
{
  const item = (id, label, o = {}) => ({ id, kind: 'car', label, action: 'install', destructive: false, optional: false, reason: '', ...o });
  const plan = { items: [item('car:a', 'Car A'), item('car:b', 'Car B'), item('skin:a:x', 'Car A — skin "red"', { kind: 'car-skin' }), item('track', 'Track One 3', { kind: 'track' }), item('car:c', 'Base Car', { kind: 'external', action: 'manual', blocked: 'x' }), item('car:d', 'Car D'), item('conflict:srp_hud', 'Old HUD', { kind: 'conflict' }), item('companion:srp_board', 'Board', { kind: 'companion' })] };
  const m = V.missingSummary(plan);
  ok('missing summary: lists up to four names, counts the rest, skips conflicts and the companion app', m.text === 'Car A, Car B, Car A (skin), Track One 3 and 2 more' && m.manual === 1);
  ok('missing summary: nothing to do → null', V.missingSummary({ items: [] }) === null && V.missingSummary(null) === null);
  const h1 = V.hudCompanionLine({ hud: { delivered: true, version: '4.0.2' }, companionApp: true });
  const h2 = V.hudCompanionLine({ hud: { delivered: false, version: '4.0.2' }, companionApp: false });
  ok('HUD / companion line: version and "nothing to install" when delivered, optional companion app', /HUD 4\.0\.2/.test(h1.hud) && /nothing to install/.test(h1.hud) && /SRP Board.*optional/.test(h1.companion));
  ok('HUD / companion line: honest when there is neither', /No server HUD/.test(h2.hud) && /No companion app/.test(h2.companion));
}

// ── discoverability: the catalog settings are one click from the server list ─────────────────────────
{
  ok('NAV: the slim bar offers a link to Setup only when something needs fixing, and it opens Setup focused on the catalog panel', /data-testid="open-catalog-settings"/.test(bar) && /navigate\('\/assetto-corsa\/setup', \{ state: \{ focus: 'catalog' \} \}\)/.test(bar) && /v\.showSetup/.test(bar));
  ok('NAV: Setup scrolls the catalog panel into view when sent from the bar', /focus\?: string/.test(setup) && /location\.state/.test(setup) && /data-testid=\\"catalog-settings\\"/.test(setup.replace(/'/g, '"').replace(/\[data-testid="catalog-settings"\]/g, 'data-testid=\\"catalog-settings\\"')) );
  ok('NAV: the Setup panel is registered on the route the bar navigates to', /path="\/assetto-corsa\/setup" element=\{<AssettoCorsaSetup \/>\}/.test(read('src/renderer/App.tsx')));
  ok('BAR + PANEL: both can show the actionable help block for the last error (the bar tucks it behind "Why?")', /data-testid="catalog-error-help"/.test(bar) && /data-testid="catalog-error-help"/.test(panel) && /catalogErrorHelp\(status\?\.lastError\)/.test(bar) && /catalogErrorHelp\(status\?\.lastError\)/.test(panel) && /Why\?/.test(bar));
  ok('ROW: the exact missing items and the HUD / companion facts are in the row details', /Missing or out of date/.test(card) && /check\.missing\.map/.test(card) && /data-testid="hud-companion"/.test(card) && /hudCompanionLine\(profile\)/.test(card));
  ok('CARDS come from the catalog, not from UI code: no server name, id, port or track is hardcoded in any catalog UI file', [card, bar, panel, ready, page, read('src/renderer/lib/acJoinView.ts')].every((src) => !/SRP Daishi|SRP Traffic|srv-a|\b9600\b|\b9650\b|shuto_revival/.test(src.replace(/\/\/.*$/gm, ''))));
}

console.log(`\nAC CATALOG UI TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
