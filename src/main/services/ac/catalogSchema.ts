// The Mercy Assetto Corsa server catalog (schema v1.x): types + a strict, dependency-free validator.
// The authoritative human-readable spec is docs/ASSETTO_CORSA_CATALOG_CONTRACT.md. A catalog is UNTRUSTED INPUT:
// the validator rejects anything malformed, unsafe or inconsistent instead of trying to repair it, and returns
// either a fully-typed catalog or a list of reasons — never a half-valid object.
import { classifyHost } from '../AcRequirementsChecker';

export const CATALOG_SCHEMA_ID = 'mercy.ac.catalog';
export const SUPPORTED_MAJOR = 1;

/** Hard limits — a catalog bigger than this is refused outright. */
export const LIMITS = {
  maxServers: 50, maxCars: 2000, maxTracks: 200, maxArchives: 100, maxLayoutsPerTrack: 64, maxSkinsPerCar: 64,
  maxString: 4000, maxArchiveBytes: 16 * 1024 ** 3, maxCatalogBytes: 2 * 1024 * 1024, maxAllowedHosts: 10, maxErrors: 100,
} as const;

export type Origin =
  | { kind: 'archive'; archiveId: string; path?: string }
  | { kind: 'base-game' }
  | { kind: 'dlc'; name: string }
  | { kind: 'manual'; homepage?: string; instructions: string };

export interface CatalogCar { id: string; name: string; version: string | null; origin: Origin; identity: { dataAcdSha256: string | null; uiCarJsonSha256: string | null } }
export interface CatalogLayout { config: string; name?: string; uiTrackJsonSha256?: string | null }
export interface CatalogTrack { id: string; name: string; version: string; origin: Origin; verify: { markerFile: string; markerSha256: string } | null; layouts: CatalogLayout[] }
export interface CatalogArchive {
  id: string; name: string; fileName: string; format: '7z' | 'zip'; bytes: number; sha256: string; url: string | null;
  allowedHosts: string[]; provider: { name: string; homepage: string }; redistribution: 'provider-official' | 'owner-authorized' | 'none';
}
export interface CatalogEndpoint { host: string; gamePort: number; httpPort: number }
export interface CatalogServer {
  id: string; displayName: string; description?: string;
  engine: { type: 'kunos-stock' | 'assettoserver' | 'other'; version?: string };
  maxPlayers?: number; ai?: { enabled: boolean; trafficCars: number }; passwordRequired?: boolean;
  connection: { public: CatalogEndpoint | null; /** Ports to use when no public host exists yet (e.g. for a LAN test). */ ports?: { gamePort: number; httpPort: number }; lan?: CatalogEndpoint };
  tracks: { trackId: string; layouts: string[]; required?: boolean }[];
  cars: { carId: string; role: 'player' | 'traffic'; required?: boolean; skins?: string[] }[];
  requirements: { csp: { required: boolean; minimumVersion: string; testedVersion?: string } | null };
  hud?: { delivery: 'none' | 'server-csp-online-script'; version: string };
  companionApps?: string[];
  status?: 'active' | 'maintenance' | 'retired';
}
export interface AcCatalog {
  schema: typeof CATALOG_SCHEMA_ID; schemaVersion: string;
  catalog: { id: string; revision: number; generatedAt: string; expiresAt?: string; environment: 'production' | 'development' };
  notice?: string; example?: boolean;
  servers: CatalogServer[]; content: { cars: CatalogCar[]; tracks: CatalogTrack[] }; archives: CatalogArchive[];
}

export type ValidationResult =
  | { ok: true; catalog: AcCatalog; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** The only companion apps the launcher can install (embedded, vetted). Any other id is ignored. */
export const KNOWN_COMPANION_APPS = ['srp_board'];

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SEG_RE = /^[A-Za-z0-9_.\-][A-Za-z0-9_.\- ]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HOST_RE = /^[A-Za-z0-9.\-]{1,253}$/;
const VERSION_RE = /^\d+(\.\d+){1,3}$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const validIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));
export const isSafeSegment = (s: string) => s !== '.' && s !== '..' && SEG_RE.test(s);
/** A relative path inside an archive: no leading slash, drive letter, backslash, colon, empty or dot segments. */
export const isSafeRelPath = (p: string) => p.length > 0 && p.length <= 300 && !p.startsWith('/') && !/[\\:\0]/.test(p) && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');

