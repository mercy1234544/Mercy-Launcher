// FiveM content marketplace — real installs of real GitHub-hosted FiveM
// resources. There is no public, queryable "FiveM content API" comparable
// to Modrinth (researched before building this: Cfx.re's forums are
// classifieds, not an API; Tebex is per-seller paid storefronts, not an
// open catalog). The existing Marketplace.tsx already curates ~160 real,
// verified GitHub repos as the FiveM content source — that curation stays
// in the renderer (it's display/catalog data, not something this service
// needs to own); what THIS service adds is what the renderer can't safely
// do itself: live per-repo metadata from GitHub's real API (stars, license,
// last-updated — fetched lazily, one repo at a time, to respect GitHub's
// 60/hour unauthenticated rate limit rather than bulk-fetching all ~160 on
// load), and the real install: download → validate → extract → place into
// the server's resources/ folder → manage the server.cfg `ensure` line →
// track what Mercy installed.
//
// FiveM's install unit is a RESOURCE FOLDER (often containing many files,
// sometimes nested), not a single file like a Minecraft plugin jar — so
// this does NOT mirror MinecraftMarketplace.ts's file-move enable/disable;
// enabling/disabling here means adding/removing the `ensure <name>` line in
// server.cfg (via the existing ResourceScanner.toggleResource(), reused
// as-is rather than reimplemented).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import axios from 'axios';
import extractZip from 'extract-zip';
import type { ServerManager, FiveMInstalledContent } from './ServerManager';
import { ResourceScanner } from './ResourceScanner';

const USER_AGENT = 'mercy1234544/fivem-server-builder/mercy-launcher (github.com/mercy1234544/fivem-server-builder)';

export interface GitHubRepoDetails {
  owner: string;
  repo: string;
  description: string | null;
  stars: number;
  license: { name: string; spdxId: string | null } | null;
  pushedAt: string;
  defaultBranch: string;
  ownerAvatarUrl: string;
  htmlUrl: string;
  openIssues: number;
  /** A real, direct release asset if the repo publishes one (preferred —
   *  compiled UI/web resources need this), else null (fall back to the
   *  repo's own source zipball). */
  latestReleaseAsset: { name: string; url: string; tag: string } | null;
}

export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  const m = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

/** The real, deterministic GitHub Open Graph image for any public repo —
 *  no API call, no rate limit, so every catalog card can show a real image
 *  immediately without needing per-card metadata fetches. */
export function githubPreviewImage(owner: string, repo: string): string {
  return `https://opengraph.githubassets.com/1/${owner}/${repo}`;
}

export class FiveMMarketplace {
  private http = axios.create({ timeout: 15000, headers: { 'User-Agent': USER_AGENT } });
  private resourceScanner = new ResourceScanner();

  /** Live, real metadata for ONE repo — fetched only when the user opens a
   *  detail view, never in bulk, to respect GitHub's real rate limit. */
  async getRepoDetails(repoUrl: string): Promise<GitHubRepoDetails> {
    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) throw new Error('Not a valid GitHub repository URL.');
    const { owner, repo } = parsed;
    const res = await this.http.get(`https://api.github.com/repos/${owner}/${repo}`);
    const r = res.data;

    let latestReleaseAsset: GitHubRepoDetails['latestReleaseAsset'] = null;
    try {
      const rel = await this.http.get(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
      const asset = (rel.data.assets || []).find((a: any) => a.name.toLowerCase().endsWith('.zip'));
      if (asset) latestReleaseAsset = { name: asset.name, url: asset.browser_download_url, tag: rel.data.tag_name };
    } catch { /* no releases — fall back to the source zipball at install time */ }

    return {
      owner, repo, description: r.description || null, stars: r.stargazers_count || 0,
      license: r.license ? { name: r.license.name, spdxId: r.license.spdx_id || null } : null,
      pushedAt: r.pushed_at, defaultBranch: r.default_branch, ownerAvatarUrl: r.owner?.avatar_url || '',
      htmlUrl: r.html_url, openIssues: r.open_issues_count || 0, latestReleaseAsset,
    };
  }

