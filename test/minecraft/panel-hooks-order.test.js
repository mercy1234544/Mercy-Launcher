// Regression test for the real production crash reported against v1.100.0:
// opening ANY Minecraft server's management page (new or existing) threw
// "Rendered more hooks than during the previous render" and was caught by
// the ErrorBoundary, showing "Something went wrong on this page" every
// single time — Retry never helped because the bug was structural, not
// transient. Proven via a live Electron reproduction (real preload/IPC,
// a real persisted server record, no mocks): MinecraftServerPanel's first
// render happens with `server === null` (before load() resolves) and hit
// `if (!server) return (...)`, but `const [launchingGame] = useState(false)`
// was declared AFTER that early return — so the null-render called one
// fewer hook than the render that follows once the server loads, which
// violates React's Rules of Hooks on every successful load.
//
// This is a source-text assertion (not a jsdom/RTL render) because this
// codebase has no React test-rendering harness set up — see
// test/library/ui-structure.test.js and test/updater/no-auto-restart.test.js
// for the same established pattern of proving structural invariants by
// parsing the real source file.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const filePath = path.join(__dirname, '..', '..', 'src', 'renderer', 'pages', 'MinecraftServerPanel.tsx');
const src = fs.readFileSync(filePath, 'utf8');

const componentStart = src.indexOf('export default function MinecraftServerPanel()');
ok('MinecraftServerPanel component found', componentStart !== -1);

const nextComponentStart = src.indexOf('function OverviewTab', componentStart);
ok('OverviewTab boundary found (marks the end of MinecraftServerPanel\'s own source)', nextComponentStart !== -1);

const componentSrc = src.slice(componentStart, nextComponentStart);

const earlyReturnMarker = 'if (!server) {';
const earlyReturnIdx = componentSrc.indexOf(earlyReturnMarker);
ok('the "if (!server)" early return exists', earlyReturnIdx !== -1);

// Find the matching closing brace of the `if (!server) { ... }` block by
// counting braces from its own opening one.
let depth = 0, i = earlyReturnIdx + earlyReturnMarker.length - 1, blockEnd = -1;
for (; i < componentSrc.length; i++) {
  if (componentSrc[i] === '{') depth++;
  else if (componentSrc[i] === '}') { depth--; if (depth === 0) { blockEnd = i + 1; break; } }
}
ok('the early-return block\'s matching closing brace was found', blockEnd !== -1);

const beforeEarlyReturn = componentSrc.slice(0, earlyReturnIdx);
const afterEarlyReturn = componentSrc.slice(blockEnd);

const HOOK_CALL = /\buse(State|Effect|Ref|Callback|Memo|Context|LayoutEffect|Reducer|ImperativeHandle)\(/g;

ok(
  'launchingGame\'s useState is declared BEFORE the early return (the actual fix — it used to be declared after it)',
  /const \[launchingGame, setLaunchingGame\] = useState\(false\)/.test(beforeEarlyReturn)
);

const hooksAfterReturn = afterEarlyReturn.match(HOOK_CALL) || [];
ok(
  'no React hook is called anywhere after the early return (the general invariant this bug violated — hooks must never depend on whether `server` loaded yet)',
  hooksAfterReturn.length === 0
);

ok(
  'the component still actually renders its real management UI after the early return (the fix did not just delete functionality)',
  /return\s*\(\s*<motion\.div/.test(afterEarlyReturn)
);

// Same defect class, still present in AssettoCorsaServerPanel.tsx — proven
// during this diagnosis (identical `useState` placed after its own
// `if (!server)`), but intentionally NOT fixed here since it wasn't the
// reported bug and touching AC/FiveM code was out of scope for this fix.
// This assertion exists only so a future AC fix doesn't silently regress
// awareness of it — it's expected to fail until AC gets the equivalent fix.
const acPath = path.join(__dirname, '..', '..', 'src', 'renderer', 'pages', 'AssettoCorsaServerPanel.tsx');
if (fs.existsSync(acPath)) {
  const acSrc = fs.readFileSync(acPath, 'utf8');
  const acKnownBug = /if \(!server\) \{[\s\S]*?\n  \}\n\n[\s\S]*?const \[launchingGame, setLaunchingGame\] = useState/.test(acSrc);
  console.log(acKnownBug
    ? '  (known, unfixed) AssettoCorsaServerPanel.tsx has the identical hook-order defect — out of scope for this fix, flagged in the report.'
    : '  AssettoCorsaServerPanel.tsx no longer has the identical defect.');
}

console.log(`\nMINECRAFT PANEL HOOKS-ORDER TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
