// Read-only pre-flight for an SRP track archive the PLAYER chose themselves (the official direct link is dead, so
// this is the supported route). It answers "is this really the SRP version these servers run, and does it contain
// the layouts they use?" BEFORE anything is installed, with a reason for every check. It unpacks only a few tiny
// files (the version marker and each layout's ui_track.json) into a temporary folder and deletes it afterwards.
//
// It never contacts the network, never writes inside the game folder, and never decides to install anything.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SrpBundle } from '../AcRequirementsChecker';
import { extractMembers, findArchiveTool, findFolder, listArchive, type ArchiveTool } from './archive';
import { sha256OfFile } from './download';

export interface TrackCheck { id: string; ok: boolean; label: string; detail: string }
export interface TrackArchiveValidation {
  ok: boolean;
  /** One plain sentence for the top of the result. */
  summary: string;
  checks: TrackCheck[];
  /** Informational only: whether the whole file is byte-identical to the copy the servers were built from. */
  identicalToOwnersCopy: boolean | null;
  fileName: string;
}

export async function validateTrackArchive(archivePath: string, bundle: SrpBundle, opts: { tool?: ArchiveTool | null; hashWholeFile?: boolean; signal?: AbortSignal; trackId?: string } = {}): Promise<TrackArchiveValidation> {
  const fileName = path.basename(archivePath);
  const checks: TrackCheck[] = [];
  const done = (summary: string, ok: boolean, identical: boolean | null = null): TrackArchiveValidation => ({ ok, summary, checks, identicalToOwnersCopy: identical, fileName });
  const add = (id: string, ok: boolean, label: string, detail: string) => { checks.push({ id, ok, label, detail }); return ok; };

  const inv = opts.trackId ? bundle.tracks.tracks.find((t) => t.id === opts.trackId) : bundle.tracks.tracks[0];
  const trackName = (() => { for (const sv of bundle.servers) for (const t of [sv.track, ...(sv.extraTracks ?? [])]) if (t.id === inv?.id && t.name) return t.name; return null; })();
  const src = bundle.sources.sources.find((s) => s.sourceId === inv?.source.sourceId);
  if (!inv) return done('No track is defined in the requirements bundle.', false);

  let st: fs.Stats | null = null;
  try { st = fs.statSync(archivePath); } catch {}
  if (!add('file', !!st && st.isFile(), 'File exists', st && st.isFile() ? `${fileName} (${(st.size / 1e6).toFixed(0)} MB)` : 'That file could not be found.')) return done('That file could not be found.', false);

  const tool = opts.tool === undefined ? findArchiveTool() : opts.tool;
  if (!add('tool', !!tool, 'Archive tool available', tool ? (tool.kind === '7z' ? '7-Zip' : "Windows' built-in tar.exe") : 'Neither 7-Zip nor Windows\' tar.exe was found, so .7z archives cannot be read.')) return done('No archive tool is available to read this file.', false);

  let entries; try { entries = await listArchive(archivePath, tool!, opts.signal); }
  catch (e: any) { add('readable', false, 'Is a readable archive', `${e?.message ?? 'The archive could not be read'} — the download may be incomplete or damaged.`); return done('This file is not a readable archive (it may be a partial or damaged download).', false); }
  add('readable', true, 'Is a readable archive', `${entries.length.toLocaleString()} entries`);

  const hasMarker = !!inv.markerFileSha256;
  const markerName = inv.markerFileName ?? `${inv.version} Stable.txt`;
  const what = trackName ? `${trackName} ${inv.version}` : `SRP ${inv.version} Stable`;
  const marker = hasMarker ? entries.find((e) => !e.isDir && (e.path === markerName || e.path.toLowerCase().endsWith('/' + markerName.toLowerCase()))) : undefined;
  if (hasMarker && !marker) {
    const other = entries.find((e) => !e.isDir && /(^|\/)[^/]*stable\.txt$/i.test(e.path));
    add('version', false, `Is ${what}`, other
      ? `This archive is a different SRP version ("${path.posix.basename(other.path)}"). These servers run ${inv.version} Stable and other versions are not verified to work.`
      : `No "${markerName}" file was found, so the version cannot be confirmed. It may not be the right track archive at all.`);
    return done(other ? `This is a different SRP version, not ${inv.version} Stable.` : `This does not look like ${what}.`, false);
  }
  let root = '';
  if (marker) root = path.posix.dirname(marker.path) === '.' ? '' : path.posix.dirname(marker.path);
  else {
    const f = findFolder(entries, inv.archivePath ?? `content/tracks/${inv.id}`);
    if (!f) { add('version', false, `Contains ${trackName ?? inv.id}`, `The track folder "${inv.id}" was not found in this archive.`); return done(`This does not look like ${what}.`, false); }
    root = f;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-track-validate-'));
  try {
    const layoutMap = new Map<string, string>();
    for (const sv of bundle.servers) for (const t of [sv.track, ...(sv.extraTracks ?? [])]) if (t.id === inv.id) for (const cfg of [t.layout, ...(t.extraLayouts ?? [])]) if (!layoutMap.has(cfg)) layoutMap.set(cfg, sv.server.displayName);
    const layouts = [...layoutMap.entries()];
    const uiOf = (cfg: string) => (root ? root + '/' : '') + (cfg === '' ? 'ui/ui_track.json' : `ui/${cfg}/ui_track.json`);
    const members = [...(marker ? [marker.path] : []), ...layouts.flatMap(([cfg]) => { const p = uiOf(cfg); return entries.some((e) => e.path === p) ? [p] : []; })];
    if (members.length) await extractMembers(archivePath, tmp, members, tool!, opts.signal);

    if (marker) {
      const mh = await sha256OfFile(path.join(tmp, marker.path.split('/').join(path.sep)));
      add('version', mh === inv.markerFileSha256, `Is ${what}`, mh === inv.markerFileSha256
        ? `The version marker matches the one the servers run.`
        : `The version marker has the right name but different contents — it is not the same build the servers run.`);
    } else add('version', true, `Contains ${trackName ?? inv.id}`, 'The track folder is present. The server publishes no version marker, so the exact version cannot be confirmed.');

    for (const [cfg, serverName] of layouts) {
      const inv_l = inv.layouts.find((l) => l.config === cfg);
      const folder = (root ? root + '/' : '') + cfg;
      const hasFolder = cfg === '' || entries.some((e) => e.path === folder || e.path.startsWith(folder + '/'));
      const uiPath = uiOf(cfg);
      if (!hasFolder) { add(`layout:${cfg}`, false, `Has the "${cfg}" layout (used by ${serverName})`, 'That layout folder is missing from the archive.'); continue; }
      if (inv_l && !inv_l.uiTrackJsonSha256) { add(`layout:${cfg}`, true, `Has the "${cfg || 'default'}" layout (used by ${serverName})`, 'Present.'); continue; }
      if (!entries.some((e) => e.path === uiPath)) { add(`layout:${cfg}`, false, `Has the "${cfg}" layout (used by ${serverName})`, 'The layout is present but its ui_track.json is missing, so it cannot be verified.'); continue; }
      const h = await sha256OfFile(path.join(tmp, uiPath.split('/').join(path.sep)));
      add(`layout:${cfg}`, !inv_l || h === inv_l.uiTrackJsonSha256, `Has the "${cfg}" layout (used by ${serverName})`, !inv_l || h === inv_l.uiTrackJsonSha256 ? 'Present, and its metadata matches the servers.' : 'Present, but its metadata differs from the servers\' copy.');
    }
  } catch (e: any) {
    add('verify', false, 'Could be checked', e?.message ?? 'The archive could not be checked.');
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }

  let identical: boolean | null = null;
  if (opts.hashWholeFile && src?.localArchive?.sha256) {
    try { identical = (await sha256OfFile(archivePath, opts.signal)) === src.localArchive.sha256; } catch { identical = null; }
  }
  const ok = checks.every((c) => c.ok);
  return done(ok ? `This is ${what} with the layouts these servers use. It is safe to install.` : 'This archive failed a check — nothing has been changed.', ok, identical);
}
