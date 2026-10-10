// The published contract is only useful if it is true: the JSON Schema must agree with the validator the launcher
// actually runs, the example file must be unmistakably an example, the snippets in the contract must parse, and no
// release-facing file may carry a private address. A tiny draft-07 subset validator (below) exercises the schema file.
const fs = require('fs'), path = require('path');
const F = require('./_acFixtures');
const { validCatalog } = require('./_catalogFixtures');
const { validateCatalog, isPrivateOrLocalString } = F.dist('ac/catalogSchema.js');
const { checkBaseUrl } = F.dist('ac/catalogClient.js');
const { parsePublicKey } = F.dist('ac/catalogSigning.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };
const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');

// ── mini JSON-schema (draft-07 subset: enough for our schema) ────────────────
function check(schema, value, root, p = '$') {
  const errs = [];
  if (schema.$ref) { const name = schema.$ref.replace('#/definitions/', ''); return check(root.definitions[name], value, root, p); }
  const typeOk = (t) => t === 'null' ? value === null : t === 'array' ? Array.isArray(value) : t === 'integer' ? Number.isInteger(value) : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === t;
  if (schema.const !== undefined && value !== schema.const) errs.push(`${p}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${p}: not in enum`);
  if (schema.type) { const ts = [].concat(schema.type); if (!ts.some(typeOk)) { errs.push(`${p}: wrong type`); return errs; } }
  if (schema.oneOf) { const n = schema.oneOf.filter((s) => check(s, value, root, p).length === 0).length; if (n !== 1) errs.push(`${p}: matches ${n} of oneOf`); }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${p}: pattern`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${p}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${p}: too long`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${p}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${p}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${p}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${p}: too many items`);
    if (schema.items) value.forEach((v, i) => errs.push(...check(schema.items, v, root, `${p}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required ?? []) if (!(r in value)) errs.push(`${p}.${r}: required`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in value) errs.push(...check(s, value[k], root, `${p}.${k}`));
  }
  return errs;
}