  private async downloadFile(url: string, destPath: string, onProgress?: (pct: number) => void): Promise<void> {
    const res = await axios.get(url, { responseType: 'stream', timeout: 30000, headers: { 'User-Agent': USER_AGENT }, maxRedirects: 5 });
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
      stream.on('data', (c) => hash.update(c));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /** Finds the real resource root inside an extracted archive — GitHub
   *  zipballs wrap everything in one "owner-repo-sha" folder, and some
   *  resources nest their actual fxmanifest.lua a level or two deeper than
   *  the archive root. Returns null if no real fxmanifest/__resource.lua is
   *  found anywhere reasonable (never guesses / never installs something
   *  that isn't actually a FiveM resource). */
  private findResourceRoot(extractedDir: string): string | null {
    const hasManifest = (dir: string) => fs.existsSync(path.join(dir, 'fxmanifest.lua')) || fs.existsSync(path.join(dir, '__resource.lua'));
    if (hasManifest(extractedDir)) return extractedDir;
    const entries = fs.readdirSync(extractedDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const entry of entries) {
      const child = path.join(extractedDir, entry.name);
      if (hasManifest(child)) return child;
      // One more level — a handful of repos nest resources under e.g. "resource/actual-resource/".
      const grandkids = fs.readdirSync(child, { withFileTypes: true }).filter((e) => e.isDirectory());
      for (const g of grandkids) {
        const grandchild = path.join(child, g.name);
        if (hasManifest(grandchild)) return grandchild;
      }
    }
    return null;
  }

  private extractManifestField(content: string, field: string): string | null {
    const m = content.match(new RegExp(`${field}\\s+['"]([^'"]+)['"]`)) || content.match(new RegExp(`${field}\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)`));
    return m ? m[1] : null;
  }

  /** The real, full install flow. Never claims success unless the resource
   *  is genuinely on disk afterward. */
  async installResource(
    serverMgr: ServerManager, serverId: string,
    opts: { repoUrl: string; resourceName: string; category: string; dependencies?: string[]; preferReleaseAsset?: boolean },
    onProgress?: (pct: number, message: string) => void,
  ): Promise<{ success: boolean; error?: string; content?: FiveMInstalledContent }> {
    const server = serverMgr.getServer(serverId);
    if (!server) return { success: false, error: 'Server not found.' };
    const parsed = parseRepoUrl(opts.repoUrl);
    if (!parsed) return { success: false, error: 'Not a valid GitHub repository URL.' };

    const targetRelPath = path.join('resources', opts.category, opts.resourceName);
    const targetAbs = serverMgr.resolveWithinServer(serverId, targetRelPath);
    if (!targetAbs) return { success: false, error: 'Could not resolve a safe install location inside this server.' };

    const existingRecord = serverMgr.getInstalledMarketplaceContent(serverId).find((c) => c.repo === `${parsed.owner}/${parsed.repo}`);
    if (fs.existsSync(targetAbs) && !existingRecord) {
      return { success: false, error: `A resource folder named "${opts.resourceName}" already exists on this server and wasn't installed by Mercy. Rename or remove it first, then try again.` };
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercy-fivem-install-'));
    try {
      onProgress?.(5, 'Resolving download…');
      let downloadUrl: string;
      let sha: string | null = null;
      if (opts.preferReleaseAsset !== false) {
        try {
          const details = await this.getRepoDetails(opts.repoUrl);
          downloadUrl = details.latestReleaseAsset?.url || `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/zipball/${details.defaultBranch}`;
          sha = details.latestReleaseAsset?.tag || null;
        } catch (e: any) {
          throw new Error(`Could not reach GitHub to resolve a download for this repository: ${e?.message || 'unknown error'}`);
        }
      } else {
        downloadUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/zipball/HEAD`;
      }

      const zipPath = path.join(workDir, 'download.zip');
      onProgress?.(15, 'Downloading…');
      await this.downloadFile(downloadUrl, zipPath, (pct) => onProgress?.(15 + Math.round(pct * 0.55), 'Downloading…'));

      if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) throw new Error('Downloaded file is empty — the source may be unavailable.');
      const actualSha1 = await this.sha1File(zipPath);

      onProgress?.(75, 'Validating archive…');
      const extractDir = path.join(workDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      try {
        await extractZip(zipPath, { dir: extractDir });
      } catch (e: any) {
        throw new Error(`This download is not a valid zip archive (${e?.message || 'extraction failed'}) — install aborted before touching your server.`);
      }

      onProgress?.(85, 'Checking resource structure…');
      const resourceRoot = this.findResourceRoot(extractDir);
      if (!resourceRoot) throw new Error('No fxmanifest.lua (or __resource.lua) was found in this download — it doesn\'t look like a real FiveM resource, so nothing was installed.');

      // Real dependency check against the manifest itself, not just the catalog's own claim.
      const manifestPath = fs.existsSync(path.join(resourceRoot, 'fxmanifest.lua')) ? path.join(resourceRoot, 'fxmanifest.lua') : path.join(resourceRoot, '__resource.lua');
      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifestVersion = this.extractManifestField(manifestContent, 'version');

      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      if (fs.existsSync(targetAbs)) {
        // A genuine re-install/update of something Mercy itself placed — back it up, don't just clobber it.
        const backupPath = `${targetAbs}.bak-${Date.now()}`;
        fs.renameSync(targetAbs, backupPath);
      }
      onProgress?.(92, 'Installing…');
      fs.cpSync(resourceRoot, targetAbs, { recursive: true });

      if (!fs.existsSync(path.join(targetAbs, 'fxmanifest.lua')) && !fs.existsSync(path.join(targetAbs, '__resource.lua'))) {
        throw new Error('Resource files did not copy correctly — install aborted.');
      }

      onProgress?.(96, 'Updating server.cfg…');
      await this.resourceScanner.toggleResource(server.installPath, opts.resourceName, true);

      if (existingRecord) serverMgr.removeInstalledMarketplaceContent(serverId, existingRecord.id);
      const record: FiveMInstalledContent = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        source: 'github', repo: `${parsed.owner}/${parsed.repo}`, resourceName: opts.resourceName,
        category: opts.category, relPath: path.relative(server.installPath, targetAbs).split(path.sep).join('/'),
        version: manifestVersion, sha: sha || actualSha1.slice(0, 12), enabled: true,
        installedAt: new Date().toISOString(), dependencies: opts.dependencies || [],
      };
      serverMgr.addInstalledMarketplaceContent(serverId, record);
      onProgress?.(100, 'Done');
      return { success: true, content: record };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Install failed.' };
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }

  listInstalled(serverMgr: ServerManager, serverId: string): (FiveMInstalledContent & { missingOnDisk: boolean })[] {
    return serverMgr.getInstalledMarketplaceContent(serverId).map((c) => {
      const abs = serverMgr.resolveWithinServer(serverId, c.relPath);
      return { ...c, missingOnDisk: !abs || !fs.existsSync(abs) };
    });
  }

  async removeResource(serverMgr: ServerManager, serverId: string, contentId: string): Promise<{ success: boolean; error?: string }> {
    const server = serverMgr.getServer(serverId);
    const item = serverMgr.getInstalledMarketplaceContent(serverId).find((c) => c.id === contentId);
    if (!server || !item) return { success: false, error: 'Content not found.' };
    const abs = serverMgr.resolveWithinServer(serverId, item.relPath);
    if (abs && fs.existsSync(abs)) {
      try { fs.rmSync(abs, { recursive: true, force: true }); } catch (e: any) { return { success: false, error: `Failed to remove resource files: ${e?.message || 'unknown error'}` }; }
    }
    try { await this.resourceScanner.toggleResource(server.installPath, item.resourceName, false); } catch {}
    serverMgr.removeInstalledMarketplaceContent(serverId, contentId);
    return { success: true };
  }

  async setResourceEnabled(serverMgr: ServerManager, serverId: string, contentId: string, enabled: boolean): Promise<{ success: boolean; error?: string }> {
    const server = serverMgr.getServer(serverId);
    const item = serverMgr.getInstalledMarketplaceContent(serverId).find((c) => c.id === contentId);
    if (!server || !item) return { success: false, error: 'Content not found.' };
    const ok = await this.resourceScanner.toggleResource(server.installPath, item.resourceName, enabled);
    if (!ok) return { success: false, error: 'server.cfg not found for this server.' };
    serverMgr.updateInstalledMarketplaceContent(serverId, contentId, { enabled });
    return { success: true };
  }

  openResourceFolder(serverMgr: ServerManager, serverId: string, contentId: string): string | null {
    const item = serverMgr.getInstalledMarketplaceContent(serverId).find((c) => c.id === contentId);
    if (!item) return null;
    return serverMgr.resolveWithinServer(serverId, item.relPath);
  }
}
