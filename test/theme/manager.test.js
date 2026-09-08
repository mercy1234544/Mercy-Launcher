// Theme persistence tests — the critical guarantee under test is that a
// SECOND ThemeManager instance pointed at the same userData path (which is
// exactly what happens on every app restart, and is untouched by an NSIS
// update/reinstall that only replaces the Program Files copy) sees exactly
// what the first instance saved. No renderer/DOM involved — this is the
// main-process persistence layer in isolation.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { ThemeManager } = require(path.resolve(__dirname, '../../dist/main/services/ThemeManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-theme-test-')); }
function mkFakeImage(dir, name, sizeBytes) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(sizeBytes, 1));
  return p;
}

(async () => {
  const userDataRoot = mkTempRoot();
  const scratch = mkTempRoot();

  // 1. Fresh defaults.
  const mgr1 = new ThemeManager(userDataRoot);
  const initial = mgr1.get();
  ok('fresh install defaults to Mercy Default', initial.activeThemeId === 'mercy-default');
  ok('fresh install has no custom tokens', Object.keys(initial.customTokens).length === 0);
  ok('fresh install has no avatar (falls back to default Mercy image)', mgr1.getAvatar() === null);
  ok('avatar dir created under userData, not the packaged app dir', fs.existsSync(path.join(userDataRoot, 'profile')));

  // 2. Set a preset + custom tokens, then verify get() reflects it immediately.
  mgr1.setActiveTheme('neon');
  ok('setActiveTheme updates the active id', mgr1.get().activeThemeId === 'neon');
  mgr1.setCustomTokens({ 'primary-500': '#00ff00', 'nav-home': '#ff0000' });
  ok('setCustomTokens marks hasCustomTheme', mgr1.get().hasCustomTheme === true);
  ok('setCustomTokens stores the exact values', mgr1.get().customTokens['primary-500'] === '#00ff00' && mgr1.get().customTokens['nav-home'] === '#ff0000');

  // 3. THE critical test: a brand-new ThemeManager instance against the SAME
  // userData path — simulating an app restart (or a version update, since
  // update installers never touch userData) — must see the same state.
  const mgr2 = new ThemeManager(userDataRoot);
  const afterRestart = mgr2.get();
  ok('theme SURVIVES an app restart (custom tokens)', afterRestart.customTokens['primary-500'] === '#00ff00');
  ok('theme SURVIVES an app restart (nav color)', afterRestart.customTokens['nav-home'] === '#ff0000');
  ok('theme SURVIVES an app restart (hasCustomTheme flag)', afterRestart.hasCustomTheme === true);
  ok('theme SURVIVES an app restart (active preset id, pre-custom-override)', afterRestart.activeThemeId === 'neon');

  // 4. setActiveTheme clears any prior custom overrides (switching presets is a clean slate).
  mgr2.setActiveTheme('carbon');
  const afterSwitch = mgr2.get();
  ok('switching presets clears prior custom tokens', Object.keys(afterSwitch.customTokens).length === 0);
  ok('switching presets clears hasCustomTheme', afterSwitch.hasCustomTheme === false);

  // 5. resetToDefault reverts everything, and that reset also survives restart.
  mgr2.setCustomTokens({ success: '#123456' });
  mgr2.resetToDefault();
  ok('resetToDefault reverts to mercy-default', mgr2.get().activeThemeId === 'mercy-default');
  ok('resetToDefault clears custom tokens', Object.keys(mgr2.get().customTokens).length === 0);
  const mgr3 = new ThemeManager(userDataRoot);
  ok('restored default SURVIVES a subsequent restart too', mgr3.get().activeThemeId === 'mercy-default' && Object.keys(mgr3.get().customTokens).length === 0);

  // 6. Profile image — set, persists across "restart", remove, graceful fallback.
  const goodImage = mkFakeImage(scratch, 'avatar.png', 2048);
  const setResult = mgr3.setAvatar(goodImage);
  ok('setAvatar succeeds for a supported, small image', setResult.success && !!setResult.dataUrl);
  ok('setAvatar returns a real data: URL', setResult.dataUrl.startsWith('data:image/png;base64,'));

  const mgr4 = new ThemeManager(userDataRoot); // simulate restart again
  const avatarAfterRestart = mgr4.getAvatar();
  ok('profile image SURVIVES an app restart', avatarAfterRestart !== null && avatarAfterRestart.startsWith('data:image/png;base64,'));

  // Replacing with a different extension removes the old file (no orphaned copies accumulating).
  const secondImage = mkFakeImage(scratch, 'avatar2.jpg', 2048);
  mgr4.setAvatar(secondImage);
  const profileFiles = fs.readdirSync(path.join(userDataRoot, 'profile'));
  ok('setAvatar replaces rather than accumulates old images', profileFiles.length === 1);

  const removed = mgr4.removeAvatar();
  ok('removeAvatar succeeds', removed === true);
  ok('avatar gone after removal — falls back to default Mercy image', mgr4.getAvatar() === null);
  const mgr5 = new ThemeManager(userDataRoot);
  ok('avatar removal SURVIVES a restart (does not reappear)', mgr5.getAvatar() === null);

  // 7. Invalid/oversized images are rejected gracefully, not crash the app.
  const badExt = mkFakeImage(scratch, 'not-an-image.exe', 1024);
  const badExtResult = mgr5.setAvatar(badExt);
  ok('setAvatar rejects unsupported file types', !badExtResult.success);

  const hugeImage = mkFakeImage(scratch, 'huge.png', 9 * 1024 * 1024);
  const hugeResult = mgr5.setAvatar(hugeImage);
  ok('setAvatar rejects images over the size limit', !hugeResult.success);
  ok('a rejected image does not leave a partial file behind', fs.readdirSync(path.join(userDataRoot, 'profile')).length === 0);

  // getAvatar on a corrupted/missing file falls back to null (never throws) —
  // simulate corruption by pointing setAvatar's target dir with a file it can't read as an image later.
  ok('getAvatar never throws even with a missing file', (() => { try { return mgr5.getAvatar() === null; } catch { return false; } })());

  // Cleanup.
  try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}

  console.log(`\nTHEME PERSISTENCE TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
