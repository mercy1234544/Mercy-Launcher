// Assetto Corsa client requirements checker — READ-ONLY.
//
// Answers one question for a player: "if I join this SRP server right now,
// is my Assetto Corsa install ready?" It compares a real player install
// against the machine-readable requirements the server owner published (the
// handoff package vendored under src/main/data/assettocorsa-srp/).
//
// HARD CONTRACT (enforced by test/assettocorsa/requirements-checker.test.js):
//   * Only reads. No write/delete/rename/copy/mkdir, no child processes, no
//     network. A fixture install is snapshotted before and after every run.
//   * Never installs, repairs or "fixes" anything — it reports and links to
//     the official source; the install actions are a separate, later step.
//   * Never prints a stamped server address: the SRP Board check reports the
//     KIND of each stamped entry (private LAN / public IP / hostname) and its
//     port, not the address itself.
//
// This is the CLIENT side of the game. AssettoCorsaManager.ts is the HOST
// side (dedicated servers the user runs); the two share nothing on purpose.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown' | 'info';

export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  evidence?: Record<string, unknown>;
}

export type SectionId = 'install' | 'csp' | 'track' | 'cars' | 'companion' | 'conflicts';

export interface AcRequirementsReport {
  schemaVersion: string;
  serverId: string;
  serverName: string;
  acRoot: string | null;
  checkedAt: string;
  deep: boolean;
  sections: Record<SectionId, CheckItem[]>;
  summary: {
    pass: number; warn: number; fail: number; unknown: number; info: number;
    readyToJoin: boolean;
    /** True when something could not be determined (never silently "ready"). */
    incomplete: boolean;
    blockers: string[];
  };
}

// ── Requirement bundle shapes (only the fields this checker reads) ───────────
export interface SrpCarRequirement {
  id: string;
  name: string | null;
  version: string | null;
  role: string;
  requirement: string;
  source: string;
  skinsPinnedByEntryList?: string[];
  identity: { dataAcdSha256: string | null; uiCarJsonSha256: string | null };
  /** Folder of this car inside its archive, when it is not the conventional content/cars/<id>. */
  archivePath?: string;
}
/** One track a server runs. `layout` is the primary layout ('' = the track's default layout); more go in `extraLayouts`. */
export interface SrpTrackRequirement {
  id: string; layout: string; layoutName?: string; version: string; source: string;
  /** Display name. Absent = the original SRP wording. */
  name?: string;
  extraLayouts?: string[];
  /** A suggestion, not a blocker: missing/outdated problems are shown as warnings. */
  optional?: boolean;
}
export interface SrpServerRequirements {
  schemaVersion: string;
  server: {
    id: string; displayName: string; type: string;
    game?: { udpPort: number; tcpPort: number; httpPort: number };
    maxPlayers?: number;
    ai?: { enabled: boolean; trafficCars: number };
    connection?: { publicHost: string | null; publicPort: number };
  };
  track: SrpTrackRequirement;
  /** Additional tracks (server-catalog servers may run several). The primary `track` keeps the original check ids. */
  extraTracks?: SrpTrackRequirement[];
  cars: SrpCarRequirement[];
  csp: { required: boolean; minimumVersion: string; testedVersion: string; /** This server does not use CSP at all. */ none?: boolean };
  hud: { delivery: string; playerInstall: boolean; version: string };
  companionApps: {
    id: string; version: string; requirement: string; installDestination: string;
    conflictsWith?: string[]; stampServerEntry: { host: string | null; hostPlaceholder?: string; tcpPort: number };
  }[];
}
export interface SrpTrackInventory {
  tracks: {
    id: string; version: string; name?: string;
    /** '' = no version marker is published for this track (folder + layout checks only). */
    markerFileSha256: string;
    /** Marker file name. Absent = "<version> Stable.txt" (SRP). */
    markerFileName?: string;
    layouts: { config: string; uiTrackJsonSha256: string }[];
    source: { sourceId: string };
    /** Folder of the track inside its archive, when not content/tracks/<id>. */
    archivePath?: string;
    /** Content the launcher never installs: the player's game / DLC, or a manual download. */
    external?: 'base-game' | 'dlc' | 'manual';
  }[];
}
export interface SrpAcquisitionSources {
  sources: {
    sourceId: string; name: string; homepage?: string; officialDirectUrl?: string; directUrlStatus?: string; redistribution?: string; localArchive?: { bytes: number; sha256: string };
    /** Catalog-supplied sources: the ONLY hosts a download (and every redirect) may touch, and whether the owner authorised it. */
    allowedHosts?: string[]; authorizedDownload?: boolean; fileName?: string;
    kind?: 'archive' | 'base-game' | 'dlc' | 'manual'; instructions?: string;
  }[];
}
export interface SrpBoardRelease {
  version: string;
  files: { path: string; sha256: string; template: boolean }[];
}
export interface SrpBundle {
  servers: SrpServerRequirements[];
  tracks: SrpTrackInventory;
  sources: SrpAcquisitionSources;
  boardRelease: SrpBoardRelease;
}

