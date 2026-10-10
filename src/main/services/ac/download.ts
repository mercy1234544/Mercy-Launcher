// Resumable, verified download for large official archives (the SRP car pack is 4.8 GB).
//
//  * https only (http is accepted solely for loopback, and only when a test opts in), every redirect hop
//    is re-checked against the same rule.
//  * Resumes a partial "<dest>.part" with an HTTP Range request when the server supports it; if the
//    server ignores the range it restarts cleanly rather than appending garbage.
//  * Nothing is moved to its final name until size AND SHA-256 match what the owner's inventory
//    recorded; a mismatch deletes the partial and reports both hashes.
//  * Checks free disk space first.
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { classifyHost } from '../AcRequirementsChecker';

export interface DownloadOptions {
  url: string;
  dest: string;
  expectedBytes?: number | null;
  expectedSha256?: string | null;
  onProgress?: (p: { received: number; total: number | null }) => void;
  signal?: AbortSignal;
  /** Tests only: allow plain http to 127.0.0.1 / localhost. */
  allowLoopbackHttp?: boolean;
  /** Development catalogs only: also allow plain http to private-network hosts (never public ones). */
  allowPrivateHttp?: boolean;
  /** When set, the URL and EVERY redirect hop must be on one of these host names (catalog downloads). */
  allowedHosts?: string[];
  /** Hard ceiling: abort if the server announces or streams more than this many bytes. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Free space to keep after the download. Default 512 MB. */
  reserveBytes?: number;
  /** Internal: a resumed download that fails verification is retried once from scratch; this stops a second retry. */
  noRetry?: boolean;
  /** Tests: replace the real free-space lookup. */
  freeBytes?: (dir: string) => number | null;
}
export interface DownloadResult { path: string; bytes: number; sha256: string; resumed: boolean; reusedExisting: boolean }

export function sha256OfFile(file: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
    signal?.addEventListener('abort', () => { s.destroy(new Error('cancelled')); }, { once: true });
  });
}

function checkUrlPolicy(u: URL, opts: Pick<DownloadOptions, 'allowLoopbackHttp' | 'allowPrivateHttp' | 'allowedHosts'>) {
  const host = u.hostname.toLowerCase();
  const loop = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  if (opts.allowedHosts && !opts.allowedHosts.some((h) => h.toLowerCase() === host)) {
    throw new Error(`Refusing to download from "${host}": it is not one of the hosts the content owner authorised for this file.`);
  }
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:' && opts.allowLoopbackHttp && loop) return;
  if (u.protocol === 'http:' && opts.allowPrivateHttp) { const k = classifyHost(host); if (k === 'private-lan' || k === 'loopback') return; }
  throw new Error(`Refusing to download over an insecure or unsupported connection (${u.protocol}//${u.hostname}). Only https is allowed.`);
}

function freeBytes(dir: string): number | null {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

function request(url: string, headers: Record<string, string>, opts: DownloadOptions, hop = 0): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); checkUrlPolicy(u, opts); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers: { 'User-Agent': 'MercyLauncher/AcInstaller', ...headers }, timeout: 30000 }, (res) => {
      const code = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        if (hop >= (opts.maxRedirects ?? 5)) return reject(new Error('Too many redirects.'));
        let next: string; try { next = new URL(res.headers.location, u).toString(); } catch { return reject(new Error('Bad redirect target.')); }
        return request(next, headers, opts, hop + 1).then(resolve, reject);
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('The download stalled (no data for 30 seconds). It can be resumed.')));
    req.on('error', reject);
    opts.signal?.addEventListener('abort', () => req.destroy(new Error('Download cancelled.')), { once: true });
  });
}

