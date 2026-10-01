// In-place YFT UV replacement — the write-back half of "Generate UV
// Template" (see uvGenerator.ts). Same technique ytdWriter.ts already uses
// for texture pixels: decompress the real RSC7 payload, patch bytes at
// KNOWN offsets, recompress, rebuild the same 16-byte header. This only
// ever works for an in-place UV swap (same vertex count, same stride, same
// buffer size) — it is NOT a general geometry writer, and never tries to
// add/remove vertices or resize anything.
import * as THREE from 'three';
import { unpackRSC7Detailed, compressDeflateRaw, buildRSC7, encodeHalf } from './resource';

export interface YftUVPatch {
  mesh: THREE.Mesh;
  uvs: Float32Array;
}

export interface YftUVWriteResult {
  bytes: Uint8Array;
  patchedMeshes: string[];
  skipped: { name: string; reason: string }[];
}

export async function writeUVsToYFT(originalBytes: ArrayBuffer, patches: YftUVPatch[]): Promise<YftUVWriteResult> {
  const result: YftUVWriteResult = { bytes: new Uint8Array(originalBytes), patchedMeshes: [], skipped: [] };
  if (patches.length === 0) return result;

  const details = await unpackRSC7Detailed(new Uint8Array(originalBytes));
  if (details.method === 'failed' || !details.resource) {
    result.skipped = patches.map((p) => ({ name: p.mesh.name, reason: 'Decompression failed: ' + (details.failReason ?? 'unknown') }));
    return result;
  }

  const buf = new Uint8Array(details.resource.buffer); // mutable copy
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  for (const { mesh, uvs } of patches) {
    const ud = mesh.userData as {
      vertexBufferOffset?: number; uvFieldOffset?: number; uvIsHalf?: boolean; vertexStride?: number; vertexCount?: number;
    };
    if (ud.vertexBufferOffset == null || ud.uvFieldOffset == null || ud.uvFieldOffset < 0 || !ud.vertexStride) {
      result.skipped.push({ name: mesh.name, reason: 'This mesh was not loaded from a real YFT vertex buffer (no recorded offset) — cannot patch UVs in place.' });
      continue;
    }
    const vertCount = uvs.length / 2;
    if (ud.vertexCount != null && vertCount !== ud.vertexCount) {
      result.skipped.push({ name: mesh.name, reason: `Vertex count mismatch (generated ${vertCount}, original ${ud.vertexCount}) — in-place UV patching requires the same vertex count.` });
      continue;
    }
    const uvSize = ud.uvIsHalf ? 4 : 8;
    let outOfRange = false;
    for (let i = 0; i < vertCount; i++) {
      const o = ud.vertexBufferOffset + i * ud.vertexStride + ud.uvFieldOffset;
      if (o < 0 || o + uvSize > buf.length) { outOfRange = true; break; }
      if (ud.uvIsHalf) {
        dv.setUint16(o, encodeHalf(uvs[i * 2]), true);
        dv.setUint16(o + 2, encodeHalf(uvs[i * 2 + 1]), true);
      } else {
        dv.setFloat32(o, uvs[i * 2], true);
        dv.setFloat32(o + 4, uvs[i * 2 + 1], true);
      }
    }
    if (outOfRange) {
      result.skipped.push({ name: mesh.name, reason: 'Computed vertex-buffer offset fell outside the file — refusing to write out of bounds.' });
      continue;
    }
    result.patchedMeshes.push(mesh.name);
  }

  if (result.patchedMeshes.length === 0) return result;

  const compressed = await compressDeflateRaw(buf);
  result.bytes = buildRSC7(details.version ?? 0x0c, details.systemFlags ?? 0, details.graphicsFlags ?? 0, compressed);
  return result;
}
