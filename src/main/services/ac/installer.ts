// Player content installer for Mercy's Servers — the WRITE side that the read-only checker deliberately lacks.
//
// Safety model (every rule is covered by test/assettocorsa/installer.test.js against disposable fixtures):
//  * Nothing happens without an explicit list of approved plan items; nothing is "fixed" silently.
//  * Custom Shaders Patch is NEVER installed or updated here — it is detected and explained only.
//  * Never overwrites: an existing folder that must be replaced is MOVED to .mercy-backups first
//    (same drive, instant), and moved back if anything later fails.
//  * Content is extracted into .mercy-staging, verified there (physics hashes / version marker) BEFORE
//    it touches content\cars or content\tracks, placed, then verified again by the real checker.
//    Any failure rolls the whole group back, leaving the previous state exactly as it was.
//  * A journal is written to disk after every step, so an install interrupted by a crash or power
//    loss is rolled back the next time the launcher looks (recoverInterruptedInstalls).
//  * Downloads come only from the official source recorded in the owner's inventory, only while the
//    inventory marks that link LIVE, only over https, and must match the recorded size and SHA-256.
//    The SRP track has no live link: it can only be installed from an archive the player obtained
//    themselves (and it is still verified against the version marker hash before being placed).
//  * Never runs while Assetto Corsa is running. Never writes outside <AC>\content and <AC>\apps\lua.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import {
  checkAcRequirements, classifyHost, parseBoardServers, safeSegment,
  type AcRequirementsReport, type SrpBundle, type SrpCarRequirement, type SrpTrackRequirement,
} from '../AcRequirementsChecker';
import { extractFolders, findArchiveTool, findFolder, listArchive, type ArchiveTool } from './archive';
import { downloadVerified, sha256OfFile } from './download';
import { buildSrpBoardFiles, planStamp, stampCoversEndpoints, type Resolver, type ResolvedEndpoints } from './endpoints';

// ── Plan types ───────────────────────────────────────────────────────────────

export type PlanItemKind = 'car' | 'car-skin' | 'track' | 'companion' | 'conflict' | 'external';
export type PlanAction = 'install' | 'repair' | 'update' | 'move-to-backup' | 'manual';

export interface PlanItem {
  id: string;
  kind: PlanItemKind;
  label: string;
  action: PlanAction;
  /** Replaces or moves existing files (they are backed up first, never deleted). */
  destructive: boolean;
  /** Optional for joining (e.g. the SRP Board). */
  optional: boolean;
  reason: string;
  sourceId?: string;
  carId?: string;
  skin?: string;
  /** Why this cannot be done automatically right now, and what the player can do instead. */
  blocked?: string;
  manualSteps?: string[];
  /** Needs an archive the player supplies (the SRP track). */
  needsLocalFile?: boolean;
}

export interface PlanDownload { sourceId: string; name: string; url: string; bytes: number | null; sha256: string | null; itemIds: string[]; allowedHosts?: string[]; fileName?: string }

export interface InstallPlan {
  serverId: string;
  acRoot: string | null;
  items: PlanItem[];
  downloads: PlanDownload[];
  csp: { status: 'ok' | 'missing' | 'too-old' | 'unknown'; message: string };
  archiveTool: 'none' | '7z' | 'bsdtar';
  summary: { total: number; automatic: number; manual: number; blocked: number; destructive: number };
  warnings: string[];
}

export interface PlanContext {
  acRoot: string | null;
  bundle: SrpBundle;
  serverId: string;
  endpoints: ResolvedEndpoints;
  documentsAcDir?: string | null;
  resolver?: Resolver;
  report?: AcRequirementsReport;
  tool?: ArchiveTool | null;
  /** Tests only: accept an http loopback "official" URL. */
  allowLoopbackHttp?: boolean;
  /** Development catalogs only: accept plain http to private-network hosts. */
  allowPrivateHttp?: boolean;
}

