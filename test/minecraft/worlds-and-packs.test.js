// Worlds + Bedrock Resource/Behavior Pack tests — deterministic, no network,
// no real Minecraft process (pure filesystem + real zip archives). Only
// ever touches disposable temp directories, never a production server.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const archiver = require('archiver');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-worldpack-test-')); }

function zipDir(sourceDir, destZip, rootName) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destZip);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    if (rootName) archive.directory(sourceDir, rootName); else archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function mkJavaServer(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.jar'), 'fake jar');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${port}\nlevel-name=world\n`);
}

function mkBedrockServer(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bedrock_server.exe'), 'fake exe');
  fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${port}\nlevel-name=Bedrock level\n`);
}

function mkJavaWorldFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'level.dat'), Buffer.from([0x1f, 0x8b, 0, 0])); // fake NBT/gzip header bytes
  fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'region', 'r.0.0.mca'), 'fake region data');
}

function mkBedrockWorldFixture(dir) {
  fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'db', 'CURRENT'), 'fake leveldb marker');
  fs.writeFileSync(path.join(dir, 'level.dat'), Buffer.from([1, 2, 3, 4])); // Bedrock's own (different) level.dat format
  fs.writeFileSync(path.join(dir, 'levelname.txt'), 'Fixture World');
}

function mkBedrockPackFixture(dir, { uuid, version = [1, 0, 0], name = 'Test Pack' }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    format_version: 2,
    header: { name, description: 'A disposable test pack', uuid, version, min_engine_version: [1, 20, 0] },
    modules: [{ type: 'resources', uuid: 'a1b2c3d4-e5f6-4789-a012-3456789abcde', version }],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'pack_icon.png'), 'fake png bytes');
}

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();

  try {
    const mgr = new MinecraftManager(userDataRoot);

    // ══════════════════════════ WORLDS ══════════════════════════
    console.log('--- Worlds ---');

    // Java server + world fixture, registered via the real importer.
    const javaDir = path.join(base, 'java-server');
    mkJavaServer(javaDir, 25901);
    mkJavaWorldFixture(path.join(javaDir, 'world'));
    const javaImp = await mgr.importServer(javaDir, 'Java World Test', 1024);
    ok('Java server import succeeds', javaImp.success === true);
    const javaId = javaImp.server.id;

    const worldInfo1 = mgr.getWorldInfo(javaId);
    ok('getWorldInfo finds the real Java world', worldInfo1.exists === true && worldInfo1.levelName === 'world');
    ok('getWorldInfo reports a real, non-zero size', typeof worldInfo1.sizeBytes === 'number' && worldInfo1.sizeBytes > 0);
    ok('getWorldInfo reports the correct edition', worldInfo1.edition === 'java');

    // EXPORT: real zip, containing the real level.dat.
    const exportPath1 = path.join(base, 'java-world-export.zip');
    const exportResult1 = await mgr.exportWorld(javaId, exportPath1);
    ok('exportWorld succeeds', exportResult1.success === true);
    ok('exported file genuinely exists and is non-empty', fs.existsSync(exportPath1) && fs.statSync(exportPath1).size > 0);

    // Re-extract the exported zip elsewhere and verify it's genuinely usable
    // outside Mercy (real level.dat present, no unrelated server files).
    const extractZip = require(path.resolve(__dirname, '../../node_modules/extract-zip'));
    const reExtractDir = path.join(base, 're-extracted-java-world');
    await extractZip(exportPath1, { dir: reExtractDir });
    ok('re-extracted export contains the real world folder with level.dat', fs.existsSync(path.join(reExtractDir, 'world', 'level.dat')));
    ok('re-extracted export does NOT include unrelated server files (server.jar)', !fs.existsSync(path.join(reExtractDir, 'world', 'server.jar')) && !fs.existsSync(path.join(reExtractDir, 'server.jar')));

    // IMPORT (edition mismatch): a real Java world zip must be refused for a Bedrock server.
    const bedrockDir = path.join(base, 'bedrock-server');
    mkBedrockServer(bedrockDir, 25902);
    const bedrockImp = await mgr.importServer(bedrockDir, 'Bedrock World Test', 0);
    ok('Bedrock server import succeeds', bedrockImp.success === true);
    const bedrockId = bedrockImp.server.id;

    const mismatchResult = await mgr.importWorld(bedrockId, exportPath1, true);
    ok('importWorld REFUSES a Java world onto a Bedrock server', mismatchResult.success === false);
    ok('the refusal correctly identifies the real detected edition', mismatchResult.detectedEdition === 'java');
    ok('no world was actually installed on the mismatched Bedrock server', !mgr.getWorldInfo(bedrockId).exists);

    // IMPORT (correct edition, world folder as top-level zip entry — the
    // shape exportWorld() itself produces): a second Java server, no
    // existing world yet, no confirmation needed.
    const javaDir2 = path.join(base, 'java-server-2');
    mkJavaServer(javaDir2, 25903);
    const javaImp2 = await mgr.importServer(javaDir2, 'Java World Import Target', 1024);
    const javaId2 = javaImp2.server.id;
    ok('second Java server has no world yet', mgr.getWorldInfo(javaId2).exists === false);

    const importResult1 = await mgr.importWorld(javaId2, exportPath1, false);
    ok('importWorld succeeds onto a server with no existing world (no confirmation needed)', importResult1.success === true);
    ok('the real level.dat now exists in the target server\'s world folder', fs.existsSync(path.join(javaDir2, 'world', 'level.dat')));

    // REPLACE-CONFIRMATION: importing again (world now exists) without
    // confirmReplace must ask first, and must NOT touch the existing world.
    const beforeReplaceContent = fs.readFileSync(path.join(javaDir2, 'world', 'level.dat'));
    const needsConfirm = await mgr.importWorld(javaId2, exportPath1, false);
    ok('re-importing onto an existing world without confirmReplace asks for confirmation', needsConfirm.success === false && needsConfirm.needsConfirmation === true);
    ok('the existing world was NOT touched while awaiting confirmation', fs.readFileSync(path.join(javaDir2, 'world', 'level.dat')).equals(beforeReplaceContent));

    // Now confirm the replace — must back up the existing world first (real,
    // registered backup, not a silent overwrite) then proceed.
    const backupsBefore = mgr.listBackups(javaId2).length;
    const confirmedReplace = await mgr.importWorld(javaId2, exportPath1, true);
    ok('confirmed replace succeeds', confirmedReplace.success === true);
    const backupsAfter = mgr.listBackups(javaId2);
    ok('a real pre-replace backup was registered (same Backups list the UI already shows)', backupsAfter.length === backupsBefore + 1);
    ok('the pre-replace backup is a real, non-empty zip file', fs.existsSync(backupsAfter[backupsAfter.length - 1].path) && fs.statSync(backupsAfter[backupsAfter.length - 1].path).size > 0);

    // AMBIGUOUS / INVALID ARCHIVE: a zip with neither a real level.dat nor a
    // Bedrock db/ folder must be honestly rejected, never guessed.
    const junkDir = path.join(base, 'junk-world-src');
    fs.mkdirSync(junkDir, { recursive: true });
    fs.writeFileSync(path.join(junkDir, 'notes.txt'), 'not a world at all');
    const junkZip = path.join(base, 'junk-world.zip');
    await zipDir(junkDir, junkZip, false);
    const junkResult = await mgr.importWorld(javaId2, junkZip, true);
    ok('importWorld rejects an archive with no recognizable world signature', junkResult.success === false && !junkResult.needsConfirmation);

    // TRAVERSAL-SHAPED ARCHIVE: an entry whose name tries to escape the
    // extraction directory must NEVER end up outside it. Verified
    // experimentally (see the session's own diagnosis) that extract-zip's
    // real zip-slip protection works by NORMALIZING an entry like
    // "../../foo.txt" down to "foo.txt" at the destination root, rather
    // than throwing — a different but equally safe mitigation strategy
    // from Mercy's own defense-in-depth assertNoTraversal() (which handles
    // the case where an entry somehow still resolves outside root). Either
    // way, the one guarantee that actually matters — nothing is EVER
    // written outside the intended temp/server directories — must hold,
    // regardless of which layer neutralized the attempt or whether the
    // now-harmless extra file ends up safely inside the imported world.
    const traversalZip = path.join(base, 'traversal-world.zip');
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(traversalZip);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append(Buffer.from('evil'), { name: '../../mercy-traversal-canary.txt' });
      archive.append(Buffer.from('fake'), { name: 'level.dat' });
      archive.finalize();
    });
    const canaryOutsideBase = path.resolve(base, '..', '..', 'mercy-traversal-canary.txt');
    const canaryOutsideUserData = path.resolve(userDataRoot, '..', 'mercy-traversal-canary.txt');
    await mgr.importWorld(javaId2, traversalZip, true);
    ok('the traversal entry never escaped to a sibling of the test\'s own temp base dir', !fs.existsSync(canaryOutsideBase));
    ok('the traversal entry never escaped to a sibling of userData (where the real temp-extraction dir lives)', !fs.existsSync(canaryOutsideUserData));
    ok('no trace of the traversal canary exists anywhere under the real Minecraft install directories tracked by this test', !fs.existsSync(path.join(base, '..', 'mercy-traversal-canary.txt')));

    // ══════════════════════════ BEDROCK PACKS ══════════════════════════
    console.log('--- Bedrock Resource/Behavior Packs ---');

    ok('no packs listed before anything is installed', mgr.listBedrockPacks(bedrockId, 'resource_packs').length === 0);

    // INSTALL: real manifest.json with a real, valid UUID + version.
    const packUuidA = 'a0b1c2d3-1111-4a2b-8c3d-4e5f6a7b8c9d';
    const packSrcA = path.join(base, 'pack-a-src');
    mkBedrockPackFixture(packSrcA, { uuid: packUuidA, version: [1, 2, 0], name: 'Canary Resource Pack' });
    const packZipA = path.join(base, 'pack-a.zip');
    await zipDir(packSrcA, packZipA, false);

    const installA = await mgr.installBedrockPack(bedrockId, 'resource_packs', packZipA);
    ok('installBedrockPack succeeds for a real, valid manifest', installA.success === true);
    ok('the pack\'s real folder now exists under resource_packs/', fs.existsSync(path.join(bedrockDir, 'resource_packs', installA.folderName, 'manifest.json')));

    const listedA = mgr.listBedrockPacks(bedrockId, 'resource_packs');
    ok('listBedrockPacks finds the real installed pack', listedA.length === 1 && listedA[0].uuid === packUuidA);
    ok('listBedrockPacks reads the real name/version from the manifest', listedA[0].name === 'Canary Resource Pack' && listedA[0].version === '1.2.0');
    ok('a freshly-installed pack is NOT enabled just because its folder exists', listedA[0].enabled === false);
    ok('listBedrockPacks reports it as valid (real manifest)', listedA[0].valid === true);

    // Install a SECOND pack to prove enabling one never disturbs the other.
    const packUuidB = 'b1c2d3e4-2222-4a2b-8c3d-4e5f6a7b8c9d';
    const packSrcB = path.join(base, 'pack-b-src');
    mkBedrockPackFixture(packSrcB, { uuid: packUuidB, version: [2, 0, 0], name: 'Second Pack' });
    const packZipB = path.join(base, 'pack-b.zip');
    await zipDir(packSrcB, packZipB, false);
    const installB = await mgr.installBedrockPack(bedrockId, 'resource_packs', packZipB);
    ok('second pack installs into its own distinct folder (no collision with the first)', installB.success === true && installB.folderName !== installA.folderName);

    // ENABLE pack A only.
    const enableA = mgr.setBedrockPackEnabled(bedrockId, 'resource_packs', packUuidA, [1, 2, 0], true);
    ok('setBedrockPackEnabled(A, true) succeeds', enableA.success === true);
    let afterEnableA = mgr.listBedrockPacks(bedrockId, 'resource_packs');
    ok('pack A is now enabled', afterEnableA.find((p) => p.uuid === packUuidA).enabled === true);
    ok('pack B is UNCHANGED (still disabled) — enabling A never touched B\'s entry', afterEnableA.find((p) => p.uuid === packUuidB).enabled === false);

    // Enable pack B too, then disable A — B must remain enabled (proves
    // toggling one entry never blindly rewrites the whole activation list).
    mgr.setBedrockPackEnabled(bedrockId, 'resource_packs', packUuidB, [2, 0, 0], true);
    const disableA = mgr.setBedrockPackEnabled(bedrockId, 'resource_packs', packUuidA, [1, 2, 0], false);
    ok('setBedrockPackEnabled(A, false) succeeds', disableA.success === true);
    const afterDisableA = mgr.listBedrockPacks(bedrockId, 'resource_packs');
    ok('pack A is now disabled', afterDisableA.find((p) => p.uuid === packUuidA).enabled === false);
    ok('pack B remains enabled — disabling A did not disturb B\'s own activation entry', afterDisableA.find((p) => p.uuid === packUuidB).enabled === true);

    // A backup of the activation file must have been made before each edit.
    const activationFile = path.join(bedrockDir, 'worlds', 'Bedrock level', 'world_resource_packs.json');
    ok('the real world_resource_packs.json activation file exists', fs.existsSync(activationFile));
    ok('a .bak backup was made before editing the activation file', fs.existsSync(`${activationFile}.bak`));

    // INVALID PACK: missing manifest.json, or a manifest with a garbage UUID.
    const noManifestDir = path.join(bedrockDir, 'resource_packs', 'no-manifest-pack');
    fs.mkdirSync(noManifestDir, { recursive: true });
    const listedWithInvalid = mgr.listBedrockPacks(bedrockId, 'resource_packs');
    ok('a pack folder with no manifest.json is listed as invalid, not silently skipped or treated as valid', listedWithInvalid.find((p) => p.folderName === 'no-manifest-pack')?.valid === false);

    const badUuidZipSrc = path.join(base, 'bad-uuid-pack-src');
    fs.mkdirSync(badUuidZipSrc, { recursive: true });
    fs.writeFileSync(path.join(badUuidZipSrc, 'manifest.json'), JSON.stringify({ header: { name: 'Bad', uuid: 'not-a-real-uuid', version: [1, 0, 0] } }));
    const badUuidZip = path.join(base, 'bad-uuid-pack.zip');
    await zipDir(badUuidZipSrc, badUuidZip, false);
    const installBad = await mgr.installBedrockPack(bedrockId, 'resource_packs', badUuidZip);
    ok('installBedrockPack REJECTS a manifest with an invalid UUID rather than installing it', installBad.success === false);

    // JSONC MANIFEST: Mojang's own shipped default packs (e.g. the "chemistry"
    // packs bundled with every real Bedrock Dedicated Server download) use
    // `//` comments inside manifest.json, which strict JSON.parse rejects.
    // A genuinely valid, real Mojang manifest must not be misreported as
    // invalid just because it has comments.
    const commentPackUuid = 'c0ffee00-1111-4222-8333-444455556666';
    const commentPackSrc = path.join(base, 'comment-pack-src');
    fs.mkdirSync(commentPackSrc, { recursive: true });
    fs.writeFileSync(path.join(commentPackSrc, 'manifest.json'), [
      '{',
      '  "format_version": 2,',
      '  "header": {',
      '    // this is a real Mojang-style inline comment',
      '    "description": "pack.description",',
      '    "name": "pack.name",',
      `    "uuid": "${commentPackUuid}",`,
      '    "version": [ 1, 0, 0 ]',
      '  },',
      '  "modules": [',
      '    { /* block comment */ "type": "resources", "uuid": "d1e2f3a4-b5c6-4789-a012-3456789abcde", "version": [1, 0, 0] }',
      '  ]',
      '}',
    ].join('\n'));
    const commentPackZip = path.join(base, 'comment-pack.zip');
    await zipDir(commentPackSrc, commentPackZip, false);
    const installComment = await mgr.installBedrockPack(bedrockId, 'resource_packs', commentPackZip);
    ok('installBedrockPack accepts a real Mojang-style manifest.json containing // and /* */ comments', installComment.success === true);
    const listedWithComment = mgr.listBedrockPacks(bedrockId, 'resource_packs');
    const commentPackEntry = listedWithComment.find((p) => p.uuid === commentPackUuid);
    ok('the comment-containing manifest is listed as valid (not "manifest.json is not valid JSON")', commentPackEntry?.valid === true);
    ok('its real name/version were still correctly read despite the comments', commentPackEntry?.name === 'pack.name' && commentPackEntry?.version === '1.0.0');
    mgr.removeBedrockPack(bedrockId, 'resource_packs', installComment.folderName, commentPackUuid);

    // REMOVE: pack A's folder + activation entries genuinely disappear; pack B untouched.
    const removeA = mgr.removeBedrockPack(bedrockId, 'resource_packs', installA.folderName, packUuidA);
    ok('removeBedrockPack succeeds', removeA.success === true);
    ok('pack A\'s real folder is genuinely gone', !fs.existsSync(path.join(bedrockDir, 'resource_packs', installA.folderName)));
    const afterRemoveA = mgr.listBedrockPacks(bedrockId, 'resource_packs');
    ok('pack A no longer appears in the list at all', !afterRemoveA.some((p) => p.uuid === packUuidA));
    ok('pack B (unrelated pack) is fully preserved after removing A', afterRemoveA.find((p) => p.uuid === packUuidB)?.enabled === true);

    // BEHAVIOR PACKS use a completely separate folder/activation file —
    // confirm resource_packs activity never leaks into behavior_packs.
    ok('behavior_packs starts empty independent of resource_packs installs', mgr.listBedrockPacks(bedrockId, 'behavior_packs').length === 0);

    // Cleanup via the real deleteServer(), not manual rm.
    await mgr.deleteServer(javaId, true);
    await mgr.deleteServer(javaId2, true);
    await mgr.deleteServer(bedrockId, true);

    console.log(`\nWORLDS + BEDROCK PACKS TESTS: ${pass} passed, ${fail} failed`);
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
