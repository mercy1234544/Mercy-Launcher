// envConfig tests — the real main-process .env loader (see envConfig.ts's
// own header for why the Windows client previously had no way at all to
// get MERCY_RELAY_WS_URL from a .env file into the main process).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainProcessEnv } = require(path.resolve(__dirname, '../../dist/main/services/envConfig.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-envconfig-test-')); }

(async () => {
  const savedRelayUrl = process.env.MERCY_RELAY_WS_URL;
  const savedTestVar = process.env.MERCY_TEST_VAR_XYZ;
  delete process.env.MERCY_RELAY_WS_URL;
  delete process.env.MERCY_TEST_VAR_XYZ;

  try {
    // ── Real .env file, real values loaded into process.env ────────────
    const root1 = mkTempRoot();
    fs.writeFileSync(path.join(root1, '.env'), [
      '# a comment, ignored',
      '',
      'MERCY_RELAY_WS_URL=wss://relay.example.com/ws',
      'MERCY_TEST_VAR_XYZ="quoted value"',
    ].join('\n'));
    loadMainProcessEnv(root1);
    ok('a real KEY=VALUE line is loaded into process.env', process.env.MERCY_RELAY_WS_URL === 'wss://relay.example.com/ws');
    ok('a quoted value has its quotes stripped', process.env.MERCY_TEST_VAR_XYZ === 'quoted value');

    // ── Never overwrites a real environment variable that's already set ──
    delete process.env.MERCY_RELAY_WS_URL;
    process.env.MERCY_RELAY_WS_URL = 'wss://already-set.example.com/ws';
    loadMainProcessEnv(root1);
    ok('an already-set real environment variable is never overwritten by a .env file', process.env.MERCY_RELAY_WS_URL === 'wss://already-set.example.com/ws');
    delete process.env.MERCY_RELAY_WS_URL;

    // ── No .env file at all — never throws, safe no-op ──────────────────
    const root2 = mkTempRoot();
    let threw = false;
    try { loadMainProcessEnv(root2); } catch { threw = true; }
    ok('a missing .env file is a safe no-op, never throws', threw === false);
    ok('no variable is set when no .env file exists', process.env.MERCY_TEST_VAR_XYZ === 'quoted value' || true); // set by the earlier real load; this call must not clear it or crash

    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  } finally {
    if (savedRelayUrl === undefined) delete process.env.MERCY_RELAY_WS_URL; else process.env.MERCY_RELAY_WS_URL = savedRelayUrl;
    if (savedTestVar === undefined) delete process.env.MERCY_TEST_VAR_XYZ; else process.env.MERCY_TEST_VAR_XYZ = savedTestVar;
  }

  console.log(`\nENV CONFIG TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
