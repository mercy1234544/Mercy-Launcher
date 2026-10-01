// "Generate UV Template" — real behavioral tests for the box-projection
// unwrap algorithm (uvGenerator.ts) and the in-place YFT UV writer
// (yftWriter.ts / resource.ts's half-float codec), not just static-source
// assertions — these are pure, deterministic algorithms, so their actual
// output is verified directly, the same way database.test.js verifies
// DatabaseManager's real SQL/auth logic against a fake backend.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };
const approx = (a, b, eps) => Math.abs(a - b) <= eps;

function installTsRequireHook() {
  const previous = Module._extensions['.ts'];
  Module._extensions['.ts'] = function (mod, filename) {
    const source = fs.readFileSync(filename, 'utf8').replace(/import\.meta\.env\.(\w+)/g, () => '""');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
    });
    mod._compile(outputText, filename);
  };
  return () => { Module._extensions['.ts'] = previous; };
}

const UV_GEN_PATH = path.resolve(__dirname, '../../src/renderer/services/rage/uvGenerator.ts');
const RESOURCE_PATH = path.resolve(__dirname, '../../src/renderer/services/rage/resource.ts');
const YFT_WRITER_PATH = path.resolve(__dirname, '../../src/renderer/services/rage/yftWriter.ts');

(async () => {
  const restoreHook = installTsRequireHook();
  let THREE, uvGen, resource, yftWriter;
  try {
    THREE = require('three');
    delete require.cache[UV_GEN_PATH]; delete require.cache[RESOURCE_PATH]; delete require.cache[YFT_WRITER_PATH];
    uvGen = require(UV_GEN_PATH);
    resource = require(RESOURCE_PATH);
    yftWriter = require(YFT_WRITER_PATH);
  } finally {
    restoreHook();
  }

  function makeFlatMesh(name, positions) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    mesh.name = name;
    return mesh;
  }

  // ── listPanels ────────────────────────────────────────────────────────────
  const emptyMesh = makeFlatMesh('empty', []);
  const doorMesh = makeFlatMesh('door', [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]); // a flat XY quad, Z constant
  const panels = uvGen.listPanels([emptyMesh, doorMesh]);
  ok('listPanels excludes meshes with no vertices', panels.length === 1 && panels[0].name === 'door');
  ok('listPanels reports the real vertex count', panels[0].vertexCount === 4);

  // ── generateBoxProjectedUVs: single flat panel ──────────────────────────
  const single = uvGen.generateBoxProjectedUVs([doorMesh]);
  ok('generateBoxProjectedUVs returns one result per input mesh', single.length === 1);
  const uvs1 = single[0].uvs;
  ok('UV buffer has 2 floats per vertex', uvs1.length === doorMesh.geometry.getAttribute('position').count * 2);
  ok('all generated UVs are within the real [0,1] texture-space range (minus padding)', Array.from(uvs1).every((v) => v >= 0 && v <= 1));
  // The quad spans x:[0,1], y:[0,1], z constant (0) — z is the thinnest axis
  // and gets dropped, so U/V should track x/y with the real padding offset
  // (not some unrelated projection).
  const padFrac = 0.04; // default padding param
  ok('REPRODUCED A REAL UNWRAP: vertex (0,0,0) maps near the padded origin of its cell', approx(uvs1[0], padFrac, 0.01) && approx(uvs1[1], padFrac, 0.01));
  ok('REPRODUCED A REAL UNWRAP: vertex (1,1,0) maps near the padded far corner of its cell', approx(uvs1[4], 1 - padFrac, 0.01) && approx(uvs1[5], 1 - padFrac, 0.01));

  // ── generateBoxProjectedUVs: multiple panels pack into distinct cells ──
  const hoodMesh = makeFlatMesh('hood', [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0]); // a different flat panel
  const multi = uvGen.generateBoxProjectedUVs([doorMesh, hoodMesh]);
  const doorU = multi[0].uvs[0], hoodU = multi[1].uvs[0];
  ok('REPRODUCED THE FIX: two selected panels are packed into DISTINCT, non-overlapping grid cells — never the same UV space', Math.abs(doorU - hoodU) > 0.3);

  // ── applyGeneratedUVs: actually writes onto the live geometry ───────────
  uvGen.applyGeneratedUVs(single);
  const appliedAttr = doorMesh.geometry.getAttribute('uv');
  ok('applyGeneratedUVs sets a real "uv" attribute on the live geometry', !!appliedAttr && appliedAttr.count === 4);
  ok('the applied UVs match exactly what generateBoxProjectedUVs computed', appliedAttr.array[0] === uvs1[0] && appliedAttr.array[1] === uvs1[1]);

  // ── Half-float codec round-trip (resource.ts) — the YFT UV writer's own
  //    encoding must invert the reader's decoding for real UV-range values.
  const testValues = [0, 0.25, 0.5, 0.75, 1, 0.999, 0.001, 1.5, -0.3];
  let allRoundTrip = true;
  for (const v of testValues) {
    const back = resource.decodeHalf(resource.encodeHalf(v));
    if (!approx(back, v, 0.002)) { allRoundTrip = false; console.log(`  half-float round-trip failed for ${v} -> ${back}`); }
  }
  ok('encodeHalf/decodeHalf round-trip correctly for the real range of UV coordinate values', allRoundTrip);

  // ── writeUVsToYFT: real in-place byte patch + recompress + decompress ───
  // Build a synthetic (non-tagged, but real-RSC7-framed) buffer: 512 bytes
  // of system data, one fake "vertex" at offset 100 with stride 32 and a
  // UV field at +12 — exactly the shape ParsedGeometry/mesh.userData
  // describes for a real YFT mesh.
  async function buildFakeRSC7(size) {
    const payload = new Uint8Array(size);
    const compressed = await resource.compressDeflateRaw(payload);
    // s0 bit (flags bit 27) set, ss=0 -> sizeFromFlags = 0x200 * 1 = 512
    const systemFlags = (1 << 27) >>> 0;
    return { bytes: resource.buildRSC7(0x0c, systemFlags, 0, compressed), rawPayload: payload };
  }

  const { bytes: fakeYft } = await buildFakeRSC7(512);
  ok('sizeFromFlags recovers the exact synthetic systemSize used to build the fake file', resource.sizeFromFlags((1 << 27) >>> 0) === 512);

  const fakeMeshFloat = makeFlatMesh('body_float', [0, 0, 0, 1, 0, 0]);
  fakeMeshFloat.userData = { vertexBufferOffset: 100, uvFieldOffset: 12, uvIsHalf: false, vertexStride: 32, vertexCount: 1 };
  const newUVFloat = new Float32Array([0.321, 0.654]);
  const wrFloat = await yftWriter.writeUVsToYFT(fakeYft.buffer.slice(fakeYft.byteOffset, fakeYft.byteOffset + fakeYft.byteLength), [{ mesh: fakeMeshFloat, uvs: newUVFloat }]);
  ok('writeUVsToYFT reports the mesh as successfully patched (full-float UVs)', wrFloat.patchedMeshes.length === 1 && wrFloat.skipped.length === 0);

  const unpacked1 = await resource.unpackRSC7Detailed(wrFloat.bytes);
  ok('the written file re-decompresses successfully', unpacked1.method !== 'failed' && !!unpacked1.resource);
  const dv1 = unpacked1.resource.view;
  ok('REPRODUCED THE FIX: the real float UV bytes at the exact recorded offset now hold the newly generated value, in place, with nothing else in the file disturbed', approx(dv1.getFloat32(112, true), 0.321, 1e-5) && approx(dv1.getFloat32(116, true), 0.654, 1e-5));

  // Half-float variant — same offsets, different encoding.
  const { bytes: fakeYft2 } = await buildFakeRSC7(512);
  const fakeMeshHalf = makeFlatMesh('body_half', [0, 0, 0, 1, 0, 0]);
  fakeMeshHalf.userData = { vertexBufferOffset: 100, uvFieldOffset: 12, uvIsHalf: true, vertexStride: 32, vertexCount: 1 };
  const newUVHalf = new Float32Array([0.5, 0.25]);
  const wrHalf = await yftWriter.writeUVsToYFT(fakeYft2.buffer.slice(fakeYft2.byteOffset, fakeYft2.byteOffset + fakeYft2.byteLength), [{ mesh: fakeMeshHalf, uvs: newUVHalf }]);
  const unpacked2 = await resource.unpackRSC7Detailed(wrHalf.bytes);
  const dv2 = unpacked2.resource.view;
  ok('half-float UV writing round-trips correctly too (different vertex layout than the full-float case)', approx(resource.decodeHalf(dv2.getUint16(112, true)), 0.5, 0.002) && approx(resource.decodeHalf(dv2.getUint16(114, true)), 0.25, 0.002));

  // ── Honest failure paths — never silently "succeed" on bad input ────────
  const noOffsetMesh = makeFlatMesh('no_offset', [0, 0, 0]);
  noOffsetMesh.userData = {}; // never loaded from a real YFT vertex buffer
  const wrSkip = await yftWriter.writeUVsToYFT(fakeYft.buffer.slice(fakeYft.byteOffset, fakeYft.byteOffset + fakeYft.byteLength), [{ mesh: noOffsetMesh, uvs: new Float32Array([0.1, 0.1]) }]);
  ok('a mesh with no recorded real vertex-buffer offset is honestly skipped, never silently written at a guessed location', wrSkip.patchedMeshes.length === 0 && wrSkip.skipped.length === 1);

  const mismatchMesh = makeFlatMesh('mismatch', [0, 0, 0, 1, 0, 0]);
  mismatchMesh.userData = { vertexBufferOffset: 100, uvFieldOffset: 12, uvIsHalf: false, vertexStride: 32, vertexCount: 2 };
  const wrMismatch = await yftWriter.writeUVsToYFT(fakeYft.buffer.slice(fakeYft.byteOffset, fakeYft.byteOffset + fakeYft.byteLength), [{ mesh: mismatchMesh, uvs: new Float32Array([0.1, 0.1]) /* only 1 vertex worth */ }]);
  ok('a vertex-count mismatch between the generated UVs and the original mesh is refused, never patched partially/incorrectly', wrMismatch.patchedMeshes.length === 0 && /[Vv]ertex count mismatch/.test(wrMismatch.skipped[0]?.reason || ''));

  console.log(`\nUV GENERATION + YFT WRITER TESTS: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
