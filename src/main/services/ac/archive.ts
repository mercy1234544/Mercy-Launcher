// Archive handling for the PLAYER installer — deliberately separate from AssettoCorsaManager's
// server-content importer, which is zip-only with a 2 GB cap. The SRP car pack is a 4.8 GB .7z.
//
// No new dependency: it drives a tool that is already on Windows — 7-Zip if installed (preferred),
// otherwise the built-in `tar.exe` (bsdtar/libarchive, which reads .7z and .zip). Arguments are
// passed as an array (never through a shell), member names come from the vetted requirements
// bundle, and every listing is validated BEFORE anything is extracted.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ArchiveTool { kind: '7z' | 'bsdtar'; exe: string }
export interface ArchiveEntry { path: string; size: number | null; isDir: boolean }

function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }

export function findArchiveTool(prefer?: 'auto' | '7z' | 'bsdtar'): ArchiveTool | null {
  const want = prefer ?? 'auto';
  if (want !== 'bsdtar') {
    const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs')].filter(Boolean) as string[];
    for (const r of roots) { const exe = path.join(r, '7-Zip', '7z.exe'); if (isFile(exe)) return { kind: '7z', exe }; }
    for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
      for (const n of ['7z.exe', '7z']) { const exe = path.join(dir, n); if (dir && isFile(exe)) return { kind: '7z', exe }; }
    }
  }
  if (want !== '7z') {
    const sys = process.env['SystemRoot'] ? path.join(process.env['SystemRoot'], 'System32', 'tar.exe') : '';
    if (sys && isFile(sys)) return { kind: 'bsdtar', exe: sys };
  }
  return null;
}

/** Reject anything that could write outside the destination. Throws with the offending name. */
export function assertSafeEntryPaths(entries: ArchiveEntry[]): void {
  for (const e of entries) {
    const p = e.path.replace(/\\/g, '/');
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..') || p.includes('\0') || /:/.test(p)) {
      throw new Error(`Unsafe path inside the archive, refusing to extract: "${e.path}"`);
    }
  }
}

function run(tool: ArchiveTool, args: string[], opts: { signal?: AbortSignal; onStdout?: (s: string) => void } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool.exe, args, { windowsHide: true, shell: false });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => { out.push(d); opts.onStdout?.(d.toString('utf8')); });
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => reject(new Error(`Could not run ${path.basename(tool.exe)}: ${e.message}`)));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    const onAbort = () => { try { child.kill(); } catch {} };
    if (opts.signal) { if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true }); }
  });
}

export async function listArchive(archive: string, tool: ArchiveTool, signal?: AbortSignal): Promise<ArchiveEntry[]> {
  if (tool.kind === '7z') {
    const r = await run(tool, ['l', '-slt', '-ba', '--', archive], { signal });
    if (r.code !== 0) throw new Error(`Could not read the archive (7-Zip exit ${r.code}): ${r.stderr.trim().split('\n')[0] || 'unknown error'}`);
    const entries: ArchiveEntry[] = [];
    for (const block of r.stdout.split(/\r?\n\r?\n/)) {
      const p = /^Path = (.*)$/m.exec(block); if (!p) continue;
      const sz = /^Size = (\d+)$/m.exec(block); const attr = /^Attributes = (.*)$/m.exec(block);
      const isDir = /^Folder = \+/m.test(block) || (attr ? attr[1].startsWith('D') : false);
      entries.push({ path: p[1].replace(/\\/g, '/'), size: sz ? parseInt(sz[1], 10) : null, isDir });
    }
    return entries;
  }
  const r = await run(tool, ['-tf', archive], { signal });
  if (r.code !== 0) throw new Error(`Could not read the archive (tar exit ${r.code}): ${r.stderr.trim().split('\n')[0] || 'unknown error'}`);
  return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => ({ path: l.replace(/\\/g, '/').replace(/\/$/, ''), size: null, isDir: l.endsWith('/') }));
}

