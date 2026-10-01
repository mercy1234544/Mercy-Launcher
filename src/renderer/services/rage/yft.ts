// YFT (fragment / drawable) geometry parser for GTA V vehicles.
//
// IMPORTANT — these .yft files use a self-describing TAGGED container format
// (as produced by the OutputDump/MGiturm pipeline and openable in OpenIV), not
// the raw RAGE crDrawable pointer hierarchy. After RSC7 decompression the
// buffer is laid out as a tree of 4-byte ASCII-tagged structures:
//
//   FRAG  root fragment
//   MATS  material table          (→ array of material structs)
//   TXEX  texture reference        (texture name string @ +0x28)
//   SKEL  skeleton
//   DRFR  drawable fragment        (→ MATS, SKEL, GEOM groups, bounds)
//   GEOM  geometry group / LOD     (→ array of MESH pointers @ +0x40)
//   MESH  one mesh                 (VBUF ptr @ +0x18, IBUF ptr @ +0x38)
//   VBUF  vertex buffer            (stride @ +0x08, dataPtr @ +0x10,
//                                   vertexCount @ +0x18, declPtr @ +0x30)
//   IBUF  index buffer             (indexCount @ +0x08, dataPtr @ +0x10)
//
// Vertex layout (per VBUF):
//   position : float3  @ offset 0          (always)
//   uv0      : half2   @ offset ~0x0C       (detected per-mesh)
//   normal   : float3  @ offset ~0x14       (detected per-mesh)
//
// Pointers are 32-bit segmented (top nibble 0x5 = system). These dump files put
// everything in one "system" segment so resolve() is offset = ptr & 0x0FFFFFFF.

import { unpackRSC7Detailed, ResourceReader, decodeHalf } from './resource';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface ParsedGeometry {
  name: string;
  /** RAW GTA-space positions (x,y,z). buildVehicleFromDrawable applies the
   *  GTA→Three transform — do NOT pre-transform here. */
  positions: Float32Array;
  uvs: Float32Array | null;
  normals: Float32Array | null;
  indices: Uint32Array;
  shaderIndex: number;
  vertexStride: number;
  fvf: number;
  /** Which texcoord channel the UVs were read from (0 or 1). */
  uvChannel: number;
  /** Absolute byte offset of this mesh's vertex buffer within the
   *  decompressed RSC7 resource (ResourceReader.resolve()'s flat address
   *  space — system then graphics concatenated). Together with
   *  vertexStride/uvFieldOffset/uvIsHalf/vertexCount, this is everything
   *  needed to patch UV values back into the real YFT file in place (see
   *  uvGenerator.ts) — same vertex count, same stride, only the UV floats
   *  at this known offset change, so no pointers or buffer sizes move. */
  vertexBufferOffset: number;
  /** Byte offset of the UV field WITHIN one vertex (i.e. add
   *  vertexBufferOffset + i*vertexStride to get one vertex's UV bytes). */
  uvFieldOffset: number;
  /** Whether that UV field is stored as 2 half-floats (4 bytes) or 2 full
   *  floats (8 bytes) per vertex. */
  uvIsHalf: boolean;
  vertexCount: number;
}

export interface ParsedShader {
  index: number;
  filename: string;
  textureParams: string[];
  /** GTA material index (from the GEOM per-mesh material array / MATS table). */
  materialIndex: number;
  /** GTA shader name hash (material struct +0x08) — for OpenIV/CodeWalker compare. */
  shaderHash: string;
  /** Texture-parameter slot the chosen diffuse came from. */
  diffuseSlot: number;
}

export interface ParsedDrawable {
  geometries: ParsedGeometry[];
  shaders: ParsedShader[];
  shaderTextureNames: (string | null)[];
  diagnostics: YftDiagnostics;
}

export interface YftDiagnostics {
  // RSC7 header
  rsc7Magic: boolean;
  rsc7Version: number;
  rsc7SystemFlags: string;
  rsc7GraphicsFlags: string;
  rsc7SystemSize: number;
  rsc7GraphicsSize: number;
  // Decompression
  decompressMethod: string;
  decompressedSize: number;
  payloadPeekHex: string;
  failReason: string;
  decompressAttemptLog: string[];
  // Container format
  containerFormat: string;     // 'tagged' | 'unknown'
  tagCounts: Record<string, number>;
  // Buffer scan
  sysPtrCount: number;
  gfxPtrCount: number;
  maxSysPtrOff: number;
  maxGfxPtrOff: number;
  sysSizeUsed: number;
  sysSizeSource: string;
  // Probe results (kept for UI compatibility)
  probeResults: Array<{ base: number; score: number; desc: string }>;
  drawableBase: number;
  drawableLodUsed: string;
  // Shader group
  shaderGroupPtrRaw: string;
  shaderGroupBase: number;
  shaderCount: number;
  shaders: Array<{ filename: string; textureParams: string[] }>;
  // Geometry
  modelsFound: number;
  meshTagCount: number;
  geometryCount: number;
  totalVertices: number;
  totalTriangles: number;
  vertexStrides: number[];
  boundingBox: string;
  textureNames: string[];
  // Hex dumps
  bufferHex: string;
  drawableHeaderHex: string;
  // Investigation log
  investigationLog: string[];
  // Legacy
  systemHeaderHex: string;
  errors: string[];
  warnings: string[];
  notes: string[];
}