export function isOfficialSourceUrl(url: string, homepage: string | undefined, allowLoopbackHttp = false): boolean {
  try {
    const u = new URL(url);
    if (allowLoopbackHttp && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true;
    if (u.protocol !== 'https:' || !homepage) return false;
    const home = new URL(homepage).hostname.toLowerCase();
    const h = u.hostname.toLowerCase();
    return h === home || h.endsWith('.' + home);
  } catch { return false; }
}

type Source = SrpBundle['sources']['sources'][number];
export interface DownloadFlags { allowLoopbackHttp?: boolean; allowPrivateHttp?: boolean }
/**
 * May Mercy Launcher fetch this source by itself?
 *  * Catalog sources (they carry `allowedHosts`): only when the owner marked them authorised, size + SHA-256 are
 *    known, and the URL's host is on the allow-list (https; plain http only for private hosts in a dev catalog).
 *  * Built-in package sources: the original rule (inventory says LIVE and the URL is on the project's own domain).
 */
export function isAuthorizedDownload(src: Source | undefined, flags: DownloadFlags = {}): src is Source & { officialDirectUrl: string } {
  if (!src || !src.officialDirectUrl) return false;
  if (src.allowedHosts) {
    if (src.authorizedDownload !== true || !src.localArchive?.sha256 || !src.localArchive?.bytes) return false;
    let u: URL; try { u = new URL(src.officialDirectUrl); } catch { return false; }
    const host = u.hostname.toLowerCase();
    if (!src.allowedHosts.some((h) => h.toLowerCase() === host)) return false;
    if (u.protocol === 'https:') return true;
    if (u.protocol !== 'http:') return false;
    const kind = classifyHost(host);
    return (!!flags.allowPrivateHttp && (kind === 'private-lan' || kind === 'loopback')) || (!!flags.allowLoopbackHttp && kind === 'loopback');
  }
  return /^LIVE/i.test(src.directUrlStatus ?? '') && isOfficialSourceUrl(src.officialDirectUrl, src.homepage, !!flags.allowLoopbackHttp);
}
const downloadable = isAuthorizedDownload;

/** Where a download is saved. Catalog files are prefixed with their hash so two catalogs can never clobber each other. */
function downloadFileName(dl: PlanDownload): string {
  const fromUrl = (() => { try { return path.basename(new URL(dl.url).pathname); } catch { return ''; } })();
  const base = (dl.fileName && safeSegment(dl.fileName)) || safeSegment(fromUrl) || `${safeSegment(dl.sourceId) ?? 'download'}.7z`;
  return dl.allowedHosts && dl.sha256 ? `${dl.sha256.slice(0, 12)}-${base}` : base;
}

/** Every track a server needs, with the plan-item id each one gets (the primary track keeps the original `track`). */
export function serverTracks(server: { track: SrpTrackRequirement; extraTracks?: SrpTrackRequirement[] }): { itemId: string; req: SrpTrackRequirement; primary: boolean }[] {
  return [{ itemId: 'track', req: server.track, primary: true }, ...(server.extraTracks ?? []).map((req) => ({ itemId: `track:${req.id}`, req, primary: false }))];
}

export async function buildInstallPlan(ctx: PlanContext): Promise<InstallPlan> {
  const server = ctx.bundle.servers.find((s) => s.server.id === ctx.serverId);
  if (!server) throw new Error(`Unknown SRP server id "${ctx.serverId}"`);
  const tool = ctx.tool === undefined ? findArchiveTool() : ctx.tool;
  const plan: InstallPlan = {
    serverId: ctx.serverId, acRoot: ctx.acRoot, items: [], downloads: [], archiveTool: tool?.kind ?? 'none',
    csp: { status: 'unknown', message: '' }, summary: { total: 0, automatic: 0, manual: 0, blocked: 0, destructive: 0 }, warnings: [],
  };
  if (!ctx.acRoot) {
    plan.warnings.push('Assetto Corsa was not found, so nothing can be planned. Install the game through Steam, or point the launcher at your game folder.');
    return plan;
  }
  const report = ctx.report ?? await checkAcRequirements({ acRoot: ctx.acRoot, bundle: ctx.bundle, serverId: ctx.serverId, deep: true, documentsAcDir: ctx.documentsAcDir });
  const srcById = (id: string) => ctx.bundle.sources.sources.find((s) => s.sourceId === id);
  const lanOk: DownloadFlags = { allowLoopbackHttp: ctx.allowLoopbackHttp, allowPrivateHttp: ctx.allowPrivateHttp };

  // CSP — explained, never installed.
  const cspInstalled = report.sections.csp.find((i) => i.id === 'csp-installed');
  const cspVer = report.sections.csp.find((i) => i.id === 'csp-version');
  if (cspInstalled?.status === 'fail') plan.csp = { status: 'missing', message: 'Custom Shaders Patch is required by this server and was not found. Mercy Launcher will not install it for you: install or update it yourself (Content Manager can do it) and then re-check.' };
  else if (cspVer?.status === 'fail') plan.csp = { status: 'too-old', message: `${cspVer.detail} Mercy Launcher will not update it for you; update it yourself, then re-check.` };
  else if (cspVer?.status === 'unknown') plan.csp = { status: 'unknown', message: 'The CSP version could not be read. Start Assetto Corsa once so CSP writes its log, then re-check.' };
  else plan.csp = { status: 'ok', message: cspVer?.detail ?? 'Custom Shaders Patch looks fine.' };

  // Cars
  for (const item of report.sections.cars) {
    if (item.status === 'pass' || item.status === 'info') continue;
    const carId = item.id.replace(/^car:/, '');
    const req = server.cars.find((c) => c.id === carId);
    if (!req) continue;
    const ev = (item.evidence ?? {}) as { state?: string; issues?: string[]; missingSkins?: string[] };
    const src = srcById(req.source);
    const label = req.name ?? req.id;
    const optionalCar = req.requirement === 'optional';
    if (req.source === 'ac_base_game' || src?.kind === 'base-game') {
      plan.items.push({ id: `car:${carId}`, kind: 'external', label, action: 'manual', destructive: false, optional: optionalCar, reason: item.detail, blocked: 'This is a base-game car, which Mercy Launcher never installs or touches.', manualSteps: ['In Steam, right-click Assetto Corsa → Properties → Installed Files → Verify integrity of game files.'] });
      continue;
    }
    if (src?.kind === 'dlc' || src?.kind === 'manual') {
      const dlc = src.kind === 'dlc';
      plan.items.push({ id: `car:${carId}`, kind: 'external', label, action: 'manual', destructive: false, optional: optionalCar, reason: item.detail,
        blocked: dlc ? `This car is part of "${src.name}", paid content you must own. Mercy Launcher never installs or downloads it.` : 'This content must be installed by you; the server owner has not authorised an automatic download.',
        manualSteps: [dlc ? `Own "${src.name}" in Steam (or the store you bought Assetto Corsa from) and verify the game files.` : (src.instructions ?? `Get "${src.name}" from ${src.homepage ?? 'its official site'} and install it with Content Manager.`)] });
      continue;
    }
    const auto = downloadable(src, lanOk);
    const blockedMsg = auto ? undefined : `No verified direct download is available for "${src?.name ?? req.source}". ${src?.homepage ? `Get it from ${src.homepage}.` : ''}`;
    const base = { kind: 'car' as const, label, optional: optionalCar, sourceId: req.source, carId, blocked: blockedMsg, manualSteps: blockedMsg ? [`Download "${src?.name ?? req.source}" from ${src?.homepage ?? 'the official site'} and install it with Content Manager (drag the archive onto it).`] : undefined };
    if (ev.state === 'missing') {
      plan.items.push({ ...base, id: `car:${carId}`, action: 'install', destructive: false, reason: 'Not installed.' });
    } else if ((ev.issues ?? []).includes('physics')) {
      plan.items.push({ ...base, id: `car:${carId}`, action: 'repair', destructive: true, reason: 'Physics data differs from the server\'s copy. The existing folder will be moved to a backup first (including any custom skins you added), then replaced.' });
    } else if ((ev.issues ?? []).includes('version')) {
      plan.items.push({ ...base, id: `car:${carId}`, action: 'update', destructive: true, reason: `${item.detail}. The existing folder will be moved to a backup first, then replaced.` });
    } else if ((ev.issues ?? []).includes('skin')) {
      for (const skin of ev.missingSkins ?? []) {
        if (!safeSegment(skin)) continue;
        plan.items.push({ ...base, kind: 'car-skin', label: `${label} — skin "${skin}"`, skin, id: `skin:${carId}:${skin}`, action: 'install', destructive: false, reason: 'A skin this server pins is missing. Only that skin folder is added; nothing existing is touched.' });
      }
    }
  }

  // Tracks (the primary track keeps the original ids; extra tracks of a catalog server get `track:<id>`)
  for (const { itemId, req: tr, primary } of serverTracks(server)) {
    const trackItem = report.sections.track.find((i) => i.id === itemId);
    const layoutItems = report.sections.track.filter((i) => (primary && i.id === 'track-layout') || i.id.startsWith(`track-layout:${tr.id}:`));
    const isBad = (i: { status: string; evidence?: Record<string, unknown> }) => i.status === 'fail' || (i.status === 'warn' && !!i.evidence?.optionalDemoted);
    const trackBad = (!!trackItem && isBad(trackItem)) || layoutItems.some(isBad);
    if (!trackBad) continue;
    const inv = ctx.bundle.tracks.tracks.find((t) => t.id === tr.id);
    const tsrc = srcById(tr.source);
    const state = ((trackItem?.evidence ?? {}) as { state?: string }).state ?? 'layout-missing';
    const trackLabel = tr.name ? `${tr.name} ${tr.version}` : `Shutoko Revival Project ${tr.version}`;
    const reason = trackItem && isBad(trackItem) ? trackItem.detail : (layoutItems.find(isBad)?.detail ?? 'Track needs attention.');
    if (inv?.external || tsrc?.kind === 'base-game' || tsrc?.kind === 'dlc' || tsrc?.kind === 'manual') {
      plan.items.push({ id: itemId, kind: 'external', label: trackLabel, action: 'manual', destructive: false, optional: false, reason,
        blocked: tsrc?.kind === 'dlc' ? `This track is part of "${tsrc.name}", paid content you must own. Mercy Launcher never installs or downloads it.` : tsrc?.kind === 'manual' ? 'This track must be installed by you; the server owner has not authorised an automatic download.' : 'This is a base-game track, which Mercy Launcher never installs or touches.',
        manualSteps: [tsrc?.kind === 'manual' ? (tsrc.instructions ?? `Get "${tsrc.name}" from ${tsrc.homepage ?? 'its official site'} and install it with Content Manager.`) : 'In Steam, right-click Assetto Corsa → Properties → Installed Files → Verify integrity of game files.'] });
      continue;
    }
    const auto = downloadable(tsrc, lanOk);
    plan.items.push({
      id: itemId, kind: 'track', label: trackLabel, action: state === 'missing' ? 'install' : 'repair',
      destructive: state !== 'missing', optional: !!tr.optional, sourceId: tr.source,
      reason,
      needsLocalFile: !auto,
      blocked: auto ? undefined : (tr.name ? `There is no authorised direct download for ${tr.name}. Mercy Launcher will not guess or substitute one.` : 'There is no live official direct download for this track (the project\'s link currently redirects to its home page). Mercy Launcher will not guess or substitute one.'),
      manualSteps: auto ? undefined : (tr.name ? [
        `Get ${tr.name} ${tr.version} from ${tsrc?.homepage ?? 'its official site'}.`,
        'Come back here and choose the downloaded .7z/.zip: the launcher will check it is the right version, install it safely and keep a backup of anything it replaces.',
      ] : [
        `Get SRP ${tr.version} Stable from ${tsrc?.homepage ?? 'the Shutoko Revival Project'} (their site or Discord).`,
        'Come back here and choose the downloaded .7z/.zip: the launcher will check it is the right version, install it safely and keep a backup of anything it replaces.',
      ]),
    });
  }

  // Companion app (optional) — depends on what is stamped vs what this machine would stamp
  const app = server.companionApps[0];
  if (app) {
    const stampPlan = await planStamp(ctx.endpoints, ctx.resolver);
    const appDir = path.join(ctx.acRoot, 'apps', 'lua', app.id);
    const appItem = report.sections.companion.find((i) => i.id === `app:${app.id}`);
    const integ = report.sections.companion.find((i) => i.id === `app:${app.id}:integrity`);
    const installed = fs.existsSync(appDir);
    let needs = !installed || appItem?.status === 'warn' || integ?.status === 'warn';
    let why = !installed ? 'Not installed.' : (appItem?.status === 'warn' ? appItem.detail : integ?.status === 'warn' ? integ.detail : '');
    if (installed && !needs && stampPlan.entries.length) {
      let have: string[] = [];
      try { have = parseBoardServers(fs.readFileSync(path.join(appDir, 'srp_board.lua'), 'latin1')) ?? []; } catch {}
      const eps = [ctx.endpoints.public, ctx.endpoints.lan].filter(Boolean) as NonNullable<ResolvedEndpoints['public']>[];
      const covered = stampPlan.entries.every((e) => have.map((x) => x.toLowerCase()).includes(e));
      if (!covered || !stampCoversEndpoints(have, eps).covered) { needs = true; why = 'The server list stamped into the installed app does not match the endpoints configured on this computer.'; }
    }
    if (needs) {
      plan.items.push({
        id: `companion:${app.id}`, kind: 'companion', label: 'SRP Board companion app', action: installed ? 'update' : 'install', destructive: installed, optional: true,
        reason: why || 'Needs (re)installing.',
        blocked: stampPlan.entries.length ? undefined : 'No server address is configured to stamp it with. Configure the public endpoint (and your LAN address, if this is your own PC) in Setup & Diagnostics first.',
      });
      plan.warnings.push(...stampPlan.warnings);
    }
  }

  // Old dev HUD
  const hud = report.sections.conflicts.find((i) => i.id === 'conflict-srp-hud');
  if (hud && (hud.status === 'fail' || hud.status === 'warn')) {
    plan.items.push({ id: 'conflict:srp_hud', kind: 'conflict', label: 'Old dev HUD app (apps\\lua\\srp_hud)', action: 'move-to-backup', destructive: true, optional: hud.status === 'warn', reason: hud.detail });
  }

  // Downloads needed by the automatic items
  const bySource = new Map<string, PlanItem[]>();
  for (const it of plan.items) if ((it.kind === 'car' || it.kind === 'car-skin' || it.kind === 'track') && it.sourceId && !it.blocked) {
    (bySource.get(it.sourceId) ?? bySource.set(it.sourceId, []).get(it.sourceId)!).push(it);
  }
  for (const [sid, its] of bySource) {
    const s = srcById(sid)!;
    if (downloadable(s, lanOk)) plan.downloads.push({ sourceId: sid, name: s.name, url: s.officialDirectUrl!, bytes: s.localArchive?.bytes ?? null, sha256: s.localArchive?.sha256 ?? null, itemIds: its.map((i) => i.id), allowedHosts: s.allowedHosts, fileName: s.fileName });
  }

  if (!tool) plan.warnings.push('No archive tool was found (7-Zip, or Windows\' built-in tar.exe). Installing from .7z archives needs one of them.');
  plan.summary = {
    total: plan.items.length,
    automatic: plan.items.filter((i) => !i.blocked && i.action !== 'manual').length,
    manual: plan.items.filter((i) => i.action === 'manual' || !!i.blocked).length,
    blocked: plan.items.filter((i) => !!i.blocked).length,
    destructive: plan.items.filter((i) => i.destructive).length,
  };
  return plan;
}

// ── Execution ────────────────────────────────────────────────────────────────

export type InstallPhase = 'preflight' | 'downloading' | 'verifying-download' | 'extracting' | 'verifying-staged' | 'installing' | 'verifying' | 'done' | 'rolling-back' | 'failed';
export interface InstallProgress { phase: InstallPhase; message: string; itemId?: string; percent?: number; received?: number; total?: number | null }

export interface InstallContext {
  acRoot: string;
  bundle: SrpBundle;
  serverId: string;
  endpoints: ResolvedEndpoints;
  /** Where archives are downloaded (userData\ac-downloads). */
  downloadDir: string;
  documentsAcDir?: string | null;
  tool?: ArchiveTool | null;
  resolver?: Resolver;
  isGameRunning?: () => Promise<boolean>;
  onProgress?: (p: InstallProgress) => void;
  log?: (line: string) => void;
  signal?: AbortSignal;
  allowLoopbackHttp?: boolean;
  /** Development catalogs only: accept plain http to private-network hosts. */
  allowPrivateHttp?: boolean;
  /** Refuse any single download larger than this (bytes). */
  maxDownloadBytes?: number;
  now?: () => Date;
  /** Tests: replace the real free-space lookup (download + extraction checks). */
  freeBytes?: (dir: string) => number | null;
  /** Test seam: called after each folder is placed; throw to simulate a mid-install failure. */
  hooks?: { afterPlace?: (index: number, itemId: string) => void | Promise<void> };
}
export interface InstallInputs {
  /** An archive the player chose for the PRIMARY track (the original single-track input). */
  trackArchivePath?: string;
  /** An archive the player chose for the first car source (the original single-pack input). */
  carPackArchivePath?: string;
  /** Player-chosen archives by catalog source id (cars). */
  archivePaths?: Record<string, string>;
  /** Player-chosen archives by track id. */
  trackArchivePaths?: Record<string, string>;
}

export interface GroupResult { group: 'preflight' | 'conflict' | 'cars' | 'track' | 'companion'; ok: boolean; itemIds: string[]; error?: string; rolledBack?: boolean; backupDir?: string; notes: string[] }
export interface InstallResult {
  success: boolean;
  groups: GroupResult[];
  skipped: { id: string; reason: string }[];
  report: AcRequirementsReport | null;
  cancelled?: boolean;
}

interface JournalOp { op: 'backup' | 'place'; from?: string; to?: string; target?: string }
interface Journal { txn: string; state: 'staging' | 'placing' | 'committed' | 'rolled-back'; startedAt: string; ops: JournalOp[]; acRoot: string }

const STAGING = '.mercy-staging';
const BACKUPS = '.mercy-backups';
const running = new Set<string>();

export function defaultIsGameRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const check = (img: string) => new Promise<boolean>((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${img}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(!err && stdout.toLowerCase().includes(img.toLowerCase())));
  });
  return Promise.all([check('acs.exe'), check('AssettoCorsa.exe')]).then(([a, b]) => a || b);
}

