// Which plan items may be installed WITHOUT asking? Pure policy so it can be tested exhaustively.
// Auto mode is deliberately narrow: only for servers the player opted in to, only cars/tracks from a source the
// owner authorised (https, allow-listed host, known size + SHA-256), only within the size limit, never anything that
// replaces or moves existing files unless the player enabled that too, never CSP, never the SRP Board or HUD moves,
// never while the game is running, and never from an unsigned, expired or development catalog.
import type { InstallPlan } from './installer';
import type { CatalogSettings, CatalogStatus } from './catalogSync';

export interface AutoSelection { itemIds: string[]; downloads: { sourceId: string; bytes: number }[]; totalBytes: number; skipped: { id: string; reason: string }[]; refused: string | null }

export function selectAutoInstall(input: { plan: InstallPlan; settings: CatalogSettings; status: CatalogStatus; serverId: string; gameRunning: boolean }): AutoSelection {
  const { plan, settings, status, serverId } = input;
  const out: AutoSelection = { itemIds: [], downloads: [], totalBytes: 0, skipped: [], refused: null };
  if (settings.installMode !== 'auto') { out.refused = 'Automatic install is off (review mode).'; return out; }
  if (!settings.autoServers.includes(serverId)) { out.refused = 'This server is not marked "keep ready", so nothing is installed automatically for it.'; return out; }
  if (!status.autoInstallAllowed) { out.refused = status.expired ? 'The catalog has expired.' : status.environment === 'development' ? 'Development catalogs never install automatically.' : !status.signatureVerified ? 'The catalog signature is not verified.' : 'Automatic install is not allowed for the current catalog.'; return out; }
  if (input.gameRunning) { out.refused = 'Assetto Corsa is running.'; return out; }
  if (!plan.acRoot) { out.refused = 'Assetto Corsa was not found.'; return out; }
  if (plan.archiveTool === 'none') { out.refused = 'No archive tool (7-Zip or tar.exe) is available.'; return out; }

  const byDownload = new Map(plan.downloads.map((d) => [d.sourceId, d]));
  const eligible: { id: string; sourceId: string }[] = [];
  for (const it of plan.items) {
    const skip = (reason: string) => out.skipped.push({ id: it.id, reason });
    if (it.kind === 'conflict') { skip('Moving existing files is never automatic.'); continue; }
    if (it.kind === 'companion') { skip('The SRP Board is installed by the player.'); continue; }
    if (it.kind === 'external' || it.action === 'manual') { skip('The launcher cannot install this; it needs a manual step.'); continue; }
    if (it.blocked) { skip(it.blocked); continue; }
    if (it.needsLocalFile) { skip('Needs a file you choose yourself.'); continue; }
    if (it.destructive && !settings.autoUpdateExisting) { skip('Replacing existing content needs your approval (backups are always kept).'); continue; }
    const dl = it.sourceId ? byDownload.get(it.sourceId) : undefined;
    if (!dl || !dl.bytes || !dl.sha256 || !dl.allowedHosts) { skip('No verified, authorised download for this item.'); continue; }
    eligible.push({ id: it.id, sourceId: it.sourceId! });
  }
  // size limit: per download and in total — a download over the limit takes all of its items with it
  const okSources = new Set<string>(); let total = 0;
  for (const sid of new Set(eligible.map((e) => e.sourceId))) {
    const d = byDownload.get(sid)!;
    if (d.bytes! > settings.maxAutoDownloadBytes) { for (const e of eligible.filter((x) => x.sourceId === sid)) out.skipped.push({ id: e.id, reason: `Download is ${(d.bytes! / 1e9).toFixed(1)} GB, over your ${(settings.maxAutoDownloadBytes / 1e9).toFixed(1)} GB automatic limit. Install it yourself.` }); continue; }
    if (total + d.bytes! > settings.maxAutoDownloadBytes) { for (const e of eligible.filter((x) => x.sourceId === sid)) out.skipped.push({ id: e.id, reason: 'Would exceed your automatic download limit for one run.' }); continue; }
    total += d.bytes!; okSources.add(sid); out.downloads.push({ sourceId: sid, bytes: d.bytes! });
  }
  out.itemIds = eligible.filter((e) => okSources.has(e.sourceId)).map((e) => e.id);
  out.totalBytes = total;
  return out;
}
