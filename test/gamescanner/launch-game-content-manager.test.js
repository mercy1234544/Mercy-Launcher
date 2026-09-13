// Regression test for the real production bug: choosing "Launch Game" for
// an Assetto Corsa server launched plain Assetto Corsa instead of Content
// Manager, even when Content Manager WAS genuinely detected.
//
// Root cause: pickLaunchTarget() matched on the literal id 'content-manager',
// but GameScanner's own curated-direct-detection path (scanDirect) actually
// produces ids prefixed with 'direct-' (e.g. 'direct-content-manager') — a
// real id that never once matched here. This "preference" was silent dead
// code; every AC launch fell straight through to the generic
// mercyGameId === 'assettocorsa' fallback (plain Assetto Corsa).
//
// launchGame.ts is a renderer (ESM/Vite-bundled, DOM-referencing) module
// with no CommonJS build, so it can't be `require()`d directly the way
// main-process services can. Instead of a weaker source-text regex
// assertion, this transpiles the real .ts source with the TypeScript
// compiler already used to build this project and evaluates the REAL
// pickLaunchTarget/launchGameFor logic against a scripted fake
// window.electronAPI.games — genuine behavioral testing, not string
// matching.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function loadLaunchGameModule() {
  const srcPath = path.resolve(__dirname, '../../src/renderer/lib/launchGame.ts');
  const source = fs.readFileSync(srcPath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  });
  const m = new Module(srcPath, module);
  m.filename = srcPath;
  m._compile(outputText, srcPath);
  return m.exports;
}

function fakeGame(overrides) {
  return {
    id: 'x', name: 'x', mercyGameId: null, mercyStatus: 'unsupported',
    installPath: 'C:\\fake', executablePath: 'C:\\fake\\x.exe', platform: 'direct',
    platformLabel: 'Direct Install', detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

(async () => {
  const { launchGameFor } = loadLaunchGameModule();

  const plainAC = fakeGame({ id: 'assetto-corsa', name: 'Assetto Corsa', mercyGameId: 'assettocorsa', mercyStatus: 'supported', platform: 'steam' });
  const contentManagerAutoDetected = fakeGame({ id: 'direct-content-manager', name: 'Content Manager', category: 'launcher' });
  const contentManagerManuallyAdded = fakeGame({ id: 'manual-abc123', name: 'Content Manager', platform: 'manual' });

  // ── 1. Content Manager (auto-detected, real id shape) is selected — not
  //    plain Assetto Corsa, even though both are present. ──────────────────
  {
    let launchedId = null;
    global.window = {
      electronAPI: {
        games: {
          getCached: async () => [plainAC, contentManagerAutoDetected],
          scan: async () => [plainAC, contentManagerAutoDetected],
          launch: async (id) => { launchedId = id; return { success: true }; },
        },
      },
    };
    const result = await launchGameFor('assettocorsa');
    ok('REPRODUCED THE FIX: with both plain AC and Content Manager detected, "Launch Game" launches Content Manager', launchedId === 'direct-content-manager');
    ok('the launch call itself reports success', result.success === true);
  }

  // ── 2. A manually-added Content Manager (random manual-* id) is also
  //    recognized — matched by name, not just the auto-detected id shape. ──
  {
    let launchedId = null;
    global.window = {
      electronAPI: {
        games: {
          getCached: async () => [plainAC, contentManagerManuallyAdded],
          scan: async () => [plainAC, contentManagerManuallyAdded],
          launch: async (id) => { launchedId = id; return { success: true }; },
        },
      },
    };
    const result = await launchGameFor('assettocorsa');
    ok('a manually-added Content Manager (random id, matched by name) is selected over plain AC', launchedId === 'manual-abc123');
    ok('reports success', result.success === true);
  }

  // ── 3. Content Manager NOT detected (only plain AC present) — must be a
  //    real, useful error, never a silent launch of plain Assetto Corsa. ───
  {
    let launchCalled = false;
    global.window = {
      electronAPI: {
        games: {
          getCached: async () => [plainAC],
          scan: async () => [plainAC],
          launch: async (id) => { launchCalled = true; return { success: true }; },
        },
      },
    };
    const result = await launchGameFor('assettocorsa');
    ok('REPRODUCED THE FIX: Content Manager missing (only plain AC detected) never silently launches plain Assetto Corsa', launchCalled === false);
    ok('reports failure with notDetected set (so the UI can offer the Add Game flow)', result.success === false && result.notDetected === true);
    ok('the error message specifically names Content Manager, not a generic "AC or Content Manager" message', /Content Manager/.test(result.error || '') && /required/.test(result.error || ''));
  }

  // ── 4. Nothing at all detected — still a clean, honest "not detected". ──
  {
    global.window = {
      electronAPI: {
        games: {
          getCached: async () => [],
          scan: async () => [],
          launch: async () => ({ success: true }),
        },
      },
    };
    const result = await launchGameFor('assettocorsa');
    ok('with nothing detected at all, still a clean notDetected failure (no crash)', result.success === false && result.notDetected === true);
  }

  // ── 5. FiveM and Minecraft selection is unaffected by this change. ──────
  {
    const fivem = fakeGame({ id: 'fivem-x', name: 'FiveM', mercyGameId: 'fivem' });
    let launchedId = null;
    global.window = { electronAPI: { games: { getCached: async () => [fivem], scan: async () => [fivem], launch: async (id) => { launchedId = id; return { success: true }; } } } };
    await launchGameFor('fivem');
    ok('FiveM launch selection is unaffected', launchedId === 'fivem-x');
  }
  {
    const mcJava = fakeGame({ id: 'minecraft-launcher-x', name: 'Minecraft Launcher', mercyGameId: 'minecraft', platform: 'direct' });
    let launchedId = null;
    global.window = { electronAPI: { games: { getCached: async () => [mcJava], scan: async () => [mcJava], launch: async (id) => { launchedId = id; return { success: true }; } } } };
    await launchGameFor('minecraft', 'java');
    ok('Minecraft launch selection is unaffected', launchedId === 'minecraft-launcher-x');
  }

  delete global.window;
  console.log(`\nLAUNCH GAME — CONTENT MANAGER SELECTION TESTS: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
