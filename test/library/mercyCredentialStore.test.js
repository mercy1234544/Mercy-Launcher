// MercyCredentialStore — real behavioral tests against the actual compiled
// main-process service (see test/presence/service.test.js for the same
// require-from-dist convention this project already uses for main-process
// code). A fake safeStorage stands in for Electron's real OS-backed
// encryption (DPAPI/Keychain/libsecret) — the class takes it as an
// injected dependency for exactly this reason (see the file's own header),
// the same pattern PresenceManager.ts uses for userDataPath instead of
// electron-store's Electron-app auto-detection.
const fs = require('fs'), path = require('path'), os = require('os');
const { MercyCredentialStore } = require(path.resolve(__dirname, '../../dist/main/services/MercyCredentialStore.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-credentials-test-')); }

// A real, working (if trivial) reversible "encryption" — proves the store
// round-trips through whatever safeStorage implementation it's given,
// without needing the real OS facility in a test environment. Real
// Electron injects the actual safeStorage at runtime (see main.ts).
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.from(`FAKE_ENCRYPTED:${plainText}`, 'utf-8'),
    decryptString: (buf) => {
      const s = buf.toString('utf-8');
      if (!s.startsWith('FAKE_ENCRYPTED:')) throw new Error('bad ciphertext');
      return s.slice('FAKE_ENCRYPTED:'.length);
    },
  };
}

(() => {
  // ── Basic save/load round trip. ──────────────────────────────────────────
  const root1 = mkTempRoot();
  const store1 = new MercyCredentialStore(root1, fakeSafeStorage());
  ok('nothing is stored initially', store1.hasStored() === false);
  ok('load() returns null when nothing is stored', store1.load() === null);

  const saved = store1.save('unlikely_youdied', 'SuperSecret123');
  ok('save() reports success when secure storage is available', saved === true);
  ok('hasStored() is true after saving', store1.hasStored() === true);

  const loaded = store1.load();
  ok('load() returns the real, correct username', loaded && loaded.username === 'unlikely_youdied');
  ok('load() returns the real, correctly decrypted password', loaded && loaded.password === 'SuperSecret123');

  ok('getStoredUsername() returns the username without needing to decrypt anything', store1.getStoredUsername() === 'unlikely_youdied');

  // ── The credential file on disk must NEVER contain the plaintext
  //    password — only the encrypted (here, fake-encrypted) ciphertext. ────
  const files = fs.readdirSync(root1).filter((f) => f.includes('mercy-credentials'));
  ok('a real credential file was actually written to disk', files.length === 1);
  const raw = fs.readFileSync(path.join(root1, files[0]), 'utf-8');
  const expectedCiphertextBase64 = Buffer.from('FAKE_ENCRYPTED:SuperSecret123', 'utf-8').toString('base64');
  ok('REPRODUCED THE FIX: the plaintext password never appears anywhere in the persisted file — only the base64-encoded ciphertext does', !raw.includes('SuperSecret123') && raw.includes(expectedCiphertextBase64));

  // ── Forget/Disconnect removes the stored credential. ─────────────────────
  store1.clear();
  ok('REPRODUCED THE FIX: clear() (Forget/Disconnect) actually removes the stored credential', store1.hasStored() === false && store1.load() === null);

  // ── Overwriting with a new save() replaces, never appends/duplicates. ────
  store1.save('userA', 'passA');
  store1.save('userB', 'passB');
  const afterOverwrite = store1.load();
  ok('saving a new credential replaces the old one, not append/duplicate', afterOverwrite.username === 'userB' && afterOverwrite.password === 'passB');
})();

(() => {
  // ── When the OS's secure storage is unavailable, credentials must NEVER
  //    be silently written in plaintext instead — save() must honestly
  //    fail, and any previously-decryptable data must not be returned. ─────
  const root2 = mkTempRoot();
  const store2 = new MercyCredentialStore(root2, fakeSafeStorage(false));
  const saveResult = store2.save('someone', 'hunter2');
  ok('REPRODUCED THE FIX: save() honestly reports failure when secure storage is unavailable, never falling back to plaintext', saveResult === false);
  ok('nothing is persisted when secure storage was unavailable at save time', store2.hasStored() === false);
})();

(() => {
  // ── A credential encrypted while secure storage was available must not
  //    be returned as if it were valid if secure storage becomes
  //    unavailable later (e.g. a different OS-level key) — never throw,
  //    never return garbage. ────────────────────────────────────────────────
  const root3 = mkTempRoot();
  const availableStorage = fakeSafeStorage(true);
  const store3 = new MercyCredentialStore(root3, availableStorage);
  store3.save('user3', 'pass3');

  // Re-open against the SAME on-disk file, but with secure storage no
  // longer available (simulating a machine/OS credential-store change).
  const store3Reopened = new MercyCredentialStore(root3, fakeSafeStorage(false));
  ok('load() returns null (never throws, never returns garbage) once secure storage is no longer available', store3Reopened.load() === null);
})();

console.log(`\nMERCY CREDENTIAL STORE TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