export interface CheckOptions {
  /** Assetto Corsa install root (the folder holding acs.exe). null = not found. */
  acRoot: string | null;
  bundle: SrpBundle;
  serverId: string;
  /** Hash each car's physics data (data.acd). Default true; set false for a faster, shallower check. */
  deep?: boolean;
  /** "Documents\\Assetto Corsa" — where CSP writes its log. Defaults to <home>\\Documents\\Assetto Corsa. */
  documentsAcDir?: string | null;
  now?: () => Date;
}

// ── Small pure helpers (exported for tests) ──────────────────────────────────

/** Numeric dotted-version compare. Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** "0.2.11 b3465" -> { version: '0.2.11', build: 3465 } */
export function parseCspVersionText(text: string): { version: string; build: number | null } | null {
  const m = /(\d+(?:\.\d+)+)(?:\s*b(\d+))?/i.exec(text);
  return m ? { version: m[1], build: m[2] ? parseInt(m[2], 10) : null } : null;
}

/** CSP writes e.g. "CSP v0.2.11 b3465, enabled, date & time: ..." near the top of its log. */
export function parseCspVersionFromLog(logHead: string): { version: string; build: number | null } | null {
  const m = /CSP v(\d+(?:\.\d+)+)(?:\s*b(\d+))?/.exec(logHead);
  return m ? { version: m[1], build: m[2] ? parseInt(m[2], 10) : null } : null;
}

export function readIniValue(text: string, key: string): string | null {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'im').exec(text);
  return m ? m[1] : null;
}

export type HostKind = 'private-lan' | 'loopback' | 'public-ip' | 'hostname';
export function classifyHost(host: string): HostKind {
  if (/^127\./.test(host) || host === 'localhost' || host === '::1') return 'loopback';
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return 'private-lan';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'public-ip';
  return 'hostname';
}

/** The entries stamped into srp_board.lua's `local SERVERS = { ... }`, or null if that line is absent. */
export function parseBoardServers(lua: string): string[] | null {
  const m = /^local SERVERS = \{(.*)\}/m.exec(lua);
  if (!m) return null;
  return Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
}

const SAFE_SEGMENT = /^[A-Za-z0-9_.\-][A-Za-z0-9_.\- ]*$/;
export function safeSegment(s: string): string | null {
  return s && s !== '.' && s !== '..' && SAFE_SEGMENT.test(s) ? s : null;
}

const MAX_SMALL_FILE = 1024 * 1024;
function readSmall(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SMALL_FILE) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}
function readSmallBuffer(file: string): Buffer | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SMALL_FILE) return null;
    return fs.readFileSync(file);
  } catch { return null; }
}
function readHead(file: string, bytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return null; } finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
}
function sha256Buffer(b: Buffer): string { return crypto.createHash('sha256').update(b).digest('hex'); }
function sha256File(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(file);
      s.on('data', (d) => h.update(d));
      s.on('error', () => resolve(null));
      s.on('end', () => resolve(h.digest('hex')));
    } catch { resolve(null); }
  });
}
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }

const WORST: CheckStatus[] = ['pass', 'info', 'unknown', 'warn', 'fail'];
function worst(a: CheckStatus, b: CheckStatus): CheckStatus { return WORST.indexOf(a) >= WORST.indexOf(b) ? a : b; }

/** Resolve the AC root from a candidate list: the first folder that really holds the game. */
export function findAcRoot(candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    if (c && (isFile(path.join(c, 'acs.exe')) || isFile(path.join(c, 'AssettoCorsa.exe')))) return c;
  }
  return null;
}

