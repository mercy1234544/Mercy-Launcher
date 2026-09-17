// AccountAuthModal contextual copy — a real static-source assertion,
// matching this project's existing convention for renderer .tsx files (no
// jsdom/@testing-library/react/Playwright in this project — see
// test/library/ui-structure.test.js's own header).
//
// THE REAL BUG this fixes: Friends & Presence's new "Sign in to Mercy"
// button (v1.105.2) opened the existing AccountAuthModal, but that modal's
// login-mode copy was hardcoded to "Log in to access your Exclusive
// scripts." — implying Friends/Presence needs a SEPARATE Exclusive Scripts
// account, when it's the exact same one Mercy username/password account.
//
// The fix adds two optional, purely-cosmetic props (loginTitle/
// loginDescription) to the ONE existing AccountAuthModal component — never
// a second modal, never a second auth system — defaulting to the original
// Marketplace/Exclusive Scripts copy so every existing caller is
// byte-identical unless it opts in.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const modalSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/components/AccountAuthModal.tsx'), 'utf-8');
const librarySrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/pages/Library.tsx'), 'utf-8');
const marketplaceSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/pages/Marketplace.tsx'), 'utf-8');

// ── There is exactly ONE AccountAuthModal component/file in the whole
//    renderer, and exactly one underlying Supabase sign-in/sign-up call
//    site (inside it) — proving no duplicate auth system was introduced. ──
const modalFiles = fs.readdirSync(path.resolve(__dirname, '../../src/renderer/components')).filter((f) => /auth.*modal|login.*modal|signin.*modal/i.test(f));
ok('exactly one AccountAuthModal component file exists (no duplicate login UI)', modalFiles.length === 1 && modalFiles[0] === 'AccountAuthModal.tsx');
ok('the modal still calls the real, existing useAuth signIn/signUp — the single Mercy username/password implementation', /const \{ signIn, signUp \} = useAuth\(\);/.test(modalSrc));
ok('there is exactly one signIn(...) call site in the modal (one code path, not a duplicated branch)', (modalSrc.match(/\bsignIn\(/g) || []).length === 1);
ok('there is exactly one signUp(...) call site in the modal', (modalSrc.match(/\bsignUp\(/g) || []).length === 1);

// ── The modal accepts optional contextual copy, defaulting to the
//    ORIGINAL Exclusive Scripts wording — so an untouched caller (like
//    Marketplace) keeps its exact current behavior with zero changes. ─────
ok('loginTitle is an optional prop defaulting to the original "Log in" heading', /loginTitle = 'Log in'/.test(modalSrc));
ok('loginDescription is an optional prop defaulting to the ORIGINAL Exclusive Scripts copy, unchanged for callers that opt out', /loginDescription = 'Log in to access your Exclusive scripts\.'/.test(modalSrc));
ok('the login-mode heading actually renders the (possibly overridden) loginTitle', /\{mode === 'login' \? loginTitle : 'Create account'\}/.test(modalSrc));
ok('the login-mode description actually renders the (possibly overridden) loginDescription', /\{mode === 'login' \? loginDescription : 'Pick a username and password/.test(modalSrc));
// Signup copy/heading is untouched and identical for every caller — every
// caller creates the exact same one Mercy account, so there is nothing
// context-specific to say there.
ok('signup mode keeps its own single, un-contextualized heading/copy for every caller', /'Create account'/.test(modalSrc) && /Pick a username and password\. Email is optional \(for recovery\)\./.test(modalSrc));

// ── Marketplace/Exclusive Scripts retains its EXACT existing wording and
//    behavior — it renders the modal with no extra props at all, so it
//    falls straight through to the untouched defaults. ────────────────────
ok('Marketplace opens AccountAuthModal with no contextual props at all (relies entirely on the original defaults)', /<AccountAuthModal open=\{authOpen\} onClose=\{\(\) => setAuthOpen\(false\)\} \/>/.test(marketplaceSrc));
ok('Marketplace never overrides loginTitle/loginDescription — its copy is exactly the original, unmodified default', !/loginTitle=|loginDescription=/.test(marketplaceSrc));

// ── Friends & Presence (Library.tsx) no longer opens AccountAuthModal at
//    all — the Discord-identity migration removed the separate Mercy
//    username/password sign-in step from this feature entirely (see
//    friendsPresenceAuthGate.test.js for the full replacement gate). The
//    contextual loginTitle/loginDescription props this file tests remain
//    fully in place on the component itself for any other caller that opts
//    in, and Marketplace's usage above is proof the untouched default path
//    still works. ─────────────────────────────────────────────────────────
ok('REPRODUCED THE DISCORD-IDENTITY MIGRATION: Library.tsx no longer imports AccountAuthModal', !/import AccountAuthModal from/.test(librarySrc));
ok('REPRODUCED THE DISCORD-IDENTITY MIGRATION: Library.tsx no longer renders AccountAuthModal anywhere', !/<AccountAuthModal\b/.test(librarySrc));

console.log(`\nACCOUNT AUTH MODAL CONTEXT TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
