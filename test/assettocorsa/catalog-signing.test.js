// Catalog signature verification: valid / tampered / wrong key / bad formats / cross-compat with the openssl
// commands the Linux side is told to use. All keys are generated here; none are real.
const crypto = require('crypto'), fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const F = require('./_acFixtures');
const { verifyCatalogSignature, parsePublicKey, parseSignatureDoc, sha256Hex } = F.dist('ac/catalogSigning.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗', n); } };

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const bytes = Buffer.from(JSON.stringify({ hello: 'world' }));
const sign = (b, keyId = 'k1', over = {}) => JSON.stringify({ alg: 'ed25519', keyId, signedAt: '2030-01-01T00:00:00Z', catalogSha256: sha256Hex(b), signature: crypto.sign(null, b, privateKey).toString('base64'), ...over });

ok('PEM key parses', !!parsePublicKey(pem));
ok('raw base64 key parses', !!parsePublicKey(raw.toString('base64')));
ok('raw base64url key parses', !!parsePublicKey(raw.toString('base64url')));
ok('garbage key rejected', parsePublicKey('hello') === null);
ok('empty key rejected', parsePublicKey('') === null);
ok('RSA PEM rejected', parsePublicKey(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' })) === null);
ok('wrong-length base64 rejected', parsePublicKey(Buffer.alloc(31).toString('base64')) === null);

const good = verifyCatalogSignature(bytes, sign(bytes), [{ keyId: 'k1', publicKey: pem }]);
ok('valid signature accepted', good.ok && good.keyId === 'k1');
ok('valid with raw-base64 pinned key', verifyCatalogSignature(bytes, sign(bytes), [{ keyId: 'k1', publicKey: raw.toString('base64') }]).ok);
ok('key rotation: second key matches', verifyCatalogSignature(bytes, sign(bytes, 'k2'), [{ keyId: 'k1', publicKey: 'AAAA' }, { keyId: 'k2', publicKey: pem }]).ok);

const tampered = Buffer.from(JSON.stringify({ hello: 'w0rld' }));
const t = verifyCatalogSignature(tampered, sign(bytes), [{ keyId: 'k1', publicKey: pem }]);
ok('tampered bytes rejected', !t.ok && t.code === 'hash-mismatch');
const t2 = verifyCatalogSignature(tampered, sign(bytes, 'k1', { catalogSha256: sha256Hex(tampered) }), [{ keyId: 'k1', publicKey: pem }]);
ok('tampered bytes with forged hash rejected by signature', !t2.ok && t2.code === 'bad-signature');
const other = crypto.generateKeyPairSync('ed25519');
ok('wrong pinned key rejected', (() => { const r = verifyCatalogSignature(bytes, sign(bytes), [{ keyId: 'k1', publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }) }]); return !r.ok && r.code === 'bad-signature'; })());
ok('unknown keyId rejected', (() => { const r = verifyCatalogSignature(bytes, sign(bytes, 'rogue'), [{ keyId: 'k1', publicKey: pem }]); return !r.ok && r.code === 'unknown-key'; })());
ok('no pinned keys rejected', (() => { const r = verifyCatalogSignature(bytes, sign(bytes), []); return !r.ok && r.code === 'no-keys'; })());
ok('invalid pinned key reported', (() => { const r = verifyCatalogSignature(bytes, sign(bytes), [{ keyId: 'k1', publicKey: 'nope' }]); return !r.ok && r.code === 'bad-key'; })());
ok('malformed sig file rejected', verifyCatalogSignature(bytes, 'not json', [{ keyId: 'k1', publicKey: pem }]).code === 'malformed');
ok('wrong alg rejected', verifyCatalogSignature(bytes, sign(bytes, 'k1', { alg: 'rsa' }), [{ keyId: 'k1', publicKey: pem }]).code === 'malformed');
ok('bad signature encoding rejected', !verifyCatalogSignature(bytes, sign(bytes, 'k1', { signature: 'AAAA' }), [{ keyId: 'k1', publicKey: pem }]).ok);
ok('oversize sig file rejected', parseSignatureDoc('x'.repeat(5000)) === null);
ok('bad keyId rejected', parseSignatureDoc(sign(bytes, '../x')) === null);
ok('truncated signature rejected', !verifyCatalogSignature(bytes, sign(bytes, 'k1', { signature: crypto.sign(null, bytes, privateKey).subarray(0, 40).toString('base64') }), [{ keyId: 'k1', publicKey: pem }]).ok);

// Cross-compat with the exact openssl commands given to the Linux side (skipped if openssl is not installed).
let opensslOk = false;
try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); opensslOk = true; } catch { /* absent */ }
if (!opensslOk) console.log('  - SKIPPED openssl cross-compat (openssl not on PATH)');
else {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-sig-'));
  try {
    const priv = path.join(d, 'k.pem'), pub = path.join(d, 'p.pem'), f = path.join(d, 'catalog.json'), sigf = path.join(d, 'raw.sig');
    execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', priv], { stdio: 'pipe' });
    execFileSync('openssl', ['pkey', '-in', priv, '-pubout', '-out', pub], { stdio: 'pipe' });
    const body = Buffer.from('{"schema":"mercy.ac.catalog","n":1}\n'); fs.writeFileSync(f, body);
    execFileSync('openssl', ['pkeyutl', '-sign', '-inkey', priv, '-rawin', '-in', f, '-out', sigf], { stdio: 'pipe' });
    const doc = JSON.stringify({ alg: 'ed25519', keyId: 'ossl', signedAt: '2030-01-01T00:00:00Z', catalogSha256: sha256Hex(body), signature: fs.readFileSync(sigf).toString('base64') });
    ok('openssl-produced signature verifies', verifyCatalogSignature(body, doc, [{ keyId: 'ossl', publicKey: fs.readFileSync(pub, 'utf8') }]).ok);
    ok('openssl signature fails on a changed byte', !verifyCatalogSignature(Buffer.concat([body, Buffer.from(' ')]), doc, [{ keyId: 'ossl', publicKey: fs.readFileSync(pub, 'utf8') }]).ok);
  } catch (e) { fail++; console.log('  ✗ openssl cross-compat threw', String(e.message).slice(0, 200)); }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
}

console.log(`\nAC CATALOG SIGNING TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
