// Catalog ⇄ requirements-bundle adapter. The checker, installer, planner and UI were built (and tested) against
// `SrpBundle`; a verified catalog is converted into one so all of that machinery works unchanged for ANY server
// the owner publishes. Nothing here touches the disk or network.
//
//  catalogToBundle  — catalog → bundle (+ public endpoints, + dev-only LAN defaults). Retired servers are dropped.
//  bundleToCatalog  — the built-in package → a catalog document (used for the offline fallback and for the example file).
import type { SrpBundle, SrpCarRequirement, SrpServerRequirements, SrpTrackRequirement } from '../AcRequirementsChecker';
import type { ReleaseEndpointsFile } from './endpoints';
import type { AcCatalog, CatalogCar, CatalogServer, CatalogTrack, Origin } from './catalogSchema';
import { CATALOG_SCHEMA_ID } from './catalogSchema';

export interface AdaptedCatalog {
  bundle: SrpBundle;
  release: ReleaseEndpointsFile;
  /** Development catalogs only: a LAN address offered as a default for testing. Never present for production. */
  lanDefaults: Record<string, { host: string }>;
  serverStatus: Record<string, 'active' | 'maintenance' | 'retired'>;
  notices: string[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'item';
const BASE = 'ac_base_game';

function sourceIdOf(kind: 'car' | 'track', id: string, o: Origin): string {
  switch (o.kind) {
    case 'archive': return o.archiveId;
    case 'base-game': return BASE;
    case 'dlc': return `dlc:${slug(o.name)}`;
    default: return `manual:${kind}:${id}`;
  }
}

export function catalogToBundle(cat: AcCatalog, base: SrpBundle): AdaptedCatalog {
  const notices: string[] = [];
  const sources: SrpBundle['sources']['sources'] = [];
  const have = new Set<string>();
  const addSource = (s: SrpBundle['sources']['sources'][number]) => { if (!have.has(s.sourceId)) { have.add(s.sourceId); sources.push(s); } };

  for (const a of cat.archives) {
    const authorised = !!a.url && a.redistribution !== 'none';
    addSource({
      sourceId: a.id, name: a.name, homepage: a.provider.homepage, officialDirectUrl: a.url ?? undefined,
      directUrlStatus: authorised ? 'AUTHORISED by the content owner (signed catalog)' : (a.url ? 'not authorised for automatic download' : 'manual download'),
      redistribution: a.redistribution, localArchive: { bytes: a.bytes, sha256: a.sha256 },
      allowedHosts: a.allowedHosts, authorizedDownload: authorised, fileName: a.fileName, kind: 'archive',
    });
  }
  const external = (kind: 'car' | 'track', id: string, o: Origin, name: string) => {
    const sid = sourceIdOf(kind, id, o);
    if (o.kind === 'base-game') addSource({ sourceId: BASE, name: 'Assetto Corsa (Kunos) base game', redistribution: 'proprietary - never bundle', kind: 'base-game' });
    else if (o.kind === 'dlc') addSource({ sourceId: sid, name: o.name, redistribution: 'proprietary - never bundle', kind: 'dlc' });
    else if (o.kind === 'manual') addSource({ sourceId: sid, name, homepage: o.homepage, redistribution: 'none', kind: 'manual', instructions: o.instructions });
    return sid;
  };

  const carDef = new Map<string, CatalogCar>(cat.content.cars.map((c) => [c.id, c]));
  const trackDef = new Map<string, CatalogTrack>(cat.content.tracks.map((t) => [t.id, t]));
  const carSource = new Map<string, string>(); for (const c of cat.content.cars) carSource.set(c.id, external('car', c.id, c.origin, c.name));
  const trackSource = new Map<string, string>(); for (const t of cat.content.tracks) trackSource.set(t.id, external('track', t.id, t.origin, t.name));

  const tracks: SrpBundle['tracks']['tracks'] = cat.content.tracks.map((t) => ({
    id: t.id, name: t.name, version: t.version,
    markerFileSha256: t.verify?.markerSha256 ?? '', markerFileName: t.verify?.markerFile,
    layouts: t.layouts.map((l) => ({ config: l.config, uiTrackJsonSha256: l.uiTrackJsonSha256 ?? '' })),
    source: { sourceId: trackSource.get(t.id)! },
    archivePath: t.origin.kind === 'archive' ? t.origin.path : undefined,
    external: t.origin.kind === 'archive' ? undefined : (t.origin.kind === 'base-game' ? 'base-game' : t.origin.kind === 'dlc' ? 'dlc' : 'manual'),
  }));

  const release: ReleaseEndpointsFile = { servers: {} };
  const lanDefaults: AdaptedCatalog['lanDefaults'] = {};
  const serverStatus: AdaptedCatalog['serverStatus'] = {};
  const servers: SrpServerRequirements[] = [];

  for (const s of cat.servers) {
    serverStatus[s.id] = s.status ?? 'active';
    if (s.status === 'retired') continue;
    const pub = s.connection.public; const lan = s.connection.lan;
    const gamePort = pub?.gamePort ?? s.connection.ports?.gamePort ?? lan?.gamePort;
    const httpPort = pub?.httpPort ?? s.connection.ports?.httpPort ?? lan?.httpPort;
    release.servers[s.id] = { host: pub?.host ?? null, tcpPort: pub?.gamePort ?? null, httpPort: pub?.httpPort ?? null };
    if (cat.catalog.environment === 'development' && lan) lanDefaults[s.id] = { host: lan.host };

    const trackReqs: SrpTrackRequirement[] = s.tracks.map((t) => {
      const def = trackDef.get(t.trackId)!;
      const first = def.layouts.find((l) => l.config === t.layouts[0]);
      return {
        id: t.trackId, layout: t.layouts[0], version: def.version, source: trackSource.get(t.trackId)!, name: def.name,
        layoutName: first?.name ? `${def.name} - ${first.name}` : def.name, extraLayouts: t.layouts.slice(1),
        optional: t.required === false ? true : undefined,
      };
    });
    const cars: SrpCarRequirement[] = s.cars.map((c) => {
      const def = carDef.get(c.carId)!;
      return {
        id: c.carId, name: def.name, version: def.version, role: c.role,
        requirement: c.required === false ? 'optional' : 'required-to-join', source: carSource.get(c.carId)!,
        skinsPinnedByEntryList: c.skins, identity: { dataAcdSha256: def.identity.dataAcdSha256, uiCarJsonSha256: def.identity.uiCarJsonSha256 },
        archivePath: def.origin.kind === 'archive' ? def.origin.path : undefined,
      };
    });
    const csp = s.requirements.csp;
    const withBoard = (s.companionApps ?? []).includes('srp_board');
    servers.push({
      schemaVersion: cat.schemaVersion,
      server: {
        id: s.id, displayName: s.displayName, type: s.engine.type,
        game: gamePort && httpPort ? { udpPort: gamePort, tcpPort: gamePort, httpPort } : undefined,
        maxPlayers: s.maxPlayers, ai: s.ai,
        connection: { publicHost: pub?.host ?? null, publicPort: gamePort ?? 0 },
      },
      track: trackReqs[0], extraTracks: trackReqs.slice(1),
      cars,
      csp: csp ? { required: csp.required, minimumVersion: csp.minimumVersion, testedVersion: csp.testedVersion ?? '' } : { required: false, minimumVersion: '0.0.0', testedVersion: '', none: true },
      hud: { delivery: s.hud?.delivery ?? 'none', playerInstall: false, version: s.hud?.version ?? '0' },
      companionApps: withBoard ? [{
        id: 'srp_board', version: base.boardRelease.version, requirement: 'optional', installDestination: 'apps/lua/srp_board',
        conflictsWith: ['apps/lua/srp_hud'], stampServerEntry: { host: pub?.host ?? null, tcpPort: gamePort ?? 0 },
      }] : [],
    });
    if (s.status === 'maintenance') notices.push(`${s.displayName} is in maintenance.`);
  }
  if (cat.notice) notices.push(cat.notice);
  return { bundle: { servers, tracks: { tracks }, sources: { sources }, boardRelease: base.boardRelease }, release, lanDefaults, serverStatus, notices };
}

/**
 * The built-in package as a catalog document. `example: true` marks it as NOT live data (the validator refuses it),
 * so it can be published as docs/examples without anyone mistaking it for the real thing.
 */
export function bundleToCatalog(bundle: SrpBundle, opts: { generatedAt: string; revision?: number; example?: boolean } = { generatedAt: new Date(0).toISOString() }): AcCatalog {
  const archives = bundle.sources.sources.filter((s) => s.localArchive).map((s) => ({
    id: s.sourceId, name: s.name, fileName: (() => { try { return decodeURIComponent(new URL(s.officialDirectUrl ?? '').pathname.split('/').pop() || `${s.sourceId}.7z`); } catch { return `${s.sourceId}.7z`; } })(),
    format: '7z' as const, bytes: s.localArchive!.bytes, sha256: s.localArchive!.sha256, url: null as string | null,
    allowedHosts: [] as string[], provider: { name: s.name, homepage: s.homepage ?? 'https://example.com' }, redistribution: 'none' as const,
  }));
  const archiveIds = new Set(archives.map((a) => a.id));
  const origin = (sourceId: string, name: string): Origin => archiveIds.has(sourceId) ? { kind: 'archive', archiveId: sourceId } : sourceId === BASE ? { kind: 'base-game' } : { kind: 'manual', instructions: `Get "${name}" from its official source.` };
  const carMap = new Map<string, CatalogCar>();
  for (const sv of bundle.servers) for (const c of sv.cars) if (!carMap.has(c.id)) carMap.set(c.id, { id: c.id, name: c.name ?? c.id, version: c.version, origin: origin(c.source, c.name ?? c.id), identity: { dataAcdSha256: c.identity.dataAcdSha256, uiCarJsonSha256: c.identity.uiCarJsonSha256 } });
  const tracks: CatalogTrack[] = bundle.tracks.tracks.map((t) => ({
    id: t.id, name: (t as { name?: string }).name ?? t.id, version: t.version, origin: origin(t.source.sourceId, t.id),
    verify: t.markerFileSha256 ? { markerFile: t.markerFileName ?? `${t.version} Stable.txt`, markerSha256: t.markerFileSha256 } : null,
    layouts: t.layouts.map((l) => ({ config: l.config, uiTrackJsonSha256: l.uiTrackJsonSha256 || null })),
  }));
  const servers: CatalogServer[] = bundle.servers.map((sv) => ({
    id: sv.server.id, displayName: sv.server.displayName,
    engine: { type: (sv.server.type as CatalogServer['engine']['type']) },
    maxPlayers: sv.server.maxPlayers, ai: sv.server.ai,
    connection: { public: null, ports: sv.server.game ? { gamePort: sv.server.game.tcpPort, httpPort: sv.server.game.httpPort } : undefined },
    tracks: [{ trackId: sv.track.id, layouts: [sv.track.layout, ...(sv.track.extraLayouts ?? [])] }],
    cars: sv.cars.map((c) => ({ carId: c.id, role: (c.role === 'traffic' ? 'traffic' : 'player') as 'player' | 'traffic', required: c.requirement !== 'optional', skins: (c.skinsPinnedByEntryList ?? []).filter(Boolean).length ? (c.skinsPinnedByEntryList ?? []).filter(Boolean) : undefined })),
    requirements: { csp: sv.csp.none ? null : { required: sv.csp.required, minimumVersion: sv.csp.minimumVersion, testedVersion: sv.csp.testedVersion || undefined } },
    hud: { delivery: sv.hud.delivery === 'server-csp-online-script' ? 'server-csp-online-script' : 'none', version: sv.hud.version },
    companionApps: sv.companionApps.map((a) => a.id),
  }));
  return {
    schema: CATALOG_SCHEMA_ID, schemaVersion: '1.0.0',
    catalog: { id: 'builtin-package', revision: opts.revision ?? 0, generatedAt: opts.generatedAt, environment: 'production' },
    ...(opts.example ? { example: true, notice: 'EXAMPLE ONLY — generated from the launcher\'s built-in package, not from a live server. Not verified; never accepted as live data.' } : {}),
    servers, content: { cars: [...carMap.values()], tracks }, archives,
  };
}
