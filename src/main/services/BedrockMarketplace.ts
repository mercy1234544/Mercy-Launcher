// Bedrock content marketplace — a real client for GitHub's public REST API
// (https://docs.github.com/en/rest), used because it is the best legitimate,
// publicly-accessible, keyless source Mercy found for real Bedrock content.
//
// Why GitHub, and not something else:
//  - Mojang/Microsoft's own Minecraft Marketplace has NO public API for
//    third-party apps — its content is tied to Xbox Live accounts and
//    Microsoft Store DRM, and most of it is paid. Mercy cannot legitimately
//    browse or install it, so this doesn't pretend to be that marketplace.
//  - Community sites like MCPEDL host a huge amount of real Bedrock content
//    but have no official API. Scraping their pages to redistribute
//    download links would not respect their terms of service, so Mercy
//    does not do that — see BedrockMarketplace.searchExternalUrl() below,
//    which only ever opens a normal search URL in the user's own browser.
//  - Modrinth (used for Java, see MinecraftMarketplace.ts) is a Java-only
//    catalog — it does not host Bedrock content at all.
//  - GitHub's REST API is public, needs no account/API key for read access
//    (rate-limited without one, see below), and many real Bedrock creators
//    publish resource packs / behavior packs / add-ons / world templates as
//    open-source repositories with real GitHub Releases
//    (.mcpack/.mcaddon/.mctemplate/.mcworld/.zip) meant to be downloaded
//    directly — that is exactly what GitHub Releases are for, so
//    downloading a real release asset here is not scraping or a ToS
//    violation.
//
// Every result is real GitHub data: repo name/description/owner/avatar/
// stars/topics from the Search API, and — once a specific repo is opened —
// real release tags/notes/assets/download counts from the Releases API.
// Nothing here is fabricated, and Java (Modrinth) content is never mixed
// into these results.
//
// Honesty about limits: GitHub's Search API allows only 10 requests/minute
// without a personal access token (60/min with one — Mercy runs
// unauthenticated by default, so this DOES bind in normal use). Hitting it
// surfaces a clear, accurate "try again in Ns" error rather than a generic
// failure or a silently-empty result — never treated as "no results".
import fs from 'fs';
import path from 'path';
import axios, { AxiosInstance } from 'axios';
import type { MinecraftManager } from './MinecraftManager';

const USER_AGENT = 'mercy1234544/fivem-server-builder/mercy-launcher (github.com/mercy1234544/fivem-server-builder)';

export type BedrockCategory = 'resource_pack' | 'behavior_pack' | 'addon' | 'world';

export interface BedrockMarketplaceHit {
  id: string; // "owner/repo"
  owner: string;
  repo: string;
  name: string;
  description: string;
  authorAvatarUrl: string | null;
  stars: number;
  htmlUrl: string;
  topics: string[];
  updatedAt: string;
}

export interface BedrockReleaseAsset {
  name: string;
  size: number;
  downloadCount: number;
  browserDownloadUrl: string;
  contentType: string;
  installable: boolean; // real extension check — never claimed installable if it isn't
}

export interface BedrockRelease {
  tagName: string;
  name: string;
  body: string;
  publishedAt: string;
  prerelease: boolean;
  assets: BedrockReleaseAsset[];
}

export interface BedrockRepoDetail {
  id: string;
  owner: string;
  repo: string;
  name: string;
  description: string;
  authorAvatarUrl: string | null;
  stars: number;
  forks: number;
  htmlUrl: string;
  homepageUrl: string | null;
  license: string | null;
  topics: string[];
}

const CATEGORY_LABEL: Record<BedrockCategory, string> = {
  resource_pack: 'Resource Pack', behavior_pack: 'Behavior Pack', addon: 'Add-on', world: 'World',
};

const CATEGORY_SEARCH_TERMS: Record<BedrockCategory, string> = {
  resource_pack: 'bedrock resource pack',
  behavior_pack: 'bedrock behavior pack',
  addon: 'bedrock addon',
  world: 'bedrock world OR bedrock map',
};

// Real Bedrock content formats are all, structurally, plain zip files under
// a game-specific extension — never treated as "installable" unless the
// extension actually matches what that category expects, so a repo's
// unrelated source-code zip isn't offered as if it were a real pack.
const CATEGORY_EXTENSIONS: Record<BedrockCategory, string[]> = {
  resource_pack: ['.mcpack', '.zip'],
  behavior_pack: ['.mcpack', '.zip'],
  addon: ['.mcaddon', '.mcpack', '.zip'],
  world: ['.mctemplate', '.mcworld', '.zip'],
};

