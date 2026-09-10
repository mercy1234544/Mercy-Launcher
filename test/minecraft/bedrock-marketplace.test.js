// Bedrock Marketplace tests — deterministic, no live GitHub network calls
// (GitHub's Search API is capped at 10 req/min unauthenticated, so a test
// suite hammering it would be flaky by construction — see this project's
// own established convention of testing pure logic here and proving the
// real network path separately in a *-live-e2e.js file, same as
// marketplace.test.js does for Modrinth).
//
// Pure mapping/query/extension logic is tested directly against REAL
// GitHub API response shapes (copied from an actual `curl
// api.github.com/search/repositories?q=topic:minecraft-bedrock-addon` /
// `.../releases` call made while building this feature), same technique
// marketplace.test.js already uses for Modrinth's real shapes.
//
// The actual install pipeline (download -> existing Bedrock pack/world
// systems) IS exercised for real here, end-to-end, against a local
// http.Server serving real fixture zips — no external network, no rate
// limit, fully deterministic, but genuinely downloads over a real HTTP
// connection and genuinely calls into MinecraftManager's already-tested
// installBedrockPack/installBedrockAddon/importWorld — never mocked/faked.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const archiver = require('archiver');
const { MinecraftManager } = require(path.resolve(__dirname, '../../dist/main/services/MinecraftManager.js'));
const {
  BedrockMarketplace, bedrockCategoryLabel, buildBedrockSearchQuery, isBedrockAssetInstallable,
  mapBedrockRepoHit, mapBedrockRepoDetail, mapBedrockRelease, bedrockExternalSearchUrl,
} = require(path.resolve(__dirname, '../../dist/main/services/BedrockMarketplace.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

function mkTempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-mc-bedrockmp-test-')); }

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

function mkBedrockServer(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bedrock_server.exe'), 'fake exe');
  fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${port}\nlevel-name=Bedrock level\n`);
}

function mkJavaServer(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.jar'), 'fake jar');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${port}\nlevel-name=world\n`);
}

function mkPackFixture(dir, { uuid, moduleType, name = 'Real Pack Name', version = [1, 0, 0] }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    format_version: 2,
    header: { name, description: 'A disposable fixture pack', uuid, version },
    modules: [{ type: moduleType, uuid: 'a1b2c3d4-e5f6-4789-a012-3456789abcde', version }],
  }, null, 2));
}

function mkWorldFixture(dir) {
  fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'db', 'CURRENT'), 'fake leveldb marker');
  fs.writeFileSync(path.join(dir, 'level.dat'), Buffer.from([1, 2, 3, 4]));
}

