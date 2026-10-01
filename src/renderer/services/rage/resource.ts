// RAGE resource container (RSC7) core.
// GTA .ytd/.yft/.ydr files are RSC7-wrapped, raw-deflate compressed, and split into
// a "system" (virtual) segment and a "graphics" (physical) segment. Internal pointers
// are 64-bit with the top nibble selecting the segment (0x5 = system, 0x6 = graphics).
//
// Decompression strategy (in priority order):
//   1. Node.js zlib.inflateRaw via IPC (always reliable)
//   2. Web DecompressionStream('deflate-raw')
//   3. Web DecompressionStream('deflate')   (zlib-wrapped, some modding tools)
//   4. Uncompressed passthrough             (≥ 32 bytes raw payload)

const RSC7_MAGIC = 0x37435352; // 'RSC7' little-endian

export interface RageResource {
  version: number;
  buffer: Uint8Array;
  view: DataView;
  systemSize: number;
  graphicsSize: number;
}

export interface UnpackDetails {
  resource: RageResource | null;
  method: 'node-zlib' | 'deflate-raw' | 'deflate' | 'uncompressed' | 'failed';
  failReason?: string;
  /** Error messages from each decompression attempt (for diagnostics). */
  attemptLog: string[];
  payloadPeekHex: string;
  version: number;
  systemFlags: number;
  graphicsFlags: number;
  systemSize: number;
  graphicsSize: number;
  compressedPayloadSize: number;
  decompressedSize: number;
}

export function sizeFromFlags(flags: number): number {
  const s0 = ((flags >>> 27) & 0x1) << 0;
  const s1 = ((flags >>> 26) & 0x1) << 1;
  const s2 = ((flags >>> 25) & 0x1) << 2;
  const s3 = ((flags >>> 24) & 0x1) << 3;
  const s4 = ((flags >>> 17) & 0x7f) << 4;
  const s5 = ((flags >>> 11) & 0x3f) << 5;
  const s6 = ((flags >>> 7) & 0xf) << 6;
  const s7 = ((flags >>> 5) & 0x3) << 7;
  const s8 = ((flags >>> 4) & 0x1) << 8;
  const ss = (flags >>> 0) & 0xf;
  const baseSize = 0x200 << ss;
  return baseSize * (s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7 + s8);
}

// ── Half-precision float (shared by the yft reader and any writer that
// needs to re-encode UV/normal data back into the same half-float fields) ──

export function decodeHalf(h: number): number {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0)  return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** Simplified float32 → float16 — correct for the small, finite, well-
 *  behaved values UV coordinates always are; does not special-case the
 *  full IEEE-754 subnormal/NaN/overflow range a general-purpose encoder
 *  would need. */
export function encodeHalf(v: number): number {
  const f32 = new Float32Array(1); f32[0] = v;
  const bits = new Uint32Array(f32.buffer)[0];
  const sign = (bits >>> 16) & 0x8000;
  const exp = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exp <= 0) return sign; // underflow/subnormal -> flush to zero
  if (exp >= 31) return sign | 0x7bff; // overflow -> clamp to max half value
  return sign | (exp << 10) | (mantissa >>> 13);
}

// ── RSC7 (re)compression — shared by every in-place binary writer (YTD
// texture replacement, YFT UV patching, …): decompress → patch bytes at
// known offsets → recompress with the same deflate-raw method → rebuild
// the same 16-byte RSC7 header with the ORIGINAL version/size flags
// (buffer size never changes, so the same flags are still correct). ──────

export async function compressDeflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new (globalThis as any).CompressionStream('deflate-raw') as {
    writable: WritableStream<Uint8Array>;
    readable: ReadableStream<Uint8Array>;
  };
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const safeBuf = data.buffer instanceof ArrayBuffer ? data : new Uint8Array(data);
  writer.write(safeBuf); writer.close();
  const chunks: Uint8Array[] = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; if (value) chunks.push(value); }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export function buildRSC7(version: number, systemFlags: number, graphicsFlags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x37435352, true); // 'RSC7'
  dv.setUint32(4, version, true);
  dv.setUint32(8, systemFlags, true);
  dv.setUint32(12, graphicsFlags, true);
  out.set(payload, 16);
  return out;
}

export function isRSC7(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const magic = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] * 0x1000000)) >>> 0;
  return magic === RSC7_MAGIC;
}

// ── Base64 helpers (chunk-safe for large buffers) ────────────────────────────