// ── The checker ──────────────────────────────────────────────────────────────

export async function checkAcRequirements(opts: CheckOptions): Promise<AcRequirementsReport> {
  const { bundle, serverId } = opts;
  const deep = opts.deep !== false;
  const now = opts.now ?? (() => new Date());
  const server = bundle.servers.find((s) => s.server.id === serverId);
  if (!server) throw new Error(`Unknown SRP server id "${serverId}"`);

  const sections: Record<SectionId, CheckItem[]> = { install: [], csp: [], track: [], cars: [], companion: [], conflicts: [] };
  const acRoot = opts.acRoot;
  const docsDir = opts.documentsAcDir === undefined ? path.join(os.homedir(), 'Documents', 'Assetto Corsa') : opts.documentsAcDir;

  // 1. Install ------------------------------------------------------------
  const hasExe = !!acRoot && (isFile(path.join(acRoot, 'acs.exe')) || isFile(path.join(acRoot, 'AssettoCorsa.exe')));
  if (!acRoot || !hasExe) {
    sections.install.push({
      id: 'ac-install', label: 'Assetto Corsa install', status: 'fail',
      detail: acRoot ? `"${acRoot}" does not contain acs.exe / AssettoCorsa.exe.` : 'Assetto Corsa was not found on this computer.',
    });
    return finish(server, acRoot, deep, now, sections);
  }
  const contentCars = path.join(acRoot, 'content', 'cars');
  const contentTracks = path.join(acRoot, 'content', 'tracks');
  sections.install.push({
    id: 'ac-install', label: 'Assetto Corsa install', status: isDir(contentCars) && isDir(contentTracks) ? 'pass' : 'fail',
    detail: isDir(contentCars) && isDir(contentTracks) ? 'Game folder found with content\\cars and content\\tracks.' : 'content\\cars or content\\tracks is missing.',
    evidence: { acRoot },
  });

  // 2. Custom Shaders Patch ------------------------------------------------
  if (server.csp.none) {
    sections.csp.push({ id: 'csp-installed', label: 'Custom Shaders Patch', status: 'info', detail: 'This server does not require Custom Shaders Patch.' });
  } else {
  const cspInstalled = isFile(path.join(acRoot, 'dwrite.dll')) && isDir(path.join(acRoot, 'extension'));
  sections.csp.push({
    id: 'csp-installed', label: 'Custom Shaders Patch installed', status: cspInstalled ? 'pass' : (server.csp.required ? 'fail' : 'warn'),
    detail: cspInstalled ? 'dwrite.dll and the extension folder are present.' : 'dwrite.dll and/or the extension folder is missing — Custom Shaders Patch does not appear to be installed.',
  });
  const logHead = docsDir ? readHead(path.join(docsDir, 'logs', 'custom_shaders_patch.log'), 16 * 1024) : null;
  const cspVer = logHead ? parseCspVersionFromLog(logHead) : null;
  const min = server.csp.minimumVersion;
  const tested = parseCspVersionText(server.csp.testedVersion);
  if (!cspVer) {
    sections.csp.push({
      id: 'csp-version', label: 'Custom Shaders Patch version', status: 'unknown',
      detail: `Version not determined — the CSP log was not found or has no version line. Start the game once, then re-check. Required: ${min} or newer.`,
    });
  } else {
    const belowMin = compareVersions(cspVer.version, min) < 0;
    const isTested = !!tested && compareVersions(cspVer.version, tested.version) === 0 && (tested.build === null || cspVer.build === tested.build);
    sections.csp.push({
      id: 'csp-version', label: 'Custom Shaders Patch version',
      status: belowMin ? 'fail' : isTested ? 'pass' : 'info',
      detail: belowMin
        ? `CSP ${cspVer.version} is older than the required ${min}. Update it (Content Manager can do this).`
        : isTested
          ? `CSP ${cspVer.version}${cspVer.build ? ` b${cspVer.build}` : ''} — the exact version this server was tested with.`
          : `CSP ${cspVer.version}${cspVer.build ? ` b${cspVer.build}` : ''} meets the minimum (${min}); ${server.csp.testedVersion ? `only ${server.csp.testedVersion} has been tested.` : 'no tested version is recorded.'}`,
      evidence: { version: cspVer.version, build: cspVer.build, source: 'last-run custom_shaders_patch.log (reflects the last game launch, not necessarily a later update)' },
    });
  }
  }

  // 3. Track(s) -------------------------------------------------------------
  sections.track.push(...await checkTrackReq(server.track, true, bundle, contentTracks));
  for (const extra of server.extraTracks ?? []) sections.track.push(...await checkTrackReq(extra, false, bundle, contentTracks));

  // 4. Cars ----------------------------------------------------------------
  for (const car of server.cars) {
    sections.cars.push(await checkCar(car, contentCars, deep, bundle));
  }

  // 5. Companion apps + HUD ------------------------------------------------
  for (const app of server.companionApps) sections.companion.push(...checkCompanionApp(app, acRoot, bundle.boardRelease));
  if (server.hud.delivery === 'none') {
    sections.companion.push({ id: 'hud', label: 'Server HUD', status: 'info', detail: 'This server does not deliver a HUD. Nothing to install.' });
  } else {
    sections.companion.push({ id: 'hud', label: 'Server HUD', status: 'info', detail: `The server delivers HUD ${server.hud.version} to you when you join. Nothing to install.` });
  }

  // 6. Conflicts -----------------------------------------------------------
  const oldHud = path.join(acRoot, 'apps', 'lua', 'srp_hud');
  const hudDelivered = server.hud.delivery !== 'none';
  sections.conflicts.push(isDir(oldHud)
    ? { id: 'conflict-srp-hud', label: 'Old dev HUD app (apps\\lua\\srp_hud)', status: hudDelivered ? 'fail' : 'warn',
        detail: hudDelivered ? 'The old dev HUD is installed next to the server-delivered HUD — you would get two HUDs. Checking never removes anything; "Move aside" puts the old app in a backup folder instead.' : 'The old dev HUD is installed. This server delivers no HUD, but it would conflict on servers that do. Nothing was removed; "Move aside" puts it in a backup folder.' }
    : { id: 'conflict-srp-hud', label: 'Old dev HUD app (apps\\lua\\srp_hud)', status: 'pass', detail: 'Not installed — no double-HUD conflict.' });

  return finish(server, acRoot, deep, now, sections);
}