/** Entries whose path is one of the given folders or lies inside one. A folder of '' means "everything". */
export function selectUnder(entries: ArchiveEntry[], folders: string[]): ArchiveEntry[] {
  if (folders.some((f) => f === '')) return entries;
  const roots = folders.map((f) => f.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
  return entries.filter((e) => { const p = e.path.toLowerCase(); return roots.some((r) => p === r || p.startsWith(r + '/')); });
}

/** The real archive path of a folder that may sit under an unknown wrapper prefix ("Pack/content/cars/x"). */
export function findFolder(entries: ArchiveEntry[], relative: string): string | null {
  const rel = relative.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  for (const e of entries) {
    const p = e.path.toLowerCase();
    if (p === rel || p.endsWith('/' + rel)) return e.path;
    const i = p.indexOf('/' + rel + '/');
    if (i >= 0) return e.path.slice(0, i + 1 + rel.length);
    if (p.startsWith(rel + '/')) return e.path.slice(0, rel.length);
  }
  return null;
}

export interface ExtractOptions {
  signal?: AbortSignal; onPercent?: (pct: number) => void; maxBytes?: number;
  /** Reuse an already-read listing instead of listing the (huge) archive again. */
  entries?: ArchiveEntry[];
  /** Refuse before extracting if this folder's drive cannot hold the selection (+10 % and 256 MB). */
  spaceCheckDir?: string;
  /** Tests: replace the real free-space lookup. */
  freeBytes?: (dir: string) => number | null;
}

/**
 * Extract only `folders` (archive-relative paths such as "content/cars/<id>") into dest.
 * Lists first, validates every selected path, extracts, then re-validates what landed on disk.
 */
export async function extractFolders(archive: string, dest: string, folders: string[], tool: ArchiveTool, opts: ExtractOptions = {}): Promise<{ extractedFiles: number; missing: string[] }> {
  const all = opts.entries ?? await listArchive(archive, tool, opts.signal);
  const wanted = selectUnder(all, folders);
  assertSafeEntryPaths(wanted);
  const missing = folders.filter((f) => !selectUnder(all, [f]).length);
  const present = folders.filter((f) => !missing.includes(f));
  const total = wanted.reduce((s, e) => s + (e.size ?? 0), 0);
  if (opts.maxBytes && total > opts.maxBytes) throw new Error(`The selected content is ${(total / 1e9).toFixed(1)} GB, over the ${(opts.maxBytes / 1e9).toFixed(0)} GB safety limit.`);
  if (opts.spaceCheckDir) {
    try {
      const free = opts.freeBytes ? opts.freeBytes(opts.spaceCheckDir) : (() => { const st = fs.statfsSync(opts.spaceCheckDir!); return Number(st.bavail) * Number(st.bsize); })();
      const need = total * 1.1 + 256 * 1024 * 1024;
      if (free !== null && free < need) throw new Error(`Not enough free disk space to install: need about ${(need / 1e9).toFixed(1)} GB, ${(free / 1e9).toFixed(1)} GB available on the Assetto Corsa drive. Nothing was changed.`);
    } catch (e: any) { if (/Not enough free disk space/.test(e?.message)) throw e; }
  }
  if (!present.length) return { extractedFiles: 0, missing };

  fs.mkdirSync(dest, { recursive: true });
  const everything = present.includes('');
  const args = tool.kind === '7z'
    ? ['x', '-y', '-aos', `-o${dest}`, '-bsp1', '-bse1', '--', archive, ...(everything ? [] : present.map((f) => f.replace(/\//g, '\\') + '\\*'))]
    : ['-xf', archive, '-C', dest, ...(everything ? [] : present)];
  const r = await run(tool, args, { signal: opts.signal, onStdout: (s) => { if (opts.onPercent) { const m = [...s.matchAll(/(\d{1,3})%/g)].pop(); if (m) opts.onPercent(Math.min(100, parseInt(m[1], 10))); } } });
  if (opts.signal?.aborted) throw new Error('Extraction was cancelled.');
  if (r.code !== 0) throw new Error(`Extraction failed (${tool.kind} exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-2).join(' | ') || 'unknown error'}`);

  const files = assertTreeIsSafe(dest);
  return { extractedFiles: files, missing };
}

/** Extract specific FILES (exact archive paths, e.g. a tiny version marker) without unpacking anything else. */
export async function extractMembers(archive: string, dest: string, members: string[], tool: ArchiveTool, signal?: AbortSignal): Promise<void> {
  assertSafeEntryPaths(members.map((m) => ({ path: m, size: null, isDir: false })));
  fs.mkdirSync(dest, { recursive: true });
  const args = tool.kind === '7z'
    ? ['x', '-y', '-aos', `-o${dest}`, '--', archive, ...members.map((m) => m.replace(/\//g, '\\'))]
    : ['-xf', archive, '-C', dest, ...members];
  const r = await run(tool, args, { signal });
  if (r.code !== 0) throw new Error(`Could not read from the archive (${tool.kind} exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown error'}`);
  assertTreeIsSafe(dest);
}

/** After extraction: no symlinks/junctions, nothing resolving outside dest. Returns the file count. */
export function assertTreeIsSafe(dest: string): number {
  const root = fs.realpathSync(dest); let files = 0;
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`The archive contained a link ("${e.name}"); refusing to install it.`);
      const real = fs.realpathSync(p);
      if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`An extracted path escaped the staging folder: "${e.name}"`);
      if (e.isDirectory()) walk(p); else files++;
    }
  })(dest);
  return files;
}
