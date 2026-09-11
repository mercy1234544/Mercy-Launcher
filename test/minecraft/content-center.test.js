// Minecraft Content Center tests — Bedrock pack provenance/Open Pack,
// Structures/Schematics/Functions storage, local datapack install, and
// real content-based (not extension-trusting) detection. Deterministic,
// no network, real disposable fixtures only.
const fs = require('fs'), path = require('path'), os = require('os');
const archiver = require('archiver');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-content-test-')); }

function zipDir(sourceDir, destZip) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destZip);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
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
function mkBedrockPackFixture(dir, { uuid, version = [1, 0, 0], name = 'Test Pack', moduleType = 'resources' }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    format_version: 2,
    header: { name, description: 'A disposable test pack', uuid, version, min_engine_version: [1, 20, 0] },
    modules: [{ type: moduleType, uuid: 'a1b2c3d4-e5f6-4789-a012-3456789abcde', version }],
  }, null, 2));
}
function mkDatapackFixture(dir, { name = 'test_function' } = {}) {
  fs.mkdirSync(path.join(dir, 'data', 'mercytest', 'functions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: 15, description: 'A disposable test datapack' } }));
  fs.writeFileSync(path.join(dir, 'data', 'mercytest', 'functions', `${name}.mcfunction`), 'say hello from a real datapack function\n');
}

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();

  try {
    const mgr = new MinecraftManager(userDataRoot);

    // ══════════════════ Bedrock pack provenance + Open Pack ══════════════
    const bedrockDir = path.join(base, 'bedrock-server');
    mkBedrockServer(bedrockDir, 19940);
    const bedrockImp = await mgr.importServer(bedrockDir, 'Bedrock Content Test', 0);
    ok('Bedrock server import succeeds (fixture setup)', bedrockImp.success === true);
    const bedrockId = bedrockImp.server.id;

    // A pack manually copied into resource_packs OUTSIDE Mercy — no marker file.
    const manualUuid = '11111111-1111-4111-8111-111111111111';
    mkBedrockPackFixture(path.join(bedrockDir, 'resource_packs', 'manually_copied'), { uuid: manualUuid, name: 'Manually Copied Pack' });
    // A pack installed THROUGH Mercy's own real install flow.
    const realPackDir = path.join(base, 'real-pack-source');
    mkBedrockPackFixture(realPackDir, { uuid: '22222222-2222-4222-8222-222222222222', name: 'Mercy Installed Pack' });
    const realPackZip = path.join(base, 'real-pack.zip');
    await zipDir(realPackDir, realPackZip);
    const installResult = await mgr.installBedrockPack(bedrockId, 'resource_packs', realPackZip);
    ok('installBedrockPack succeeds', installResult.success === true);

    const packs = mgr.listBedrockPacks(bedrockId, 'resource_packs');
    const manual = packs.find((p) => p.uuid === manualUuid);
    const mercyInstalled = packs.find((p) => p.folderName === installResult.folderName);
    ok('a pack manually placed in resource_packs (never through Mercy) is honestly reported as NOT installed via Mercy', manual?.installedViaMercy === false);
    ok('a pack installed through Mercy\'s own real install flow is reported as installed via Mercy', mercyInstalled?.installedViaMercy === true);

    // Open Pack — real, validated path lookup.
    const validPath = mgr.getPackFolderPath(bedrockId, 'resource_packs', installResult.folderName);
    ok('getPackFolderPath resolves a real, existing pack folder', validPath !== null && fs.existsSync(validPath));
    const missingPath = mgr.getPackFolderPath(bedrockId, 'resource_packs', 'this_folder_does_not_exist');
    ok('getPackFolderPath returns null for a pack that genuinely does not exist', missingPath === null);
    const traversalPath = mgr.getPackFolderPath(bedrockId, 'resource_packs', '../../../etc');
    ok('getPackFolderPath refuses a traversal attempt in the folder name, never resolving outside the real packs directory', traversalPath === null);

    // Open World Folder — real, validated path lookup.
    fs.mkdirSync(path.join(bedrockDir, 'worlds', 'Bedrock level'), { recursive: true });
    fs.writeFileSync(path.join(bedrockDir, 'worlds', 'Bedrock level', 'level.dat'), 'fake');
    const worldPath = mgr.getWorldFolderPath(bedrockId);
    ok('getWorldFolderPath resolves the real world folder once it exists', worldPath !== null && fs.existsSync(worldPath));

    // ══════════════════ Structures / Schematics ══════════════════════════
    const goodStructure = path.join(base, 'real.mcstructure');
    fs.writeFileSync(goodStructure, Buffer.from([0x0a, 0, 0, 0])); // real NBT TAG_Compound root byte
    const structResult = mgr.storeStructure(bedrockId, goodStructure);
    ok('a real .mcstructure file (correct NBT signature) is stored successfully for a Bedrock server', structResult.success === true && structResult.content?.kind === 'structure');
    ok('storeStructure records source:"local" — never fabricated as a Modrinth install', structResult.content?.source === 'local');

    const badStructure = path.join(base, 'fake.mcstructure');
    fs.writeFileSync(badStructure, Buffer.from([0xff, 0xff])); // wrong signature
    const badStructResult = mgr.storeStructure(bedrockId, badStructure);
    ok('a file with the wrong signature is honestly rejected as not a real .mcstructure', badStructResult.success === false);

    const javaDir = path.join(base, 'java-server');
    mkJavaServer(javaDir, 25941);
    const javaImp = await mgr.importServer(javaDir, 'Java Content Test', 1024);
    const javaId = javaImp.server.id;

    const wrongEditionStructure = mgr.storeStructure(javaId, goodStructure);
    ok('a .mcstructure dropped on a JAVA server is refused — Bedrock-only format', wrongEditionStructure.success === false && /bedrock/i.test(wrongEditionStructure.error));

    const goodSchem = path.join(base, 'real.schem');
    fs.writeFileSync(goodSchem, Buffer.from([0x1f, 0x8b, 0, 0])); // real gzip signature
    const schemResult = mgr.storeStructure(javaId, goodSchem);
    ok('a real .schem file (correct gzip signature) is stored successfully for a Java server', schemResult.success === true && schemResult.content?.kind === 'schematic');

    const wrongEditionSchem = mgr.storeStructure(bedrockId, goodSchem);
    ok('a .schem dropped on a BEDROCK server is refused — Bedrock cannot read Java WorldEdit schematics at all', wrongEditionSchem.success === false);

    const badSchem = path.join(base, 'fake.schem');
    fs.writeFileSync(badSchem, 'not actually gzip data');
    const badSchemResult = mgr.storeStructure(javaId, badSchem);
    ok('a file with the wrong signature is honestly rejected as not a real .schem', badSchemResult.success === false);

    // Duplicate filename gets a real, non-destructive numbered suffix.
    const dupResult = mgr.storeStructure(javaId, goodSchem);
    ok('storing the same filename twice never overwrites — a numbered suffix is used instead', dupResult.success === true && dupResult.content.fileName !== schemResult.content.fileName);

    // ══════════════════ Functions ═════════════════════════════════════════
    const goodFunction = path.join(base, 'real.mcfunction');
    fs.writeFileSync(goodFunction, 'say hello\ngive @s diamond 1\n');
    const funcResult = mgr.storeFunction(bedrockId, goodFunction);
    ok('a real, plain-text .mcfunction file is stored successfully', funcResult.success === true && funcResult.content?.kind === 'function');

    const binaryFile = path.join(base, 'fake.mcfunction');
    fs.writeFileSync(binaryFile, Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const badFuncResult = mgr.storeFunction(bedrockId, binaryFile);
    ok('a binary file with a .mcfunction extension is honestly rejected — not real plain text', badFuncResult.success === false);

    const wrongExt = path.join(base, 'notafunction.txt');
    fs.writeFileSync(wrongExt, 'say hello');
    const wrongExtResult = mgr.storeFunction(bedrockId, wrongExt);
    ok('only real .mcfunction files are accepted by storeFunction', wrongExtResult.success === false);

    // ══════════════════ Local datapack install ═══════════════════════════
    const datapackDir = path.join(base, 'real-datapack');
    mkDatapackFixture(datapackDir);
    const datapackZip = path.join(base, 'real-datapack.zip');
    await zipDir(datapackDir, datapackZip);
    const datapackResult = await mgr.installLocalDatapack(javaId, datapackZip);
    ok('a real local datapack (valid pack.mcmeta) installs successfully', datapackResult.success === true && datapackResult.content?.kind === 'datapack' && datapackResult.content?.source === 'local');
    const installedDatapackAbs = mgr.resolveWithinServer(javaId, datapackResult.content.relPath);
    ok('the installed datapack is a real file that genuinely exists on disk', !!installedDatapackAbs && fs.existsSync(installedDatapackAbs));

    const notADatapackDir = path.join(base, 'not-a-datapack');
    fs.mkdirSync(notADatapackDir, { recursive: true });
    fs.writeFileSync(path.join(notADatapackDir, 'random.txt'), 'nothing here');
    const notADatapackZip = path.join(base, 'not-a-datapack.zip');
    await zipDir(notADatapackDir, notADatapackZip);
    const badDatapackResult = await mgr.installLocalDatapack(javaId, notADatapackZip);
    ok('an archive with no real pack.mcmeta is honestly rejected, never installed', badDatapackResult.success === false);

    const datapackOnBedrock = await mgr.installLocalDatapack(bedrockId, datapackZip);
    ok('datapacks are refused on a Bedrock server — a Java-only mechanism', datapackOnBedrock.success === false);

    // ══════════════════ Content detection (drag/drop) ═══════════════════
    const worldZipDir = path.join(base, 'world-for-detect');
    fs.mkdirSync(path.join(worldZipDir, 'region'), { recursive: true });
    fs.writeFileSync(path.join(worldZipDir, 'level.dat'), 'fake');
    const worldZip = path.join(base, 'world-for-detect.zip');
    await zipDir(worldZipDir, worldZip);
    const worldDetect = await mgr.detectMinecraftContent(javaId, worldZip);
    ok('a real Java world archive is detected as a World, compatible with a Java server', worldDetect.kind === 'world' && worldDetect.compatible === true);

    const bedrockWorldDetect = await mgr.detectMinecraftContent(bedrockId, worldZip);
    ok('a Java world dropped on a Bedrock server is detected but marked incompatible, with an honest reason', bedrockWorldDetect.kind === 'world' && bedrockWorldDetect.compatible === false && /java/i.test(bedrockWorldDetect.reason || ''));

    const resourcePackDetect = await mgr.detectMinecraftContent(bedrockId, realPackZip);
    ok('a real single-manifest resource pack archive is detected by its actual module type', resourcePackDetect.kind === 'resource_pack' && resourcePackDetect.compatible === true);

    const behaviorDir = path.join(base, 'behavior-src');
    mkBedrockPackFixture(behaviorDir, { uuid: '33333333-3333-4333-8333-333333333333', name: 'Behavior Test', moduleType: 'data' });
    const behaviorZip = path.join(base, 'behavior.zip');
    await zipDir(behaviorDir, behaviorZip);
    const behaviorDetect = await mgr.detectMinecraftContent(bedrockId, behaviorZip);
    ok('a real behavior-pack manifest (module type "data") is detected as a Behavior Pack, not a Resource Pack', behaviorDetect.kind === 'behavior_pack');

    const addonDir = path.join(base, 'addon-src');
    mkBedrockPackFixture(path.join(addonDir, 'rp'), { uuid: '44444444-4444-4444-8444-444444444444', name: 'Addon RP' });
    mkBedrockPackFixture(path.join(addonDir, 'bp'), { uuid: '55555555-5555-4555-8555-555555555555', name: 'Addon BP', moduleType: 'data' });
    const addonZip = path.join(base, 'addon.zip');
    await zipDir(addonDir, addonZip);
    const addonDetect = await mgr.detectMinecraftContent(bedrockId, addonZip);
    ok('an archive containing two real manifests (a real add-on) is detected as an Add-on, not a single pack', addonDetect.kind === 'addon');

    const datapackDetect = await mgr.detectMinecraftContent(javaId, datapackZip);
    ok('a real datapack archive is detected as a Java Datapack', datapackDetect.kind === 'datapack' && datapackDetect.compatible === true);

    const structureDetect = await mgr.detectMinecraftContent(bedrockId, goodStructure);
    ok('a loose .mcstructure file is detected by its real extension/content', structureDetect.kind === 'structure' && structureDetect.compatible === true);
    const functionDetect = await mgr.detectMinecraftContent(bedrockId, goodFunction);
    ok('a loose .mcfunction file is detected as a real Function', functionDetect.kind === 'function' && functionDetect.compatible === true);

    const junkFile = path.join(base, 'random.exe');
    fs.writeFileSync(junkFile, 'not minecraft content at all');
    const junkDetect = await mgr.detectMinecraftContent(bedrockId, junkFile);
    ok('an unrecognized file extension is honestly reported as unsupported, never guessed', junkDetect.kind === 'unsupported' && junkDetect.compatible === false);

    const emptyZipDir = path.join(base, 'empty-zip-src');
    fs.mkdirSync(emptyZipDir, { recursive: true });
    fs.writeFileSync(path.join(emptyZipDir, 'readme.txt'), 'nothing recognizable here');
    const emptyZip = path.join(base, 'empty.zip');
    await zipDir(emptyZipDir, emptyZip);
    const emptyDetect = await mgr.detectMinecraftContent(bedrockId, emptyZip);
    ok('an archive with no recognizable manifest/world/datapack signature is honestly unsupported, not silently guessed', emptyDetect.kind === 'unsupported');

    console.log(`\nCONTENT CENTER TESTS: ${pass} passed, ${fail} failed`);
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