/** Checks one required track + its layouts. The primary track keeps the original ids (`track`, `track-layout`). */
async function checkTrackReq(tr: SrpServerRequirements['track'], primary: boolean, bundle: SrpBundle, contentTracks: string): Promise<CheckItem[]> {
  const out: CheckItem[] = [];
  const trackItemId = primary ? 'track' : `track:${tr.id}`;
  const layoutItemId = (cfg: string, first: boolean) => (primary && first ? 'track-layout' : `track-layout:${tr.id}:${cfg || 'default'}`);
  const trackInv = bundle.tracks.tracks.find((t) => t.id === tr.id);
  const trackSrc = bundle.sources.sources.find((s) => s.sourceId === tr.source);
  const where = trackSrc ? ` Official source: ${trackSrc.homepage ?? 'see the SRP project site'}${trackSrc.directUrlStatus && !trackSrc.allowedHosts ? ` (direct link status: ${trackSrc.directUrlStatus})` : ''}.` : '';
  const trackSeg = safeSegment(tr.id);
  const trackDir = trackSeg ? path.join(contentTracks, trackSeg) : null;
  const label = tr.name ? `${tr.name} ${tr.version}` : `SRP track ${tr.version}`;
  if (!trackInv || !trackDir) {
    out.push({ id: trackItemId, label: tr.name ?? 'SRP track', status: 'unknown', detail: 'No inventory entry for the required track in the requirements bundle.' });
    return out;
  }
  if (trackInv.external) {
    const what = trackInv.external === 'base-game' ? 'a base-game track; verify game files in Steam' : trackInv.external === 'dlc' ? 'part of a DLC you must own' : 'content you must install yourself';
    out.push(isDir(trackDir)
      ? { id: trackItemId, label, status: 'pass', detail: 'Installed.', evidence: { state: 'ok' } }
      : { id: trackItemId, label, status: 'fail', detail: `Track folder content\\tracks\\${tr.id} is not installed — it is ${what}. Mercy Launcher never installs it.${where}`, evidence: { state: 'missing', external: trackInv.external } });
  } else if (!isDir(trackDir)) {
    out.push({ id: trackItemId, label, status: 'fail', detail: `Track folder content\\tracks\\${tr.id} is not installed.${where}`, evidence: { state: 'missing' } });
  } else if (!trackInv.markerFileSha256) {
    out.push({ id: trackItemId, label, status: 'info', detail: 'Track folder is installed. The server publishes no version marker for it, so the exact version cannot be confirmed.', evidence: { state: 'ok' } });
  } else {
    const markerName = trackInv.markerFileName ?? `${trackInv.version} Stable.txt`;
    const markerPath = path.join(trackDir, markerName);
    if (!isFile(markerPath)) {
      const others = (() => { try { return fs.readdirSync(trackDir).filter((f) => /\.txt$/i.test(f) && /stable|version|\d+\.\d+/i.test(f)); } catch { return []; } })();
      out.push({
        id: trackItemId, label, status: 'fail',
        detail: others.length
          ? `A different SRP version appears to be installed (found "${others[0]}", need "${markerName}"). It was NOT changed. This server needs ${trackInv.version}; other versions are unverified.${where}`
          : `The version marker "${markerName}" is missing, so the installed SRP version cannot be confirmed.${where}`,
        evidence: { state: others.length ? 'other-version' : 'marker-missing', found: others },
      });
    } else {
      const h = await sha256File(markerPath);
      out.push({
        id: trackItemId, label, status: h === trackInv.markerFileSha256 ? 'pass' : 'fail',
        detail: h === trackInv.markerFileSha256 ? `Version marker matches ${trackInv.version} Stable.` : `Version marker "${markerName}" differs from the server's copy — not the same SRP build.${where}`,
        evidence: { state: h === trackInv.markerFileSha256 ? 'ok' : 'marker-mismatch' },
      });
    }
  }
  if (!isDir(trackDir)) { /* layouts cannot be inspected until the track exists; the track item already fails */ }

  const layouts = [tr.layout, ...(tr.extraLayouts ?? [])];
  for (let i = 0; i < layouts.length; i++) {
    const cfg = layouts[i]; const itemId = layoutItemId(cfg, i === 0);
    const layout = trackInv.layouts.find((l) => l.config === cfg);
    const layoutSeg = cfg === '' ? '' : safeSegment(cfg);
    const shown = cfg === '' ? 'Default layout' : `Layout ${cfg}`;
    if (!layout || layoutSeg === null) { out.push({ id: itemId, label: shown, status: 'unknown', detail: 'Layout not present in the inventory.' }); continue; }
    if (!isDir(trackDir)) continue;
    const layoutDir = layoutSeg ? path.join(trackDir, layoutSeg) : trackDir;
    const uiPath = layoutSeg ? path.join(trackDir, 'ui', layoutSeg, 'ui_track.json') : path.join(trackDir, 'ui', 'ui_track.json');
    if (!isDir(layoutDir)) {
      out.push({ id: itemId, label: shown, status: 'fail', detail: `Layout folder "${layout.config}" is missing from the installed track.`, evidence: { state: 'layout-missing' } });
    } else if (!layout.uiTrackJsonSha256) {
      out.push({ id: itemId, label: shown, status: 'pass', detail: 'Layout folder present.' });
    } else if (!isFile(uiPath)) {
      out.push({ id: itemId, label: shown, status: 'warn', detail: 'Layout folder present, but its ui_track.json could not be read to confirm the version.' });
    } else {
      const h = await sha256File(uiPath);
      out.push({ id: itemId, label: shown, status: h === layout.uiTrackJsonSha256 ? 'pass' : 'warn', detail: h === layout.uiTrackJsonSha256 ? 'Layout metadata matches the server.' : "Layout metadata differs from the server's copy." });
    }
  }
  // An optional track never blocks joining: its failures are shown as warnings (and marked so the planner still offers a fix).
  if (tr.optional) for (const i of out) if (i.status === 'fail') { i.status = 'warn'; i.evidence = { ...(i.evidence ?? {}), optionalDemoted: true }; }
  return out;
}

