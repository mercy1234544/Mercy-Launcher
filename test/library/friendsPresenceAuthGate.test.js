// Friends & Presence "Connect with Discord" gate — a real static-source
// assertion, matching this project's existing convention for renderer .tsx
// files (see test/library/ui-structure.test.js's own header: this codebase
// deliberately has no React component/E2E rendering harness — no jsdom, no
// @testing-library/react, no Playwright — so renderer invariants are
// verified by reading the real shipped .tsx source text and asserting on it
// directly).
//
// THE DISCORD-IDENTITY MIGRATION this test now verifies: Friends & Presence
// no longer requires a separate Mercy username/password (Supabase) account
// at all. Its identity IS the existing launcher Discord/Vehicle Studio
// session (useAppAuth) — being authorized there is now sufficient, with no
// second sign-in step, no AccountAuthModal, and no "Remember my Mercy
// account" concept anywhere in this section. Marketplace/AdminPanel keep the
// original useAuth/AccountAuthModal system entirely untouched — this test
// also proves this section no longer references it at all, while confirming
// Marketplace's own usage is undisturbed.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const librarySrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/pages/Library.tsx'), 'utf-8');
const marketplaceSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/pages/Marketplace.tsx'), 'utf-8');

// Isolate FriendsPresenceSection's own function body so assertions about
// "does NOT use X" can't accidentally pass just because some unrelated part
// of this large file happens to (or doesn't) mention it.
const sectionStart = librarySrc.indexOf('function FriendsPresenceSection()');
ok('FriendsPresenceSection exists', sectionStart !== -1);
const nextFunctionStart = librarySrc.indexOf('\nfunction ', sectionStart + 1);
const section = librarySrc.slice(sectionStart, nextFunctionStart === -1 ? undefined : nextFunctionStart);

// ── 1. Identity comes ONLY from the existing Discord/Vehicle Studio access
//    gate (useAppAuth) — the separate Mercy Supabase account system
//    (useAuth) is not referenced anywhere in this file any more. ──────────
ok('reads the launcher Discord/Vehicle Studio status from the real useAppAuth store', /const launcherAccessStatus = useAppAuth\(\(s\) => s\.status\)/.test(section));
ok('imports the real useAppAuth store', /import \{ useAppAuth \} from '\.\.\/stores\/useAppAuth';/.test(librarySrc));
ok('REPRODUCED THE MIGRATION: no longer imports the separate Mercy Supabase account store (useAuth) at all', !/import \{ useAuth \} from '\.\.\/stores\/useAuth';/.test(librarySrc));
ok('derives a single discordConnected flag from enabled+authorized, never a separate Mercy profile', /const discordConnected = !!\(launcherAccessStatus\?\.enabled && launcherAccessStatus\?\.authorized\)/.test(section));

// ── 2. No separate Mercy sign-in flow anywhere in this section: no
//    AccountAuthModal, no password/account-creation copy. ─────────────────
ok('REPRODUCED THE MIGRATION: does not import AccountAuthModal at all', !/import AccountAuthModal from/.test(librarySrc));
ok('does not render AccountAuthModal anywhere in this file', !/<AccountAuthModal\b/.test(librarySrc));
ok('no "Create Mercy account" copy remains', !/Create Mercy account/i.test(section));
ok('no "Remember my Mercy account" / remembered sign-in copy remains', !/Remember my Mercy account/i.test(section) && !/Remembered Sign-In/i.test(section));
ok('no "Sign in to your Mercy account" copy remains', !/Sign in to your Mercy account/.test(section));
ok('no "Connect Mercy Account" / "Disconnect Mercy Account" copy remains', !/Connect Mercy Account/.test(section) && !/Disconnect Mercy Account/.test(section));

// ── 3. The no-identity gate: whenever the launcher's Discord session isn't
//    authorized, Friends & Presence must say so and offer to reconnect
//    through THAT SAME Discord flow — never a password prompt. ───────────
const noIdentityBranch = section.match(/if \(!discordConnected\) \{([\s\S]*?)\n\s*\}\n\s*if \(connection === 'auth-required'\)/);
ok('a distinct "not connected with Discord" branch exists, appearing BEFORE the generic auth-required branch (so it takes priority)', !!noIdentityBranch);
const noIdentityBlock = noIdentityBranch ? noIdentityBranch[1] : '';
ok('shows Discord-identity copy ("Connect with Discord")', /title="Connect with Discord"/.test(noIdentityBlock));
ok('explains there is no separate account needed', /no separate account needed/.test(noIdentityBlock));
ok('the action calls startDiscordLogin(), never opens a password modal', /onClick=\{\(\) => startDiscordLogin\(\)\}/.test(noIdentityBlock) && !/setAuthModalOpen/.test(noIdentityBlock));

