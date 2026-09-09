import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Blocks, FolderOpen, ArrowLeft, Loader2, CheckCircle2, AlertTriangle, XCircle, ChevronDown } from 'lucide-react';
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

  const [allRuntimes, setAllRuntimes] = useState<{ path: string; version: string; major: number; source: string }[]>([]);
  const [requiredJava, setRequiredJava] = useState<number | null>(null);
  const [checkingJava, setCheckingJava] = useState(false);
  const [selectedJavaPath, setSelectedJavaPath] = useState<string | null>(null); // null = auto-select the closest compatible runtime

  const refreshRuntimes = () => window.electronAPI.minecraft.detectAllJava().then(setAllRuntimes).catch(() => setAllRuntimes([]));
  const [installingJava, setInstallingJava] = useState(false);
  const [javaInstallProgress, setJavaInstallProgress] = useState<{ pct: number; message: string } | null>(null);

  const installJava = async (major: number) => {
    setInstallingJava(true);
    const cleanup = window.electronAPI.onMinecraftInstallJavaProgress(setJavaInstallProgress);
    try {
      const result = await window.electronAPI.minecraft.installJava(major);
      if (result.success) { toast.success(`Java ${major} installed`); refreshRuntimes(); }
      else toast.error(result.error || `Failed to install Java ${major}`);
    } catch (e: any) {
      toast.error(e?.message || `Failed to install Java ${major}`);
    } finally {
      cleanup?.(); setInstallingJava(false); setJavaInstallProgress(null);
    }
  };

  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; message: string } | null>(null);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [seed, setSeed] = useState('');
  const [gamemode, setGamemode] = useState<'survival' | 'creative' | 'adventure' | 'spectator'>('survival');
  const [difficulty, setDifficulty] = useState<'peaceful' | 'easy' | 'normal' | 'hard'>('easy');
  const [hardcore, setHardcore] = useState(false);
  const [onlineMode, setOnlineMode] = useState(true);
  const [maxPlayers, setMaxPlayers] = useState(20);
  const [motd, setMotd] = useState('A Mercy Launcher Server');
  const [viewDistance, setViewDistance] = useState(10);
  const [simulationDistance, setSimulationDistance] = useState(10);
  const [pvp, setPvp] = useState(true);
  const [whitelist, setWhitelist] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [vanilla, paper] = await Promise.all([
          window.electronAPI.minecraft.fetchVanillaVersions(),
          window.electronAPI.minecraft.fetchPaperVersions(),
        ]);
        refreshRuntimes();
        const releases = vanilla.filter((v) => v.type === 'release');
        setVanillaVersions(releases);
        setPaperVersions(paper.slice().reverse()); // newest-looking first
        if (releases[0]) setVersion(releases[0].id);
      } catch (e: any) {
        setVersionsError('Could not reach Mojang/PaperMC to load versions — check your internet connection.');
      } finally { setLoadingVersions(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live, per-version/type requirement — straight from Mojang/PaperMC's own
  // metadata (not a local guess), so a brand-new Minecraft release that
  // needs a newer Java than anything seen before is still reported correctly.
  useEffect(() => {
    if (!version) { setRequiredJava(null); return; }
    let cancelled = false;
    setCheckingJava(true);
    window.electronAPI.minecraft.requiredJavaForVersion(serverType, version)
      .then((v) => { if (!cancelled) setRequiredJava(v); })
      .catch(() => { if (!cancelled) setRequiredJava(null); })
      .finally(() => { if (!cancelled) setCheckingJava(false); });
    setSelectedJavaPath(null); // a version change resets manual picks back to auto
    return () => { cancelled = true; };
  }, [serverType, version]);

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

  const compatibleRuntimes = requiredJava != null ? allRuntimes.filter((r) => r.major >= requiredJava).sort((a, b) => a.major - b.major) : [];
  const autoRuntime = compatibleRuntimes[0] || null;
  const selectedRuntime = (selectedJavaPath ? allRuntimes.find((r) => r.path === selectedJavaPath) : autoRuntime) || null;
  const javaCompatible = requiredJava == null || (selectedRuntime != null && selectedRuntime.major >= requiredJava);
  const canCreate = name.trim() && installPath && version && port > 0 && port < 65536 && ram >= 512 && acceptedEula && !creating && javaCompatible;

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    setProgress({ pct: 0, message: 'Starting…' });
    const cleanup = window.electronAPI.onMinecraftCreateProgress((data) => setProgress(data));
    try {
      const result = await window.electronAPI.minecraft.create({
        name: name.trim(), installPath, version, serverType, ramMB: ram, port, acceptedEula, javaPath: selectedJavaPath,
        seed: seed.trim() || undefined, gamemode, difficulty, hardcore, onlineMode, maxPlayers, motd: motd.trim() || undefined,
        viewDistance, simulationDistance, pvp, whitelist,
      });
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
        <p className="text-[11px] text-surface-600 mt-3">Fabric, Forge, and NeoForge aren't supported as server types yet — their installers need a separate, more involved setup flow Mercy doesn't run yet. Mods for those loaders can still be browsed in the Marketplace for reference.</p>
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
      </Panel>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3 block">Java Compatibility</label>
        <div className="flex items-center justify-between text-sm">
          <span className="text-surface-400">Required Java</span>
          <span className="font-mono font-semibold text-surface-100">
            {checkingJava ? <Loader2 size={13} className="animate-spin inline" /> : requiredJava != null ? `Java ${requiredJava}` : 'Unknown'}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm mt-2">
          <span className="text-surface-400">Selected Runtime</span>
          {selectedRuntime ? (
            <span className={`font-mono font-semibold flex items-center gap-1.5 ${javaCompatible ? 'text-success' : 'text-error'}`}>
              Java {selectedRuntime.major} {javaCompatible ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
            </span>
          ) : (
            <span className="font-mono font-semibold text-error flex items-center gap-1.5">None found <XCircle size={13} /></span>
          )}
        </div>

        {requiredJava != null && !javaCompatible && (
          <div className="mt-3 p-2.5 rounded-lg bg-error-bg border border-error/20 text-xs text-error space-y-2">
            <div className="flex items-start gap-2">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <span>
                Java {requiredJava} is required for Minecraft {version}, but {selectedRuntime ? `Java ${selectedRuntime.major} is currently selected` : 'no compatible Java runtime was found'} on this PC.
              </span>
            </div>
            {javaInstallProgress ? (
              <div>
                <div className="flex items-center justify-between mb-1 text-[11px] text-surface-300"><span>{javaInstallProgress.message}</span><span>{javaInstallProgress.pct}%</span></div>
                <div className="w-full h-1.5 bg-overlay-6 rounded-full overflow-hidden"><div className="h-full bg-primary-500 transition-all" style={{ width: `${javaInstallProgress.pct}%` }} /></div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button onClick={() => installJava(requiredJava)} disabled={installingJava} className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
                  {installingJava ? <Loader2 size={12} className="animate-spin" /> : null} Install Java {requiredJava}
                </button>
                <span className="text-surface-500">or</span>
                <button onClick={refreshRuntimes} className="underline hover:no-underline">re-check if you already installed one</button>
              </div>
            )}
            <p className="text-[10px] text-surface-500">Downloads the real, official Eclipse Temurin (OpenJDK) build for Java {requiredJava} and installs it inside Mercy only — no system-wide changes.</p>
          </div>
        )}

        {compatibleRuntimes.length > 1 && (
          <div className="mt-3">
            <label className="text-[11px] text-surface-500 mb-1.5 block">Multiple compatible runtimes found — choose one:</label>
            <select value={selectedJavaPath || autoRuntime?.path || ''} onChange={(e) => setSelectedJavaPath(e.target.value)} className="input-field text-sm">
              {compatibleRuntimes.map((r) => (
                <option key={r.path} value={r.path}>Java {r.major} — {r.source}</option>
              ))}
            </select>
          </div>
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

      <Panel>
        <button onClick={() => setShowAdvanced((v) => !v)} className="w-full flex items-center justify-between text-left">
          <div>
            <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider block">World & Gameplay Settings</label>
            <p className="text-[11px] text-surface-600 mt-0.5">Seed, difficulty, game mode, and more — all editable later too.</p>
          </div>
          <ChevronDown size={16} className={`text-surface-500 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
        </button>
        {showAdvanced && (
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div className="col-span-2">
              <label className="text-[11px] font-semibold text-surface-400 mb-1.5 block">World Seed (optional)</label>
              <input value={seed} onChange={(e) => setSeed(e.target.value)} className="input-field text-sm" placeholder="Leave blank for a random world" />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-surface-400 mb-1.5 block">Game Mode</label>
              <select value={gamemode} onChange={(e) => setGamemode(e.target.value as any)} className="input-field text-sm py-2">
                {['survival', 'creative', 'adventure', 'spectator'].map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-surface-400 mb-1.5 block">Difficulty</label>
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as any)} className="input-field text-sm py-2">
                {['peaceful', 'easy', 'normal', 'hard'].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-[11px] font-semibold text-surface-400 mb-1.5 block">MOTD</label>
              <input value={motd} onChange={(e) => setMotd(e.target.value)} className="input-field text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-surface-400 mb-1.5 block">Max Players</label>
              <input type="number" min={1} value={maxPlayers} onChange={(e) => setMaxPlayers(parseInt(e.target.value) || 20)} className="input-field text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-surface-400 mb-1.5 block">View Distance</label>
              <input type="number" min={3} max={32} value={viewDistance} onChange={(e) => setViewDistance(parseInt(e.target.value) || 10)} className="input-field text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-surface-400 mb-1.5 block">Simulation Distance</label>
              <input type="number" min={3} max={32} value={simulationDistance} onChange={(e) => setSimulationDistance(parseInt(e.target.value) || 10)} className="input-field text-sm" />
            </div>
            <div className="flex items-center justify-between"><span className="text-xs text-surface-300">PvP</span><Toggle checked={pvp} onChange={setPvp} /></div>
            <div className="flex items-center justify-between"><span className="text-xs text-surface-300">Online Mode (verify accounts)</span><Toggle checked={onlineMode} onChange={setOnlineMode} /></div>
            <div className="flex items-center justify-between"><span className="text-xs text-surface-300">Hardcore</span><Toggle checked={hardcore} onChange={setHardcore} /></div>
            <div className="flex items-center justify-between"><span className="text-xs text-surface-300">Whitelist</span><Toggle checked={whitelist} onChange={setWhitelist} /></div>
          </div>
        )}
      </Panel>

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
