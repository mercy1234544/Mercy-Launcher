import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Search, Download, Loader2, X, ExternalLink, Package, Puzzle, Layers,
  AlertTriangle, CheckCircle2, Server as ServerIcon, ShieldCheck, Blocks, Box, Map, PackageCheck, PackageX, Info,
} from 'lucide-react';
import { Panel, SectionHeading, EmptyState } from '../components/ui';
import toast from 'react-hot-toast';

const TYPE_TABS: { id: string; label: string; icon: any }[] = [
  { id: '', label: 'All', icon: Layers },
  { id: 'plugin', label: 'Plugins', icon: Puzzle },
  { id: 'datapack', label: 'Datapacks', icon: Package },
  { id: 'mod', label: 'Mods', icon: Puzzle },
];

const LOADERS = ['', 'fabric', 'forge', 'neoforge', 'paper', 'spigot', 'bukkit'];

export default function MinecraftMarketplace() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const preselectServerId = params.get('server') || '';

  const [servers, setServers] = useState<MinecraftServer[]>([]);
  const [serversLoaded, setServersLoaded] = useState(false);
  const [targetServerId, setTargetServerId] = useState(preselectServerId);
  const targetServer = servers.find((s) => s.id === targetServerId) || null;

  // Edition is the primary, top-level choice — the catalog shown, and which
  // servers are even offered in the picker below, both follow from it. When
  // arriving pre-targeted at a specific server (e.g. from that server's own
  // Content/Packs tab), the server's own real edition is the source of
  // truth and seeds this rather than defaulting to Java.
  const [edition, setEdition] = useState<'java' | 'bedrock'>('java');
  const editionServers = servers.filter((s) => (edition === 'bedrock' ? s.edition === 'bedrock' : s.edition !== 'bedrock'));

  const [query, setQuery] = useState('');
  const [projectType, setProjectType] = useState('');
  const [loader, setLoader] = useState('');
  const [mcVersion, setMcVersion] = useState('');
  const [versions, setVersions] = useState<{ id: string; type: string }[]>([]);

  const [hits, setHits] = useState<MarketplaceHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<MarketplaceHit | null>(null);

  useEffect(() => {
    window.electronAPI.minecraft.getAll().then((all) => { setServers(all); setServersLoaded(true); }).catch(() => setServersLoaded(true));
    window.electronAPI.minecraft.fetchVanillaVersions().then((v) => setVersions(v.filter((x) => x.type === 'release'))).catch(() => setVersions([]));
  }, []);

  // Seed the edition from the preselected server's real edition, exactly once,
  // once the server list has actually loaded (never guessed/left at the
  // default while the real value is available).
  useEffect(() => {
    if (!serversLoaded || !preselectServerId) return;
    const found = servers.find((s) => s.id === preselectServerId);
    if (found) setEdition(found.edition === 'bedrock' ? 'bedrock' : 'java');
  }, [serversLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseEdition = (next: 'java' | 'bedrock') => {
    setEdition(next);
    // A server that belongs to the other edition can never be a valid
    // install target for this catalog — drop the selection rather than
    // leave a mismatched server silently selected underneath.
    if (targetServer && (next === 'bedrock') !== (targetServer.edition === 'bedrock')) {
      setTargetServerId('');
      const next2 = new URLSearchParams(params); next2.delete('server'); setParams(next2, { replace: true });
    }
  };

  // When a target server is chosen, default the version filter to its own version.
  useEffect(() => {
    if (targetServer && targetServer.version !== 'unknown') setMcVersion(targetServer.version);
  }, [targetServerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runSearch = async () => {
    if (edition === 'bedrock') return; // Modrinth is a Java-only catalog — never queried while browsing Bedrock.
    setLoading(true); setError(null);
    try {
      const res = await window.electronAPI.minecraftMarketplace.search({ query, projectType: projectType || undefined, loader: loader || undefined, minecraftVersion: mcVersion || undefined, limit: 24 });
      setHits(res.hits);
    } catch (e: any) {
      setError('Could not reach Modrinth — check your internet connection.');
    } finally { setLoading(false); }
  };

  useEffect(() => { runSearch(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(runSearch, 350); return () => clearTimeout(t); }, [query, projectType, loader, mcVersion, edition]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTarget = (id: string) => {
    setTargetServerId(id);
    const next = new URLSearchParams(params); if (id) next.set('server', id); else next.delete('server'); setParams(next, { replace: true });
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-5 max-w-6xl mx-auto pb-16">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(preselectServerId ? `/minecraft/server/${preselectServerId}` : '/minecraft')} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors"><ArrowLeft size={16} /></button>
        <SectionHeading icon={Puzzle} iconClass="bg-emerald-500/15 border-emerald-500/25 text-emerald-300" title="Minecraft Marketplace" subtitle="Browse and install Minecraft content" />
      </div>

      {/* Edition is the top-level choice — it decides the catalog below. */}
      <div className="flex gap-2">
        {([
          { id: 'java' as const, label: 'Java Edition', icon: Blocks },
          { id: 'bedrock' as const, label: 'Bedrock Edition', icon: Box },
        ]).map((e) => (
          <button key={e.id} onClick={() => chooseEdition(e.id)}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border text-sm font-bold transition-all ${edition === e.id ? 'border-primary-500/50 bg-primary-500/10 text-primary-300' : 'border-overlay-6 bg-overlay-3 text-surface-400 hover:bg-overlay-6'}`}>
            <e.icon size={16} /> {e.label}
          </button>
        ))}
      </div>

      <Panel className="flex items-center gap-3">
        <ServerIcon size={16} className="text-surface-500 shrink-0" />
        <div className="flex-1">
          <p className="text-xs text-surface-500">Installing for</p>
          <select value={targetServerId} onChange={(e) => setTarget(e.target.value)} className="input-field text-sm py-1.5 mt-0.5">
            <option value="">Browse only (choose a server to enable installing)</option>
            {editionServers.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.serverType === 'paper' ? 'Paper' : s.serverType === 'bedrock' ? 'Bedrock' : 'Vanilla'} {s.version !== 'unknown' ? s.version : ''}</option>)}
          </select>
          {editionServers.length === 0 && serversLoaded && (
            <p className="text-[11px] text-surface-600 mt-1">No {edition === 'bedrock' ? 'Bedrock' : 'Java'} Edition servers yet — this catalog is for browsing only until you create or import one.</p>
          )}
        </div>
        {targetServer && edition === 'java' && (
          <span className="text-[11px] text-surface-500 flex items-center gap-1.5 shrink-0"><ShieldCheck size={13} className="text-success" /> Compatibility is checked against this server</span>
        )}
      </Panel>

      {edition === 'bedrock' ? (
        <BedrockCatalogPanel targetServer={targetServer} />
      ) : (
        <Panel className="space-y-3">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search mods, plugins, datapacks…" className="input-field pl-9" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {TYPE_TABS.map((t) => (
              <button key={t.id} onClick={() => setProjectType(t.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${projectType === t.id ? 'bg-primary-600/15 text-primary-300 border border-primary-500/25' : 'text-surface-400 hover:text-surface-200 hover:bg-overlay-4 border border-transparent'}`}>
                <t.icon size={13} /> {t.label}
              </button>
            ))}
            <div className="w-px h-5 bg-overlay-8 mx-1" />
            <select value={mcVersion} onChange={(e) => setMcVersion(e.target.value)} className="input-field text-xs py-1.5 w-auto">
              <option value="">Any Minecraft version</option>
              {versions.map((v) => <option key={v.id} value={v.id}>{v.id}</option>)}
            </select>
            <select value={loader} onChange={(e) => setLoader(e.target.value)} className="input-field text-xs py-1.5 w-auto">
              {LOADERS.map((l) => <option key={l} value={l}>{l || 'Any loader/platform'}</option>)}
            </select>
          </div>
        </Panel>
      )}

      {edition === 'bedrock' ? null : loading ? (
        <Panel className="flex items-center justify-center py-16"><Loader2 size={20} className="animate-spin text-primary-400" /></Panel>
      ) : error ? (
        <Panel><EmptyState icon={AlertTriangle} title="Couldn't load Marketplace results" description={error} /></Panel>
      ) : hits.length === 0 ? (
        <Panel><EmptyState icon={Search} title="No results" description="Try a different search term or clear the filters." /></Panel>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {hits.map((h) => (
            <button key={h.projectId} onClick={() => setSelected(h)} className="text-left">
              <Panel interactive className="h-full flex flex-col gap-2">
                <div className="flex items-center gap-2.5">
                  {h.iconUrl ? <img src={h.iconUrl} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" /> : <div className="w-9 h-9 rounded-lg bg-overlay-6 flex items-center justify-center shrink-0"><Package size={16} className="text-surface-500" /></div>}
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-surface-100 truncate">{h.title}</p>
                    <p className="text-[11px] text-surface-500 truncate">by {h.author}</p>
                  </div>
                </div>
                <p className="text-xs text-surface-400 line-clamp-2 flex-1">{h.description}</p>
                <div className="flex items-center justify-between text-[10px] text-surface-500">
                  <span className="capitalize">{h.projectType}</span>
                  <span>{h.downloads.toLocaleString()} downloads</span>
                </div>
              </Panel>
            </button>
          ))}
        </div>
      )}

      <AnimatePresence>
        {selected && (
          <ModDetailModal hit={selected} targetServer={targetServer} onClose={() => setSelected(null)} />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Bedrock: a real catalog backed by GitHub (see BedrockMarketplace.ts's
// own header comment for why GitHub, and why not Mojang's Marketplace,
// MCPEDL, or Modrinth). Every result here is real GitHub repo/release data
// — never fabricated, and never Java content relabeled as Bedrock.
const BEDROCK_CATEGORY_TABS: { id: BedrockCategory; label: string; icon: any }[] = [
  { id: 'resource_pack', label: 'Resource Packs', icon: PackageCheck },
  { id: 'behavior_pack', label: 'Behavior Packs', icon: PackageX },
  { id: 'addon', label: 'Add-ons', icon: Blocks },
  { id: 'world', label: 'Worlds', icon: Map },
];

const MCPEDL_PATH: Record<BedrockCategory, string> = {
  resource_pack: 'texture-packs', behavior_pack: 'addons', addon: 'addons', world: 'maps',
};
function mcpedlUrl(category: BedrockCategory, query: string): string {
  const q = query.trim();
  return q ? `https://mcpedl.com/?s=${encodeURIComponent(q)}` : `https://mcpedl.com/${MCPEDL_PATH[category]}/`;
}

function BedrockCatalogPanel({ targetServer }: { targetServer: MinecraftServer | null }) {
  const [category, setCategory] = useState<BedrockCategory>('resource_pack');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<BedrockMarketplaceHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BedrockMarketplaceHit | null>(null);

  const runSearch = async () => {
    setLoading(true); setError(null);
    try {
      const res = await window.electronAPI.bedrockMarketplace.search(category, query);
      setHits(res.hits);
    } catch (e: any) {
      setError(e?.message || 'Could not reach GitHub.');
      setHits([]);
    } finally { setLoading(false); }
  };

  useEffect(() => { runSearch(); }, [category]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(runSearch, 500); return () => clearTimeout(t); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <Panel padding="sm" className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-overlay-6 flex items-center justify-center shrink-0 text-surface-400"><Info size={14} /></div>
        <p className="text-[11px] text-surface-400 leading-relaxed">
          Real, open-source Bedrock content from GitHub — Mojang's own Marketplace has no public API, and Modrinth is Java-only. Results are actual repositories with real releases; there's no legitimate way for Mercy to fabricate more than what's shown here.
        </p>
      </Panel>

      <div className="flex flex-wrap gap-2">
        {BEDROCK_CATEGORY_TABS.map((t) => (
          <button key={t.id} onClick={() => setCategory(t.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${category === t.id ? 'bg-primary-600/15 text-primary-300 border border-primary-500/25' : 'text-surface-400 hover:text-surface-200 hover:bg-overlay-4 border border-transparent'}`}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search GitHub for Bedrock content…" className="input-field pl-9" />
      </div>

      {loading ? (
        <Panel className="flex items-center justify-center py-16"><Loader2 size={20} className="animate-spin text-primary-400" /></Panel>
      ) : error ? (
        <Panel><EmptyState icon={AlertTriangle} title="Couldn't load results" description={error} /></Panel>
      ) : hits.length === 0 ? (
        <Panel><EmptyState icon={Search} title="No results" description="Try a different search term, or a different category." /></Panel>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {hits.map((h) => (
            <button key={h.id} onClick={() => setSelected(h)} className="text-left">
              <Panel interactive className="h-full flex flex-col gap-2">
                <div className="flex items-center gap-2.5">
                  {h.authorAvatarUrl ? <img src={h.authorAvatarUrl} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" /> : <div className="w-9 h-9 rounded-lg bg-overlay-6 flex items-center justify-center shrink-0"><Package size={16} className="text-surface-500" /></div>}
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-surface-100 truncate">{h.name}</p>
                    <p className="text-[11px] text-surface-500 truncate">by {h.owner}</p>
                  </div>
                </div>
                <p className="text-xs text-surface-400 line-clamp-2 flex-1">{h.description || 'No description provided.'}</p>
                <div className="flex items-center justify-between text-[10px] text-surface-500">
                  <span className="capitalize">{bedrockCategoryLabelClient(category)}</span>
                  <span>★ {h.stars.toLocaleString()}</span>
                </div>
              </Panel>
            </button>
          ))}
        </div>
      )}

      <Panel padding="sm" className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-surface-500">Not finding it? MCPEDL hosts far more community content, but has no API Mercy can install from directly.</p>
        <button onClick={() => window.electronAPI?.openExternal(mcpedlUrl(category, query))} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 shrink-0">
          Search MCPEDL <ExternalLink size={12} />
        </button>
      </Panel>

      <AnimatePresence>
        {selected && <BedrockDetailModal hit={selected} category={category} targetServer={targetServer} onClose={() => setSelected(null)} />}
      </AnimatePresence>
    </div>
  );
}

function bedrockCategoryLabelClient(category: BedrockCategory): string {
  return category === 'resource_pack' ? 'Resource Pack' : category === 'behavior_pack' ? 'Behavior Pack' : category === 'addon' ? 'Add-on' : 'World';
}

// ── Bedrock detail + install modal ──────────────────────────────────────────
function BedrockDetailModal({ hit, category, targetServer, onClose }: { hit: BedrockMarketplaceHit; category: BedrockCategory; targetServer: MinecraftServer | null; onClose: () => void }) {
  const [releases, setReleases] = useState<BedrockRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; message: string } | null>(null);
  const [pendingAsset, setPendingAsset] = useState<BedrockReleaseAsset | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true); setError(null);
      try {
        setReleases(await window.electronAPI.bedrockMarketplace.getReleases(hit.owner, hit.repo, category));
      } catch (e: any) { setError(e?.message || 'Could not load releases'); }
      finally { setLoading(false); }
    })();
  }, [hit.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const install = async (asset: BedrockReleaseAsset, confirmReplaceWorld = false) => {
    if (!targetServer) return;
    setInstalling(true);
    const cleanup = window.electronAPI.onBedrockMarketplaceInstallProgress(setProgress);
    try {
      const result = await window.electronAPI.bedrockMarketplace.install(targetServer.id, category, { browserDownloadUrl: asset.browserDownloadUrl, name: asset.name }, confirmReplaceWorld);
      if (result.success) {
        setPendingAsset(null);
        if (category === 'addon' && (result.installedResourcePack || result.installedBehaviorPack)) {
          const parts = [result.installedResourcePack && 'Resource Pack', result.installedBehaviorPack && 'Behavior Pack'].filter(Boolean);
          toast.success(`Installed as: ${parts.join(' + ')}`);
        } else {
          toast.success(`${hit.name} installed`);
        }
        onClose();
      } else if (result.needsConfirmation) {
        setPendingAsset(asset);
      } else {
        toast.error(result.error || 'Install failed');
      }
    } catch (e: any) {
      toast.error(e?.message || 'Install failed');
    } finally {
      cleanup?.(); setInstalling(false); setProgress(null);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl bg-surface-900 border border-overlay-10 p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {hit.authorAvatarUrl ? <img src={hit.authorAvatarUrl} alt="" className="w-12 h-12 rounded-xl object-cover" /> : <div className="w-12 h-12 rounded-xl bg-overlay-6 flex items-center justify-center"><Package size={20} className="text-surface-500" /></div>}
            <div>
              <p className="text-base font-bold text-surface-100">{hit.name}</p>
              <p className="text-xs text-surface-500">by {hit.owner} · ★ {hit.stars.toLocaleString()}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6"><X size={16} /></button>
        </div>

        <p className="text-sm text-surface-300">{hit.description || 'No description provided.'}</p>
        {hit.topics.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {hit.topics.map((c) => <span key={c} className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-overlay-6 text-surface-400">{c}</span>)}
          </div>
        )}
        <p className="text-[11px] text-surface-500">
          <a className="text-primary-400 hover:underline cursor-pointer" onClick={() => window.electronAPI?.openExternal(hit.htmlUrl)}>View on GitHub <ExternalLink size={10} className="inline" /></a>
        </p>

        <div className="border-t border-overlay-6 pt-4">
          <label className="text-[11px] font-semibold text-surface-400 mb-1.5 block">Releases</label>
          {loading ? (
            <div className="flex items-center justify-center py-6"><Loader2 size={16} className="animate-spin text-primary-400" /></div>
          ) : error ? (
            <p className="text-xs text-error">{error}</p>
          ) : releases.length === 0 ? (
            <p className="text-xs text-surface-500">This repository has no published releases — nothing for Mercy to install yet.</p>
          ) : (
            <div className="space-y-3">
              {releases.slice(0, 3).map((r) => (
                <div key={r.tagName} className="rounded-xl border border-overlay-6 p-3">
                  <p className="text-xs font-semibold text-surface-200">{r.name} {r.prerelease && <span className="text-amber-400">(pre-release)</span>}</p>
                  {r.assets.length === 0 ? (
                    <p className="text-[11px] text-surface-500 mt-1">No downloadable files attached to this release.</p>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      {r.assets.map((a) => (
                        <div key={a.name} className="flex items-center gap-2">
                          <span className={`text-xs flex-1 truncate ${a.installable ? 'text-surface-200' : 'text-surface-600'}`}>{a.name}</span>
                          <span className="text-[10px] text-surface-500 shrink-0">{(a.size / 1024 / 1024).toFixed(1)} MB{a.downloadCount > 0 ? ` · ${a.downloadCount.toLocaleString()} downloads` : ''}</span>
                          {!targetServer ? (
                            <span className="text-[10px] text-surface-600 shrink-0">Select a server</span>
                          ) : !a.installable ? (
                            <span className="text-[10px] text-surface-600 shrink-0" title={`Not a recognized ${bedrockCategoryLabelClient(category)} file`}>Not installable</span>
                          ) : (
                            <button onClick={() => install(a)} disabled={installing} className="btn-primary text-[11px] py-1 px-2.5 shrink-0 disabled:opacity-50">
                              {installing ? <Loader2 size={11} className="animate-spin" /> : 'Install'}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {progress && (
          <div>
            <div className="flex items-center justify-between mb-1.5 text-xs"><span className="text-surface-300">{progress.message}</span><span className="text-surface-500">{progress.pct}%</span></div>
            <div className="w-full h-1.5 bg-overlay-6 rounded-full overflow-hidden"><div className="h-full bg-primary-500 transition-all" style={{ width: `${progress.pct}%` }} /></div>
          </div>
        )}

        {pendingAsset && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              A world already exists on this server — installing will replace it (backed up first).
              <div className="flex gap-2 mt-2">
                <button onClick={() => setPendingAsset(null)} className="btn-secondary text-xs py-1 px-2.5">Cancel</button>
                <button onClick={() => install(pendingAsset, true)} disabled={installing} className="btn-primary text-xs py-1 px-2.5">Back Up &amp; Replace</button>
              </div>
            </div>
          </div>
        )}

        {!targetServer && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-overlay-4 border border-overlay-8 text-xs text-surface-400"><ServerIcon size={14} className="shrink-0" /> Select a Bedrock server above to install this.</div>
        )}
      </motion.div>
    </motion.div>
  );
}

// ── Detail + install modal ──────────────────────────────────────────────────
function ModDetailModal({ hit, targetServer, onClose }: { hit: MarketplaceHit; targetServer: MinecraftServer | null; onClose: () => void }) {
  const [project, setProject] = useState<MarketplaceProject | null>(null);
  const [versionList, setVersionList] = useState<MarketplaceVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; message: string } | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [p, v] = await Promise.all([
          window.electronAPI.minecraftMarketplace.getProject(hit.projectId),
          window.electronAPI.minecraftMarketplace.getVersions(hit.projectId, targetServer ? { minecraftVersion: targetServer.version !== 'unknown' ? targetServer.version : undefined } : undefined),
        ]);
        setProject(p);
        setVersionList(v);
        if (v[0]) setSelectedVersionId(v[0].id);
      } catch { toast.error('Could not load project details'); }
      finally { setLoading(false); }
    })();
  }, [hit.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedVersion = versionList.find((v) => v.id === selectedVersionId) || null;

  // Client-side compatibility hint — the real, authoritative check happens
  // in MinecraftMarketplace.installContent(); this only avoids offering an
  // Install button the backend would just reject anyway.
  const compatibility = useMemo(() => {
    if (!targetServer) return null;
    if (targetServer.serverType === 'bedrock') return { ok: false, reason: 'Marketplace content isn\'t supported for Bedrock servers yet — Java plugins, mods, and datapacks don\'t run on Bedrock.' };
    if (hit.projectType === 'plugin') {
      if (targetServer.serverType !== 'paper') return { ok: false, reason: 'Plugins require a Paper server — this is a Vanilla server.' };
      return { ok: true };
    }
    if (hit.projectType === 'datapack') return { ok: true };
    if (hit.projectType === 'mod') return { ok: false, reason: `Mods need a Fabric/Forge/NeoForge server. Mercy only runs Vanilla and Paper, so this can't be installed on any server here.` };
    return { ok: false, reason: `${hit.projectType} is client-side content — a server doesn't install this.` };
  }, [hit, targetServer]);

  const install = async () => {
    if (!targetServer || !selectedVersion) return;
    setInstalling(true);
    const cleanup = window.electronAPI.onMinecraftMarketplaceInstallProgress(setProgress);
    try {
      const result = await window.electronAPI.minecraftMarketplace.install(targetServer.id, hit.projectId, selectedVersion.id);
      if (result.success) toast.success(`${project?.title || hit.title} installed`);
      else toast.error(result.error || 'Install failed');
    } catch (e: any) {
      toast.error(e?.message || 'Install failed');
    } finally {
      cleanup?.(); setInstalling(false); setProgress(null);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl bg-surface-900 border border-overlay-10 p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {hit.iconUrl ? <img src={hit.iconUrl} alt="" className="w-12 h-12 rounded-xl object-cover" /> : <div className="w-12 h-12 rounded-xl bg-overlay-6 flex items-center justify-center"><Package size={20} className="text-surface-500" /></div>}
            <div>
              <p className="text-base font-bold text-surface-100">{hit.title}</p>
              <p className="text-xs text-surface-500">by {hit.author} · {hit.downloads.toLocaleString()} downloads</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6"><X size={16} /></button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-primary-400" /></div>
        ) : (
          <>
            <p className="text-sm text-surface-300">{project?.description || hit.description}</p>
            <div className="flex flex-wrap gap-1.5">
              {hit.categories.map((c) => <span key={c} className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-overlay-6 text-surface-400 capitalize">{c}</span>)}
            </div>
            {project?.license && (
              <p className="text-[11px] text-surface-500">License: <span className="text-surface-300">{project.license.name}</span>{project.sourceUrl && <> · <a className="text-primary-400 hover:underline cursor-pointer" onClick={() => window.electronAPI?.openExternal(project.sourceUrl!)}>Source <ExternalLink size={10} className="inline" /></a></>}</p>
            )}

            <div className="border-t border-overlay-6 pt-4">
              <label className="text-[11px] font-semibold text-surface-400 mb-1.5 block">Version</label>
              {versionList.length === 0 ? (
                <p className="text-xs text-surface-500">No versions found{targetServer && targetServer.version !== 'unknown' ? ` for Minecraft ${targetServer.version}` : ''}.</p>
              ) : (
                <select value={selectedVersionId} onChange={(e) => setSelectedVersionId(e.target.value)} className="input-field text-sm">
                  {versionList.map((v) => <option key={v.id} value={v.id}>{v.versionNumber} — {v.gameVersions.slice(-3).join(', ')} ({v.loaders.join('/')})</option>)}
                </select>
              )}
              {selectedVersion && selectedVersion.dependencies.length > 0 && (
                <p className="text-[11px] text-surface-500 mt-2">Dependencies: {selectedVersion.dependencies.map((d) => d.dependencyType).join(', ')} ({selectedVersion.dependencies.length})</p>
              )}
            </div>

            {!targetServer ? (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-overlay-4 border border-overlay-8 text-xs text-surface-400"><ServerIcon size={14} className="shrink-0" /> Select a server above to install this.</div>
            ) : compatibility && !compatibility.ok ? (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-error-bg border border-error/20 text-xs text-error"><AlertTriangle size={14} className="shrink-0 mt-0.5" /> {compatibility.reason}</div>
            ) : progress ? (
              <div>
                <div className="flex items-center justify-between mb-1.5 text-xs"><span className="text-surface-300">{progress.message}</span><span className="text-surface-500">{progress.pct}%</span></div>
                <div className="w-full h-1.5 bg-overlay-6 rounded-full overflow-hidden"><div className="h-full bg-primary-500 transition-all" style={{ width: `${progress.pct}%` }} /></div>
              </div>
            ) : (
              <button onClick={install} disabled={installing || !selectedVersion} className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50">
                {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Install to {targetServer.name}
              </button>
            )}
          </>
        )}
      </motion.div>
    </motion.div>
  );
}
