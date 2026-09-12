// Regression test for the same hook-order defect class proven and fixed in
// MinecraftServerPanel.tsx (see test/minecraft/panel-hooks-order.test.js for
// the full story and the real production crash it was fixed for).
// AssettoCorsaServerPanel.tsx had the identical structural bug: `useState`
// for `launchingGame` was declared AFTER `if (!server) return (...)`, so the
// first render (server===null, before load() resolves) called one fewer
// hook than the render that follows once the server loads — guaranteed
// "Rendered more hooks than during the previous render" on every successful
// open of any Assetto Corsa server's management page. Found during the
// Minecraft diagnosis (identical fingerprint), fixed here.
//
// Source-text assertion (not a jsdom/RTL render) — this codebase has no
// React test-rendering harness; see test/library/ui-structure.test.js and
// test/updater/no-auto-restart.test.js for the same established pattern.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const filePath = path.join(__dirname, '..', '..', 'src', 'renderer', 'pages', 'AssettoCorsaServerPanel.tsx');
const src = fs.readFileSync(filePath, 'utf8');

const componentStart = src.indexOf('export default function AssettoCorsaServerPanel()');
ok('AssettoCorsaServerPanel component found', componentStart !== -1);

// This file has no distinctly-named next top-level function right after the
// component the way Minecraft's file does — bound the scan generously
// instead, at the next `\nfunction ` after the component start.
const nextFnMatch = /\nfunction /.exec(src.slice(componentStart + 50));
const boundary = nextFnMatch ? componentStart + 50 + nextFnMatch.index : src.length;
const componentSrc = src.slice(componentStart, boundary);

const earlyReturnMarker = 'if (!server) {';
const earlyReturnIdx = componentSrc.indexOf(earlyReturnMarker);
ok('the "if (!server)" early return exists', earlyReturnIdx !== -1);

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
  'launchingGame\'s useState is declared BEFORE the early return (the fix — it used to be declared after it)',
  /const \[launchingGame, setLaunchingGame\] = useState\(false\)/.test(beforeEarlyReturn)
);

const hooksAfterReturn = afterEarlyReturn.match(HOOK_CALL) || [];
ok(
  'no React hook is called anywhere after the early return, up to the next top-level function',
  hooksAfterReturn.length === 0
);

console.log(`\nASSETTO CORSA PANEL HOOKS-ORDER TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