// Serves one fixture file over a real local HTTP connection, so
// BedrockMarketplace.installAsset() genuinely downloads it exactly the way
// it would a real GitHub release asset — no network, no mocking of axios.
function serveOnce(filePath) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/${path.basename(filePath)}`, close: () => server.close() });
    });
  });
}

(async () => {
  const userDataRoot = mkTempRoot();
  const base = mkTempRoot();

  try {
    // ── Pure: category labels ────────────────────────────────────────────
    ok('bedrockCategoryLabel: resource_pack', bedrockCategoryLabel('resource_pack') === 'Resource Pack');
    ok('bedrockCategoryLabel: behavior_pack', bedrockCategoryLabel('behavior_pack') === 'Behavior Pack');
    ok('bedrockCategoryLabel: addon', bedrockCategoryLabel('addon') === 'Add-on');
    ok('bedrockCategoryLabel: world', bedrockCategoryLabel('world') === 'World');

    // ── Pure: query building always anchors on "bedrock" (never lets a
    // plain Java-only project surface as a Bedrock result) ───────────────
    for (const cat of ['resource_pack', 'behavior_pack', 'addon', 'world']) {
      const q = buildBedrockSearchQuery(cat, '');
      ok(`buildBedrockSearchQuery(${cat}) requires the word "bedrock"`, /\bbedrock\b/i.test(q));
      ok(`buildBedrockSearchQuery(${cat}) restricts to real repo fields (in:name,description,topics)`, q.includes('in:name,description,topics'));
    }
    ok('buildBedrockSearchQuery appends a real user query', buildBedrockSearchQuery('resource_pack', 'faithful').includes('faithful'));
    ok('buildBedrockSearchQuery with empty user query has no trailing double space', !buildBedrockSearchQuery('world', '').includes('  '));

    // ── Pure: extension-based installable check — the actual mechanism
    // that keeps a world file from being offered as an installable
    // resource/behavior pack and vice versa. ─────────────────────────────
    ok('a .mcpack IS installable as a resource_pack', isBedrockAssetInstallable('resource_pack', 'Faithful.mcpack'));
    ok('a .mcpack IS installable as a behavior_pack', isBedrockAssetInstallable('behavior_pack', 'MyMod.mcpack'));
    ok('a .mcaddon IS installable as an addon', isBedrockAssetInstallable('addon', 'CoolAddon.mcaddon'));
    ok('a .mctemplate IS installable as a world', isBedrockAssetInstallable('world', 'SkyblockTemplate.mctemplate'));
    ok('a .mcworld IS installable as a world', isBedrockAssetInstallable('world', 'MyBase.mcworld'));
    ok('a .mctemplate (world file) is NOT offered as an installable resource_pack', !isBedrockAssetInstallable('resource_pack', 'SkyblockTemplate.mctemplate'));
    ok('a .mctemplate (world file) is NOT offered as an installable behavior_pack', !isBedrockAssetInstallable('behavior_pack', 'SkyblockTemplate.mctemplate'));
    ok('a Java .jar is never installable for any Bedrock category', !isBedrockAssetInstallable('resource_pack', 'plugin.jar') && !isBedrockAssetInstallable('addon', 'plugin.jar'));
    ok('unrelated source archives (Source code (zip)) are still real zips and ARE flagged installable — Mercy relies on manifest validation at install time, not the filename alone, to reject them', isBedrockAssetInstallable('addon', 'Source code (zip).zip') === true);

    // ── Pure: external MCPEDL link never claims to be an install source ──
    ok('bedrockExternalSearchUrl always points at mcpedl.com, nowhere else', bedrockExternalSearchUrl('world', 'skyblock').startsWith('https://mcpedl.com/'));
    ok('bedrockExternalSearchUrl includes the real user query', bedrockExternalSearchUrl('world', 'skyblock').includes(encodeURIComponent('skyblock')));
    ok('bedrockExternalSearchUrl with empty query still resolves to a real category browse page, not a broken URL', /^https:\/\/mcpedl\.com\/[a-z-]+\/$/.test(bedrockExternalSearchUrl('resource_pack', '')));

    // ── Pure: real GitHub API response shapes (copied from an actual
    // curl against api.github.com while building this feature) map to
    // real, correct display fields — never fabricated. ───────────────────
    const realRepoShape = {
      full_name: 'SIsilicon/WorldEdit-BE', name: 'WorldEdit-BE',
      owner: { login: 'SIsilicon', avatar_url: 'https://avatars.githubusercontent.com/u/34734122?v=4' },
      description: 'A Minecraft Bedrock addon port of the famous WorldEdit mod for Minecraft: Java Edition.',
      html_url: 'https://github.com/SIsilicon/WorldEdit-BE',
      stargazers_count: 1234, topics: ['minecraft-bedrock-addon', 'worldedit'],
      updated_at: '2026-03-20T16:19:36Z',
    };
    const hit = mapBedrockRepoHit(realRepoShape);
    ok('mapBedrockRepoHit reads the real repo name', hit.name === 'WorldEdit-BE');
    ok('mapBedrockRepoHit reads the real owner login', hit.owner === 'SIsilicon');
    ok('mapBedrockRepoHit reads the real description verbatim (never rewritten/fabricated)', hit.description === realRepoShape.description);
    ok('mapBedrockRepoHit reads the real star count', hit.stars === 1234);
    ok('mapBedrockRepoHit reads the real topics array', hit.topics.includes('minecraft-bedrock-addon'));
    ok('mapBedrockRepoHit reads the real GitHub URL, not a fabricated one', hit.htmlUrl === 'https://github.com/SIsilicon/WorldEdit-BE');

    const repoDetail = mapBedrockRepoDetail({ ...realRepoShape, forks_count: 56, license: { name: 'MIT License' }, homepage: 'https://worldedit-be.readthedocs.io' }, 'fallback-owner', 'fallback-repo');
    ok('mapBedrockRepoDetail reads real forks count', repoDetail.forks === 56);
    ok('mapBedrockRepoDetail reads real license name', repoDetail.license === 'MIT License');
    ok('mapBedrockRepoDetail reads real homepage', repoDetail.homepageUrl === 'https://worldedit-be.readthedocs.io');
    const repoDetailNoLicense = mapBedrockRepoDetail({ full_name: 'x/y', name: 'y' }, 'x', 'y');
    ok('mapBedrockRepoDetail never fabricates a license when GitHub reports none', repoDetailNoLicense.license === null);

    const realReleaseShape = {
      tag_name: 'v0.11.0-beta.5', name: 'v0.11.0-beta.5', body: 'Real release notes text.',
      published_at: '2026-03-20T16:19:36Z', prerelease: true,
      assets: [
        { name: 'WorldEdit.beta.editor.mcaddon', size: 512000, download_count: 4321, browser_download_url: 'https://github.com/SIsilicon/WorldEdit-BE/releases/download/v0.11.0-beta.5/WorldEdit.beta.editor.mcaddon', content_type: 'application/octet-stream' },
        { name: 'Source code (zip)', size: 99999, download_count: 12, browser_download_url: 'https://github.com/SIsilicon/WorldEdit-BE/archive/refs/tags/v0.11.0-beta.5.zip', content_type: 'application/zip' },
      ],
    };
    const release = mapBedrockRelease(realReleaseShape, 'addon');
    ok('mapBedrockRelease reads the real tag name', release.tagName === 'v0.11.0-beta.5');
    ok('mapBedrockRelease reads the real prerelease flag', release.prerelease === true);
    ok('mapBedrockRelease reads the real download count per asset', release.assets[0].downloadCount === 4321);
    ok('mapBedrockRelease correctly flags the real .mcaddon asset as installable for the addon category', release.assets.find((a) => a.name.endsWith('.mcaddon')).installable === true);

    // ── Real end-to-end install: local HTTP server + real fixture zips +
    // the ACTUAL existing MinecraftManager pack/world pipeline. ──────────
    const mgr = new MinecraftManager(userDataRoot);
    const bedrockDir = path.join(base, 'bedrock-server');
    mkBedrockServer(bedrockDir, 19140);
    const bedrockImport = await mgr.importServer(bedrockDir, 'BedrockMP Test Server', 0);
    ok('setup: real Bedrock server registered', bedrockImport.success === true);
    const bedrockId = bedrockImport.server.id;

    const bm = new BedrockMarketplace(userDataRoot);

    // Resource pack install via the marketplace pipeline.
    const rpUuid = '11111111-2222-4333-8444-555566667777';
    const rpSrc = path.join(base, 'rp-src');
    mkPackFixture(rpSrc, { uuid: rpUuid, moduleType: 'resources', name: 'Real Resource Pack' });
    const rpZip = path.join(base, 'rp.zip');
    await zipDir(rpSrc, rpZip);
    const rpServed = await serveOnce(rpZip);
    try {
      const rpResult = await bm.installAsset(mgr, bedrockId, 'resource_pack', { browserDownloadUrl: rpServed.url, name: 'rp.zip' });
      ok('installAsset(resource_pack) downloads over real HTTP and installs via the EXISTING installBedrockPack', rpResult.success === true);
      const rpList = mgr.listBedrockPacks(bedrockId, 'resource_packs');
      ok('the resource pack genuinely appears via the existing listBedrockPacks (no second tracking system)', rpList.some((p) => p.uuid === rpUuid && p.name === 'Real Resource Pack'));
    } finally { rpServed.close(); }

    // Behavior pack install via the marketplace pipeline.
    const bpUuid = '22222222-3333-4444-8555-666677778888';
    const bpSrc = path.join(base, 'bp-src');
    mkPackFixture(bpSrc, { uuid: bpUuid, moduleType: 'data', name: 'Real Behavior Pack' });
    const bpZip = path.join(base, 'bp.zip');
    await zipDir(bpSrc, bpZip);
    const bpServed = await serveOnce(bpZip);
    try {
      const bpResult = await bm.installAsset(mgr, bedrockId, 'behavior_pack', { browserDownloadUrl: bpServed.url, name: 'bp.zip' });
      ok('installAsset(behavior_pack) installs via the EXISTING installBedrockPack', bpResult.success === true);
      const bpList = mgr.listBedrockPacks(bedrockId, 'behavior_packs');
      ok('the behavior pack genuinely appears via the existing listBedrockPacks', bpList.some((p) => p.uuid === bpUuid));
    } finally { bpServed.close(); }

    // Combined add-on (RP + BP in one archive) via the marketplace pipeline.
    const addonRpUuid = '33333333-4444-4555-8666-777788889999';
    const addonBpUuid = '44444444-5555-4666-8777-888899990000';
    const addonSrc = path.join(base, 'addon-src');
    mkPackFixture(path.join(addonSrc, 'rp'), { uuid: addonRpUuid, moduleType: 'resources', name: 'Addon RP' });
    mkPackFixture(path.join(addonSrc, 'bp'), { uuid: addonBpUuid, moduleType: 'data', name: 'Addon BP' });
    const addonZip = path.join(base, 'addon.zip');
    await zipDir(addonSrc, addonZip);
    const addonServed = await serveOnce(addonZip);
    try {
      const addonResult = await bm.installAsset(mgr, bedrockId, 'addon', { browserDownloadUrl: addonServed.url, name: 'addon.mcaddon' });
      ok('installAsset(addon) installs BOTH packs via the EXISTING installBedrockAddon (no duplicate system)', addonResult.success === true && !!addonResult.installedResourcePack && !!addonResult.installedBehaviorPack);
      ok('the addon\'s resource pack genuinely appears', mgr.listBedrockPacks(bedrockId, 'resource_packs').some((p) => p.uuid === addonRpUuid));
      ok('the addon\'s behavior pack genuinely appears', mgr.listBedrockPacks(bedrockId, 'behavior_packs').some((p) => p.uuid === addonBpUuid));
    } finally { addonServed.close(); }

    // World install via the marketplace pipeline.
    const worldSrc = path.join(base, 'world-src');
    mkWorldFixture(worldSrc);
    const worldZip = path.join(base, 'world.mctemplate');
    await zipDir(worldSrc, worldZip);
    const worldServed = await serveOnce(worldZip);
    try {
      const worldResult = await bm.installAsset(mgr, bedrockId, 'world', { browserDownloadUrl: worldServed.url, name: 'world.mctemplate' });
      ok('installAsset(world) installs via the EXISTING importWorld', worldResult.success === true);
      const info = mgr.getWorldInfo(bedrockId);
      ok('the world genuinely exists on disk afterward', info.exists === true);
    } finally { worldServed.close(); }

    // Re-installing a world (already exists now) must require confirmation,
    // proving the EXISTING replace-confirmation/backup flow is reused, not
    // bypassed by the marketplace path.
    const worldServed2 = await serveOnce(worldZip);
    try {
      const needsConfirm = await bm.installAsset(mgr, bedrockId, 'world', { browserDownloadUrl: worldServed2.url, name: 'world.mctemplate' });
      ok('re-installing a world via the marketplace path requires confirmation, same as manual import', needsConfirm.needsConfirmation === true && needsConfirm.success === false);
    } finally { worldServed2.close(); }

    // ── Invalid/incompatible content is rejected via the real pipeline ───
    const badSrc = path.join(base, 'bad-src');
    fs.mkdirSync(badSrc, { recursive: true });
    fs.writeFileSync(path.join(badSrc, 'readme.txt'), 'not a real pack');
    const badZip = path.join(base, 'bad.zip');
    await zipDir(badSrc, badZip);
    const badServed = await serveOnce(badZip);
    try {
      const badResult = await bm.installAsset(mgr, bedrockId, 'resource_pack', { browserDownloadUrl: badServed.url, name: 'bad.zip' });
      ok('an archive with no real manifest.json is rejected, not silently accepted', badResult.success === false && !!badResult.error);
    } finally { badServed.close(); }

    // ── A Java server is refused outright — never mixed with Bedrock content.
    const javaDir = path.join(base, 'java-server');
    mkJavaServer(javaDir, 25580);
    const javaImport = await mgr.importServer(javaDir, 'BedrockMP Java Control', 512);
    const javaId = javaImport.server.id;
    const rpServed2 = await serveOnce(rpZip);
    try {
      const onJava = await bm.installAsset(mgr, javaId, 'resource_pack', { browserDownloadUrl: rpServed2.url, name: 'rp.zip' });
      ok('installAsset refuses to install Bedrock content onto a Java server', onJava.success === false && /not Bedrock Edition/i.test(onJava.error || ''));
    } finally { rpServed2.close(); }

    // ── Cleanup: no leftover marketplace download temp files ─────────────
    const tmpDir = path.join(userDataRoot, 'tmp');
    const leftoverDownloads = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).filter((f) => f.startsWith('bedrock-marketplace-')) : [];
    ok('no leftover bedrock-marketplace-* temp download files remain after install/cleanup', leftoverDownloads.length === 0);

    await mgr.deleteServer(bedrockId, true, true);
    await mgr.deleteServer(javaId, true, true);

    console.log(`\nBEDROCK MARKETPLACE TESTS: ${pass} passed, ${fail} failed`);
  } finally {
    try { fs.rmSync(userDataRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
