import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Search, Download, Loader2, X, ExternalLink, Package, Puzzle, Layers,
  AlertTriangle, CheckCircle2, Server as ServerIcon, ShieldCheck,
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
  const [targetServerId, setTargetServerId] = useState(preselectServerId);
  const targetServer = servers.find((s) => s.id === targetServerId) || null;

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
    window.electronAPI.minecraft.getAll().then(setServers).catch(() => setServers([]));
    window.electronAPI.minecraft.fetchVanillaVersions().then((v) => setVersions(v.filter((x) => x.type === 'release'))).catch(() => setVersions([]));
  }, []);

  // When a target server is chosen, default the version filter to its own version.
  useEffect(() => {
    if (targetServer && targetServer.version !== 'unknown') setMcVersion(targetServer.version);
  }, [targetServerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runSearch = async () => {
    setLoading(true); setError(null);
    try {
      const res = await window.electronAPI.minecraftMarketplace.search({ query, projectType: projectType || undefined, loader: loader || undefined, minecraftVersion: mcVersion || undefined, limit: 24 });
      setHits(res.hits);
    } catch (e: any) {
      setError('Could not reach Modrinth — check your internet connection.');
    } finally { setLoading(false); }
  };

  useEffect(() => { runSearch(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(runSearch, 350); return () => clearTimeout(t); }, [query, projectType, loader, mcVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTarget = (id: string) => {
    setTargetServerId(id);
    const next = new URLSearchParams(params); if (id) next.set('server', id); else next.delete('server'); setParams(next, { replace: true });
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-5 max-w-6xl mx-auto pb-16">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(preselectServerId ? `/minecraft/server/${preselectServerId}` : '/minecraft')} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors"><ArrowLeft size={16} /></button>
        <SectionHeading icon={Puzzle} iconClass="bg-emerald-500/15 border-emerald-500/25 text-emerald-300" title="Minecraft Marketplace" subtitle="Real mods, plugins, and datapacks from Modrinth — Java Edition catalog only" />
      </div>

      <Panel className="flex items-center gap-3">
        <ServerIcon size={16} className="text-surface-500 shrink-0" />
        <div className="flex-1">
          <p className="text-xs text-surface-500">Installing for</p>
          <select value={targetServerId} onChange={(e) => setTarget(e.target.value)} className="input-field text-sm py-1.5 mt-0.5">
            <option value="">Browse only (choose a server to enable installing)</option>
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.serverType === 'bedrock' ? 'Bedrock (catalog not available)' : s.serverType === 'paper' ? 'Paper' : 'Vanilla'} {s.version !== 'unknown' ? s.version : ''}</option>)}
          </select>
        </div>
        {targetServer && targetServer.serverType !== 'bedrock' && (
          <span className="text-[11px] text-surface-500 flex items-center gap-1.5 shrink-0"><ShieldCheck size={13} className="text-success" /> Compatibility is checked against this server</span>
        )}
      </Panel>

      {targetServer?.serverType === 'bedrock' && (
        <Panel>
          <EmptyState
            icon={AlertTriangle}
            title="No Marketplace catalog available for Bedrock"
            description="Mercy's Marketplace is built on Modrinth, which only hosts Java Edition content (mods, plugins, datapacks). There is no equivalent legitimate, publicly-accessible catalog API for Bedrock add-ons that Mercy can honestly plug in here, so rather than show Java results that could never install on this server, Bedrock resource packs and behavior packs are managed directly from this server's own Packs tab instead."
          />
        </Panel>
      )}

      {targetServer?.serverType !== 'bedrock' && <Panel className="space-y-3">
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
      </Panel>}

      {targetServer?.serverType === 'bedrock' ? null : loading ? (
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
