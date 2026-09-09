// Minecraft content marketplace — a real client for Modrinth's public API
// (https://docs.modrinth.com/), not a fabricated catalog. Modrinth is used
// because its API is public, free, requires no API key for browsing, and
// its projects carry real licensing/attribution metadata Mercy surfaces
// rather than strips. Every network call sends a descriptive User-Agent
// identifying Mercy per Modrinth's own API etiquette
// (https://docs.modrinth.com/api/#rate-limits) — no fake data, no
// invented download source.
//
// Mercy only supports Vanilla and Paper as SERVER TYPES (see
// MinecraftManager.ts's own comment on why Fabric/Forge/NeoForge aren't
// offered as create-server options). That constrains what Marketplace
// content can actually be INSTALLED, independent of what can be BROWSED:
//  - "plugin" projects (paper/spigot/bukkit/purpur) → installable on Paper only.
//  - "datapack" projects → installable on Vanilla or Paper (no mod loader
//    needed at all — datapacks are a vanilla game feature).
//  - "mod" projects (fabric/forge/neoforge) → browsable for reference, but
//    NEVER installable, since Mercy runs neither of those loaders. Dropping
//    a Fabric mod's jar into a Paper/Vanilla server's plugins folder would
//    just be a silently-broken file, so this is refused with a clear reason
//    rather than pretended to work.
//  - resourcepacks/shaders → client-side content; a server doesn't install these.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import type { MinecraftManager, MinecraftServerType, InstalledContent } from './MinecraftManager';

const USER_AGENT = 'mercy1234544/fivem-server-builder/mercy-launcher (github.com/mercy1234544/fivem-server-builder)';

export interface MarketplaceHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  projectType: string;
  categories: string[];
  loaders: string[];
  gameVersions: string[];
  downloads: number;
  iconUrl: string | null;
  license: string | null;
}

export interface MarketplaceVersion {
  id: string;
  versionNumber: string;
  name: string;
  gameVersions: string[];
  loaders: string[];
  datePublished: string;
  files: { url: string; filename: string; primary: boolean; size: number; sha1: string | null }[];
  dependencies: { projectId: string | null; versionId: string | null; dependencyType: string }[];
}

export interface MarketplaceProject {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  author: string;
  projectType: string;
  categories: string[];
  license: { id: string; name: string; url: string | null } | null;
  sourceUrl: string | null;
  websiteUrl: string | null;
  iconUrl: string | null;
  downloads: number;
  gameVersions: string[];
  loaders: string[];
}

export type ContentClassification =
  | { installable: true; kind: 'plugin' | 'datapack' }
  | { installable: false; reason: string };

const PLUGIN_LOADERS = ['paper', 'spigot', 'bukkit', 'purpur'];
const MOD_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];

/** Modrinth's `project_type` field can be a stale/legacy value — many
 *  long-established Bukkit/Paper plugins (EssentialsX among them,
 *  confirmed live against the real API) are still tagged project_type:
 *  "mod" from before Modrinth split out a distinct "plugin" type, even
 *  though their real, current `loaders` correctly list paper/spigot/bukkit.
 *  What a server can actually run is determined by LOADERS, not by that
 *  label, so loaders are checked first and are authoritative; project_type
 *  is only a fallback for projects with no loaders at all (datapacks,
 *  resourcepacks, shaders don't carry mod-loader-shaped loaders). */
export function classifyForServer(projectType: string, loaders: string[], serverType: MinecraftServerType): ContentClassification {
  if (projectType === 'datapack') return { installable: true, kind: 'datapack' }; // no mod loader needed — a vanilla game feature

  const hasPluginLoader = loaders.some((l) => PLUGIN_LOADERS.includes(l));
  const hasModLoader = loaders.some((l) => MOD_LOADERS.includes(l));

  if (hasPluginLoader) {
    if (serverType !== 'paper') return { installable: false, reason: 'This is a Paper/Spigot/Bukkit plugin — this server is Vanilla, which has no plugin support at all.' };
    return { installable: true, kind: 'plugin' };
  }
  if (hasModLoader) {
    const named = loaders.filter((l) => MOD_LOADERS.includes(l)).join('/');
    return { installable: false, reason: `This requires a ${named || 'Fabric/Forge/NeoForge'} server. Mercy currently only supports Vanilla and Paper servers, and cannot run mods on either.` };
  }
  if (projectType === 'plugin') {
    if (serverType !== 'paper') return { installable: false, reason: 'Plugins require a Paper server — this server is Vanilla, which has no plugin support at all.' };
    return { installable: true, kind: 'plugin' };
  }
  if (projectType === 'mod') {
    return { installable: false, reason: 'This is a mod, which requires a Fabric/Forge/NeoForge server. Mercy currently only supports Vanilla and Paper servers, and cannot run mods on either.' };
  }
  return { installable: false, reason: `${projectType || 'This content'} is client-side content — it isn't something a server installs.` };
}