/** Turn a low-level filesystem failure into something a player can act on. The original code is kept on the error. */
export function friendlyFsError(e: any, what: string): Error {
  const code = e?.code as string | undefined;
  const base = path.basename(what);
  let msg: string;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') msg = `"${base}" has a file that is in use or protected, so it could not be moved. Close Assetto Corsa, Content Manager and any folder or editor windows open on it, then try again. Nothing was changed.`;
  else if (code === 'ENOSPC') msg = 'The drive ran out of free space while installing. Free up space and try again. Everything this step changed was restored.';
  else if (code === 'ENOTEMPTY' || code === 'EEXIST') msg = `"${base}" could not be replaced because something is already there. Nothing was changed.`;
  else return e instanceof Error ? e : new Error(String(e));
  const err: any = new Error(msg); err.code = code; err.cause = e; return err;
}

/**
 * Move a folder. rename() is atomic and is the normal path. ONLY a cross-drive move (EXDEV) falls back to copy+delete,
 * and then via a temporary name so a half-copied folder can never be mistaken for a finished one. A locked file
 * (EBUSY/EPERM/EACCES) is NEVER worked around by copying — that used to leave a partial backup — it fails cleanly.
 */
function moveDir(src: string, dst: string) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); return; }
  catch (e: any) {
    if (e?.code !== 'EXDEV') throw friendlyFsError(e, src);
  }
  const tmp = `${dst}.mercy-partial`;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(src, tmp, { recursive: true, errorOnExist: true, force: false });
    fs.renameSync(tmp, dst);
  } catch (e: any) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    throw friendlyFsError(e, src);
  }
  fs.rmSync(src, { recursive: true, force: true });
}