export interface YftParseResult {
  drawable: ParsedDrawable | null;
  reason?: string;
  diagnostics: YftDiagnostics;
}

// ── Safe-read helpers ────────────────────────────────────────────────────────

function su8(r: ResourceReader, o: number)  { return (o >= 0 && o + 1 <= r.res.buffer.length) ? r.u8(o) : 0; }
function su16(r: ResourceReader, o: number) { return (o >= 0 && o + 2 <= r.res.buffer.length) ? r.u16(o) : 0; }
function su32(r: ResourceReader, o: number) { return (o >= 0 && o + 4 <= r.res.buffer.length) ? r.u32(o) : 0; }
function sf32(r: ResourceReader, o: number) { return (o >= 0 && o + 4 <= r.res.buffer.length) ? r.f32(o) : 0; }
function sptr(r: ResourceReader, o: number) { return (o >= 0 && o + 4 <= r.res.buffer.length) ? r.ptr(o) : 0; }

function tagAt(r: ResourceReader, o: number): string {
  if (o < 0 || o + 4 > r.res.buffer.length) return '';
  return String.fromCharCode(su8(r, o), su8(r, o + 1), su8(r, o + 2), su8(r, o + 3));
}

function readCString(r: ResourceReader, o: number, max = 96): string {
  if (o < 0) return '';
  let s = '';
  for (let i = 0; i < max; i++) {
    const c = su8(r, o + i);
    if (c === 0) break;
    if (c < 32 || c > 126) return s; // stop at non-printable
    s += String.fromCharCode(c);
  }
  return s;
}

// ── Hex dump ─────────────────────────────────────────────────────────────────

function hexDump(buf: Uint8Array, off: number, len: number): string {
  const out: string[] = [];
  const end = Math.min(off + len, buf.length);
  for (let i = off; i < end; i += 16) {
    const row: string[] = [];
    for (let j = 0; j < 16 && i + j < end; j++)
      row.push(buf[i + j].toString(16).padStart(2, '0'));
    const ascii = Array.from({ length: Math.min(16, end - i) }, (_, j) => {
      const c = buf[i + j]; return (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
    }).join('');
    out.push(`+${(i - off).toString(16).padStart(4, '0')}  ${row.join(' ').padEnd(47)}  ${ascii}`);
  }
  return out.join('\n');
}

// ── Tag enumeration ──────────────────────────────────────────────────────────

function findTagOffsets(buf: Uint8Array, tag: string): number[] {
  const a = tag.charCodeAt(0), b = tag.charCodeAt(1), c = tag.charCodeAt(2), d = tag.charCodeAt(3);
  const out: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 4)
    if (buf[i] === a && buf[i + 1] === b && buf[i + 2] === c && buf[i + 3] === d) out.push(i);
  return out;
}

