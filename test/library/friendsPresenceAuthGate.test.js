// Friends & Presence "sign in to your Mercy account" gate — a real
// static-source assertion, matching this project's existing convention for
// renderer .tsx files (see test/library/ui-structure.test.js's own header:
// this codebase deliberately has no React component/E2E rendering harness
// — no jsdom, no @testing-library/react, no Playwright — so renderer
// invariants are verified by reading the real shipped .tsx source text and
// asserting on it directly).
//
// THE REAL BUG this gate fixes: a user can be fully signed into the
// separate Vehicle Studio/Discord access gate (useAppAuth — shown in the
// sidebar) while having NO Mercy Supabase account session at all
// (useAuth().profile === null). Before this fix, Friends & Presence showed
// the exact same generic "Please sign in again" for that case as it did
// for a real, previously-valid session that expired — misleading the user
// into thinking their account was broken rather than simply never signed
// into. Confirmed live against the actual running v1.105.1 installed
// client: zero Supabase session keys exist in localStorage, so
// mercyFetch()'s own client-side "not signed in" branch fires before any
// network request is ever made.
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

// ── 1. Detects the real Mercy account session (useAuth), never the
//    separate Vehicle Studio/Discord access gate (useAppAuth). ────────────
ok('reads the Mercy account profile from the real useAuth store', /const profile = useAuth\(\(s\) => s\.profile\)/.test(section));
ok('imports useAuth from the real Supabase-backed store, not a new one', /import \{ useAuth \} from '\.\.\/stores\/useAuth';/.test(librarySrc));
// (Explanatory comments in the section legitimately mention "useAppAuth" by
// name to document why it's NOT used here — so check for an actual
// call/import site, not just the word appearing anywhere.)
ok('REPRODUCED THE FIX: FriendsPresenceSection never calls useAppAuth() (the separate Vehicle Studio/Discord access gate) — that state must never be conflated with a Mercy account session', !/\buseAppAuth\(/.test(section));
ok('Library.tsx never imports useAppAuth at all', !/from '\.\.\/stores\/useAppAuth'/.test(librarySrc));

// ── 2. Does NOT show the generic "Please sign in again" message when there
//    is no profile at all — that message is now reserved for a REAL
//    session that existed and expired/was rejected. ───────────────────────
const noProfileBranch = section.match(/if \(!profile\) \{([\s\S]*?)\n\s*\}\n\s*if \(connection === 'auth-required'\)/);
ok('a distinct "no Mercy account" branch exists, appearing BEFORE the generic auth-required branch (so it takes priority)', !!noProfileBranch);
const noProfileBlock = noProfileBranch ? noProfileBranch[1] : '';

// ── 3. Clear, correct copy — not the generic "session needs to be
//    refreshed" message, which would be actively misleading here. ────────
ok('shows the exact required title "Sign in to your Mercy account"', /title="Sign in to your Mercy account"/.test(noProfileBlock));
ok('shows the exact required explanation of what the Mercy account is for', /Friends & Presence uses your Mercy account to manage friends, presence, servers, and join requests\./.test(noProfileBlock));
ok('does NOT show the "Please sign in again" / session-refresh copy in the no-profile branch', !/Please sign in again/.test(noProfileBlock) && !/session needs to be refreshed/.test(noProfileBlock));

// ── 4. A clearly labeled "Sign in to Mercy" action that opens the modal
//    state, never a fetch/refresh() retry (that could never succeed with
//    no session to refresh). ───────────────────────────────────────────────
ok('provides a clearly labeled "Sign in to Mercy" button', /Sign in to Mercy/.test(noProfileBlock));
ok('the sign-in button opens the auth modal (setAuthModalOpen(true)), never just retries the network call', /onClick=\{\(\) => setAuthModalOpen\(true\)\}/.test(noProfileBlock));

// ── 5. Reuses the EXISTING AccountAuthModal / Mercy username+password flow
//    — no second login system, no duplicate modal component. ─────────────
ok('imports the real, existing AccountAuthModal component (not a new/duplicate login UI)', /import AccountAuthModal from '\.\.\/components\/AccountAuthModal';/.test(librarySrc));
const accountAuthModalUsages = (librarySrc.match(/<AccountAuthModal\b/g) || []).length;
ok('AccountAuthModal is rendered exactly once in Library.tsx (the gate reuses it, it does not duplicate it)', accountAuthModalUsages === 1);
ok('the rendered modal is wired to the real open/close state used by the sign-in button', /<AccountAuthModal open=\{authModalOpen\} onClose=\{\(\) => setAuthModalOpen\(false\)\}\s*\/>/.test(librarySrc));
ok('Marketplace.tsx (the only other place AccountAuthModal is used) is untouched by this change', marketplaceSrc.includes('<AccountAuthModal open={authOpen} onClose={() => setAuthOpen(false)} />'));
// The real underlying auth flow (username/password against Supabase) lives
// entirely inside AccountAuthModal.tsx itself and is untouched — the gate
// only ever imports and renders that existing component.
const accountAuthModalSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/components/AccountAuthModal.tsx'), 'utf-8');
ok('AccountAuthModal itself still uses the real, existing useAuth signIn/signUp — no second auth system was introduced', /const \{ signIn, signUp \} = useAuth\(\);/.test(accountAuthModalSrc));

// ── 6. Automatic initialization on successful sign-in — no launcher
//    restart required. ──────────────────────────────────────────────────
ok('a dedicated effect watches the real profile and refreshes Friends/Presence the moment it becomes populated', /useEffect\(\(\) => \{\s*if \(profile\) useFriendsPresence\.getState\(\)\.refresh\(\);\s*\}, \[profile\]\);/.test(section));

// ── 7. Existing reconnect/disconnected states for an ALREADY-authenticated
//    user are preserved unchanged — only gated behind the new profile
//    check, never removed or altered. ──────────────────────────────────────
ok('the existing "unconfigured" (Mercy service not deployed) state is preserved and still checked first', /if \(connection === 'unconfigured'\) \{/.test(section));
ok('the existing "auth-required" (real expired/rejected session) state is preserved for users who DO have a profile', /if \(connection === 'auth-required'\) \{/.test(section));
ok('the existing "unreachable" state and its Retry action are preserved', /connection === 'unreachable'/.test(section) && /Retry/.test(section));
ok('the existing "reconnecting" banner (last-known data still shown) is preserved', /connection === 'reconnecting'/.test(section));
ok('the existing loading spinner for a genuine first load is preserved', /loading && !hasData/.test(section));

console.log(`\nFRIENDS PRESENCE AUTH GATE TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