/** Best-effort display label — prefers Modrinth's own `all_project_types`
 *  (search results only) when present, else infers from loaders, else
 *  falls back to the raw (possibly stale) `project_type`. Purely cosmetic;
 *  classifyForServer() above never trusts this and re-derives from loaders. */
function displayProjectType(projectType: string, loaders: string[], allProjectTypes?: string[]): string {
  if (allProjectTypes?.length) {
    for (const preferred of ['plugin', 'datapack', 'resourcepack', 'shader', 'mod']) {
      if (allProjectTypes.includes(preferred)) return preferred;
    }
  }
  if (loaders.some((l) => PLUGIN_LOADERS.includes(l))) return 'plugin';
  if (loaders.some((l) => MOD_LOADERS.includes(l))) return 'mod';
  return projectType;
}

export class MinecraftMarketplace {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: 'https://api.modrinth.com/v2',
      timeout: 15000,
      headers: { 'User-Agent': USER_AGENT },
    });
  }

  async search(opts: { query?: string; projectType?: string; minecraftVersion?: string; loader?: string; limit?: number; offset?: number }): Promise<{ hits: MarketplaceHit[]; total: number }> {
    const facets: string[][] = [];
    if (opts.projectType) facets.push([`project_type:${opts.projectType}`]);
    if (opts.minecraftVersion) facets.push([`versions:${opts.minecraftVersion}`]);
    if (opts.loader) facets.push([`categories:${opts.loader}`]);
    const res = await this.http.get('/search', {
      params: {
        query: opts.query || '',
        limit: opts.limit ?? 20,
        offset: opts.offset ?? 0,
        index: opts.query ? 'relevance' : 'downloads',
        facets: facets.length ? JSON.stringify(facets) : undefined,
      },
    });
    const hits: MarketplaceHit[] = (res.data.hits || []).map((h: any) => {
      const loaders = (h.display_categories || h.categories || []).filter((c: string) => LOADER_NAMES.has(c));
      return {
        projectId: h.project_id, slug: h.slug, title: h.title, description: h.description,
        author: h.author, projectType: displayProjectType(h.project_type, loaders, h.all_project_types), categories: h.categories || [],
        loaders, gameVersions: h.versions || [], downloads: h.downloads || 0,
        iconUrl: h.icon_url || null, license: h.license || null,
      };
    });
    return { hits, total: res.data.total_hits || hits.length };
  }

  async getProject(projectId: string): Promise<MarketplaceProject> {
    const res = await this.http.get(`/project/${encodeURIComponent(projectId)}`);
    const p = res.data;
    const loaders = p.loaders || [];
    return {
      projectId: p.id, slug: p.slug, title: p.title, description: p.description, body: p.body || '',
      author: p.team || '', projectType: displayProjectType(p.project_type, loaders), categories: p.categories || [],
      license: p.license ? { id: p.license.id, name: p.license.name, url: p.license.url || null } : null,
      sourceUrl: p.source_url || null, websiteUrl: p.wiki_url || p.discord_url || null,
      iconUrl: p.icon_url || null, downloads: p.downloads || 0,
      gameVersions: p.game_versions || [], loaders,
    };
  }

  async getVersions(projectId: string, opts: { minecraftVersion?: string; loader?: string } = {}): Promise<MarketplaceVersion[]> {
    const params: any = {};
    if (opts.minecraftVersion) params.game_versions = JSON.stringify([opts.minecraftVersion]);
    if (opts.loader) params.loaders = JSON.stringify([opts.loader]);
    const res = await this.http.get(`/project/${encodeURIComponent(projectId)}/version`, { params });
    return (res.data || []).map(mapVersion);
  }

  async getVersion(versionId: string): Promise<MarketplaceVersion> {
    const res = await this.http.get(`/version/${encodeURIComponent(versionId)}`);
    return mapVersion(res.data);
  }

  /** Bulk-resolves dependency project IDs to real names via Modrinth's
   *  batch endpoint (one call instead of N), so the UI never shows a bare
   *  opaque project ID for a dependency. */
  async resolveDependencyNames(deps: { projectId: string | null; versionId: string | null; dependencyType: string }[]): Promise<{ projectId: string; projectName: string; dependencyType: string }[]> {
    const ids = deps.map((d) => d.projectId).filter((id): id is string => !!id);
    if (ids.length === 0) return [];
    try {
      const res = await this.http.get('/projects', { params: { ids: JSON.stringify(ids) } });
      const names = new Map<string, string>((res.data || []).map((p: any) => [p.id, p.title]));
      return deps.filter((d) => d.projectId).map((d) => ({ projectId: d.projectId!, projectName: names.get(d.projectId!) || d.projectId!, dependencyType: d.dependencyType }));
    } catch {
      return deps.filter((d) => d.projectId).map((d) => ({ projectId: d.projectId!, projectName: d.projectId!, dependencyType: d.dependencyType }));
    }
  }

  private async downloadFile(url: string, destPath: string, onProgress?: (pct: number) => void): Promise<void> {
    const res = await axios.get(url, { responseType: 'stream', timeout: 30000, headers: { 'User-Agent': USER_AGENT } });
    const total = parseInt(String(res.headers['content-length'] || '0'), 10);
    let received = 0;
    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(destPath);
      res.data.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (onProgress && total) onProgress(Math.round((received / total) * 100));
      });
      res.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
      res.data.on('error', reject);
    });
  }

  private sha1File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha1');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private activeRelDir(mgr: MinecraftManager, serverId: string, kind: 'plugin' | 'datapack'): string {
    return kind === 'plugin' ? 'plugins' : path.join(mgr.getLevelName(serverId), 'datapacks');
  }

  /** The full real install flow: resolve compatibility → download the real
   *  file → verify its hash → place it in the correct directory → track it.
   *  Never overwrites a file it didn't itself install. */
  async installContent(
    mgr: MinecraftManager, serverId: string, projectId: string, versionId: string,
    onProgress?: (pct: number, message: string) => void,
  ): Promise<{ success: boolean; error?: string; content?: InstalledContent }> {
    const server = mgr.getServer(serverId);
    if (!server) return { success: false, error: 'Server not found.' };

    onProgress?.(5, 'Checking compatibility…');
    const [project, version] = await Promise.all([this.getProject(projectId), this.getVersion(versionId)]);
    const classification = classifyForServer(project.projectType, version.loaders, server.serverType);
    if (!classification.installable) return { success: false, error: classification.reason };

    if (server.version && server.version !== 'unknown' && version.gameVersions.length && !version.gameVersions.includes(server.version)) {
      return { success: false, error: `"${project.title}" version ${version.versionNumber} does not list Minecraft ${server.version} as supported.` };
    }

    const file = version.files.find((f) => f.primary) || version.files[0];
    if (!file) return { success: false, error: 'This version has no downloadable file.' };

    const relDir = this.activeRelDir(mgr, serverId, classification.kind);
    const relPath = path.join(relDir, file.filename);
    const targetAbs = mgr.resolveWithinServer(serverId, relPath);
    if (!targetAbs) return { success: false, error: 'Could not resolve a safe install location inside this server.' };

    const existing = mgr.getInstalledContent(serverId).find((c) => c.projectId === projectId);
    if (fs.existsSync(targetAbs) && !existing) {
      return { success: false, error: `A file named "${file.filename}" already exists in this server's ${relDir.replace(/\\/g, '/')} folder and wasn't installed by Mercy. Rename or remove it first, then try again.` };
    }

    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    const tmpPath = `${targetAbs}.mercy-download`;
    try {
      onProgress?.(15, `Downloading ${file.filename}…`);
      await this.downloadFile(file.url, tmpPath, (pct) => onProgress?.(15 + Math.round(pct * 0.6), `Downloading ${file.filename}…`));

      onProgress?.(80, 'Verifying download…');
      const actualSha1 = await this.sha1File(tmpPath);
      if (file.sha1 && actualSha1 !== file.sha1) {
        throw new Error(`Downloaded file failed hash verification (expected ${file.sha1}, got ${actualSha1}) — the download may be corrupt or tampered with. Try again.`);
      }

      // A re-install/update: remove the old file first if it lived elsewhere.
      if (existing && existing.relPath !== relPath) {
        const oldAbs = mgr.resolveWithinServer(serverId, existing.relPath);
        if (oldAbs && fs.existsSync(oldAbs)) { try { fs.unlinkSync(oldAbs); } catch {} }
      }
      fs.renameSync(tmpPath, targetAbs);
      onProgress?.(95, 'Recording install…');

      if (existing) mgr.removeInstalledContent(serverId, existing.id);
      const deps = await this.resolveDependencyNames(version.dependencies);
      const record: InstalledContent = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        kind: classification.kind, source: 'modrinth',
        projectId, projectName: project.title, versionId, versionNumber: version.versionNumber,
        fileName: file.filename, relPath, sha1: actualSha1, size: file.size,
        enabled: true, installedAt: new Date().toISOString(), dependencies: deps,
      };
      mgr.addInstalledContent(serverId, record);
      onProgress?.(100, 'Done');
      return { success: true, content: record };
    } catch (e: any) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      return { success: false, error: e?.message || 'Install failed.' };
    }
  }

  listInstalled(mgr: MinecraftManager, serverId: string): (InstalledContent & { missingOnDisk: boolean })[] {
    return mgr.getInstalledContent(serverId).map((c) => {
      const abs = mgr.resolveWithinServer(serverId, c.relPath);
      return { ...c, missingOnDisk: !abs || !fs.existsSync(abs) };
    });
  }

  removeContent(mgr: MinecraftManager, serverId: string, contentId: string): { success: boolean; error?: string } {
    const item = mgr.getInstalledContent(serverId).find((c) => c.id === contentId);
    if (!item) return { success: false, error: 'Content not found.' };
    const abs = mgr.resolveWithinServer(serverId, item.relPath);
    if (abs && fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch (e: any) { return { success: false, error: `Failed to remove file: ${e?.message || 'unknown error'}` }; }
    }
    mgr.removeInstalledContent(serverId, contentId);
    return { success: true };
  }

  async setContentEnabled(mgr: MinecraftManager, serverId: string, contentId: string, enabled: boolean): Promise<{ success: boolean; error?: string }> {
    const item = mgr.getInstalledContent(serverId).find((c) => c.id === contentId);
    if (!item) return { success: false, error: 'Content not found.' };
    if (item.enabled === enabled) return { success: true };
    const activeDir = this.activeRelDir(mgr, serverId, item.kind);
    const targetRelPath = enabled ? path.join(activeDir, item.fileName) : path.join(activeDir, 'mercy-disabled', item.fileName);
    const currentAbs = mgr.resolveWithinServer(serverId, item.relPath);
    const targetAbs = mgr.resolveWithinServer(serverId, targetRelPath);
    if (!currentAbs || !fs.existsSync(currentAbs)) return { success: false, error: 'The installed file is missing from disk — try Refresh.' };
    if (!targetAbs) return { success: false, error: 'Could not resolve a safe target location.' };
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    try { fs.renameSync(currentAbs, targetAbs); } catch (e: any) { return { success: false, error: e?.message || 'Failed to move file.' }; }
    mgr.updateInstalledContent(serverId, contentId, { enabled, relPath: targetRelPath });
    return { success: true };
  }
}

const LOADER_NAMES = new Set(['fabric', 'forge', 'neoforge', 'quilt', 'paper', 'spigot', 'bukkit', 'purpur', 'sponge']);

function mapVersion(v: any): MarketplaceVersion {
  return {
    id: v.id, versionNumber: v.version_number, name: v.name,
    gameVersions: v.game_versions || [], loaders: v.loaders || [], datePublished: v.date_published,
    files: (v.files || []).map((f: any) => ({ url: f.url, filename: f.filename, primary: !!f.primary, size: f.size || 0, sha1: f.hashes?.sha1 || null })),
    dependencies: (v.dependencies || []).map((d: any) => ({ projectId: d.project_id || null, versionId: d.version_id || null, dependencyType: d.dependency_type })),
  };
}
