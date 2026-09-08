import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Blocks, FolderOpen, ArrowLeft, Loader2, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { Panel, SectionHeading, Toggle } from '../components/ui';
import toast from 'react-hot-toast';

type ServerType = 'vanilla' | 'paper';

export default function MinecraftServerWizard() {
  const navigate = useNavigate();
  const [name, setName] = useState('My Minecraft Server');
  const [installPath, setInstallPath] = useState('');
  const [serverType, setServerType] = useState<ServerType>('vanilla');
  const [version, setVersion] = useState('');
  const [ram, setRam] = useState(2048);
  const [port, setPort] = useState(25565);
  const [acceptedEula, setAcceptedEula] = useState(false);

  const [vanillaVersions, setVanillaVersions] = useState<{ id: string; type: string }[]>([]);
  const [paperVersions, setPaperVersions] = useState<string[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(true);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  const [java, setJava] = useState<{ found: boolean; version: string | null; major: number | null } | null>(null);
  const [requiredJava, setRequiredJava] = useState<number | null>(null);

  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; message: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [vanilla, paper, javaInfo] = await Promise.all([
          window.electronAPI.minecraft.fetchVanillaVersions(),
          window.electronAPI.minecraft.fetchPaperVersions(),
          window.electronAPI.minecraft.detectJava(),
        ]);
        const releases = vanilla.filter((v) => v.type === 'release');
        setVanillaVersions(releases);
        setPaperVersions(paper.slice().reverse()); // newest-looking first
        setJava(javaInfo);
        if (releases[0]) setVersion(releases[0].id);
      } catch (e: any) {
        setVersionsError('Could not reach Mojang/PaperMC to load versions — check your internet connection.');
      } finally { setLoadingVersions(false); }
    })();
  }, []);

  useEffect(() => {
    if (!version) return;
    window.electronAPI.minecraft.javaRequirement(version).then(setRequiredJava).catch(() => setRequiredJava(null));
  }, [version]);

  useEffect(() => {
    // Switching type resets to that type's first available version.
    if (serverType === 'vanilla' && vanillaVersions[0]) setVersion(vanillaVersions[0].id);
    if (serverType === 'paper' && paperVersions[0]) setVersion(paperVersions[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverType]);

  const browse = async () => {
    const dir = await window.electronAPI?.openDirectory();
    if (dir) setInstallPath(dir);
  };

  const javaMismatch = java?.found && java.major != null && requiredJava != null && java.major < requiredJava;
  const canCreate = name.trim() && installPath && version && port > 0 && port < 65536 && ram >= 512 && acceptedEula && !creating;

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    setProgress({ pct: 0, message: 'Starting…' });
    const cleanup = window.electronAPI.onMinecraftCreateProgress((data) => setProgress(data));
    try {
      const result = await window.electronAPI.minecraft.create({ name: name.trim(), installPath, version, serverType, ramMB: ram, port, acceptedEula });
      if (result.success && result.server) {
        toast.success('Server created');
        navigate(`/minecraft/server/${result.server.id}`);
      } else {
        toast.error(result.error || 'Server creation failed');
      }
    } catch (e: any) {
      toast.error(e?.message || 'Server creation failed');
    } finally {
      cleanup?.();
      setCreating(false);
      setProgress(null);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-5 max-w-3xl mx-auto pb-16">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/minecraft')} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors"><ArrowLeft size={16} /></button>
        <SectionHeading icon={Blocks} iconClass="bg-emerald-500/15 border-emerald-500/25 text-emerald-300" title="Create Minecraft Server" subtitle="A real server, downloaded and configured for you" />
      </div>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Server Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className="input-field" placeholder="My Minecraft Server" />
      </Panel>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Server Location</label>
        <div className="flex gap-2">
          <div className="flex-1 bg-overlay-3 border border-overlay-6 rounded-xl px-4 py-2.5 text-sm text-surface-300 truncate font-mono">{installPath || 'Choose an empty folder…'}</div>
          <button onClick={browse} className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary-500/10 text-primary-400 hover:bg-primary-500/20 border border-primary-500/20 transition-all"><FolderOpen size={16} /></button>
        </div>
      </Panel>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3 block">Server Type</label>
        <div className="grid grid-cols-2 gap-3">
          {(['vanilla', 'paper'] as ServerType[]).map((t) => (
            <button key={t} onClick={() => setServerType(t)}
              className={`rounded-xl border p-4 text-left transition-all ${serverType === t ? 'border-primary-500/50 bg-primary-500/10' : 'border-overlay-6 bg-overlay-3 hover:bg-overlay-6'}`}>
              <p className="text-sm font-bold text-surface-100 capitalize">{t}</p>
              <p className="text-[11px] text-surface-500 mt-1">{t === 'vanilla' ? 'Official Mojang server — no plugins or mods.' : 'High-performance server with plugin support.'}</p>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-surface-600 mt-3">Fabric, Forge, and NeoForge aren't supported yet — their installers need a separate multi-step flow that isn't reliable enough to ship tonight.</p>
      </Panel>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Minecraft Version</label>
        {loadingVersions ? (
          <div className="flex items-center gap-2 text-sm text-surface-400 py-2"><Loader2 size={14} className="animate-spin" /> Loading real version list…</div>
        ) : versionsError ? (
          <div className="flex items-center gap-2 text-xs text-error py-2"><XCircle size={14} className="shrink-0" /> {versionsError}</div>
        ) : (
          <select value={version} onChange={(e) => setVersion(e.target.value)} className="input-field">
            {(serverType === 'vanilla' ? vanillaVersions.map((v) => v.id) : paperVersions).map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        )}
        {requiredJava && (
          <p className={`text-[11px] mt-2 flex items-center gap-1.5 ${javaMismatch ? 'text-warning' : 'text-surface-500'}`}>
            {javaMismatch && <AlertTriangle size={12} className="shrink-0" />}
            Needs Java {requiredJava}+. {java?.found ? `Detected Java ${java.major ?? '?'} on this PC${javaMismatch ? ' — may not run this version.' : '.'}` : 'No Java installation detected on this PC — install a JDK before starting the server.'}
          </p>
        )}
      </Panel>

      <div className="grid grid-cols-2 gap-4">
        <Panel>
          <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">RAM Allocation (MB)</label>
          <input type="number" min={512} step={512} value={ram} onChange={(e) => setRam(parseInt(e.target.value) || 512)} className="input-field" />
        </Panel>
        <Panel>
          <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Port</label>
          <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(parseInt(e.target.value) || 25565)} className="input-field" />
        </Panel>
      </div>

      <Panel className="flex items-center gap-4">
        <div className="flex-1">
          <p className="text-sm font-semibold text-surface-100">Accept the Minecraft EULA</p>
          <p className="text-xs text-surface-500 mt-0.5">Required by Mojang to run a server. <a className="text-primary-400 hover:underline cursor-pointer" onClick={() => window.electronAPI?.openExternal('https://www.minecraft.net/en-us/eula')}>Read the EULA</a></p>
        </div>
        <Toggle checked={acceptedEula} onChange={setAcceptedEula} />
      </Panel>

      {progress && (
        <Panel>
          <div className="flex items-center justify-between mb-2"><p className="text-xs font-semibold text-surface-300">{progress.message}</p><p className="text-xs text-surface-500">{progress.pct}%</p></div>
          <div className="w-full h-1.5 bg-overlay-6 rounded-full overflow-hidden"><div className="h-full rounded-full bg-primary-500 transition-all duration-300" style={{ width: `${progress.pct}%` }} /></div>
        </Panel>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={() => navigate('/minecraft')} disabled={creating} className="btn-secondary">Cancel</button>
        <button onClick={handleCreate} disabled={!canCreate} className="btn-primary flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
          {creating ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} {creating ? 'Creating…' : 'Create Server'}
        </button>
      </div>
    </motion.div>
  );
}