// ── 4. auth-required (an existing, now-authorized-but-expired Discord
//    session) points at the SAME reconnect action, never a Mercy password
//    concept ("password may have changed", "reauthFailed", etc). ─────────
const authRequiredBranch = section.match(/if \(connection === 'auth-required'\) \{([\s\S]*?)\n\s*\}\n\s*if \(loading/);
ok('the existing "auth-required" branch is preserved for an authorized-but-expired session', !!authRequiredBranch);
const authRequiredBlock = authRequiredBranch ? authRequiredBranch[1] : '';
ok('REPRODUCED THE MIGRATION: auth-required now says to reconnect with Discord, never mentions a Mercy password', /Reconnect with Discord/.test(authRequiredBlock) && !/password/i.test(authRequiredBlock));
ok('the auth-required action also calls the real Discord login, not a Mercy sign-in modal', /onClick=\{\(\) => startDiscordLogin\(\)\}/.test(authRequiredBlock));
ok('REPRODUCED THE MIGRATION: no leftover reauthFailed / saved-credential branching remains', !/reauthFailed/.test(section) && !/hasSavedCredential/.test(section));

// ── 5. Automatic initialization the moment Discord becomes authorized — no
//    launcher restart required, mirroring the old profile-watch effect but
//    keyed on the new identity source. ────────────────────────────────────
ok('a dedicated effect watches discordConnected and refreshes Friends/Presence the moment it becomes true', /useEffect\(\(\) => \{\s*if \(discordConnected\) useFriendsPresence\.getState\(\)\.refresh\(\);\s*\}, \[discordConnected\]\);/.test(section));

// ── 6. Existing reconnect/disconnected states unrelated to identity are
//    preserved unchanged. ──────────────────────────────────────────────────
ok('the existing "unconfigured" (Mercy service not deployed) state is preserved and still checked first', /if \(connection === 'unconfigured'\) \{/.test(section));
ok('the existing "unreachable" state and its Retry action are preserved', /connection === 'unreachable'/.test(section) && /Retry/.test(section));
ok('the existing "reconnecting" banner (last-known data still shown) is preserved', /connection === 'reconnecting'/.test(section));
ok('the existing loading spinner for a genuine first load is preserved', /loading && !hasData/.test(section));

// ── 7. The settings popover shows the Discord identity plainly, with no
//    Mercy-account or remembered-credential sections left over. ───────────
const popoverStart = librarySrc.indexOf('function FriendsPresenceSettingsPopover(');
const popoverSection = librarySrc.slice(popoverStart, librarySrc.indexOf('\nfunction ', popoverStart + 1));
ok('FriendsPresenceSettingsPopover exists', popoverStart !== -1);
ok('the popover shows "Connected with Discord" identity copy', /Connected with Discord/.test(popoverSection));
ok('the popover no longer has a Mercy Account row or Remembered Sign-In section', !/Mercy Account/.test(popoverSection) && !/Remembered Sign-In/.test(popoverSection));

// ── 8. Marketplace/AdminPanel's independent Mercy account system (useAuth +
//    AccountAuthModal, used for Script Marketplace entitlements/admin roles
//    — a genuinely different feature) is completely untouched. ────────────
ok('Marketplace.tsx still imports and uses the real useAuth store, entirely unaffected by this migration', /import \{ useAuth \} from '\.\.\/stores\/useAuth';/.test(marketplaceSrc));
ok('Marketplace.tsx (the only remaining place AccountAuthModal is used) is untouched by this change', marketplaceSrc.includes('<AccountAuthModal open={authOpen} onClose={() => setAuthOpen(false)} />'));
const accountAuthModalSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/components/AccountAuthModal.tsx'), 'utf-8');
ok('AccountAuthModal itself still uses the real, existing useAuth signIn/signUp — untouched, still available for Marketplace/Admin', /const \{ signIn, signUp \} = useAuth\(\);/.test(accountAuthModalSrc));

console.log(`\nFRIENDS PRESENCE AUTH GATE TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
