// What changed between two accepted catalogs? Pure, so the sync layer can tell the UI exactly which servers and
// content were added, removed, updated or stopped being required — without ever deleting anything on disk.
import type { AcCatalog } from './catalogSchema';

export type ChangeKind =
  | 'server-added' | 'server-removed' | 'server-updated' | 'server-status'
  | 'content-added' | 'content-removed' | 'content-updated'
  | 'requirement-added' | 'requirement-removed' | 'requirement-changed'
  | 'archive-changed' | 'endpoint-changed';

export interface CatalogChange { kind: ChangeKind; serverId?: string; contentId?: string; text: string }
export interface CatalogDiff { changed: boolean; changes: CatalogChange[]; summary: string[]; serverIds: string[]; firstSync: boolean }

const MAX_SUMMARY = 12;
const j = (v: unknown) => JSON.stringify(v ?? null);


export function diffCatalogs(prev: AcCatalog | null, next: AcCatalog): CatalogDiff {
  const changes: CatalogChange[] = [];
  const push = (c: CatalogChange) => changes.push(c);
  if (!prev) {
    return { changed: true, changes: next.servers.map((s) => ({ kind: 'server-added' as const, serverId: s.id, text: `Server available: ${s.displayName}` })), summary: [`${next.servers.length} server${next.servers.length === 1 ? '' : 's'} available`], serverIds: next.servers.map((s) => s.id), firstSync: true };
  }
  const pServers = new Map(prev.servers.map((s) => [s.id, s])); const nServers = new Map(next.servers.map((s) => [s.id, s]));
  const pCars = new Map(prev.content.cars.map((c) => [c.id, c])); const nCars = new Map(next.content.cars.map((c) => [c.id, c]));
  const pTracks = new Map(prev.content.tracks.map((t) => [t.id, t])); const nTracks = new Map(next.content.tracks.map((t) => [t.id, t]));
  const pArch = new Map(prev.archives.map((a) => [a.id, a])); const nArch = new Map(next.archives.map((a) => [a.id, a]));

  for (const [id, s] of nServers) if (!pServers.has(id)) push({ kind: 'server-added', serverId: id, text: `New server: ${s.displayName}` });
  for (const [id, s] of pServers) if (!nServers.has(id)) push({ kind: 'server-removed', serverId: id, text: `Server removed from the catalog: ${s.displayName}` });

  for (const [id, n] of nServers) {
    const p = pServers.get(id); if (!p) continue;
    const name = n.displayName;
    if ((p.status ?? 'active') !== (n.status ?? 'active')) push({ kind: 'server-status', serverId: id, text: `${name}: now ${n.status ?? 'active'}` });
    if (p.displayName !== n.displayName || (p.description ?? '') !== (n.description ?? '') || p.maxPlayers !== n.maxPlayers || j(p.ai) !== j(n.ai)) push({ kind: 'server-updated', serverId: id, text: `${name}: details updated` });
    if (j(p.connection.public) !== j(n.connection.public)) push({ kind: 'endpoint-changed', serverId: id, text: `${name}: connection address ${p.connection.public ? 'changed' : 'added'}` });
    if (j(p.requirements) !== j(n.requirements)) push({ kind: 'requirement-changed', serverId: id, text: `${name}: Custom Shaders Patch requirement changed` });
    // tracks + layouts
    const pt = new Map(p.tracks.map((t) => [t.trackId, t])); const nt = new Map(n.tracks.map((t) => [t.trackId, t]));
    for (const [tid, t] of nt) {
      const old = pt.get(tid);
      const tname = nTracks.get(tid)?.name ?? tid;
      if (!old) push({ kind: 'requirement-added', serverId: id, contentId: tid, text: `${name}: track ${tname} now required` });
      else {
        for (const l of t.layouts) if (!old.layouts.includes(l)) push({ kind: 'requirement-added', serverId: id, contentId: tid, text: `${name}: layout ${l || 'default'} of ${tname} added` });
        for (const l of old.layouts) if (!t.layouts.includes(l)) push({ kind: 'requirement-removed', serverId: id, contentId: tid, text: `${name}: layout ${l || 'default'} of ${tname} no longer used` });
        if ((old.required ?? true) !== (t.required ?? true)) push({ kind: 'requirement-changed', serverId: id, contentId: tid, text: `${name}: track ${tname} is now ${(t.required ?? true) ? 'required' : 'optional'}` });
      }
    }
    for (const [tid] of pt) if (!nt.has(tid)) push({ kind: 'requirement-removed', serverId: id, contentId: tid, text: `${name}: track ${pTracks.get(tid)?.name ?? tid} no longer required` });
    // cars
    const pc = new Map(p.cars.map((c) => [c.carId, c])); const nc = new Map(n.cars.map((c) => [c.carId, c]));
    for (const [cid, c] of nc) {
      const old = pc.get(cid); const cname = nCars.get(cid)?.name ?? cid;
      if (!old) push({ kind: 'requirement-added', serverId: id, contentId: cid, text: `${name}: car ${cname} added` });
      else {
        if ((old.required ?? true) !== (c.required ?? true)) push({ kind: 'requirement-changed', serverId: id, contentId: cid, text: `${name}: car ${cname} is now ${(c.required ?? true) ? 'required' : 'optional'}` });
        if (j(old.skins ?? []) !== j(c.skins ?? [])) push({ kind: 'requirement-changed', serverId: id, contentId: cid, text: `${name}: pinned skins of ${cname} changed` });
      }
    }
    for (const [cid] of pc) if (!nc.has(cid)) push({ kind: 'requirement-removed', serverId: id, contentId: cid, text: `${name}: car ${pCars.get(cid)?.name ?? cid} no longer required` });
    if (j(p.companionApps ?? []) !== j(n.companionApps ?? []) || j(p.hud) !== j(n.hud)) push({ kind: 'server-updated', serverId: id, text: `${name}: HUD / companion app settings changed` });
  }

  for (const [id, c] of nCars) {
    const o = pCars.get(id);
    if (!o) { if (![...nServers.values()].every((s) => !s.cars.some((x) => x.carId === id))) push({ kind: 'content-added', contentId: id, text: `New car: ${c.name}` }); continue; }
    if (o.version !== c.version || j(o.identity) !== j(c.identity) || j(o.origin) !== j(c.origin)) push({ kind: 'content-updated', contentId: id, text: `Car updated: ${c.name}${o.version !== c.version ? ` (${o.version ?? '?'} → ${c.version ?? '?'})` : ''}` });
  }
  for (const [id, c] of pCars) if (!nCars.has(id)) push({ kind: 'content-removed', contentId: id, text: `Car left the catalog: ${c.name} (your installed copy is kept)` });
  for (const [id, t] of nTracks) {
    const o = pTracks.get(id);
    if (!o) { push({ kind: 'content-added', contentId: id, text: `New track: ${t.name}` }); continue; }
    if (o.version !== t.version || j(o.verify) !== j(t.verify) || j(o.layouts) !== j(t.layouts) || j(o.origin) !== j(t.origin)) push({ kind: 'content-updated', contentId: id, text: `Track updated: ${t.name}${o.version !== t.version ? ` (${o.version} → ${t.version})` : ''}` });
  }
  for (const [id, t] of pTracks) if (!nTracks.has(id)) push({ kind: 'content-removed', contentId: id, text: `Track left the catalog: ${t.name} (your installed copy is kept)` });
  for (const [id, a] of nArch) {
    const o = pArch.get(id);
    if (o && (o.sha256 !== a.sha256 || o.bytes !== a.bytes || o.url !== a.url || j(o.allowedHosts) !== j(a.allowedHosts) || o.redistribution !== a.redistribution)) push({ kind: 'archive-changed', contentId: id, text: `Download updated: ${a.name}` });
  }

  const serverIds = [...new Set(changes.map((c) => c.serverId).filter((x): x is string => !!x))];
  // a change to shared content touches every server that uses it
  for (const c of changes) if (!c.serverId && c.contentId) for (const s of next.servers) if (s.cars.some((x) => x.carId === c.contentId) || s.tracks.some((x) => x.trackId === c.contentId)) if (!serverIds.includes(s.id)) serverIds.push(s.id);
  const summary = changes.map((c) => c.text);
  const shown = summary.slice(0, MAX_SUMMARY); if (summary.length > MAX_SUMMARY) shown.push(`…and ${summary.length - MAX_SUMMARY} more change${summary.length - MAX_SUMMARY === 1 ? '' : 's'}`);
  return { changed: changes.length > 0, changes, summary: shown, serverIds, firstSync: false };
}