async function checkCar(car: SrpCarRequirement, contentCars: string, deep: boolean, bundle: SrpBundle): Promise<CheckItem> {
  const label = car.name ?? car.id;
  const seg = safeSegment(car.id);
  const src = bundle.sources.sources.find((s) => s.sourceId === car.source);
  if (!seg) return { id: `car:${car.id}`, label, status: 'unknown', detail: 'Unsafe car id in requirements; skipped.' };
  const dir = path.join(contentCars, seg);
  if (!isDir(dir)) {
    return { id: `car:${car.id}`, label, status: car.requirement === 'optional' ? 'warn' : 'fail', detail: car.source === 'ac_base_game' ? 'Missing — this is a base-game car; verify game files in Steam.' : `Not installed.${src ? ` Comes from ${src.name} (${src.homepage ?? 'official site'}).` : ''}`, evidence: { state: 'missing', source: car.source, role: car.role } };
  }
  let status: CheckStatus = 'pass';
  const notes: string[] = [];
  const issues: string[] = [];

  // version via ui_car.json (null in the requirement = not comparable, e.g. base-game cars)
  const uiPath = path.join(dir, 'ui', 'ui_car.json');
  const uiBuf = readSmallBuffer(uiPath);
  let installedVersion: string | null = null;
  if (uiBuf) {
    try { const j = JSON.parse(uiBuf.toString('utf8').replace(/^﻿/, '')); installedVersion = j.version != null ? String(j.version) : null; } catch {}
  }
  if (car.version !== null) {
    if (installedVersion === null) { status = worst(status, 'warn'); notes.push('ui_car.json version unreadable'); issues.push('version'); }
    else if (installedVersion !== car.version) { status = worst(status, 'warn'); notes.push(`version ${installedVersion} (server has ${car.version})`); issues.push('version'); }
  }
  // metadata hash — only where the server's copy is authoritative
  if (car.identity.uiCarJsonSha256 && uiBuf && sha256Buffer(uiBuf) !== car.identity.uiCarJsonSha256 && installedVersion === car.version) {
    notes.push('ui_car.json differs (same version)');
    status = worst(status, 'info');
  }
  // physics identity
  if (deep && car.identity.dataAcdSha256) {
    const acd = path.join(dir, 'data.acd');
    if (!isFile(acd)) { status = worst(status, 'warn'); notes.push('data.acd not found (unpacked data folder or different layout)'); issues.push('physics-unverifiable'); }
    else {
      const h = await sha256File(acd);
      if (h !== car.identity.dataAcdSha256) { status = worst(status, 'fail'); notes.push('physics data (data.acd) differs from the server\'s copy'); issues.push('physics'); }
    }
  }
  // pinned skins
  const missingSkins = (car.skinsPinnedByEntryList ?? []).filter((s) => s && safeSegment(s) && !isDir(path.join(dir, 'skins', s)));
  if (missingSkins.length) { status = worst(status, 'warn'); notes.push(`missing pinned skin: ${missingSkins.join(', ')}`); issues.push('skin'); }

  // An optional car (e.g. a traffic car) never blocks joining.
  if (car.requirement === 'optional' && status === 'fail') status = 'warn';
  // Base-game cars have no name in the requirements; prefer the installed car's own display name over a raw id.
  let shownLabel = label;
  if (car.name === null && uiBuf) { try { const n = JSON.parse(uiBuf.toString('utf8').replace(/^﻿/, '')).name; if (typeof n === 'string' && n.trim()) shownLabel = n.trim(); } catch {} }
  return {
    id: `car:${car.id}`, label: shownLabel, status,
    detail: notes.length ? notes.join('; ') : 'Installed and matches the server.',
    evidence: { state: 'present', issues, missingSkins, installedVersion, requiredVersion: car.version, role: car.role, source: car.source, deepChecked: deep && !!car.identity.dataAcdSha256 },
  };
}