/** Is this string / host something that must never appear in a PRODUCTION catalog? */
export function isPrivateOrLocalString(s: string): boolean {
  if (/\blocalhost\b/i.test(s)) return true;
  if (/(^|[^A-Za-z0-9-])[A-Za-z0-9-]+\.local\b/i.test(s)) return true;
  if (/(^|[^0-9a-f:])(::1|fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i.test(s)) return true;
  for (const m of s.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) { const k = classifyHost(m[0]); if (k === 'private-lan' || k === 'loopback') return true; }
  return false;
}

function hostOfUrl(u: string): string | null { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } }

export function validateCatalog(raw: unknown): ValidationResult {
  const errors: string[] = []; const warnings: string[] = [];
  const err = (p: string, m: string) => { if (errors.length < LIMITS.maxErrors) errors.push(`${p}: ${m}`); };
  const warn = (p: string, m: string) => { warnings.push(`${p}: ${m}`); };

  if (!isObj(raw)) return { ok: false, errors: ['(root): the catalog must be a JSON object'], warnings };
  if (raw.schema !== CATALOG_SCHEMA_ID) err('schema', `must be "${CATALOG_SCHEMA_ID}"`);
  const sv = typeof raw.schemaVersion === 'string' ? SEMVER_RE.exec(raw.schemaVersion) : null;
  if (!sv) err('schemaVersion', 'must be a semantic version like "1.0.0"');
  else if (+sv[1] !== SUPPORTED_MAJOR) err('schemaVersion', `major version ${sv[1]} is not supported by this launcher (supports ${SUPPORTED_MAJOR}.x) — update Mercy Launcher`);
  if (raw.example === true) err('example', 'this is an EXAMPLE catalog and is never accepted as live data');

  // ── catalog metadata ──────────────────────────────────────────────────────
  const meta = raw.catalog;
  let env: 'production' | 'development' = 'production';
  if (!isObj(meta)) err('catalog', 'missing');
  else {
    if (!(typeof meta.id === 'string' && /^[a-z0-9._-]{1,64}$/.test(meta.id))) err('catalog.id', 'must match [a-z0-9._-]{1,64}');
    if (!isInt(meta.revision, 0, Number.MAX_SAFE_INTEGER)) err('catalog.revision', 'must be a non-negative integer');
    if (!validIso(meta.generatedAt)) err('catalog.generatedAt', 'must be an ISO-8601 UTC timestamp');
    if (meta.expiresAt !== undefined) { if (!validIso(meta.expiresAt)) err('catalog.expiresAt', 'must be an ISO-8601 UTC timestamp'); else if (validIso(meta.generatedAt) && Date.parse(meta.expiresAt) <= Date.parse(meta.generatedAt)) err('catalog.expiresAt', 'must be later than generatedAt'); }
    if (meta.environment !== 'production' && meta.environment !== 'development') err('catalog.environment', 'must be "production" or "development"'); else env = meta.environment;
  }
  if (raw.notice !== undefined && !(typeof raw.notice === 'string' && raw.notice.length <= 2000)) err('notice', 'must be a string up to 2000 characters');

  const serversRaw = Array.isArray(raw.servers) ? raw.servers : (err('servers', 'must be an array'), []);
  const carsRaw = isObj(raw.content) && Array.isArray(raw.content.cars) ? raw.content.cars : (err('content.cars', 'must be an array'), []);
  const tracksRaw = isObj(raw.content) && Array.isArray(raw.content.tracks) ? raw.content.tracks : (err('content.tracks', 'must be an array'), []);
  const archivesRaw = Array.isArray(raw.archives) ? raw.archives : (err('archives', 'must be an array'), []);
  if (serversRaw.length > LIMITS.maxServers) err('servers', `too many (max ${LIMITS.maxServers})`);
  if (carsRaw.length > LIMITS.maxCars) err('content.cars', `too many (max ${LIMITS.maxCars})`);
  if (tracksRaw.length > LIMITS.maxTracks) err('content.tracks', `too many (max ${LIMITS.maxTracks})`);
  if (archivesRaw.length > LIMITS.maxArchives) err('archives', `too many (max ${LIMITS.maxArchives})`);
  if (errors.length) return { ok: false, errors, warnings };

  // ── archives ──────────────────────────────────────────────────────────────
  const archiveIds = new Set<string>();
  archivesRaw.forEach((a: any, i: number) => {
    const p = `archives[${i}]`;
    if (!isObj(a)) return err(p, 'must be an object');
    if (!(typeof a.id === 'string' && ID_RE.test(a.id))) err(`${p}.id`, 'invalid id'); else if (archiveIds.has(a.id)) err(`${p}.id`, `duplicate archive id "${a.id}"`); else archiveIds.add(a.id);
    if (!isStr(a.name)) err(`${p}.name`, 'required');
    if (!(typeof a.fileName === 'string' && isSafeSegment(a.fileName) && !/[\\/]/.test(a.fileName))) err(`${p}.fileName`, 'must be a plain file name (no path)');
    if (a.format !== '7z' && a.format !== 'zip') err(`${p}.format`, 'must be "7z" or "zip"');
    if (!isInt(a.bytes, 1, LIMITS.maxArchiveBytes)) err(`${p}.bytes`, `must be an integer from 1 to ${LIMITS.maxArchiveBytes} (16 GiB)`);
    if (!(typeof a.sha256 === 'string' && HEX64.test(a.sha256))) err(`${p}.sha256`, 'must be 64 lowercase hex characters');
    if (!(isObj(a.provider) && isStr(a.provider.name) && typeof a.provider.homepage === 'string' && /^https:\/\//i.test(a.provider.homepage))) err(`${p}.provider`, 'needs a name and an https homepage');
    if (!['provider-official', 'owner-authorized', 'none'].includes(a.redistribution)) err(`${p}.redistribution`, 'must be provider-official, owner-authorized or none');
    const hosts = Array.isArray(a.allowedHosts) ? a.allowedHosts : (err(`${p}.allowedHosts`, 'must be an array'), []);
    if (hosts.length > LIMITS.maxAllowedHosts) err(`${p}.allowedHosts`, `too many (max ${LIMITS.maxAllowedHosts})`);
    hosts.forEach((h: any, j: number) => { if (!(typeof h === 'string' && HOST_RE.test(h) && !h.includes('*'))) err(`${p}.allowedHosts[${j}]`, 'must be a plain host name (no scheme, port or wildcard)'); });
    if (a.url === null) { /* manual: fine */ }
    else if (typeof a.url !== 'string') err(`${p}.url`, 'must be a string or null');
    else {
      const h = hostOfUrl(a.url); const isHttps = /^https:\/\//i.test(a.url);
      const devLocal = env === 'development' && /^http:\/\//i.test(a.url) && !!h && (classifyHost(h) === 'private-lan' || classifyHost(h) === 'loopback');
      if (!h) err(`${p}.url`, 'is not a valid URL');
      else if (!isHttps && !devLocal) err(`${p}.url`, 'must be https (plain http is accepted only for private hosts in a development catalog)');
      else if (!hosts.some((x: any) => typeof x === 'string' && x.toLowerCase() === h)) err(`${p}.url`, `host "${h}" is not listed in allowedHosts`);
      if (a.redistribution === 'none') warn(p, 'has a url but redistribution is "none": the launcher will NOT download it automatically');
    }
  });

  // ── content ───────────────────────────────────────────────────────────────
  const checkOrigin = (p: string, o: any, kindOfContentId: string) => {
    if (!isObj(o)) return err(`${p}.origin`, 'required');
    switch (o.kind) {
      case 'archive':
        if (!(typeof o.archiveId === 'string' && archiveIds.has(o.archiveId))) err(`${p}.origin.archiveId`, `references unknown archive "${String(o.archiveId)}"`);
        if (o.path !== undefined && !(typeof o.path === 'string' && isSafeRelPath(o.path))) err(`${p}.origin.path`, 'unsafe path (no "..", absolute paths, backslashes or colons)');
        break;
      case 'base-game': break;
      case 'dlc': if (!isStr(o.name)) err(`${p}.origin.name`, 'required'); break;
      case 'manual':
        if (!isStr(o.instructions, 2000)) err(`${p}.origin.instructions`, 'required');
        if (o.homepage !== undefined && !(typeof o.homepage === 'string' && /^https:\/\//i.test(o.homepage))) err(`${p}.origin.homepage`, 'must be an https URL');
        break;
      default: err(`${p}.origin.kind`, `must be archive, base-game, dlc or manual (content ${kindOfContentId})`);
    }
  };
  const hexOrNull = (p: string, v: any) => { if (v !== null && v !== undefined && !(typeof v === 'string' && HEX64.test(v))) err(p, 'must be null or 64 lowercase hex characters'); };

  const carIds = new Set<string>(); const carById = new Map<string, any>();
  carsRaw.forEach((c: any, i: number) => {
    const p = `content.cars[${i}]`;
    if (!isObj(c)) return err(p, 'must be an object');
    if (!(typeof c.id === 'string' && isSafeSegment(c.id) && c.id.length <= 100)) err(`${p}.id`, 'must be a safe folder name'); else if (carIds.has(c.id)) err(`${p}.id`, `duplicate car "${c.id}"`); else { carIds.add(c.id); carById.set(c.id, c); }
    if (!isStr(c.name)) err(`${p}.name`, 'required');
    if (c.version !== null && !(typeof c.version === 'string' && c.version.length >= 1 && c.version.length <= 40)) err(`${p}.version`, 'must be a string or null');
    checkOrigin(p, c.origin, String(c.id));
    if (!isObj(c.identity)) err(`${p}.identity`, 'required'); else { hexOrNull(`${p}.identity.dataAcdSha256`, c.identity.dataAcdSha256); hexOrNull(`${p}.identity.uiCarJsonSha256`, c.identity.uiCarJsonSha256); }
    if (isObj(c.origin) && c.origin.kind === 'archive' && isObj(c.identity) && !c.identity.dataAcdSha256) warn(p, 'is installed from an archive but has no dataAcdSha256 — its physics cannot be verified');
  });

  const trackIds = new Set<string>(); const trackById = new Map<string, any>();
  tracksRaw.forEach((t: any, i: number) => {
    const p = `content.tracks[${i}]`;
    if (!isObj(t)) return err(p, 'must be an object');
    if (!(typeof t.id === 'string' && isSafeSegment(t.id) && t.id.length <= 100)) err(`${p}.id`, 'must be a safe folder name'); else if (trackIds.has(t.id)) err(`${p}.id`, `duplicate track "${t.id}"`); else { trackIds.add(t.id); trackById.set(t.id, t); }
    if (!isStr(t.name)) err(`${p}.name`, 'required');
    if (!isStr(t.version, 40)) err(`${p}.version`, 'required');
    checkOrigin(p, t.origin, String(t.id));
    if (t.verify !== null) {
      if (!isObj(t.verify)) err(`${p}.verify`, 'must be an object or null');
      else { if (!(typeof t.verify.markerFile === 'string' && isSafeSegment(t.verify.markerFile) && !/[\\/]/.test(t.verify.markerFile))) err(`${p}.verify.markerFile`, 'must be a plain file name'); if (!(typeof t.verify.markerSha256 === 'string' && HEX64.test(t.verify.markerSha256))) err(`${p}.verify.markerSha256`, 'must be 64 lowercase hex characters'); }
    }
    if (!Array.isArray(t.layouts) || t.layouts.length < 1) err(`${p}.layouts`, 'needs at least one layout'); else {
      if (t.layouts.length > LIMITS.maxLayoutsPerTrack) err(`${p}.layouts`, 'too many layouts');
      const seen = new Set<string>();
      t.layouts.forEach((l: any, j: number) => {
        if (!isObj(l) || typeof l.config !== 'string' || (l.config !== '' && !isSafeSegment(l.config))) return err(`${p}.layouts[${j}].config`, 'must be a safe folder name, or "" for the default layout');
        if (seen.has(l.config)) err(`${p}.layouts[${j}].config`, `duplicate layout "${l.config}"`); seen.add(l.config);
        hexOrNull(`${p}.layouts[${j}].uiTrackJsonSha256`, l.uiTrackJsonSha256);
      });
    }
  });

  // ── servers ───────────────────────────────────────────────────────────────
  const serverIds = new Set<string>(); const referencedCars = new Set<string>(); const referencedTracks = new Set<string>();
  const checkEndpoint = (p: string, e: any) => {
    if (!isObj(e)) return err(p, 'must be an object');
    if (!(typeof e.host === 'string' && HOST_RE.test(e.host))) err(`${p}.host`, 'must be a host name or IP address (no scheme or port)');
    if (!isInt(e.gamePort, 1, 65535)) err(`${p}.gamePort`, 'must be 1–65535');
    if (!isInt(e.httpPort, 1, 65535)) err(`${p}.httpPort`, 'must be 1–65535');
  };
  serversRaw.forEach((s: any, i: number) => {
    const p = `servers[${i}]`;
    if (!isObj(s)) return err(p, 'must be an object');
    if (!(typeof s.id === 'string' && ID_RE.test(s.id))) err(`${p}.id`, 'invalid id'); else if (serverIds.has(s.id)) err(`${p}.id`, `duplicate server "${s.id}"`); else serverIds.add(s.id);
    if (!isStr(s.displayName, 100)) err(`${p}.displayName`, 'required (1–100 characters)');
    if (s.description !== undefined && !(typeof s.description === 'string' && s.description.length <= 1000)) err(`${p}.description`, 'must be up to 1000 characters');
    if (!isObj(s.engine) || !['kunos-stock', 'assettoserver', 'other'].includes(s.engine.type)) err(`${p}.engine.type`, 'must be kunos-stock, assettoserver or other');
    if (s.maxPlayers !== undefined && !isInt(s.maxPlayers, 1, 1000)) err(`${p}.maxPlayers`, 'must be 1–1000');
    if (s.ai !== undefined && !(isObj(s.ai) && typeof s.ai.enabled === 'boolean' && isInt(s.ai.trafficCars, 0, 10000))) err(`${p}.ai`, 'must be {enabled, trafficCars}');
    if (!isObj(s.connection) || !('public' in s.connection)) err(`${p}.connection`, 'needs a "public" endpoint object or null');
    else {
      if (s.connection.public !== null) checkEndpoint(`${p}.connection.public`, s.connection.public);
      if (s.connection.ports !== undefined) { const pt = s.connection.ports; if (!(isObj(pt) && isInt(pt.gamePort, 1, 65535) && isInt(pt.httpPort, 1, 65535))) err(`${p}.connection.ports`, 'must be {gamePort, httpPort} (1–65535)'); }
      if (s.connection.lan !== undefined) { if (env !== 'development') err(`${p}.connection.lan`, 'a LAN endpoint is only allowed in a development catalog'); else checkEndpoint(`${p}.connection.lan`, s.connection.lan); }
    }
    if (!Array.isArray(s.tracks) || s.tracks.length < 1) err(`${p}.tracks`, 'needs at least one track'); else s.tracks.forEach((t: any, j: number) => {
      const tp = `${p}.tracks[${j}]`;
      if (!isObj(t) || typeof t.trackId !== 'string') return err(tp, 'needs a trackId');
      const def = trackById.get(t.trackId);
      if (!def) return err(`${tp}.trackId`, `references unknown track "${t.trackId}"`);
      referencedTracks.add(t.trackId);
      if (!Array.isArray(t.layouts) || t.layouts.length < 1) return err(`${tp}.layouts`, 'needs at least one layout');
      t.layouts.forEach((l: any, k: number) => { if (typeof l !== 'string' || !(def.layouts ?? []).some((x: any) => x?.config === l)) err(`${tp}.layouts[${k}]`, `layout "${String(l)}" is not defined by track "${t.trackId}"`); });
      if (t.required !== undefined && typeof t.required !== 'boolean') err(`${tp}.required`, 'must be a boolean');
    });
    if (!Array.isArray(s.cars)) err(`${p}.cars`, 'must be an array'); else {
      if (s.cars.length > LIMITS.maxCars) err(`${p}.cars`, 'too many');
      const seen = new Set<string>();
      s.cars.forEach((c: any, j: number) => {
        const cp = `${p}.cars[${j}]`;
        if (!isObj(c) || typeof c.carId !== 'string') return err(cp, 'needs a carId');
        if (!carById.has(c.carId)) err(`${cp}.carId`, `references unknown car "${c.carId}"`); else referencedCars.add(c.carId);
        if (seen.has(c.carId)) err(`${cp}.carId`, `duplicate car "${c.carId}" on this server`); seen.add(c.carId);
        if (c.role !== 'player' && c.role !== 'traffic') err(`${cp}.role`, 'must be player or traffic');
        if (c.required !== undefined && typeof c.required !== 'boolean') err(`${cp}.required`, 'must be a boolean');
        if (c.skins !== undefined) { if (!Array.isArray(c.skins) || c.skins.length > LIMITS.maxSkinsPerCar || c.skins.some((x: any) => typeof x !== 'string' || !isSafeSegment(x))) err(`${cp}.skins`, 'must be a list of safe skin folder names'); }
      });
    }
    if (!isObj(s.requirements) || !('csp' in s.requirements)) err(`${p}.requirements.csp`, 'required (an object, or null when CSP is not needed)');
    else if (s.requirements.csp !== null) { const c = s.requirements.csp; if (!(isObj(c) && typeof c.required === 'boolean' && typeof c.minimumVersion === 'string' && VERSION_RE.test(c.minimumVersion))) err(`${p}.requirements.csp`, 'needs {required, minimumVersion like "0.1.76"}'); else if (c.testedVersion !== undefined && !(typeof c.testedVersion === 'string' && c.testedVersion.length <= 40)) err(`${p}.requirements.csp.testedVersion`, 'must be a short string'); }
    if (s.hud !== undefined && !(isObj(s.hud) && ['none', 'server-csp-online-script'].includes(s.hud.delivery) && isStr(s.hud.version, 40))) err(`${p}.hud`, 'must be {delivery: none|server-csp-online-script, version}');
    if (s.companionApps !== undefined) { if (!Array.isArray(s.companionApps) || s.companionApps.some((x: any) => typeof x !== 'string')) err(`${p}.companionApps`, 'must be a list of app ids'); else for (const a of s.companionApps) if (!KNOWN_COMPANION_APPS.includes(a)) warn(`${p}.companionApps`, `"${a}" is not a built-in app the launcher can install; it is ignored`); }
    if (s.status !== undefined && !['active', 'maintenance', 'retired'].includes(s.status)) err(`${p}.status`, 'must be active, maintenance or retired');
  });

  for (const a of archivesRaw) if (isObj(a) && typeof a.id === 'string' && ![...carsRaw, ...tracksRaw].some((c: any) => isObj(c?.origin) && c.origin.kind === 'archive' && c.origin.archiveId === a.id)) warn(`archives[${a.id}]`, 'is not used by any car or track');
  for (const id of carIds) if (!referencedCars.has(id)) warn(`content.cars[${id}]`, 'is not used by any server');
  for (const id of trackIds) if (!referencedTracks.has(id)) warn(`content.tracks[${id}]`, 'is not used by any server');

  // ── global string hygiene + production LAN-leak scan ──────────────────────
  const walk = (v: any, p: string, depth: number) => {
    if (errors.length >= LIMITS.maxErrors || depth > 12) return;
    if (typeof v === 'string') {
      if (v.length > LIMITS.maxString) err(p, `string longer than ${LIMITS.maxString} characters`);
      else if (env === 'production' && isPrivateOrLocalString(v)) err(p, 'contains a private/loopback/local address — a PRODUCTION catalog must never include one');
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`, depth + 1));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (env === 'production' && isPrivateOrLocalString(k)) err(`${p}.${k}`, 'a key contains a private/loopback/local address'); walk(x, p ? `${p}.${k}` : k, depth + 1); }
  };
  walk(raw, '', 0);

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, catalog: raw as unknown as AcCatalog, warnings };
}