function bufToB64(buf: Uint8Array): string {
  // Chunk size MUST be a multiple of 3 so each btoa() call produces no
  // mid-stream padding ('='). Embedded padding chars in a concatenated base64
  // string misalign Node.js's decoder and produce garbled output.
  // 49152 = 48 × 1024 = 3 × 16384. The final (possibly shorter) chunk may
  // still have trailing '==' but that is correct and expected at the very end.
  const CHUNK = 49152;
  let b64 = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, buf.length);
    let binary = '';
    for (let j = i; j < end; j++) binary += String.fromCharCode(buf[j]);
    b64 += btoa(binary);
  }
  return b64;
}

function b64ToBuf(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Decompression via Node.js zlib (IPC to main process) ─────────────────────

async function tryDecompressViaNode(
  data: Uint8Array,
  format: 'deflate-raw' | 'deflate',
  log: string[],
): Promise<Uint8Array | null> {
  try {
    const livery = (window as any).electronAPI?.livery;
    if (!livery?.inflateRaw) {
      log.push(`Node zlib (${format}): IPC not available`);
      return null;
    }
    const b64 = bufToB64(data);
    const method = format === 'deflate-raw' ? 'inflateRaw' : 'inflate';
    const result: string | null = await livery[method](b64);
    if (!result) {
      log.push(`Node zlib (${format}): IPC returned null (no result)`);
      return null;
    }
    if (result.startsWith('ERR:')) {
      log.push(`Node zlib (${format}): decompression failed — ${result.slice(4)}`);
      return null;
    }
    const out = b64ToBuf(result);
    log.push(`Node zlib (${format}): OK — decompressed ${data.length} → ${out.length} bytes`);
    return out.length >= 4 ? out : null;
  } catch (e: any) {
    log.push(`Node zlib (${format}): threw — ${e?.message || e}`);
    return null;
  }
}

// ── Decompression via Web DecompressionStream ─────────────────────────────────

async function tryDecompressWeb(
  data: Uint8Array,
  format: 'deflate-raw' | 'deflate',
  log: string[],
): Promise<Uint8Array | null> {
  if (typeof (globalThis as any).DecompressionStream === 'undefined') {
    log.push(`Web DecompressionStream(${format}): API not available in this environment`);
    return null;
  }
  try {
    const ds = new (globalThis as any).DecompressionStream(format);
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const out = new Response(new Blob([ab]).stream().pipeThrough(ds));
    const result = new Uint8Array(await out.arrayBuffer());
    if (result.length < 4) {
      log.push(`Web DecompressionStream(${format}): result too small (${result.length} bytes)`);
      return null;
    }
    log.push(`Web DecompressionStream(${format}): OK — ${data.length} → ${result.length} bytes`);
    return result;
  } catch (e: any) {
    log.push(`Web DecompressionStream(${format}): threw — ${e?.message || e}`);
    return null;
  }
}

// ── Main unpacker ──────────────────────────────────────────────────────────────

export async function unpackRSC7Detailed(bytes: Uint8Array): Promise<UnpackDetails> {
  const attemptLog: string[] = [];

  const empty = (method: UnpackDetails['method'], failReason?: string): UnpackDetails => ({
    resource: null, method, failReason, attemptLog,
    payloadPeekHex: '', version: 0, systemFlags: 0, graphicsFlags: 0,
    systemSize: 0, graphicsSize: 0, compressedPayloadSize: 0, decompressedSize: 0,
  });

  if (!isRSC7(bytes)) return empty('failed', 'RSC7 magic not found in first 4 bytes');
  if (bytes.length < 17) return empty('failed', 'File too small (< 17 bytes)');

  const dv           = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version      = dv.getInt32(4, true);
  const systemFlags  = dv.getUint32(8, true);
  const graphicsFlags= dv.getUint32(12, true);
  const systemSize   = sizeFromFlags(systemFlags);
  const graphicsSize = sizeFromFlags(graphicsFlags);

  attemptLog.push(`RSC7 header: version=${version} (0x${version.toString(16)})`);
  attemptLog.push(`systemFlags=0x${systemFlags.toString(16)} → systemSize=0x${systemSize.toString(16)} (${systemSize})`);
  attemptLog.push(`graphicsFlags=0x${graphicsFlags.toString(16)} → graphicsSize=0x${graphicsSize.toString(16)} (${graphicsSize})`);
  attemptLog.push(`Total expected decompressed size: 0x${(systemSize + graphicsSize).toString(16)}`);

  const payload = bytes.subarray(16);

  const peek: string[] = [];
  for (let i = 0; i < Math.min(32, payload.length); i++)
    peek.push(payload[i].toString(16).padStart(2, '0'));
  const payloadPeekHex = peek.join(' ');

  attemptLog.push(`Payload size: ${payload.length} bytes`);
  attemptLog.push(`Payload first 32 bytes: ${payloadPeekHex}`);

  const fill = (inflated: Uint8Array, method: UnpackDetails['method']): UnpackDetails => {
    const gs = graphicsSize || Math.max(0, inflated.length - systemSize);
    return {
      resource: {
        version, buffer: inflated,
        view: new DataView(inflated.buffer, inflated.byteOffset, inflated.byteLength),
        systemSize, graphicsSize: gs,
      },
      method, attemptLog, payloadPeekHex, version, systemFlags, graphicsFlags,
      systemSize, graphicsSize, compressedPayloadSize: payload.length,
      decompressedSize: inflated.length,
    };
  };

  // 1. Node.js zlib (most reliable — uses native C decompressor)
  attemptLog.push(`\n[1] Trying Node.js zlib.inflateRaw...`);
  const nodeRaw = await tryDecompressViaNode(payload, 'deflate-raw', attemptLog);
  if (nodeRaw) return fill(nodeRaw, 'node-zlib');

  // 2. Web DecompressionStream deflate-raw
  attemptLog.push(`\n[2] Trying Web DecompressionStream('deflate-raw')...`);
  const webRaw = await tryDecompressWeb(payload, 'deflate-raw', attemptLog);
  if (webRaw) return fill(webRaw, 'deflate-raw');

  // 3. Node.js zlib inflate (zlib-wrapped)
  attemptLog.push(`\n[3] Trying Node.js zlib.inflate (zlib-wrapped)...`);
  const nodeZlib = await tryDecompressViaNode(payload, 'deflate', attemptLog);
  if (nodeZlib) return fill(nodeZlib, 'node-zlib');

  // 4. Web DecompressionStream deflate (zlib-wrapped)
  attemptLog.push(`\n[4] Trying Web DecompressionStream('deflate')...`);
  const webZlib = await tryDecompressWeb(payload, 'deflate', attemptLog);
  if (webZlib) return fill(webZlib, 'deflate');

  // 5. Uncompressed passthrough
  attemptLog.push(`\n[5] All decompression strategies failed. Using raw payload as uncompressed.`);
  attemptLog.push(`    WARNING: structures will be read from COMPRESSED data — likely garbage.`);
  if (payload.length >= 32) {
    return fill(payload, 'uncompressed');
  }

  return empty('failed',
    `All decompression strategies failed. Payload (${payload.length}B): ${payloadPeekHex}. ` +
    `RSC7 version=${version} sysFlags=0x${systemFlags.toString(16)} gfxFlags=0x${graphicsFlags.toString(16)}`
  );
}

export async function unpackRSC7(bytes: Uint8Array): Promise<RageResource | null> {
  const d = await unpackRSC7Detailed(bytes);
  return d.resource;
}

// ── Pointer-resolving reader ──────────────────────────────────────────────────

export class ResourceReader {
  readonly res: RageResource;
  readonly dv: DataView;
  sysSize: number; // mutable so investigation code can try different values

  constructor(res: RageResource) {
    this.res = res;
    this.dv  = res.view;
    this.sysSize = res.systemSize > 0 && res.systemSize < res.buffer.length
      ? res.systemSize
      : res.buffer.length;
  }

  resolve(ptr: number): number {
    if (!ptr) return -1;
    const seg = (ptr >>> 28) & 0xf;
    const off = ptr & 0x0fffffff;
    if (seg === 0x5) return off < this.sysSize ? off : -1;
    if (seg === 0x6) {
      const abs = this.sysSize + off;
      return abs < this.res.buffer.length ? abs : -1;
    }
    return -1;
  }

  u8(o: number)  { return this.dv.getUint8(o); }
  u16(o: number) { return this.dv.getUint16(o, true); }
  u32(o: number) { return this.dv.getUint32(o, true); }
  i32(o: number) { return this.dv.getInt32(o, true); }
  f32(o: number) { return this.dv.getFloat32(o, true); }
  ptr(o: number) { return this.dv.getUint32(o, true); }

  str(o: number, max = 128): string {
    if (o < 0) return '';
    let s = '';
    for (let i = 0; i < max; i++) {
      const c = this.dv.getUint8(o + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}
