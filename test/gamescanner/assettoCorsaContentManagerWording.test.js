// Assetto Corsa / Content Manager wording — a real static-source
// assertion, matching this project's existing convention for renderer
// .tsx/.ts files (no jsdom/@testing-library/react/Playwright available —
// see test/library/ui-structure.test.js's own header).
//
// THE REAL ISSUE this fixes: the Library, Home, and Assetto Corsa hub pages
// all described "server tools" as belonging to Assetto Corsa itself, with
// no mention that the actual dedicated-server tooling is built and launched
// through Content Manager (confirmed live: AssettoCorsaServerPanel.tsx
// already says exactly this internally — "Launch Assetto Corsa or Content
// Manager"). This left the Library/Home/Hub wording out of step with what
// the launcher actually does. Fixed with a targeted wording change in three
// places; no behavior change, no other game's wording touched.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const librarySrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/pages/Library.tsx'), 'utf-8');
const gamesSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/config/games.ts'), 'utf-8');
const hubSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/pages/AssettoCorsaHub.tsx'), 'utf-8');

// ── 1. Library.tsx's "Server Tools" button — the Assetto Corsa row gets a
//    distinct tooltip naming Content Manager; every other game keeps the
//    original generic tooltip, completely untouched. ───────────────────────
ok('the Server Tools button tooltip is conditional on mercyGame.id, not a single hardcoded string', /title=\{mercyGame\.id === 'assettocorsa' \?/.test(librarySrc));
ok('REPRODUCED THE FIX: the Assetto Corsa tooltip explicitly names Content Manager as what builds/launches its servers', /Assetto Corsa servers are built and launched through Content Manager/.test(librarySrc));
ok('every other game keeps the exact original generic tooltip text, unchanged', /: 'Open Mercy Server Tools'/.test(librarySrc));
ok('the visible button label is untouched (still just "Server Tools") — only the tooltip changed', /<ExternalLink size=\{12\} \/> Server Tools<\/button>/.test(librarySrc));

// ── 2. games.ts — only Assetto Corsa's tagline changed; the other three
//    games' taglines are byte-identical to before. ─────────────────────────
ok('REPRODUCED THE FIX: Assetto Corsa\'s tagline now names Content Manager', /tagline: 'Manage your Assetto Corsa servers, launched through Content Manager\.'/.test(gamesSrc));
ok('FiveM\'s tagline is untouched', /tagline: 'Manage your FiveM servers\.'/.test(gamesSrc));
ok('Minecraft\'s tagline is untouched', /tagline: 'Manage your Minecraft servers\.'/.test(gamesSrc));
ok('BeamNG.drive\'s tagline is untouched', /tagline: 'Manage your BeamNG\.drive servers\.'/.test(gamesSrc));

// ── 3. AssettoCorsaHub.tsx's page subtitle. ─────────────────────────────────
ok('REPRODUCED THE FIX: the Assetto Corsa hub subtitle names Content Manager', /subtitle="Create and manage your Assetto Corsa dedicated servers — launched through Content Manager"/.test(hubSrc));

console.log(`\nASSETTO CORSA / CONTENT MANAGER WORDING TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