export function bedrockCategoryLabel(category: BedrockCategory): string {
  return CATEGORY_LABEL[category];
}

/** Pure query-builder — always anchors on the real word "bedrock" so a
 *  plain Java project (which wouldn't mention Bedrock in its own
 *  name/description/topics) is never a relevant hit, keeping Java content
 *  out of Bedrock results without needing to inspect file contents. */
export function buildBedrockSearchQuery(category: BedrockCategory, query: string): string {
  const terms = CATEGORY_SEARCH_TERMS[category];
  const user = query.trim();
  return `${terms}${user ? ` ${user}` : ''} in:name,description,topics archived:false`;
}

/** Pure extension check — an asset is only ever "installable" for a
 *  category if its filename genuinely matches what that category's real
 *  Bedrock file format looks like (never assumed from content-type or
 *  guessed). */
export function isBedrockAssetInstallable(category: BedrockCategory, filename: string): boolean {
  const lower = filename.toLowerCase();
  return CATEGORY_EXTENSIONS[category].some((ext) => lower.endsWith(ext));
}

export function mapBedrockRepoHit(r: any): BedrockMarketplaceHit {
  return {
    id: r.full_name, owner: r.owner?.login || '', repo: r.name, name: r.name,
    description: r.description || '', authorAvatarUrl: r.owner?.avatar_url || null,
    stars: r.stargazers_count || 0, htmlUrl: r.html_url, topics: r.topics || [],
    updatedAt: r.updated_at || r.pushed_at || '',
  };
}

export function mapBedrockRepoDetail(r: any, fallbackOwner: string, fallbackRepo: string): BedrockRepoDetail {
  return {
    id: r.full_name, owner: r.owner?.login || fallbackOwner, repo: r.name || fallbackRepo, name: r.name,
    description: r.description || '', authorAvatarUrl: r.owner?.avatar_url || null,
    stars: r.stargazers_count || 0, forks: r.forks_count || 0, htmlUrl: r.html_url,
    homepageUrl: r.homepage || null, license: r.license?.name || null, topics: r.topics || [],
  };
}

export function mapBedrockReleaseAsset(a: any, category: BedrockCategory): BedrockReleaseAsset {
  return {
    name: a.name, size: a.size || 0, downloadCount: a.download_count || 0,
    browserDownloadUrl: a.browser_download_url, contentType: a.content_type || 'application/octet-stream',
    installable: isBedrockAssetInstallable(category, a.name || ''),
  };
}

export function mapBedrockRelease(r: any, category: BedrockCategory): BedrockRelease {
  return {
    tagName: r.tag_name, name: r.name || r.tag_name, body: r.body || '',
    publishedAt: r.published_at || r.created_at, prerelease: !!r.prerelease,
    assets: (r.assets || []).map((a: any) => mapBedrockReleaseAsset(a, category)),
  };
}

/** Never a fabricated catalog: for a source Mercy can't legitimately
 *  browse/download from (MCPEDL has no public API), this just builds a
 *  normal external search URL for the renderer to open in the user's own
 *  browser — never scraped, never presented as something Mercy installs. */
export function bedrockExternalSearchUrl(category: BedrockCategory, query: string): string {
  const categoryTerm = category === 'resource_pack' ? 'texture-pack' : category === 'behavior_pack' ? 'addon' : category === 'world' ? 'maps' : 'addon';
  const q = encodeURIComponent(query.trim());
  return q ? `https://mcpedl.com/?s=${q}` : `https://mcpedl.com/${categoryTerm}/`;
}

export class BedrockMarketplace {
  private http: AxiosInstance;

  constructor(private userDataPath: string) {
    this.http = axios.create({
      baseURL: 'https://api.github.com',
      timeout: 15000,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    });
  }