function checkCompanionApp(app: SrpServerRequirements['companionApps'][number], acRoot: string, release: SrpBoardRelease): CheckItem[] {
  const out: CheckItem[] = [];
  const seg = safeSegment(app.id);
  const dir = seg ? path.join(acRoot, 'apps', 'lua', seg) : null;
  if (!dir || !isDir(dir)) {
    out.push({ id: `app:${app.id}`, label: `Companion app ${app.id}`, status: 'warn', detail: `Not installed (optional). Without it the F9 position strip stays visible on this server.` });
    return out;
  }
  const manifest = readSmall(path.join(dir, 'manifest.ini'));
  const installedVersion = manifest ? readIniValue(manifest, 'VERSION') : null;
  const vstat: CheckStatus = installedVersion === null ? 'warn' : compareVersions(installedVersion, app.version) === 0 ? 'pass' : compareVersions(installedVersion, app.version) < 0 ? 'warn' : 'info';
  out.push({
    id: `app:${app.id}`, label: `Companion app ${app.id}`, status: vstat,
    detail: installedVersion === null ? 'Installed, but its manifest.ini version could not be read.' : vstat === 'pass' ? `Version ${installedVersion} installed (current).` : vstat === 'warn' ? `Version ${installedVersion} installed; ${app.version} is current.` : `Version ${installedVersion} installed (newer than the ${app.version} this check knows).`,
    evidence: { installedVersion, currentVersion: app.version },
  });

  // integrity: unchanged files match the release; the lua must match once its stamped server list is blanked
  const problems: string[] = [];
  for (const f of release.files) {
    const rel = f.path.replace(/^apps\/lua\/srp_board\//, '');
    const buf = readSmallBuffer(path.join(dir, rel));
    if (!buf) { problems.push(`${rel} missing/unreadable`); continue; }
    if (f.template) {
      const normalized = Buffer.from(buf.toString('latin1').replace(/^local SERVERS = \{.*\}/m, 'local SERVERS = { }'), 'latin1');
      if (sha256Buffer(normalized) !== f.sha256) problems.push(`${rel} differs from the release beyond its server list`);
    } else if (sha256Buffer(buf) !== f.sha256) problems.push(`${rel} differs from the release`);
  }
  out.push({
    id: `app:${app.id}:integrity`, label: 'Companion app files', status: problems.length ? 'warn' : 'pass',
    detail: problems.length ? problems.join('; ') : 'Files match the release (server list excluded).',
  });

  // stamp analysis (kinds + ports only — never the address)
  const lua = readSmall(path.join(dir, 'srp_board.lua'));
  const entries = lua ? parseBoardServers(lua) : null;
  if (entries === null) {
    out.push({ id: `app:${app.id}:stamp`, label: 'Companion app server list', status: 'warn', detail: 'Could not find the app\'s server list line.' });
  } else if (entries.length === 0) {
    out.push({ id: `app:${app.id}:stamp`, label: 'Companion app server list', status: 'warn', detail: 'Installed but not stamped with any server, so it does nothing.' });
  } else {
    const parsed = entries.map((e) => { const i = e.lastIndexOf(':'); return { kind: classifyHost(e.slice(0, i)), port: parseInt(e.slice(i + 1), 10) }; });
    const wantsPort = app.stampServerEntry.tcpPort;
    const hasPort = parsed.some((p) => p.port === wantsPort);
    const onlyPrivate = parsed.every((p) => p.kind === 'private-lan' || p.kind === 'loopback');
    out.push({
      id: `app:${app.id}:stamp`, label: 'Companion app server list',
      status: !hasPort ? 'warn' : onlyPrivate ? 'info' : 'pass',
      detail: !hasPort
        ? `Stamped for ${entries.length} server(s), none on this server's port ${wantsPort}.`
        : onlyPrivate
          ? `Stamped for ${entries.length} server(s), all private-network addresses. That works when you join from the same network, but will not match this server when joined from outside (public address not assigned yet).`
          : `Stamped for ${entries.length} server(s) including a public one on port ${wantsPort}.`,
      evidence: { entries: parsed },
    });
  }
  return out;
}

function finish(server: SrpServerRequirements, acRoot: string | null, deep: boolean, now: () => Date, sections: Record<SectionId, CheckItem[]>): AcRequirementsReport {
  const all = (Object.values(sections) as CheckItem[][]).flat();
  const count = (s: CheckStatus) => all.filter((i) => i.status === s).length;
  const blockers = all.filter((i) => i.status === 'fail').map((i) => `${i.label}: ${i.detail}`);
  return {
    schemaVersion: server.schemaVersion,
    serverId: server.server.id,
    serverName: server.server.displayName,
    acRoot, checkedAt: now().toISOString(), deep, sections,
    summary: { pass: count('pass'), warn: count('warn'), fail: count('fail'), unknown: count('unknown'), info: count('info'), readyToJoin: blockers.length === 0, incomplete: count('unknown') > 0, blockers },
  };
}
