// Theme preset tests — validates the real THEMES data (src/renderer/config/
// themes.ts) rather than mocking it. That file is renderer-only (not
// compiled by tsconfig.main.json, so there's no dist/ output to require()
// the way main-process services are tested elsewhere in this project) and
// has zero imports of its own, so it's transpiled in-memory here via the
// `typescript` package already a devDependency — no new test framework, no
// new dependency, same plain node + assert convention as every other test
// in this repo.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const ts = require('typescript');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function loadThemesModule() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/config/themes.ts'), 'utf-8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const moduleObj = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(moduleObj, moduleObj.exports, require);
  return moduleObj.exports;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;
const RGBA_RE = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)$/;
function isValidColor(v) { return typeof v === 'string' && (HEX_RE.test(v) || RGBA_RE.test(v)); }

(() => {
  const { THEMES, getTheme, NAV_COLOR_TARGETS, CUSTOMIZABLE_TOKEN_GROUPS } = loadThemesModule();

  // ── Existing presets untouched (regression guard) ─────────────────────
  const existingIds = ['mercy-default', 'midnight', 'carbon', 'neon', 'minimal', 'light'];
  for (const id of existingIds) {
    ok(`existing preset "${id}" is still present`, THEMES.some((t) => t.id === id));
  }
  ok('getTheme("mercy-default") still returns the real Mercy Default preset', getTheme('mercy-default').name === 'Mercy Default');
  ok('getTheme falls back to the default for an unknown id (never throws/undefined)', getTheme('does-not-exist')?.id === 'mercy-default');

  // ── The 12 new presets are all present, exactly once each ─────────────
  const newIds = ['lava', 'royal', 'forest', 'cyberpunk', 'abyss', 'sandstone', 'vaporwave', 'terminal', 'paper', 'solar', 'graphite', 'obsidian'];
  for (const id of newIds) {
    const matches = THEMES.filter((t) => t.id === id);
    ok(`new preset "${id}" exists`, matches.length === 1);
  }
  ok('total theme count is exactly 6 existing + 12 new = 18', THEMES.length === 18);

  const allIds = THEMES.map((t) => t.id);
  ok('no duplicate theme ids across the whole THEMES array', allIds.length === new Set(allIds).size);

  // ── Every theme (old and new) has a real, complete token set ──────────
  const requiredKeys = Object.keys(getTheme('mercy-default').tokens);
  ok('sanity: mercy-default itself has a non-trivial number of real token keys', requiredKeys.length > 30);
  for (const t of THEMES) {
    const missing = requiredKeys.filter((k) => t.tokens[k] === undefined || t.tokens[k] === '');
    ok(`"${t.id}" has every required ThemeTokens key present and non-empty`, missing.length === 0);
    const invalid = requiredKeys.filter((k) => !isValidColor(t.tokens[k]));
    ok(`"${t.id}" has only real hex/rgba color values, never a fabricated/malformed one`, invalid.length === 0);
    ok(`"${t.id}" has a real name and description`, typeof t.name === 'string' && t.name.length > 0 && typeof t.description === 'string' && t.description.length > 0);
    ok(`"${t.id}" swatch is exactly 3 real colors`, Array.isArray(t.swatch) && t.swatch.length === 3 && t.swatch.every(isValidColor));
  }

  // ── Real, non-fabricated color science: an achromatic named color (Light
  // Grey / Dark Grey / Black / White / Crisp White) must produce a genuinely
  // neutral (near-zero saturation) generated scale, not a color-tinted one
  // — this is the actual bug this test suite would have caught before
  // release (a plain HSL saturation floor turned "Crisp White" pink). ──────
  function approxHueless(hex) {
    const m = hex.replace('#', '');
    const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
    return Math.max(r, g, b) - Math.min(r, g, b) <= 10; // small channel spread = looks grey to the eye
  }
  const obsidian = getTheme('obsidian');
  ok('Obsidian\'s generated primary-500 is genuinely neutral grey, not tinted pink/red by an HSL hue default', approxHueless(obsidian.tokens['primary-500']));
  ok('Obsidian\'s generated primary-50 is genuinely neutral', approxHueless(obsidian.tokens['primary-50']));
  ok('Obsidian\'s generated surface-800 is genuinely neutral, not tinted', approxHueless(obsidian.tokens['surface-800']));
  const graphite = getTheme('graphite');
  ok('Graphite\'s primary-500 matches its own real seed color (#9ca3af), not amplified into an unrelated hue', graphite.tokens['primary-500'].toLowerCase() === '#9ca3af');
  ok('Graphite\'s generated surfaces are genuinely neutral grey', approxHueless(graphite.tokens['surface-800']) && approxHueless(graphite.tokens['surface-900']));

  // ── A vivid named color (e.g. Lava's Orange) must actually stay vivid —
  // guards the opposite failure mode (over-correcting the fix above into
  // desaturating every real color). ──────────────────────────────────────
  const lava = getTheme('lava');
  ok('Lava\'s primary-500 is the real, undiluted Orange seed color', lava.tokens['primary-500'].toLowerCase() === '#f97316');
  ok('Lava\'s primary-500 is NOT desaturated toward grey', !approxHueless(lava.tokens['primary-500']));

  // ── Light-theme presets (Paper, Solar) actually read as light, not dark ─
  function relativeLuminance(hex) {
    const m = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  for (const id of ['paper', 'solar']) {
    const t = getTheme(id);
    ok(`"${id}" bg-base is genuinely light (high luminance), a real light theme`, relativeLuminance(t.tokens['bg-base']) > 0.7);
    ok(`"${id}" text-primary is genuinely dark (readable on a light background)`, relativeLuminance(t.tokens['text-primary']) < 0.4);
  }
  // ── Dark-themed presets actually read as dark ─────────────────────────
  for (const id of ['lava', 'royal', 'forest', 'cyberpunk', 'abyss', 'sandstone', 'vaporwave', 'terminal', 'graphite', 'obsidian']) {
    const t = getTheme(id);
    ok(`"${id}" bg-base is genuinely dark (low luminance), a real dark theme`, relativeLuminance(t.tokens['bg-base']) < 0.15);
  }

  // ── Existing consumers of THEMES (Settings.tsx, useTheme.ts) rely on
  // these exports remaining stable in shape — never removed/renamed by
  // this change. ─────────────────────────────────────────────────────────
  ok('NAV_COLOR_TARGETS is still exported and non-empty', Array.isArray(NAV_COLOR_TARGETS) && NAV_COLOR_TARGETS.length > 0);
  ok('CUSTOMIZABLE_TOKEN_GROUPS is still exported and non-empty', Array.isArray(CUSTOMIZABLE_TOKEN_GROUPS) && CUSTOMIZABLE_TOKEN_GROUPS.length > 0);

  console.log(`\nTHEME PRESET TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