export async function downloadVerified(opts: DownloadOptions): Promise<DownloadResult> {
  const { dest, expectedBytes = null, expectedSha256 = null } = opts;
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Reuse a finished, verified file from an earlier run.
  if (fs.existsSync(dest)) {
    const size = fs.statSync(dest).size;
    if ((expectedBytes === null || size === expectedBytes) && expectedSha256) {
      const h = await sha256OfFile(dest, opts.signal);
      if (h === expectedSha256) return { path: dest, bytes: size, sha256: h, resumed: false, reusedExisting: true };
    }
    fs.rmSync(dest, { force: true });
  }

  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (expectedBytes !== null && have > expectedBytes) { fs.rmSync(part, { force: true }); have = 0; }

  if (opts.maxBytes !== undefined && expectedBytes !== null && expectedBytes > opts.maxBytes) throw new Error(`This file is ${(expectedBytes / 1e9).toFixed(1)} GB, which is over the ${(opts.maxBytes / 1e9).toFixed(1)} GB limit. It was not downloaded.`);
  const free = (opts.freeBytes ?? freeBytes)(path.dirname(dest));
  const needed = expectedBytes !== null ? Math.max(0, expectedBytes - have) : 0;
  if (free !== null && needed > 0 && free < needed + (opts.reserveBytes ?? 512 * 1024 * 1024)) {
    throw new Error(`Not enough free disk space for this download: need about ${(needed / 1e9).toFixed(1)} GB, ${(free / 1e9).toFixed(1)} GB available on that drive.`);
  }

  let res = await request(opts.url, have > 0 ? { Range: `bytes=${have}-` } : {}, opts);
  let resumed = false;
  if (res.statusCode === 416) { // our partial is not a valid prefix, or already complete
    res.resume();
    if (expectedBytes !== null && have === expectedBytes) resumed = true;
    else { fs.rmSync(part, { force: true }); have = 0; res = await request(opts.url, {}, opts); }
  }
  let total: number | null = expectedBytes;
  if (!(resumed && have === expectedBytes)) {
    if (res.statusCode === 206) {
      const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(String(res.headers['content-range'] ?? ''));
      if (!m || parseInt(m[1], 10) !== have) { res.resume(); fs.rmSync(part, { force: true }); throw new Error('The server returned an unexpected byte range; the partial download was discarded. Try again.'); }
      resumed = true;
      if (m[3] !== '*') total = parseInt(m[3], 10);
    } else if (res.statusCode === 200) {
      if (have > 0) { fs.rmSync(part, { force: true }); have = 0; } // server ignored Range: restart cleanly
      const cl = parseInt(String(res.headers['content-length'] ?? ''), 10);
      if (Number.isFinite(cl)) total = cl;
    } else {
      res.resume();
      throw new Error(`The download server answered HTTP ${res.statusCode}. The file may have moved or been removed.`);
    }
    if (opts.maxBytes !== undefined && total !== null && total > opts.maxBytes) { res.resume(); throw new Error(`The server announces ${(total / 1e9).toFixed(1)} GB, over the ${(opts.maxBytes / 1e9).toFixed(1)} GB limit. It was not downloaded.`); }
    if (expectedBytes !== null && total !== null && total !== expectedBytes) {
      res.resume();
      throw new Error(`The server's file is ${total} bytes but the verified inventory expects ${expectedBytes}. The upstream file has changed, so it will not be installed.`);
    }
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
      let received = have; let last = 0;
      const ceiling = expectedBytes ?? opts.maxBytes ?? null;
      res.on('data', (c: Buffer) => {
        received += c.length;
        // A server that sends more than it promised (or than we allow) is cut off instead of filling the disk.
        if (ceiling !== null && received > ceiling) { res.destroy(new Error(`The server sent more data than the ${ceiling} bytes expected. The download was stopped.`)); return; }
        const now = Date.now(); if (opts.onProgress && now - last > 250) { last = now; opts.onProgress({ received, total }); }
      });
      res.on('error', (e) => { out.destroy(); reject(e); });
      res.on('aborted', () => { out.destroy(); reject(new Error('The connection dropped. The partial download is kept and will resume.')); });
      out.on('error', reject);
      out.on('finish', () => resolve());
      res.pipe(out);
    });
    opts.onProgress?.({ received: fs.statSync(part).size, total });
  }

  const size = fs.statSync(part).size;
  if ((expectedBytes ?? total) !== null && size !== (expectedBytes ?? total)) {
    throw new Error(`The download ended early (${size} of ${expectedBytes ?? total} bytes). The partial file is kept; start the install again to resume.`);
  }
  const h = await sha256OfFile(part, opts.signal);
  if (expectedSha256 && h !== expectedSha256) {
    fs.rmSync(part, { force: true });
    // A resumed file can be wrong simply because the leftover partial was damaged: try once from scratch.
    if (resumed && !opts.noRetry) return downloadVerified({ ...opts, noRetry: true });
    throw new Error(`The downloaded file's SHA-256 does not match the verified inventory (got ${h.slice(0, 16)}…, expected ${expectedSha256.slice(0, 16)}…). It was discarded and NOT installed. The upstream file may have been updated; the owner needs to refresh the inventory.`);
  }
  fs.renameSync(part, dest);
  return { path: dest, bytes: size, sha256: h, resumed, reusedExisting: false };
}
