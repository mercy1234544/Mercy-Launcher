// AccountAuthModal — "Remember my Mercy account" checkbox. Static-source
// assertion (see test/library/ui-structure.test.js's header for why this
// project verifies renderer .tsx invariants this way).
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const modalSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/components/AccountAuthModal.tsx'), 'utf-8');

ok('a "remember" checkbox state exists, defaulting to true (closest to this app\'s prior always-remember behavior)', /const \[remember, setRemember\] = useState\(true\);/.test(modalSrc));
ok('the checkbox is clearly labeled "Remember my Mercy account on this computer"', /Remember my Mercy account on this computer/.test(modalSrc));
ok('the checkbox is a real, controlled checkbox input bound to the remember state', /type="checkbox" checked=\{remember\} onChange=\{\(e\) => setRemember\(e\.target\.checked\)\}/.test(modalSrc));
ok('unchecking it shows a clear explanation that the sign-in will not be remembered', /!remember[\s\S]{0,200}won't be remembered/.test(modalSrc));

ok('REPRODUCED THE FIX: signIn is called with the real remember flag, not hardcoded', /await signIn\(u, password, remember\)/.test(modalSrc));
ok('REPRODUCED THE FIX: signUp is called with the real remember flag, not hardcoded', /await signUp\(u, password, email \|\| undefined, remember\)/.test(modalSrc));

console.log(`\nACCOUNT AUTH MODAL REMEMBER-ME TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