(async () => {
  const schema = JSON.parse(read('docs/ac-catalog.schema.json'));
  ok('schema parses and is draft-07', schema.$schema === 'http://json-schema.org/draft-07/schema#' && !!schema.definitions.server && !!schema.definitions.archive);
  const sOk = (c) => check(schema, c, schema).length === 0;

  // ── schema ⇄ validator agreement on the shared fixture set ──────────────────
  const cases = [
    ['valid catalog', null, true],
    ['wrong schema id', (c) => { c.schema = 'x'; }, false],
    ['missing servers', (c) => { delete c.servers; }, false],
    ['bad revision', (c) => { c.catalog.revision = -3; }, false],
    ['bad environment', (c) => { c.catalog.environment = 'staging'; }, false],
    ['unknown major', (c) => { c.schemaVersion = '2.0.0'; }, false],
    ['archive sha not hex', (c) => { c.archives[0].sha256 = 'zz'; }, false],
    ['archive too large', (c) => { c.archives[0].bytes = 17 * 1024 ** 3; }, false],
    ['archive http url', (c) => { c.archives[0].url = 'http://dl.example.com/a.7z'; }, false],
    ['archive bad format', (c) => { c.archives[0].format = 'exe'; }, false],
    ['archive bad redistribution', (c) => { c.archives[0].redistribution = 'maybe'; }, false],
    ['archive allowedHosts wildcard', (c) => { c.archives[0].allowedHosts = ['*.example.com']; }, false],
    ['car id traversal', (c) => { c.content.cars[0].id = '..'; }, false],
    ['car id slash', (c) => { c.content.cars[0].id = 'a/b'; }, false],
    ['origin path traversal', (c) => { c.content.cars[0].origin.path = '../../x'; }, false],
    ['origin path absolute', (c) => { c.content.cars[0].origin.path = '/etc/x'; }, false],
    ['origin unknown kind', (c) => { c.content.cars[0].origin.kind = 'script'; }, false],
    ['manual origin without instructions', (c) => { c.content.cars[0].origin = { kind: 'manual' }; }, false],
    ['track marker hash bad', (c) => { c.content.tracks[0].verify.markerSha256 = 'abc'; }, false],
    ['track without layouts', (c) => { c.content.tracks[0].layouts = []; }, false],
    ['port out of range', (c) => { c.servers[0].connection.public.gamePort = 70000; }, false],
    ['host with scheme', (c) => { c.servers[0].connection.public.host = 'https://x'; }, false],
    ['server without tracks', (c) => { c.servers[0].tracks = []; }, false],
    ['bad car role', (c) => { c.servers[0].cars[0].role = 'admin'; }, false],
    ['csp bad version', (c) => { c.servers[0].requirements.csp.minimumVersion = 'latest'; }, false],
    ['csp missing', (c) => { delete c.servers[0].requirements; }, false],
    ['bad hud', (c) => { c.servers[0].hud = { delivery: 'exe', version: '1' }; }, false],
    ['bad status', (c) => { c.servers[0].status = 'nuked'; }, false],
    ['csp null is fine', (c) => { c.servers[0].requirements.csp = null; }, true],
    ['public null is fine', (c) => { c.servers[0].connection.public = null; }, true],
    ['public null + ports is fine', (c) => { c.servers[0].connection.public = null; c.servers[0].connection.ports = { gamePort: 9600, httpPort: 8081 }; }, true],
    ['default layout is fine', (c) => { c.content.tracks[0].layouts = [{ config: '' }]; c.servers[0].tracks = [{ trackId: 'trk_one', layouts: [''] }]; }, true],
    ['optional track is fine', (c) => { c.servers[0].tracks[0].required = false; }, true],
    ['dlc origin is fine', (c) => { c.content.cars[0].origin = { kind: 'dlc', name: 'Pack' }; }, true],
  ];
  for (const [name, mut, expectValid] of cases) {
    const c = validCatalog(mut ?? undefined);
    const byValidator = validateCatalog(c).ok, bySchema = sOk(c);
    ok(`agreement: ${name} (validator ${byValidator ? 'accepts' : 'rejects'}, schema ${bySchema ? 'accepts' : 'rejects'})`, byValidator === expectValid && bySchema === expectValid);
  }
  // A real JSON-schema engine (Ajv, present in node_modules as a transitive dependency) must read the schema file the
  // same way the little checker above does — otherwise the checker would be proving nothing about the published file.
  let Ajv = null; try { Ajv = require('ajv'); } catch { /* optional */ }
  if (!Ajv) console.log('  - SKIPPED Ajv cross-check (ajv not installed)');
  else {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    for (const [name, mut] of cases) { const c = validCatalog(mut ?? undefined); ok(`ajv agrees with the mini checker: ${name}`, validate(c) === sOk(c)); }
    ok('ajv accepts the published example file', validate(JSON.parse(read('docs/examples/ac-catalog.example.json'))));
  }
  // Rules a schema cannot express are the validator's job — they must still be rejected there.
  ok('validator-only rule: dangling car reference', !validateCatalog(validCatalog((c) => { c.servers[0].cars.push({ carId: 'ghost', role: 'player' }); })).ok);
  ok('validator-only rule: URL host outside allowedHosts', !validateCatalog(validCatalog((c) => { c.archives[0].url = 'https://evil.example.net/a.7z'; })).ok);
  ok('validator-only rule: LAN address in production', !validateCatalog(validCatalog((c) => { c.servers[0].connection.public.host = '192.168.1.5'; })).ok);
  ok('schema documents that it is not the whole contract', /ALSO enforces rules a JSON Schema cannot express/.test(schema.description));

  // ── the example file ────────────────────────────────────────────────────────
  const exTxt = read('docs/examples/ac-catalog.example.json'); const ex = JSON.parse(exTxt);
  ok('example is flagged example:true and says EXAMPLE ONLY', ex.example === true && /EXAMPLE ONLY/.test(ex.notice));
  ok('example is refused as live data by the launcher', !validateCatalog(ex).ok && validateCatalog(ex).errors.some((e) => /EXAMPLE/.test(e)));
  ok('example conforms to the published schema', check(schema, ex, schema).length === 0);
  const stripped = JSON.parse(exTxt); delete stripped.example;
  const sv = validateCatalog(stripped);
  ok('example is internally consistent (valid once the example flag is removed)', sv.ok);
  if (!sv.ok) console.log('   ', sv.errors.slice(0, 4));
  ok('example has no download URLs, no public endpoints and no authorised redistribution', ex.archives.every((a) => a.url === null && a.redistribution === 'none') && ex.servers.every((s) => s.connection.public === null));
  ok('example carries no private address', !isPrivateOrLocalString(exTxt));
  ok('example lists the two existing servers', ex.servers.map((s) => s.id).join() === 'main,server2');

  // ── the contract text ───────────────────────────────────────────────────────
  const doc = read('docs/ASSETTO_CORSA_CATALOG_CONTRACT.md');
  ok('contract names every route and the file formats', ['/catalog.json', '/catalog.json.sig', '/health.json'].every((r) => doc.includes(r)) && /Ed25519/.test(doc) && /ETag|If-None-Match/.test(doc));
  ok('contract gives the exact openssl signing commands that the signing test verifies', /openssl genpkey -algorithm ed25519/.test(doc) && /openssl pkey -in .* -pubout/.test(doc) && /openssl pkeyutl -sign -rawin/.test(doc));
  ok('contract forbids exposing the dashboard / admin / private key', /8787|dashboard/i.test(doc) && /private/i.test(doc) && /never copied to Windows|NOT in any web root/i.test(doc));
  ok('contract states LAN is development-only and never in production', /Production/.test(doc) && /connection\.lan/.test(doc) && /forbidden/.test(doc));
  ok('contract documents connection.ports and the policy table', /connection\.ports|"ports"/.test(doc) && /Client policy/.test(doc));
  ok('contract points at the schema and the example file that exist', /docs\/ac-catalog\.schema\.json/.test(doc) && /docs\/examples\/ac-catalog\.example\.json/.test(doc));
  const m = /## 11\. EXAMPLE ONLY[\s\S]*?```json\n([\s\S]*?)\n```/.exec(doc);
  let snippet = null; try { snippet = m ? JSON.parse(m[1].replace(/<64 hex>/g, 'a'.repeat(64))) : null; } catch { /* reported below */ }
  ok('the inline contract example parses as JSON and is marked example:true', !!snippet && snippet.example === true);
  ok('the inline contract example is refused by the launcher (never mistaken for live data)', !!snippet && !validateCatalog(snippet).ok);

  // ── release-facing data ─────────────────────────────────────────────────────
  const cfg = JSON.parse(read('src/main/data/assettocorsa-srp/catalog.config.json'));
  ok('release catalog address is null or a public https URL (never private)', cfg.baseUrl === null || (checkBaseUrl(cfg.baseUrl).ok && checkBaseUrl(cfg.baseUrl).privateHost === false && /^https:/.test(cfg.baseUrl)));
  ok('release trusted keys are valid PUBLIC Ed25519 keys', Array.isArray(cfg.trustedKeys) && cfg.trustedKeys.every((k) => /^[A-Za-z0-9._-]{1,64}$/.test(k.keyId) && !!parsePublicKey(k.publicKey) && !/PRIVATE/.test(k.publicKey)));
  ok('nothing is invented: no catalog address and no key are shipped until the owner supplies them', cfg.baseUrl === null && cfg.trustedKeys.length === 0);
  const rel = JSON.parse(read('src/main/data/assettocorsa-srp/endpoints.public.json'));
  ok('release endpoints still hold no private address', Object.values(rel.servers).every((s) => s.host === null || !isPrivateOrLocalString(s.host)));
  const scan = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) scan(p, out); else if (/\.(ts|tsx|json|md)$/.test(e.name)) out.push(p); } return out; };
  const files = [...scan(path.join(ROOT, 'src/main/data')), ...scan(path.join(ROOT, 'src/main/services/ac')), ...scan(path.join(ROOT, 'src/renderer/components/ac')), path.join(ROOT, 'docs/ASSETTO_CORSA_CATALOG_CONTRACT.md'), path.join(ROOT, 'docs/ac-catalog.schema.json'), path.join(ROOT, 'docs/examples/ac-catalog.example.json')];
  const leaks = files.filter((f) => /\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/.test(fs.readFileSync(f, 'utf8')));
  ok(`no private address in ${files.length} release-facing source/doc/data files`, leaks.length === 0);
  if (leaks.length) console.log('   leaks in:', leaks.map((f) => path.relative(ROOT, f)));

  console.log(`\nAC CATALOG DOCS + RELEASE DATA TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