class Txn {
  readonly id: string;
  readonly stagingDir: string;
  readonly backupDir: string;
  private journalFile: string;
  private j: Journal;
  constructor(private acRoot: string, now: Date, tag: string) {
    this.id = `${now.toISOString().replace(/[:.]/g, '-')}_${tag}`;
    this.stagingDir = path.join(acRoot, 'content', STAGING, this.id);
    this.backupDir = path.join(acRoot, 'content', BACKUPS, this.id);
    this.journalFile = path.join(this.backupDir, 'journal.json');
    this.j = { txn: this.id, state: 'staging', startedAt: now.toISOString(), ops: [], acRoot };
    fs.mkdirSync(this.stagingDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.persist();
  }
  private persist() { fs.writeFileSync(this.journalFile, JSON.stringify(this.j, null, 2)); }
  private rel(p: string) { return path.relative(this.acRoot, p); }
  /** Move `target` aside (if it exists) and put `staged` in its place. Journaled before and after each step. */
  place(staged: string, target: string) {
    this.j.state = 'placing';
    if (fs.existsSync(target)) {
      const backup = path.join(this.backupDir, this.rel(target));
      this.j.ops.push({ op: 'backup', from: target, to: backup }); this.persist();
      moveDir(target, backup);
    }
    this.j.ops.push({ op: 'place', target }); this.persist();
    moveDir(staged, target);
  }
  /** Move `target` aside only (no replacement). */
  moveAside(target: string) {
    this.j.state = 'placing';
    const backup = path.join(this.backupDir, this.rel(target));
    this.j.ops.push({ op: 'backup', from: target, to: backup }); this.persist();
    moveDir(target, backup);
  }
  hasBackups(): boolean { return this.j.ops.some((o) => o.op === 'backup'); }
  rollback(): string[] {
    const errors: string[] = [];
    for (const o of [...this.j.ops].reverse()) {
      try {
        if (o.op === 'place' && o.target) fs.rmSync(o.target, { recursive: true, force: true });
        else if (o.op === 'backup' && o.from && o.to && fs.existsSync(o.to)) moveDir(o.to, o.from);
      } catch (e: any) { errors.push(`${o.op} ${o.target ?? o.from}: ${e?.message ?? e}`); }
    }
    this.j.state = errors.length ? this.j.state : 'rolled-back';
    this.persist();
    this.cleanupStaging();
    // A clean rollback put every original back, so the backup folder holds nothing but the journal — remove it rather
    // than leave clutter behind after every cancelled or failed attempt. (With errors it stays: it holds the originals.)
    if (!errors.length) { try { fs.rmSync(this.backupDir, { recursive: true, force: true }); } catch {} }
    return errors;
  }
  commit() { this.j.state = 'committed'; this.persist(); this.cleanupStaging(); if (!this.hasBackups()) { try { fs.rmSync(this.backupDir, { recursive: true, force: true }); } catch {} } }
  cleanupStaging() { try { fs.rmSync(this.stagingDir, { recursive: true, force: true }); } catch {} }
}

/** Read-only: journals of installs that never finished (they are rolled back automatically at the start of the next install). */
export function listInterruptedInstalls(acRoot: string): string[] {
  const root = path.join(acRoot, 'content', BACKUPS);
  let dirs: string[] = []; try { dirs = fs.readdirSync(root); } catch { return []; }
  return dirs.filter((d) => { try { const j: Journal = JSON.parse(fs.readFileSync(path.join(root, d, 'journal.json'), 'utf8')); return j.state === 'staging' || j.state === 'placing'; } catch { return false; } });
}

/** Roll back any install that was interrupted (crash, power loss, killed process). Safe to call any time. */
export function recoverInterruptedInstalls(acRoot: string): { recovered: string[]; errors: string[] } {
  const out = { recovered: [] as string[], errors: [] as string[] };
  const root = path.join(acRoot, 'content', BACKUPS);
  let dirs: string[] = []; try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    const jf = path.join(root, d, 'journal.json');
    let j: Journal; try { j = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch { continue; }
    if (j.state === 'committed' || j.state === 'rolled-back') continue;
    const errors: string[] = [];
    for (const o of [...j.ops].reverse()) {
      try {
        if (o.op === 'place' && o.target) fs.rmSync(o.target, { recursive: true, force: true });
        else if (o.op === 'backup' && o.from && o.to && fs.existsSync(o.to)) moveDir(o.to, o.from);
      } catch (e: any) { errors.push(`${o.op}: ${e?.message ?? e}`); }
    }
    if (errors.length) { out.errors.push(...errors.map((e) => `${d}: ${e}`)); continue; }
    j.state = 'rolled-back'; fs.writeFileSync(jf, JSON.stringify(j, null, 2));
    try { fs.rmSync(path.join(acRoot, 'content', STAGING, d), { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch {} // nothing left in it but the journal
    out.recovered.push(d);
  }
  return out;
}

class Cancelled extends Error { constructor() { super('Cancelled by the player.'); } }

export async function executeInstall(ctx: InstallContext, planIn: InstallPlan, approvedIds: string[], inputs: InstallInputs = {}): Promise<InstallResult> {
  let plan = planIn;
  const now = ctx.now ?? (() => new Date());
  const emit = (p: InstallProgress) => { ctx.onProgress?.(p); ctx.log?.(`[${p.phase}]${p.itemId ? ` ${p.itemId}` : ''} ${p.message}`); };
  const result: InstallResult = { success: false, groups: [], skipped: [], report: null };
  const server = ctx.bundle.servers.find((s) => s.server.id === ctx.serverId);
  if (!server) throw new Error(`Unknown SRP server id "${ctx.serverId}"`);
  if (running.has(ctx.acRoot)) throw new Error('An installation is already running for this Assetto Corsa folder.');
  running.add(ctx.acRoot);
  try {
    emit({ phase: 'preflight', message: 'Checking the Assetto Corsa folder…' });
    if (!fs.existsSync(path.join(ctx.acRoot, 'content', 'cars')) || !fs.existsSync(path.join(ctx.acRoot, 'content', 'tracks'))) throw new Error('This does not look like an Assetto Corsa folder (content\\cars or content\\tracks is missing).');
    if (await (ctx.isGameRunning ?? defaultIsGameRunning)()) throw new Error('Assetto Corsa is running. Close the game (and Content Manager\'s game launch) before installing content.');
    const rec = recoverInterruptedInstalls(ctx.acRoot);
    if (rec.recovered.length) emit({ phase: 'preflight', message: `Rolled back ${rec.recovered.length} earlier interrupted install(s) before starting.` });
    if (rec.errors.length) throw new Error(`An earlier interrupted install could not be rolled back automatically (${rec.errors[0]}). Nothing new was installed. Backups are in content\\${BACKUPS}.`);
    if (rec.recovered.length) {
      // The plan the player approved was built from the half-finished state the crash left behind. The rollback just
      // changed that state, so rebuild the plan from reality before acting on the approved items.
      plan = await buildInstallPlan({ acRoot: ctx.acRoot, bundle: ctx.bundle, serverId: ctx.serverId, endpoints: ctx.endpoints, documentsAcDir: ctx.documentsAcDir, resolver: ctx.resolver, tool: ctx.tool, allowLoopbackHttp: ctx.allowLoopbackHttp, allowPrivateHttp: ctx.allowPrivateHttp });
      emit({ phase: 'preflight', message: 'Re-checked your install after the rollback.' });
    }

    const approved = new Set(approvedIds);
    const chosen = plan.items.filter((i) => approved.has(i.id));
    for (const id of approvedIds) if (!plan.items.some((i) => i.id === id)) result.skipped.push({ id, reason: 'Not part of the plan.' });
    const tool = ctx.tool === undefined ? findArchiveTool() : ctx.tool;
    const check = () => { if (ctx.signal?.aborted) throw new Cancelled(); };

    const hasLocalTrackFile = (i: PlanItem) => !!(i.id === 'track' ? inputs.trackArchivePath : inputs.trackArchivePaths?.[i.id.replace(/^track:/, '')]);
    const runGroup = async (group: GroupResult['group'], items: PlanItem[], fn: (txn: Txn) => Promise<string[]>) => {
      if (!items.length) return;
      const blocked = items.filter((i) => i.blocked && !(i.needsLocalFile && hasLocalTrackFile(i)));
      for (const b of blocked) result.skipped.push({ id: b.id, reason: b.blocked! });
      const runnable = items.filter((i) => !blocked.includes(i));
      if (!runnable.length) return;
      const txn = new Txn(ctx.acRoot, now(), group);
      const g: GroupResult = { group, ok: false, itemIds: runnable.map((i) => i.id), notes: [] };
      try {
        check();
        g.notes.push(...await fn(txn));
        txn.commit(); g.ok = true; g.backupDir = txn.hasBackups() ? txn.backupDir : undefined;
      } catch (e: any) {
        // A cancel kills the running archive tool, which surfaces as an unrelated tool error — report it as the cancel it is.
        const wasCancelled = e instanceof Cancelled || !!ctx.signal?.aborted;
        g.error = wasCancelled ? 'Cancelled by the player.' : (e?.message ?? String(e));
        emit({ phase: 'rolling-back', message: `Something went wrong (${g.error}). Restoring the previous state…` });
        const errs = txn.rollback();
        g.rolledBack = errs.length === 0;
        if (errs.length) g.notes.push(`Rollback was incomplete: ${errs.join('; ')}. Your original files are in ${txn.backupDir}.`);
        else g.notes.push('Everything this step changed was restored to how it was before.');
        if (wasCancelled) result.cancelled = true;
      }
      result.groups.push(g);
    };

    // 1) conflicts
    await runGroup('conflict', chosen.filter((i) => i.kind === 'conflict'), async (txn) => {
      const dir = path.join(ctx.acRoot, 'apps', 'lua', 'srp_hud');
      if (fs.existsSync(dir)) { emit({ phase: 'installing', itemId: 'conflict:srp_hud', message: 'Moving the old dev HUD to a backup…' }); txn.moveAside(dir); }
      return ['The old HUD app was moved (not deleted) into the backup folder.'];
    });

    // Archives already fetched (and verified) during this run, so a pack that holds both cars and a track is downloaded once.
    const fetched = new Map<string, string>();
    const dlFlags: DownloadFlags = { allowLoopbackHttp: ctx.allowLoopbackHttp, allowPrivateHttp: ctx.allowPrivateHttp };
    /** Returns a verified archive for a source: the player's own file if given, else a download from an authorised host. */
    const obtainArchive = async (sourceId: string, chosen: string | undefined, missingMsg: string): Promise<string> => {
      if (chosen) { if (!fs.existsSync(chosen)) throw new Error('The archive you chose no longer exists.'); return chosen; }
      const cached = fetched.get(sourceId); if (cached) return cached;
      const src = ctx.bundle.sources.sources.find((x) => x.sourceId === sourceId);
      const dl = plan.downloads.find((d) => d.sourceId === sourceId);
      if (!dl) throw new Error(missingMsg);
      if (!isAuthorizedDownload(src ? { ...src, officialDirectUrl: dl.url } : undefined, dlFlags)) throw new Error('The download address is not one the content owner authorised; refusing.');
      emit({ phase: 'downloading', message: `Downloading ${dl.name}…` });
      const r = await downloadVerified({ url: dl.url, dest: path.join(ctx.downloadDir, downloadFileName(dl)), expectedBytes: dl.bytes, expectedSha256: dl.sha256, signal: ctx.signal,
        allowLoopbackHttp: ctx.allowLoopbackHttp, allowPrivateHttp: ctx.allowPrivateHttp, allowedHosts: dl.allowedHosts, maxBytes: ctx.maxDownloadBytes, freeBytes: ctx.freeBytes,
        onProgress: (p) => emit({ phase: 'downloading', message: `Downloading ${dl.name}…`, received: p.received, total: p.total, percent: p.total ? Math.round(p.received / p.total * 100) : undefined }) });
      emit({ phase: 'verifying-download', message: r.reusedExisting ? 'Using the already-downloaded, verified file.' : 'Download verified (size and SHA-256 match the inventory).' });
      fetched.set(sourceId, r.path);
      return r.path;
    };

    // 2) cars + skins (one or more archives, one transaction)
    const carItems = chosen.filter((i) => i.kind === 'car' || i.kind === 'car-skin');
    await runGroup('cars', carItems, async (txn) => {
      if (!tool) throw new Error('No archive tool found (7-Zip or Windows tar.exe).');
      const items = carItems.filter((i) => !i.blocked);
      const bySource = new Map<string, PlanItem[]>();
      for (const it of items) (bySource.get(it.sourceId!) ?? bySource.set(it.sourceId!, []).get(it.sourceId!)!).push(it);
      let nCars = 0, nSkins = 0, n = 0, idx = 0;
      for (const [sourceId, group] of bySource) {
        const chosenPath = inputs.archivePaths?.[sourceId] ?? (idx++ === 0 ? inputs.carPackArchivePath : undefined);
        const archive = await obtainArchive(sourceId, chosenPath, 'No verified download is available for this content.');
        check();
        emit({ phase: 'extracting', message: 'Reading the archive…' });
        const entries = await listArchive(archive, tool, ctx.signal);

        const wantedCars: { item: PlanItem; req: SrpCarRequirement; folder: string }[] = [];
        for (const it of group.filter((i) => i.kind === 'car')) {
          const req = server.cars.find((c) => c.id === it.carId)!;
          const folder = findFolder(entries, req.archivePath ?? `content/cars/${req.id}`);
          if (!folder) throw new Error(`"${it.label}" is not inside this archive.`);
          wantedCars.push({ item: it, req, folder });
        }
        const wantedSkins: { item: PlanItem; folder: string }[] = [];
        for (const it of group.filter((i) => i.kind === 'car-skin')) {
          const reqCar = server.cars.find((c) => c.id === it.carId);
          const folder = findFolder(entries, `${reqCar?.archivePath ?? `content/cars/${it.carId}`}/skins/${it.skin}`);
          if (!folder) throw new Error(`Skin "${it.skin}" for ${it.carId} is not inside this archive.`);
          wantedSkins.push({ item: it, folder });
        }
        const staged = path.join(txn.stagingDir, `x${idx}`);
        await extractFolders(archive, staged, [...wantedCars.map((w) => w.folder), ...wantedSkins.map((w) => w.folder)], tool,
          { signal: ctx.signal, entries, spaceCheckDir: ctx.acRoot, freeBytes: ctx.freeBytes, onPercent: (pct) => emit({ phase: 'extracting', message: 'Extracting only what you approved…', percent: pct }) });

        emit({ phase: 'verifying-staged', message: 'Checking the extracted files before installing them…' });
        for (const w of wantedCars) {
          const dir = path.join(staged, w.folder);
          if (!fs.existsSync(path.join(dir, 'ui', 'ui_car.json'))) throw new Error(`"${w.item.label}" is incomplete in the archive (no ui_car.json).`);
          const expected = w.req.identity.dataAcdSha256;
          if (expected) {
            const acd = path.join(dir, 'data.acd');
            if (!fs.existsSync(acd)) throw new Error(`"${w.item.label}" has no data.acd in the archive, so its physics cannot be verified.`);
            const h = await sha256OfFile(acd, ctx.signal);
            if (h !== expected) throw new Error(`"${w.item.label}" in this archive has different physics data than the server uses. It was not installed.`);
          }
        }
        for (const w of wantedSkins) if (!fs.readdirSync(path.join(staged, w.folder)).length) throw new Error(`Skin "${w.item.skin}" is empty in the archive.`);

        check();
        emit({ phase: 'installing', message: 'Installing…' });
        for (const w of wantedCars) {
          txn.place(path.join(staged, w.folder), path.join(ctx.acRoot, 'content', 'cars', w.req.id));
          await ctx.hooks?.afterPlace?.(n++, w.item.id);
        }
        for (const w of wantedSkins) {
          const target = path.join(ctx.acRoot, 'content', 'cars', w.item.carId!, 'skins', w.item.skin!);
          if (!fs.existsSync(path.join(ctx.acRoot, 'content', 'cars', w.item.carId!))) throw new Error(`Cannot add a skin: ${w.item.carId} is not installed.`);
          if (fs.existsSync(target)) continue; // non-destructive by construction
          txn.place(path.join(staged, w.folder), target);
          await ctx.hooks?.afterPlace?.(n++, w.item.id);
        }

        emit({ phase: 'verifying', message: 'Verifying the installed content…' });
        const after = await checkAcRequirements({ acRoot: ctx.acRoot, bundle: ctx.bundle, serverId: ctx.serverId, deep: true, documentsAcDir: ctx.documentsAcDir });
        const bad = after.sections.cars.filter((c) => wantedCars.some((w) => c.id === `car:${w.req.id}`) && (c.status === 'fail' || c.status === 'warn'));
        if (bad.length) throw new Error(`After installing, "${bad[0].label}" still fails verification: ${bad[0].detail}`);
        nCars += wantedCars.length; nSkins += wantedSkins.length;
      }
      return [`Installed ${nCars} car(s) and ${nSkins} skin(s).`];
    });

    // 3) tracks (downloaded from an authorised host if possible, otherwise from the player's own archive)
    const trackItems = chosen.filter((i) => i.kind === 'track');
    await runGroup('track', trackItems, async (txn) => {
      if (!tool) throw new Error('No archive tool found (7-Zip or Windows tar.exe).');
      const notes: string[] = [];
      let placed = 0;
      for (const it of trackItems.filter((i) => !i.blocked || (i.needsLocalFile && hasLocalTrackFile(i)))) {
        const entry = serverTracks(server).find((t) => t.itemId === it.id)!;
        const tr = entry.req;
        const inv = ctx.bundle.tracks.tracks.find((t) => t.id === tr.id)!;
        const chosenPath = entry.primary ? inputs.trackArchivePath : inputs.trackArchivePaths?.[tr.id];
        const archive = await obtainArchive(it.sourceId!, chosenPath, entry.primary ? 'There is no verified download for the track; choose the archive you downloaded.' : `There is no verified download for ${tr.name ?? tr.id}; choose the archive you downloaded.`);
        emit({ phase: 'extracting', message: 'Reading the archive…' });
        const entries = await listArchive(archive, tool, ctx.signal);
        const markerName = inv.markerFileName ?? `${inv.version} Stable.txt`;
        let rootFolder: string;
        if (inv.markerFileSha256) {
          const markerEntry = entries.find((e) => !e.isDir && (e.path === markerName || e.path.toLowerCase().endsWith('/' + markerName.toLowerCase())));
          if (!markerEntry) {
            const other = entries.find((e) => /(^|\/)[^/]*stable\.txt$/i.test(e.path));
            throw new Error(other ? `This archive is a different SRP version ("${path.posix.basename(other.path)}"), not ${inv.version} Stable that these servers run. Nothing was changed.` : `"${markerName}" was not found in this archive, so it cannot be confirmed as ${tr.name ? `${tr.name} ${inv.version}` : `SRP ${inv.version} Stable`}. Nothing was changed.`);
          }
          const root = path.posix.dirname(markerEntry.path); rootFolder = root === '.' ? '' : root;
        } else {
          const f = findFolder(entries, inv.archivePath ?? `content/tracks/${tr.id}`);
          if (!f) throw new Error(`Track "${tr.name ?? tr.id}" is not inside this archive. Nothing was changed.`);
          rootFolder = f;
        }
        const staged = path.join(txn.stagingDir, `t-${safeSegment(tr.id) ?? 'x'}`);
        await extractFolders(archive, staged, [rootFolder], tool, { signal: ctx.signal, entries, spaceCheckDir: ctx.acRoot, freeBytes: ctx.freeBytes, onPercent: (pct) => emit({ phase: 'extracting', message: 'Extracting the track…', percent: pct }) });
        const stagedRoot = rootFolder ? path.join(staged, rootFolder) : staged;

        emit({ phase: 'verifying-staged', message: 'Checking the track version before installing it…' });
        if (inv.markerFileSha256) {
          const mh = await sha256OfFile(path.join(stagedRoot, markerName), ctx.signal);
          if (mh !== inv.markerFileSha256) throw new Error(`This archive's version marker is not the one the servers run (hash mismatch). It was not installed.`);
        }
        for (const cfg of [tr.layout, ...(tr.extraLayouts ?? [])]) {
          const layout = inv.layouts.find((l) => l.config === cfg);
          if (!layout) continue;
          const ui = cfg === '' ? path.join(stagedRoot, 'ui', 'ui_track.json') : path.join(stagedRoot, 'ui', layout.config, 'ui_track.json');
          if (cfg !== '' && !fs.existsSync(path.join(stagedRoot, layout.config))) throw new Error(`The archive does not contain the "${layout.config}" layout these servers use.`);
          if (layout.uiTrackJsonSha256) {
            if (!fs.existsSync(ui)) throw new Error(`The archive does not contain the "${layout.config || 'default'}" layout these servers use.`);
            if (await sha256OfFile(ui, ctx.signal) !== layout.uiTrackJsonSha256) throw new Error(`The "${layout.config || 'default'}" layout in this archive differs from the servers' copy.`);
          }
        }
        check();
        emit({ phase: 'installing', message: 'Installing the track…' });
        txn.place(stagedRoot, path.join(ctx.acRoot, 'content', 'tracks', tr.id));
        await ctx.hooks?.afterPlace?.(placed++, it.id);
        emit({ phase: 'verifying', message: 'Verifying the installed track…' });
        const after = await checkAcRequirements({ acRoot: ctx.acRoot, bundle: ctx.bundle, serverId: ctx.serverId, deep: false, documentsAcDir: ctx.documentsAcDir });
        const tb = after.sections.track.find((c) => (c.status === 'fail' || (c.status === 'warn' && !!c.evidence?.optionalDemoted)) && (c.id === it.id || (entry.primary ? c.id === 'track-layout' : false) || c.id.startsWith(`track-layout:${tr.id}:`)));
        if (tb) throw new Error(`After installing, the track still fails verification: ${tb.detail}`);
        notes.push(tr.name ? `Installed ${tr.name} ${inv.version}.` : `Installed SRP ${inv.version} Stable.`);
      }
      return notes;
    });

    // 4) companion app
    const compItems = chosen.filter((i) => i.kind === 'companion');
    await runGroup('companion', compItems, async (txn) => {
      const app = server.companionApps[0];
      emit({ phase: 'installing', itemId: `companion:${app.id}`, message: 'Preparing the SRP Board…' });
      if (!fs.existsSync(path.join(ctx.acRoot, 'apps')) && !fs.existsSync(path.join(ctx.acRoot, 'extension'))) throw new Error('Custom Shaders Patch does not appear to be installed (no apps or extension folder), so the SRP Board has nowhere to live. Install CSP yourself first.');
      const sp = await planStamp(ctx.endpoints, ctx.resolver);
      if (!sp.entries.length) throw new Error('No server address is configured to stamp the SRP Board with.');
      const files = buildSrpBoardFiles(sp.entries);
      const staged = path.join(txn.stagingDir, app.id);
      fs.mkdirSync(staged, { recursive: true });
      for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(staged, name), buf);
      // verify staged copy against the release before it goes anywhere
      for (const f of ctx.bundle.boardRelease.files) {
        const rel = f.path.replace(/^apps\/lua\/srp_board\//, '');
        const buf = fs.readFileSync(path.join(staged, rel));
        const norm = f.template ? Buffer.from(buf.toString('latin1').replace(/^local SERVERS = \{.*\}/m, 'local SERVERS = { }'), 'latin1') : buf;
        const h = crypto.createHash('sha256').update(norm).digest('hex');
        if (h !== f.sha256) throw new Error(`The staged ${rel} does not match the release; aborting.`);
      }
      fs.mkdirSync(path.join(ctx.acRoot, 'apps', 'lua'), { recursive: true });
      txn.place(staged, path.join(ctx.acRoot, 'apps', 'lua', app.id));
      await ctx.hooks?.afterPlace?.(0, `companion:${app.id}`);
      const after = await checkAcRequirements({ acRoot: ctx.acRoot, bundle: ctx.bundle, serverId: ctx.serverId, deep: false, documentsAcDir: ctx.documentsAcDir });
      const integ = after.sections.companion.find((c) => c.id === `app:${app.id}:integrity`);
      if (integ?.status !== 'pass') throw new Error(`After installing, the SRP Board failed its integrity check: ${integ?.detail}`);
      return [`Installed the SRP Board (${sp.entries.length} server entr${sp.entries.length === 1 ? 'y' : 'ies'} stamped${sp.warnings.length ? '; see warnings' : ''}).`, ...sp.warnings];
    });

    result.report = await checkAcRequirements({ acRoot: ctx.acRoot, bundle: ctx.bundle, serverId: ctx.serverId, deep: true, documentsAcDir: ctx.documentsAcDir });
    result.success = result.groups.length > 0 && result.groups.every((g) => g.ok) && result.skipped.length === 0;
    emit({ phase: result.success ? 'done' : 'failed', message: result.success ? 'Installation finished.' : 'Some steps did not complete — see the details.' });
    return result;
  } catch (e: any) {
    emit({ phase: 'failed', message: e?.message ?? String(e) });
    result.groups.push({ group: 'preflight', ok: false, itemIds: [], error: e?.message ?? String(e), notes: ['Nothing was installed.'] });
    return result;
  } finally { running.delete(ctx.acRoot); }
}

