// Friends & Presence Settings popover — static-source assertion, matching
// this project's existing convention for renderer .tsx files with no jsdom/
// @testing-library/react/Playwright available (see
// test/library/ui-structure.test.js's own header).
//
// THE DISCORD-IDENTITY MIGRATION this test now verifies: the popover used
// to show three separate things (Launcher Access, Mercy Account,
// Remembered Sign-In) because Friends & Presence needed its own separate
// Mercy username/password account. It now shows exactly one identity — the
// existing launcher Discord session — with no Mercy account section, no
// remembered-credential section, and no password concept anywhere.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const librarySrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/pages/Library.tsx'), 'utf-8');

const panelStart = librarySrc.indexOf('function FriendsPresenceSettingsPopover(');
ok('the dedicated Friends & Presence Settings popover component exists', panelStart !== -1);
const panelEnd = librarySrc.indexOf('\nfunction FriendsPresenceSection()');
const panel = librarySrc.slice(panelStart, panelEnd === -1 ? undefined : panelEnd);

// ── The popover shows exactly one identity: the launcher's Discord session.
const propsSignature = panel.slice(0, panel.indexOf('{\n  const connected'));
ok('takes launcherAccessStatus and an onReconnect callback, never a profile/credential prop', /launcherAccessStatus:/.test(propsSignature) && /onReconnect:/.test(propsSignature));
ok('REPRODUCED THE MIGRATION: the popover no longer accepts a Mercy profile, saved-credential, or connect/disconnect props', !/\bprofile:/.test(propsSignature) && !/hasSavedCredential/.test(propsSignature) && !/savedCredentialUsername/.test(propsSignature) && !/onConnect:/.test(propsSignature) && !/onDisconnect:/.test(propsSignature) && !/onForgetCredential:/.test(propsSignature));
ok('shows "Connected with Discord" identity copy, derived from the real launcherAccessStatus', /Connected with Discord/.test(panel) && /const connected = !!\(launcherAccessStatus\?\.enabled && launcherAccessStatus\?\.authorized\)/.test(panel));
ok('shows the real Discord username inline when connected, never a static/fake value', /launcherAccessStatus\?\.username/.test(panel));

// ── No Mercy account or remembered-credential sections remain. ────────────
ok('REPRODUCED THE MIGRATION: the popover no longer has a separate "Mercy Account" row', !/Mercy Account/.test(panel));
ok('REPRODUCED THE MIGRATION: the popover no longer has a "Remembered Sign-In" section', !/Remembered Sign-In/.test(panel));
ok('REPRODUCED THE MIGRATION: no "Connect/Disconnect Mercy Account" actions remain', !/Connect Mercy Account/.test(panel) && !/Disconnect Mercy Account/.test(panel));
ok('REPRODUCED THE MIGRATION: no "Forget saved sign-in" action remains', !/Forget saved sign-in/.test(panel));
// "password" may still appear in reassuring copy ("no ... password to
// manage here") — what must never appear is any claim about STORING one
// (the old encrypted-credential-storage explanation), since there is no
// credential store involved in this identity any more.
ok('no credential-storage explanation remains (there is no stored password/credential for this identity)', !/encrypted credential storage/.test(panel) && !/stored using this computer/.test(panel));

// ── When not connected, the popover offers to reconnect through the SAME
//    Discord flow — never a password prompt. ─────────────────────────────
ok('provides a "Reconnect with Discord" action wired to the real onReconnect callback when not connected', /onClick=\{onReconnect\}[\s\S]{0,80}Reconnect with Discord/.test(panel));

// ── Wiring from FriendsPresenceSection: real store actions, not stubs. ────
const sectionStart = librarySrc.indexOf('function FriendsPresenceSection()');
const section = librarySrc.slice(sectionStart);
ok('the popover is rendered with the real launcherAccessStatus from useAppAuth', /launcherAccessStatus=\{launcherAccessStatus\}/.test(section));
ok('the popover\'s onReconnect calls the real useAppAuth().startLogin — the SAME login the app-wide access gate uses, never a second flow', /onReconnect=\{\(\) => startDiscordLogin\(\)\}/.test(section) && /const startDiscordLogin = useAppAuth\(\(s\) => s\.startLogin\)/.test(section));

// ── Settings are reachable directly from Friends & Presence itself —
//    never requiring a trip through Marketplace. ──────────────────────────
ok('the settings popover is rendered directly inside the Friends & Presence section header', /<FriendsPresenceSettingsPopover/.test(section));

console.log(`\nMERCY ACCOUNT SETTINGS PANEL TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
