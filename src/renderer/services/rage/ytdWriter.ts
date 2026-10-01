// In-place YTD texture replacement.
//
// Given the original .ytd bytes and a list of (name → canvas) replacements,
// returns modified .ytd bytes with the edited pixels written back — same
// RSC7 container, same texture structs, only the pixel data changes.
//
// Constraints:
// - Only textures whose dimensions match the original can be replaced.
// - DXT1/DXT5 originals stay compressed (we re-encode to DXT1).
// - Uncompressed originals stay uncompressed.
// - Mip chains are rebuilt at every level.

import { unpackRSC7Detailed, compressDeflateRaw, buildRSC7 } from './resource';
import { parseYtdDetailed, type TextureRecord } from './ytd';
import { buildMipChainDXT1, encodeRawDXT1, downsample2x } from '../ddsEncoder';

export interface YtdReplacement {
  name: string;
  canvas: HTMLCanvasElement;
}
export interface YtdWriteResult {
  bytes: Uint8Array;
  replaced: string[];
  skipped: { name: string; reason: string }[];
}

// ── Pixel encoder ─────────────────────────────────────────────────────────────

function encodeForFormat(
  canvas: HTMLCanvasElement, format: string | null, levels: number
): Uint8Array | null {
  if (!format) return null;
  const ctx = canvas.getContext('2d')!;
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rgba = id.data;
  const w = canvas.width, h = canvas.height;

  if (format === 'DXT1') return buildMipChainDXT1(canvas, levels);

  if (format === 'DXT5') {
    // DXT5 mip chain — DXT5 blocks are 16 bytes each, we use uncompressed alpha
    // for now (alpha channel in DXT5's 8-byte alpha block set to 0xFF).
    const chunks: Uint8Array[] = [];
    let curRgba: Uint8ClampedArray | Uint8Array = rgba;
    let cw = w, ch = h;
    for (let mip = 0; mip < levels; mip++) {
      const bw = Math.max(1, Math.ceil(cw / 4)), bh = Math.max(1, Math.ceil(ch / 4));
      const block = new Uint8Array(bw * bh * 16);
      let off = 0;
      for (let by = 0; by < ch; by += 4) for (let bx = 0; bx < cw; bx += 4) {
        // DXT5 alpha block — all pixels alpha=0xff → endpoints 0xff,0xff, codes all 00
        block[off + 0] = 0xff; block[off + 1] = 0xff; // alpha0, alpha1
        // 6 bytes of 3-bit indices → all zeros (select endpoint0 = 0xff)
        // DXT1 color block at +8
        const dxt1 = encodeRawDXT1(curRgba, cw, ch);
        // Pick out just this block's 8 bytes
        const blockIdx = (Math.floor(by / 4) * bw + Math.floor(bx / 4)) * 8;
        block.set(dxt1.subarray(blockIdx, blockIdx + 8), off + 8);
        off += 16;
      }
      chunks.push(block);
      if (cw <= 1 && ch <= 1) break;
      const ds = downsample2x(curRgba, cw, ch);
      curRgba = ds.data; cw = ds.w; ch = ds.h;
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  if (format === 'A8R8G8B8' || format === 'A8B8G8R8') {
    const swap = format === 'A8R8G8B8';
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      if (swap) { out[i] = rgba[i + 2]; out[i + 1] = rgba[i + 1]; out[i + 2] = rgba[i]; out[i + 3] = rgba[i + 3]; }
      else { out.set(rgba.subarray(i, i + 4), i); }
    }
    return out;
  }
  return null;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function replaceTexturesInYTD(
  originalBytes: ArrayBuffer,
  replacements: YtdReplacement[],
): Promise<YtdWriteResult> {
  const result: YtdWriteResult = { bytes: new Uint8Array(originalBytes), replaced: [], skipped: [] };
  if (replacements.length === 0) return result;

  const bytes = new Uint8Array(originalBytes);

  // Parse original to get texture records with dataOffset
  const report = await parseYtdDetailed(originalBytes);
  const texMap = new Map<string, TextureRecord>();
  for (const tex of report.textures) if (tex.texOffset !== undefined) texMap.set(tex.name, tex);

  // Decompress
  const details = await unpackRSC7Detailed(bytes);
  if (details.method === 'failed' || !details.resource) {
    result.skipped = replacements.map((r) => ({ name: r.name, reason: 'Decompression failed: ' + (details.failReason ?? 'unknown') }));
    return result;
  }

  const buf = new Uint8Array(details.resource.buffer); // mutable copy

  for (const rep of replacements) {
    const tex = texMap.get(rep.name);
    if (!tex) { result.skipped.push({ name: rep.name, reason: 'Texture name not found in original YTD' }); continue; }
    if (!tex.decoded) { result.skipped.push({ name: rep.name, reason: 'Original texture could not be decoded — skipping' }); continue; }
    if (rep.canvas.width !== tex.width || rep.canvas.height !== tex.height) {
      result.skipped.push({ name: rep.name, reason: `Dimension mismatch: canvas=${rep.canvas.width}×${rep.canvas.height}, original=${tex.width}×${tex.height}` });
      continue;
    }
    const encoded = encodeForFormat(rep.canvas, tex.format, Math.max(1, tex.levels));
    if (!encoded) { result.skipped.push({ name: rep.name, reason: `Format ${tex.format} encoding not supported yet` }); continue; }
    // Write encoded pixels into decompressed buffer at the data offset
    const dataOff = tex.dataOffset;
    if (dataOff < 0 || dataOff + encoded.length > buf.length) {
      result.skipped.push({ name: rep.name, reason: `Data offset 0x${dataOff.toString(16)} out of range (buffer=${buf.length})` });
      continue;
    }
    buf.set(encoded, dataOff);
    result.replaced.push(rep.name);
  }

  if (result.replaced.length === 0) return result;

  // Re-compress and rebuild RSC7
  const compressed = await compressDeflateRaw(buf);
  result.bytes = buildRSC7(
    details.version ?? 0x0C,
    details.systemFlags ?? 0,
    details.graphicsFlags ?? 0,
    compressed,
  );
  return result;
}
