// Friends & Presence Settings popover (Launcher Access vs Mercy Account vs
// Remembered Sign-In) — static-source assertion, matching this project's
// existing convention for renderer .tsx files with no jsdom/
// @testing-library/react/Playwright available (see
// test/library/ui-structure.test.js's own header).
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const librarySrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/pages/Library.tsx'), 'utf-8');

const panelStart = librarySrc.indexOf('function FriendsPresenceSettingsPopover(');
ok('the dedicated Friends & Presence Settings popover component exists', panelStart !== -1);
const panelEnd = librarySrc.indexOf('\nfunction FriendsPresenceSection()');
const panel = librarySrc.slice(panelStart, panelEnd === -1 ? undefined : panelEnd);

// ── Launcher Access vs Mercy Account — always visibly distinct. ───────────
ok('shows a real "Launcher Access" status line', /Launcher Access/.test(panel));
ok('shows a real "Mercy Account" status line, visibly separate from Launcher Access', /Mercy Account/.test(panel));
ok('Launcher Access status is derived from the real useAppAuth status (enabled && authorized), never fabricated', /launcherConnected = !!\(launcherAccessStatus\?\.enabled && launcherAccessStatus\?\.authorized\)/.test(panel));
ok('Mercy Account "Connected as" shows the real profile username, never a static/fake value', /Connected as \{profile\.username\}/.test(panel));

// ── Mercy Account section: Connect when disconnected, Disconnect when
//    connected — and Disconnect is clearly explained as session-only. ─────
ok('shows "Connect Mercy Account" when no profile exists', /onClick=\{onConnect\}[\s\S]{0,80}Connect Mercy Account/.test(panel));
ok('shows "Disconnect Mercy Account" when a profile exists', /onClick=\{onDisconnect\}[\s\S]{0,80}Disconnect Mercy Account/.test(panel));
ok('REPRODUCED THE FIX: Disconnect is explicitly explained as NOT forgetting the saved sign-in — distinct from a full forget', /Disconnecting ends this session only[\s\S]{0,80}saved sign-in[\s\S]{0,40}kept for next time/.test(panel));

// ── Remembered Sign-In section: shows whether a saved credential exists,
//    names the real username, explains the encryption, and provides an
//    explicit forget action — but the password itself is NEVER shown or
//    passed to this component. ─────────────────────────────────────────────
ok('shows a dedicated "Remembered Sign-In" section', /Remembered Sign-In/.test(panel));
ok('shows the real saved username when a credential exists', /A saved sign-in exists for[\s\S]{0,80}\{savedCredentialUsername\}/.test(panel));
ok('clearly explains the OS-backed encrypted storage mechanism, never implying plaintext storage', /encrypted credential storage — never in plain text/.test(panel));
ok('provides an explicit "Forget saved sign-in" action, wired to the real onForgetCredential callback', /onClick=\{onForgetCredential\}[\s\S]{0,80}Forget saved sign-in/.test(panel));
// The word "password" appears only in the explanatory sentence about HOW
// it's stored — the component's own prop signature must never accept an
// actual password value (no `password` prop/parameter, no rendering of a
// password variable), which is the real thing this guards against.
const propsSignature = panel.slice(0, panel.indexOf('{\n  const launcherConnected'));
ok('REPRODUCED THE FIX: the component\'s props never include an actual password value — only a username and booleans', !/\bpassword\b/i.test(propsSignature) && !/\{password\}/.test(panel));

// ── Wiring from FriendsPresenceSection: real store actions, not stubs. ────
const sectionStart = librarySrc.indexOf('function FriendsPresenceSection()');
const section = librarySrc.slice(sectionStart);
ok('the popover is rendered with the real disconnectSession as onDisconnect', /onDisconnect=\{\(\) => disconnectMercySession\(\)\}/.test(section));
ok('the popover is rendered with the real forgetCredential as onForgetCredential', /onForgetCredential=\{\(\) => forgetMercyCredential\(\)\}/.test(section));
ok('disconnectMercySession is the real useAuth().disconnectSession, not signOut (which would also forget the credential)', /const disconnectMercySession = useAuth\(\(s\) => s\.disconnectSession\)/.test(section));
ok('forgetMercyCredential is the real useAuth().forgetCredential', /const forgetMercyCredential = useAuth\(\(s\) => s\.forgetCredential\)/.test(section));
ok('reads the real hasSavedCredential/savedCredentialUsername display flags from useAuth, never invented locally', /const hasSavedCredential = useAuth\(\(s\) => s\.hasSavedCredential\)/.test(section) && /const savedCredentialUsername = useAuth\(\(s\) => s\.savedCredentialUsername\)/.test(section));

// ── Settings are reachable directly from Friends & Presence itself —
//    never requiring a trip through Marketplace. ──────────────────────────
ok('the settings popover is rendered directly inside the Friends & Presence section header', /<FriendsPresenceSettingsPopover/.test(section));

console.log(`\nMERCY ACCOUNT SETTINGS PANEL TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