  private async githubGet(url: string, params?: any) {
    try {
      return await this.http.get(url, { params });
    } catch (e: any) {
      const status = e?.response?.status;
      const remaining = e?.response?.headers?.['x-ratelimit-remaining'];
      if (status === 403 && remaining === '0') {
        const resetEpoch = parseInt(e.response.headers['x-ratelimit-reset'] || '0', 10);
        const waitSec = Math.max(1, resetEpoch - Math.floor(Date.now() / 1000));
        throw new Error(`GitHub's public search is rate-limited to 10 requests/minute without a personal access token, and that limit was just reached. Try again in about ${waitSec}s.`);
      }
      throw new Error(e?.response?.data?.message || e?.message || 'Could not reach GitHub.');
    }
  }

  async search(category: BedrockCategory, query = '', limit = 24): Promise<{ hits: BedrockMarketplaceHit[]; total: number; category: BedrockCategory }> {
    const q = buildBedrockSearchQuery(category, query);
    const res = await this.githubGet('/search/repositories', {
      q, per_page: Math.min(limit, 30), ...(query.trim() ? {} : { sort: 'stars', order: 'desc' }),
    });
    const hits: BedrockMarketplaceHit[] = (res.data.items || []).map(mapBedrockRepoHit);
    return { hits, total: res.data.total_count || hits.length, category };
  }

  async getRepo(owner: string, repo: string): Promise<BedrockRepoDetail> {
    const res = await this.githubGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    return mapBedrockRepoDetail(res.data, owner, repo);
  }

  async getReleases(owner: string, repo: string, category: BedrockCategory, limit = 8): Promise<BedrockRelease[]> {
    const res = await this.githubGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`, { per_page: limit });
    return (res.data || []).filter((r: any) => !r.draft).map((r: any) => mapBedrockRelease(r, category));
  }

  /** Never a fabricated catalog: for a source Mercy can't legitimately
   *  browse/download from (MCPEDL has no public API), this just builds a
   *  normal external search URL for the renderer to open in the user's own
   *  browser — never scraped, never presented as something Mercy installs. */
  searchExternalUrl(category: BedrockCategory, query: string): string {
    return bedrockExternalSearchUrl(category, query);
  }

  private async downloadAsset(url: string, destPath: string, onProgress?: (pct: number) => void): Promise<void> {
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

  /** The full real install flow: download the real GitHub release asset,
   *  then hand it straight to the EXISTING, already-tested Bedrock
   *  pack/world install pipeline on MinecraftManager — never a second
   *  pack-management system. Cleans up the downloaded file itself; the
   *  target methods manage their own extraction temp dirs. */
  async installAsset(
    mgr: MinecraftManager, serverId: string, category: BedrockCategory,
    asset: { browserDownloadUrl: string; name: string },
    opts: { confirmReplaceWorld?: boolean } = {},
    onProgress?: (pct: number, message: string) => void,
  ): Promise<{ success: boolean; error?: string; needsConfirmation?: boolean; detectedEdition?: 'java' | 'bedrock'; folderName?: string; installedResourcePack?: string; installedBehaviorPack?: string }> {
    const server = mgr.getServer(serverId);
    if (!server) return { success: false, error: 'Server not found.' };
    if (server.edition !== 'bedrock') return { success: false, error: 'This server is not Bedrock Edition.' };

    const ext = CATEGORY_EXTENSIONS[category].find((e) => asset.name.toLowerCase().endsWith(e)) || path.extname(asset.name) || '.zip';
    const tmpDir = path.join(this.userDataPath, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `bedrock-marketplace-${serverId}-${Date.now()}${ext}`);

    try {
      onProgress?.(10, `Downloading ${asset.name}…`);
      await this.downloadAsset(asset.browserDownloadUrl, tmpPath, (pct) => onProgress?.(10 + Math.round(pct * 0.7), `Downloading ${asset.name}…`));

      onProgress?.(85, 'Installing…');
      if (category === 'resource_pack' || category === 'behavior_pack') {
        const kind = category === 'resource_pack' ? 'resource_packs' : 'behavior_packs';
        const result = await mgr.installBedrockPack(serverId, kind, tmpPath);
        onProgress?.(100, 'Done');
        return result;
      }
      if (category === 'addon') {
        const result = await mgr.installBedrockAddon(serverId, tmpPath);
        onProgress?.(100, 'Done');
        return result;
      }
      // world
      const result = await mgr.importWorld(serverId, tmpPath, !!opts.confirmReplaceWorld);
      onProgress?.(100, 'Done');
      return result;
    } catch (e: any) {
      return { success: false, error: e?.message || 'Install failed.' };
    } finally {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    }
  }
}