function censusTags(buf: Uint8Array): Record<string, number> {
  const counts: Record<string, number> = {};
  const isAZ = (c: number) => c >= 0x41 && c <= 0x5a;
  for (let i = 0; i + 4 <= buf.length; i += 4) {
    if (isAZ(buf[i]) && isAZ(buf[i + 1]) && isAZ(buf[i + 2]) && isAZ(buf[i + 3])) {
      const t = String.fromCharCode(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  return counts;
}

// ── Vertex layout discovery (empirical) ───────────────────────────────────────
// Different meshes pack UV / normal at different offsets. Probe the stride for
// the slot that yields the most normalized UVs (half2 in ~[0,1]) and the most
// unit-length float3 normals.

interface VLayout {
  posOff: number; normalOff: number;
  uvOff: number; uvIsHalf: boolean;
  uv1Off: number; uv1IsHalf: boolean; // texcoord1 — some shaders bind the diffuse here
}

// CodeWalker grcFvf component byte-sizes, indexed by the 4-bit type nibble:
//   0 Half(2) 1 Half2(4) 2 Half3(6) 3 Half4(8) 4 Float(4) 5 Float2(8)
//   6 Float3(12) 7 Float4(16) 8 UByte4(4) 9 Color(4) 10+ packed(4)
const FVF_SIZE = [2, 4, 6, 8, 4, 8, 12, 16, 4, 4, 4, 4, 4, 4, 4, 4];

// Decode the vertex layout from the grcFvf DECLARATION — the exact, correct way
// (a heuristic that scans for "UV-looking" floats picks colour bytes by mistake
// and collapses every UV to ~0, which renders all textures as one flat texel).
// Declaration: fvf mask u32 @+0x00, stride byte @+0x04, element count @+0x07,
// 16 type-nibbles packed into 8 bytes @+0x08. Channels: 0=pos, 3=normal,
// 4=colour0, 6=texcoord0, 7=texcoord1.
function decodeDeclaration(r: ResourceReader, declOff: number, stride: number): VLayout | null {
  if (declOff < 0) return null;
  const fvf = su32(r, declOff);
  const tlo = su32(r, declOff + 8), thi = su32(r, declOff + 12);
  const typeOf = (ch: number) => ((ch < 8 ? tlo : thi) >>> ((ch % 8) * 4)) & 0xf;
  let off = 0;
  const elemOff: Record<number, number> = {};
  let uvType = -1, uv1Type = -1;
  for (let ch = 0; ch < 16; ch++) {
    if (!((fvf >>> ch) & 1)) continue;
    const t = typeOf(ch);
    elemOff[ch] = off;
    if (ch === 6) uvType = t;
    if (ch === 7) uv1Type = t;
    off += FVF_SIZE[t];
  }
  // The computed stride MUST equal the declared stride, or our decode is wrong.
  if (off !== stride) return null;
  return {
    posOff: elemOff[0] ?? 0,
    normalOff: elemOff[3] ?? -1,
    uvOff: elemOff[6] ?? -1,
    uvIsHalf: uvType >= 0 && uvType <= 3, // 0-3 half formats, 4-7 float formats
    uv1Off: elemOff[7] ?? -1,
    uv1IsHalf: uv1Type >= 0 && uv1Type <= 3,
  };
}

function discoverVertexLayout(r: ResourceReader, dataOff: number, count: number, stride: number): VLayout {
  const N = Math.min(count, 256);
  let bestUv = -1, bestUvScore = 0, bestUvHalf = true;
  let bestNrm = -1, bestNrmScore = 0;

  // UV as half2
  for (let off = 8; off + 4 <= stride; off += 2) {
    let ok = 0;
    for (let i = 0; i < N; i++) {
      const o = dataOff + i * stride + off;
      const u = decodeHalf(su16(r, o)), v = decodeHalf(su16(r, o + 2));
      if (u >= -0.25 && u <= 1.25 && v >= -0.25 && v <= 1.25 && (u !== 0 || v !== 0)) ok++;
    }
    if (ok > bestUvScore) { bestUvScore = ok; bestUv = off; bestUvHalf = true; }
  }
  // UV as float2 (fallback) — only if half2 was weak
  if (bestUvScore < N * 0.5) {
    for (let off = 12; off + 8 <= stride; off += 4) {
      let ok = 0;
      for (let i = 0; i < N; i++) {
        const o = dataOff + i * stride + off;
        const u = sf32(r, o), v = sf32(r, o + 4);
        if (u >= -0.25 && u <= 1.25 && v >= -0.25 && v <= 1.25 && (u !== 0 || v !== 0)) ok++;
      }
      if (ok > bestUvScore) { bestUvScore = ok; bestUv = off; bestUvHalf = false; }
    }
  }
  // normal as float3 unit vector
  for (let off = 12; off + 12 <= stride; off += 4) {
    let ok = 0;
    for (let i = 0; i < N; i++) {
      const o = dataOff + i * stride + off;
      const x = sf32(r, o), y = sf32(r, o + 4), z = sf32(r, o + 8);
      const m = Math.sqrt(x * x + y * y + z * z);
      if (m > 0.85 && m < 1.15) ok++;
    }
    if (ok > bestNrmScore) { bestNrmScore = ok; bestNrm = off; }
  }

  return {
    posOff: 0,
    uvOff: bestUvScore > N * 0.5 ? bestUv : -1,
    uvIsHalf: bestUvHalf,
    uv1Off: -1, uv1IsHalf: true,
    normalOff: bestNrmScore > N * 0.5 ? bestNrm : -1,
  };
}

// ── VBUF / IBUF / MESH parsing ─────────────────────────────────────────────────

interface VBuf { stride: number; count: number; dataOff: number; declOff: number; }
interface IBuf { count: number; dataOff: number; }

function parseVBuf(r: ResourceReader, vbOff: number): VBuf | null {
  if (tagAt(r, vbOff) !== 'VBUF') return null;
  const stride = su32(r, vbOff + 0x08);
  const dataOff = r.resolve(sptr(r, vbOff + 0x10));
  const count = su32(r, vbOff + 0x18);
  const declOff = r.resolve(sptr(r, vbOff + 0x30));
  if (stride < 12 || stride > 256 || count === 0 || count > 1_000_000) return null;
  if (dataOff < 0 || dataOff + count * stride > r.res.buffer.length) return null;
  return { stride, count, dataOff, declOff };
}

function parseIBuf(r: ResourceReader, ibOff: number): IBuf | null {
  if (tagAt(r, ibOff) !== 'IBUF') return null;
  const count = su32(r, ibOff + 0x08);
  const dataOff = r.resolve(sptr(r, ibOff + 0x10));
  if (count === 0 || count > 20_000_000) return null;
  if (dataOff < 0 || dataOff + count * 2 > r.res.buffer.length) return null;
  return { count, dataOff };
}

function buildGeometry(
  r: ResourceReader, meshOff: number, geoIdx: number,
  shaderIndex: number, diag: YftDiagnostics,
): ParsedGeometry | null {
  const vbOff = r.resolve(sptr(r, meshOff + 0x18));
  const ibOff = r.resolve(sptr(r, meshOff + 0x38));
  if (vbOff < 0 || ibOff < 0) return null;

  const vb = parseVBuf(r, vbOff);
  const ib = parseIBuf(r, ibOff);
  if (!vb || !ib) {
    diag.warnings.push(`MESH@0x${meshOff.toString(16)}: VBUF/IBUF invalid`);
    return null;
  }

  if (!diag.vertexStrides.includes(vb.stride)) diag.vertexStrides.push(vb.stride);

  // Decode the real layout from the vertex declaration; only fall back to the
  // heuristic if the declaration is missing or its computed stride disagrees.
  const layout = decodeDeclaration(r, vb.declOff, vb.stride)
    ?? discoverVertexLayout(r, vb.dataOff, vb.count, vb.stride);

  const positions = new Float32Array(vb.count * 3);
  const normals = layout.normalOff >= 0 ? new Float32Array(vb.count * 3) : null;

  for (let i = 0; i < vb.count; i++) {
    const vo = vb.dataOff + i * vb.stride;
    // RAW position (transform applied downstream in buildVehicleFromDrawable)
    positions[i * 3]     = sf32(r, vo + layout.posOff);
    positions[i * 3 + 1] = sf32(r, vo + layout.posOff + 4);
    positions[i * 3 + 2] = sf32(r, vo + layout.posOff + 8);

    if (normals && layout.normalOff >= 0) {
      normals[i * 3]     = sf32(r, vo + layout.normalOff);
      normals[i * 3 + 1] = sf32(r, vo + layout.normalOff + 4);
      normals[i * 3 + 2] = sf32(r, vo + layout.normalOff + 8);
    }
  }

  // UVs: read texcoord0; if it is degenerate (every vertex maps to one point —
  // some GTA shaders leave UV0 unused and bind the diffuse to texcoord1), use
  // texcoord1 instead. This is the real per-shader UV-channel binding, detected
  // from the data rather than assumed.
  const readUVChannel = (uvOff: number, isHalf: boolean): { uvs: Float32Array; ext: number } | null => {
    if (uvOff < 0) return null;
    const out = new Float32Array(vb.count * 2);
    let mnU = 1e9, mxU = -1e9, mnV = 1e9, mxV = -1e9;
    for (let i = 0; i < vb.count; i++) {
      const o = vb.dataOff + i * vb.stride + uvOff;
      const u = isHalf ? decodeHalf(su16(r, o)) : sf32(r, o);
      const v = isHalf ? decodeHalf(su16(r, o + 2)) : sf32(r, o + 4);
      out[i * 2] = u; out[i * 2 + 1] = v;
      if (u < mnU) mnU = u; if (u > mxU) mxU = u;
      if (v < mnV) mnV = v; if (v > mxV) mxV = v;
    }
    return { uvs: out, ext: Math.max(mxU - mnU, mxV - mnV) };
  };
  let uvs: Float32Array | null = null;
  let uvChannel = 0;
  let uvFieldOffset = layout.uvOff;
  let uvIsHalf = layout.uvIsHalf;
  const uv0 = readUVChannel(layout.uvOff, layout.uvIsHalf);
  if (uv0 && uv0.ext > 0.002) {
    uvs = uv0.uvs;
  } else {
    const uv1 = readUVChannel(layout.uv1Off, layout.uv1IsHalf);
    if (uv1 && uv1.ext > 0.002) { uvs = uv1.uvs; uvChannel = 1; uvFieldOffset = layout.uv1Off; uvIsHalf = layout.uv1IsHalf; }
    else uvs = uv0 ? uv0.uvs : null;
  }

  const triCount = Math.floor(ib.count / 3);
  const indices = new Uint32Array(ib.count);
  let maxIdx = 0;
  for (let i = 0; i < ib.count; i++) {
    const v = su16(r, ib.dataOff + i * 2);
    indices[i] = v;
    if (v > maxIdx) maxIdx = v;
  }
  // Guard: index out of vertex range → drop mesh
  if (maxIdx >= vb.count) {
    diag.warnings.push(`MESH@0x${meshOff.toString(16)}: index ${maxIdx} >= vertCount ${vb.count}`);
    return null;
  }

  diag.totalVertices += vb.count;
  diag.totalTriangles += triCount;

  return {
    name: `mesh_${geoIdx}`,
    positions, uvs, normals, indices,
    shaderIndex, vertexStride: vb.stride, fvf: 0, uvChannel,
    vertexBufferOffset: vb.dataOff, uvFieldOffset, uvIsHalf, vertexCount: vb.count,
  };
}

// ── GEOM (LOD group) parsing ───────────────────────────────────────────────────
// GEOM layout (offsets from the tag):
//   +0x08  ptr → MESH-pointer array (count entries)  ← the reliable location
//   +0x10  count (u16)
//   +0x20  ptr → per-mesh material-index array (u16, count entries, lockstep)
// NOTE: the MESH array is reached via the pointer @+0x08 — it is NOT always
// inline at +0x40. (For some vehicles +0x08 happens to point at +0x40, which is
// why an earlier "+0x40" reader appeared to work; for others the array lives in
// a separate block and +0x40 holds inline VBUF data, so reading +0x40 yields 0
// meshes and the body GEOM is silently lost — leaving only a wheel to render.)
// The 7-ish GEOMs of a vehicle are body LOD levels + wheels; GEOM[0] (highest
// vertex count) is the complete high-LOD body.

interface GeomEntry { meshOff: number; matIdx: number; }

function geomEntries(r: ResourceReader, geomOff: number): GeomEntry[] {
  const count = su16(r, geomOff + 0x10);
  if (count === 0 || count > 8192) return [];
  const meshArrBase = r.resolve(sptr(r, geomOff + 0x08));
  const matIdxBase  = r.resolve(sptr(r, geomOff + 0x20));
  if (meshArrBase < 0) return [];
  const out: GeomEntry[] = [];
  for (let i = 0; i < count; i++) {
    const meshOff = r.resolve(sptr(r, meshArrBase + i * 8));
    if (meshOff < 0 || tagAt(r, meshOff) !== 'MESH') continue;
    const matIdx = matIdxBase >= 0 ? su16(r, matIdxBase + i * 2) : -1;
    out.push({ meshOff, matIdx });
  }
  return out;
}

function meshVertCount(r: ResourceReader, meshOff: number): number {
  const vb = r.resolve(sptr(r, meshOff + 0x18));
  if (vb < 0 || tagAt(r, vb) !== 'VBUF') return 0;
  return su32(r, vb + 0x18);
}

// ── MATS material table + TXEX texture resolution ───────────────────────────────
// MATS @ first 'MATS' tag: material-ptr array @+0x10, count u16 @+0x18.
// Each material struct: param list ptr @+0x00 → 16-byte param entries; the TXEX
// pointers (diffuse, normal, spec, …) live in that list. First diffuse-like name
// is the primary texture.

interface MatsTable { arrOff: number; count: number; }

function readMatsTable(r: ResourceReader): MatsTable | null {
  const offs = findTagOffsets(r.res.buffer, 'MATS');
  if (offs.length === 0) return null;
  const arrOff = r.resolve(sptr(r, offs[0] + 0x10));
  const count = su16(r, offs[0] + 0x18);
  if (arrOff < 0 || count === 0 || count > 4096) return null;
  return { arrOff, count };
}

function txexName(r: ResourceReader, txexOff: number): string | null {
  const n = r.resolve(sptr(r, txexOff + 0x28));
  if (n < 0) return null;
  const nm = readCString(r, n, 96);
  return nm.length >= 2 && /^[a-zA-Z0-9_]+$/.test(nm) ? nm : null;
}

function materialTextures(r: ResourceReader, matIdx: number, mats: MatsTable): string[] {
  if (matIdx < 0 || matIdx >= mats.count) return [];
  const mOff = r.resolve(sptr(r, mats.arrOff + matIdx * 8));
  if (mOff < 0) return [];
  const out: string[] = [];
  const list = r.resolve(sptr(r, mOff + 0x00));
  if (list >= 0) {
    for (let o = 0; o < 0x140; o += 8) {
      const p = r.resolve(sptr(r, list + o));
      if (p >= 0 && tagAt(r, p) === 'TXEX') { const nm = txexName(r, p); if (nm && !out.includes(nm)) out.push(nm); }
    }
  }
  if (out.length === 0) {
    // Fallback: TXEX pointers directly inside the material struct.
    for (let o = 0; o < 0x80; o += 4) {
      const p = r.resolve(sptr(r, mOff + o));
      if (p >= 0 && tagAt(r, p) === 'TXEX') { const nm = txexName(r, p); if (nm && !out.includes(nm)) out.push(nm); }
    }
  }
  return out;
}

// Pick the primary (diffuse/albedo) texture, preferring colour maps over the
// shared normal/spec/dirt maps.
function pickPrimaryTexture(names: string[]): string | null {
  if (names.length === 0) return null;
  const diff = names.find((n) => /_diff|diffuse|albedo|_c$|sign|symbol|livery|skin|paint|body|_d$/i.test(n));
  if (diff) return diff;
  const notMap = names.find((n) => !/_n$|normal|_spec$|spec|_s$|smallspec|dirt|blank/i.test(n));
  return notMap || names[0];
}

function collectTextureNames(r: ResourceReader): string[] {
  const buf = r.res.buffer;
  const txexOffs = findTagOffsets(buf, 'TXEX');
  const names: string[] = [];
  const seen = new Set<string>();
  for (const t of txexOffs) {
    const nm = txexName(r, t);
    if (nm && !seen.has(nm)) { seen.add(nm); names.push(nm); }
  }
  return names;
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function parseYftGeometry(buffer: ArrayBuffer): Promise<YftParseResult> {
  const diag: YftDiagnostics = {
    rsc7Magic: false, rsc7Version: 0,
    rsc7SystemFlags: '', rsc7GraphicsFlags: '',
    rsc7SystemSize: 0, rsc7GraphicsSize: 0,
    decompressMethod: 'failed', decompressedSize: 0,
    payloadPeekHex: '', failReason: '',
    decompressAttemptLog: [],
    containerFormat: 'unknown', tagCounts: {},
    sysPtrCount: 0, gfxPtrCount: 0, maxSysPtrOff: 0, maxGfxPtrOff: 0,
    sysSizeUsed: 0, sysSizeSource: '',
    probeResults: [], drawableBase: -1, drawableLodUsed: '',
    shaderGroupPtrRaw: '', shaderGroupBase: -1, shaderCount: 0, shaders: [],
    modelsFound: 0, meshTagCount: 0, geometryCount: 0,
    totalVertices: 0, totalTriangles: 0,
    vertexStrides: [], boundingBox: '', textureNames: [],
    bufferHex: '', drawableHeaderHex: '',
    investigationLog: [],
    systemHeaderHex: '',
    errors: [], warnings: [], notes: [],
  };

  const log = diag.investigationLog;
  const bytes = new Uint8Array(buffer);

  diag.rsc7Magic = bytes.length >= 4 &&
    bytes[0] === 0x52 && bytes[1] === 0x53 && bytes[2] === 0x43 && bytes[3] === 0x37;

  log.push(`=== YFT INVESTIGATION (tagged-format parser) ===`);
  log.push(`File size: ${bytes.length} bytes (0x${bytes.length.toString(16)})`);
  log.push(`RSC7 magic: ${diag.rsc7Magic ? 'YES' : 'NO'}`);

  // ── Decompress ──────────────────────────────────────────────────────────────
  const unpack = await unpackRSC7Detailed(bytes);
  diag.rsc7Version       = unpack.version;
  diag.rsc7SystemFlags   = `0x${unpack.systemFlags.toString(16)}`;
  diag.rsc7GraphicsFlags = `0x${unpack.graphicsFlags.toString(16)}`;
  diag.rsc7SystemSize    = unpack.systemSize;
  diag.rsc7GraphicsSize  = unpack.graphicsSize;
  diag.decompressMethod  = unpack.method;
  diag.decompressedSize  = unpack.decompressedSize;
  diag.payloadPeekHex    = unpack.payloadPeekHex;
  diag.failReason        = unpack.failReason ?? '';
  diag.decompressAttemptLog = unpack.attemptLog;

  log.push(`\n=== DECOMPRESSION ===`);
  for (const line of unpack.attemptLog) log.push(line);
  log.push(`Result: method=${unpack.method}, size=${unpack.decompressedSize}`);

  if (!unpack.resource) {
    const reason = unpack.failReason || 'RSC7 decompression failed.';
    diag.errors.push(reason);
    log.push(`FATAL: ${reason}`);
    return { drawable: null, reason, diagnostics: diag };
  }

  const res = unpack.resource;
  const buf = res.buffer;
  const r = new ResourceReader(res);
  diag.sysSizeUsed = r.sysSize;
  diag.sysSizeSource = res.systemSize > 0 && res.systemSize < buf.length ? 'RSC7 flags' : 'whole buffer';
  diag.bufferHex = hexDump(buf, 0, Math.min(0x100, buf.length));
  diag.systemHeaderHex = diag.bufferHex;
  diag.drawableHeaderHex = hexDump(buf, 0, Math.min(0xa0, buf.length));

  // Lightweight pointer census (keeps the diagnostics panel honest).
  {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let sys = 0, gfx = 0, maxSys = 0, maxGfx = 0;
    const limit = buf.length - 3;
    for (let i = 0; i < limit; i += 4) {
      const v = dv.getUint32(i, true);
      const seg = (v >>> 28) & 0xf, off = v & 0x0fffffff;
      if (seg === 5) { sys++; if (off > maxSys) maxSys = off; }
      else if (seg === 6) { gfx++; if (off > maxGfx) maxGfx = off; }
    }
    diag.sysPtrCount = sys; diag.gfxPtrCount = gfx;
    diag.maxSysPtrOff = maxSys; diag.maxGfxPtrOff = maxGfx;
  }

  log.push(`\n=== BUFFER FIRST 0x40 BYTES ===`);
  log.push(hexDump(buf, 0, Math.min(0x40, buf.length)));

  // ── Tag census ──────────────────────────────────────────────────────────────
  diag.tagCounts = censusTags(buf);
  const meshOffs = findTagOffsets(buf, 'MESH');
  diag.meshTagCount = meshOffs.length;
  log.push(`\n=== TAG CENSUS ===`);
  log.push(`MESH=${diag.tagCounts['MESH'] || 0} VBUF=${diag.tagCounts['VBUF'] || 0} IBUF=${diag.tagCounts['IBUF'] || 0} ` +
           `GEOM=${diag.tagCounts['GEOM'] || 0} DRFR=${diag.tagCounts['DRFR'] || 0} TXEX=${diag.tagCounts['TXEX'] || 0} MATS=${diag.tagCounts['MATS'] || 0}`);

  if (meshOffs.length === 0) {
    const reason = 'No MESH tags found — file is not in the expected tagged YFT format.';
    diag.errors.push(reason);
    log.push(`FATAL: ${reason}`);
    return { drawable: null, reason, diagnostics: diag };
  }
  diag.containerFormat = 'tagged';
  diag.modelsFound = meshOffs.length;
  diag.drawableBase = 0;            // FRAG root is the drawable in this format
  diag.drawableLodUsed = 'tagged';

  // ── All TXEX names (diagnostics) ─────────────────────────────────────────────
  const textureNames = collectTextureNames(r);
  diag.textureNames = textureNames;
  log.push(`\n=== TEXTURES ===`);
  log.push(`TXEX texture names: ${textureNames.length}`);
  log.push(textureNames.slice(0, 40).join(', '));

  // ── Select the high-LOD GEOM (avoids rendering overlapping LOD copies) ───────
  log.push(`\n=== GEOM / LOD SELECTION ===`);
  const geomOffs = findTagOffsets(buf, 'GEOM');
  let renderEntries: GeomEntry[] = [];
  let bestVerts = 0, bestGeom = -1;
  for (let gi = 0; gi < geomOffs.length; gi++) {
    const entries = geomEntries(r, geomOffs[gi]);
    let v = 0; for (const e of entries) v += meshVertCount(r, e.meshOff);
    log.push(`  GEOM[${gi}] meshes=${entries.length} verts=${v}`);
    if (v > bestVerts) { bestVerts = v; bestGeom = gi; renderEntries = entries; }
  }
  if (renderEntries.length === 0) {
    log.push(`  No GEOM yielded meshes — falling back to all ${meshOffs.length} MESH tags (no material map).`);
    renderEntries = meshOffs.map((m) => ({ meshOff: m, matIdx: -1 }));
  } else {
    log.push(`  Selected GEOM[${bestGeom}] (high LOD): ${renderEntries.length} of ${meshOffs.length} meshes.`);
  }
  diag.modelsFound = renderEntries.length;

  // ── Materials: one shader per distinct material used, with its primary texture ─
  const mats = readMatsTable(r);
  log.push(`\n=== MATERIALS ===`);
  log.push(mats ? `MATS table: ${mats.count} materials` : `No MATS table found.`);

  const shaders: ParsedShader[] = [];
  const shaderByMat = new Map<number, number>(); // matIdx → shaders[] index
  const ensureShader = (matIdx: number): number => {
    const existing = shaderByMat.get(matIdx);
    if (existing !== undefined) return existing;
    const idx = shaders.length;
    let filename = `material_${matIdx}`;
    let texParams: string[] = [];
    let shaderHash = '0x0', diffuseSlot = -1;
    if (mats && matIdx >= 0) {
      const texs = materialTextures(r, matIdx, mats);
      const primary = pickPrimaryTexture(texs);
      if (primary) { filename = primary; texParams = [primary, ...texs.filter((t) => t !== primary)]; diffuseSlot = texs.indexOf(primary); }
      const mOff = r.resolve(sptr(r, mats.arrOff + matIdx * 8));
      if (mOff >= 0) shaderHash = `0x${su32(r, mOff + 0x08).toString(16)}`;
    }
    shaders.push({ index: idx, filename, textureParams: texParams, materialIndex: matIdx, shaderHash, diffuseSlot });
    shaderByMat.set(matIdx, idx);
    return idx;
  };
  // Guarantee at least one neutral slot so Materials > 0 even without MATS.
  if (!mats) { shaders.push({ index: 0, filename: 'vehicle_paint', textureParams: [], materialIndex: -1, shaderHash: '0x0', diffuseSlot: -1 }); shaderByMat.set(-1, 0); }

  // Global mesh→material map (across ALL GEOMs) so the fallback path can still
  // resolve per-part materials even if it bypasses GEOM selection.
  const meshMatMap = new Map<number, number>();
  for (const g of geomOffs)
    for (const e of geomEntries(r, g))
      if (!meshMatMap.has(e.meshOff)) meshMatMap.set(e.meshOff, e.matIdx);

  // ── Build geometries from a set of entries (resets per-build counters) ────────
  const buildSet = (entries: GeomEntry[]): ParsedGeometry[] => {
    diag.totalVertices = 0; diag.totalTriangles = 0; diag.vertexStrides = [];
    const out: ParsedGeometry[] = [];
    for (let i = 0; i < entries.length; i++) {
      const shaderIdx = ensureShader(entries[i].matIdx);
      try {
        const g = buildGeometry(r, entries[i].meshOff, i, shaderIdx, diag);
        if (g) out.push(g);
      } catch (e: any) { diag.warnings.push(`MESH[${i}] threw: ${e?.message || e}`); }
    }
    return out;
  };

  const dimsOf = (geos: ParsedGeometry[]): [number, number, number] => {
    let nx = 1e9, xx = -1e9, ny = 1e9, xy = -1e9, nz = 1e9, xz = -1e9;
    for (const g of geos) for (let i = 0; i < g.positions.length; i += 3) {
      const x = g.positions[i], y = g.positions[i + 1], z = g.positions[i + 2];
      if (x < nx) nx = x; if (x > xx) xx = x;
      if (y < ny) ny = y; if (y > xy) xy = y;
      if (z < nz) nz = z; if (z > xz) xz = z;
    }
    return geos.length ? [xx - nx, xy - ny, xz - nz] : [0, 0, 0];
  };

  // ── Build, with a hard safety net against the "tire only" failure ────────────
  log.push(`\n=== GEOMETRY ===`);
  log.push(`Building selected ${renderEntries.length} meshes...`);
  let geometries = buildSet(renderEntries);
  let dims = dimsOf(geometries);
  // A real vehicle body is always > 3 m on its longest axis. If the selected
  // geometry is smaller (e.g. GEOM selection grabbed a wheel), render EVERY MESH
  // tag instead — guarantees the full vehicle shows rather than a single part.
  if (geometries.length === 0 || Math.max(...dims) < 3.0) {
    log.push(`  Selected set max-dim=${Math.max(...dims).toFixed(2)}m < 3m → FALLBACK: rendering all ${meshOffs.length} MESH tags.`);
    const allEntries: GeomEntry[] = meshOffs.map((m) => ({ meshOff: m, matIdx: meshMatMap.get(m) ?? -1 }));
    const allGeos = buildSet(allEntries);
    if (allGeos.length > geometries.length) { geometries = allGeos; dims = dimsOf(geometries); }
  }
  diag.geometryCount = geometries.length;

  let texturedShaders = 0;
  for (const s of shaders) if (s.textureParams.length > 0) texturedShaders++;
  diag.shaderCount = shaders.length;
  diag.shaders = shaders.map((s) => ({ filename: s.filename, textureParams: s.textureParams }));
  log.push(`Shaders/materials: ${shaders.length} (${texturedShaders} with a resolved texture)`);

  if (geometries.length > 0) {
    diag.boundingBox = `${dims[0].toFixed(2)} x ${dims[1].toFixed(2)} x ${dims[2].toFixed(2)} m`;
  }

  log.push(`Geometries built: ${geometries.length} / ${meshOffs.length}`);
  log.push(`Total vertices: ${diag.totalVertices}`);
  log.push(`Total triangles: ${diag.totalTriangles}`);
  log.push(`Bounding box: ${diag.boundingBox}`);
  log.push(`Vertex strides seen: ${diag.vertexStrides.join(', ')}`);

  if (geometries.length === 0) {
    const reason = `${meshOffs.length} MESH tags found but 0 geometries decoded. ${diag.warnings.slice(0, 3).join('; ')}`;
    diag.errors.push(reason);
    return { drawable: null, reason, diagnostics: diag };
  }

  diag.notes.push(
    `OK: ${geometries.length} meshes, ${diag.totalVertices} verts, ${diag.totalTriangles} tris, ` +
    `${shaders.length} shaders/textures, bbox=${diag.boundingBox}, decompress=${unpack.method}.`
  );

  return {
    drawable: {
      geometries, shaders,
      shaderTextureNames: shaders.map((s) => s.textureParams[0] ?? null),
      diagnostics: diag,
    },
    diagnostics: diag,
  };
}
