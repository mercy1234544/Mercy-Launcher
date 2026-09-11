import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import * as Tabs from '@radix-ui/react-tabs';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Blocks, ArrowLeft, Play, Square, RotateCcw, Loader2, Terminal, Settings2, Users,
  Archive, FolderOpen, LayoutDashboard, Cpu, MemoryStick, Clock, Hash, Save, Trash2,
  Download, RefreshCw, AlertTriangle, File as FileIcon, Folder, ChevronRight, Copy, Trash,
  Puzzle, ExternalLink, ShieldAlert, Power, Wifi, CheckCircle2, XCircle, Globe, Home, Gamepad2, ChevronDown,
  Map, Upload, PackageCheck, PackageX, Info,
} from 'lucide-react';
import { Panel, SectionHeading, Toggle, EmptyState } from '../components/ui';
import { useMinecraftStore } from '../stores/useMinecraftStore';
import toast from 'react-hot-toast';

const STATUS_META: Record<string, { label: string; dot: string; text: string }> = {
  running: { label: 'Online', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  starting: { label: 'Starting…', dot: 'bg-amber-400', text: 'text-amber-300' },
  stopping: { label: 'Stopping…', dot: 'bg-amber-400', text: 'text-amber-300' },
  stopped: { label: 'Offline', dot: 'bg-surface-600', text: 'text-surface-400' },
  error: { label: 'Error', dot: 'bg-red-400', text: 'text-red-300' },
};

function fmtUptime(ms: number | null): string {
  if (ms == null) return 'Not available';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

// Real, live per-process metrics — never a guessed/estimated value. `stats`
// is null while the server isn't running at all (nothing to measure);
// metricsAvailable=false means Windows itself couldn't be queried just now;
// cpuPercent=null with metricsAvailable=true means a real sample was taken
// but there's no PRIOR sample yet to diff against (the very first poll after
// start) — all three are distinct, honestly-labeled states, never conflated.
function fmtCpu(stats: { cpuPercent: number | null; metricsAvailable: boolean } | null): string {
  if (!stats) return 'Not available';
  if (!stats.metricsAvailable) return 'Unavailable';
  if (stats.cpuPercent == null) return 'Measuring…';
  return `${stats.cpuPercent.toFixed(1)}%`;
}
function fmtMemory(stats: { memoryBytes: number | null; metricsAvailable: boolean } | null): string {
  if (!stats) return 'Not available';
  if (!stats.metricsAvailable || stats.memoryBytes == null) return 'Unavailable';
  return `${(stats.memoryBytes / 1024 / 1024).toFixed(0)} MB`;
}

export default function MinecraftServerPanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { upsertServer } = useMinecraftStore();
  const [server, setServer] = useState<MinecraftServer | null>(null);
  const [busy, setBusy] = useState(false);
  const validTabs = ['overview', 'connect', 'console', 'properties', 'players', 'backups', 'files', 'content', 'worlds', 'packs', 'danger'];
  const requestedTab = searchParams.get('tab');
  const [tab, setTab] = useState(requestedTab && validTabs.includes(requestedTab) ? requestedTab : 'overview');

  const load = async () => {
    if (!id) return;
    const s = await window.electronAPI.minecraft.get(id);
    if (s) { setServer(s); upsertServer(s); }
  };
  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (!id) return;
    const cleanup = window.electronAPI.onMinecraftStatusChange((data) => {
      if (data.serverId !== id) return;
      load();
    });
    return cleanup;
  }, [id]);

  if (!server) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <Panel className="flex items-center justify-center py-16"><Loader2 size={20} className="animate-spin text-primary-400" /></Panel>
      </div>
    );
  }

  const meta = STATUS_META[server.status] || STATUS_META.stopped;
  const isRunning = server.status === 'running' || server.status === 'starting';

  const handleStart = async () => { setBusy(true); const r = await window.electronAPI.minecraft.start(server.id); if (!r.success) toast.error(r.error || 'Failed to start'); setBusy(false); load(); };
  const handleStop = async () => { setBusy(true); await window.electronAPI.minecraft.stop(server.id, false); setBusy(false); load(); };
  const handleForceStop = async () => { setBusy(true); await window.electronAPI.minecraft.stop(server.id, true); setBusy(false); load(); };
  const handleRestart = async () => { setBusy(true); await window.electronAPI.minecraft.restart(server.id); setBusy(false); load(); };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-5 max-w-5xl mx-auto pb-16">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/minecraft')} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors"><ArrowLeft size={16} /></button>
        <SectionHeading
          icon={Blocks} iconClass="bg-emerald-500/15 border-emerald-500/25 text-emerald-300"
          title={server.name}
          subtitle={server.edition === 'bedrock' ? `${server.version} · Bedrock Edition` : `${server.version} · ${server.serverType === 'paper' ? 'Paper' : 'Vanilla'}`}
          action={
            <div className="flex items-center gap-2">
              <span className={`flex items-center gap-1.5 text-xs font-semibold ${meta.text}`}><span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} /> {meta.label}</span>
              {!isRunning ? (
                <button onClick={handleStart} disabled={busy} className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5">{busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Start</button>
              ) : (
                <>
                  <button onClick={handleRestart} disabled={busy} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><RotateCcw size={13} /> Restart</button>
                  <button onClick={handleStop} disabled={busy} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><Square size={13} /> Stop</button>
                  <button onClick={handleForceStop} disabled={busy} className="p-2 rounded-lg text-surface-500 hover:text-error hover:bg-overlay-6 transition-colors" title="Force stop"><AlertTriangle size={14} /></button>
                </>
              )}
            </div>
          }
        />
      </div>

      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="flex flex-wrap gap-1 mb-4" aria-label="Server management">
          {[
            { id: 'overview', label: 'Overview', icon: LayoutDashboard },
            { id: 'connect', label: 'Connect', icon: Wifi },
            { id: 'console', label: 'Console', icon: Terminal },
            { id: 'properties', label: 'Properties', icon: Settings2 },
            { id: 'players', label: 'Players', icon: Users },
            { id: 'backups', label: 'Backups', icon: Archive },
            { id: 'files', label: 'Files', icon: FolderOpen },
            { id: 'content', label: server.edition === 'bedrock' ? 'Content' : server.serverType === 'paper' ? 'Mods & Plugins' : 'Datapacks', icon: Puzzle },
            { id: 'worlds', label: 'World', icon: Map },
            ...(server.edition === 'bedrock' ? [{ id: 'packs', label: 'Packs', icon: PackageCheck }] : []),
          ].map((t) => (
            <Tabs.Trigger key={t.id} value={t.id}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors outline-none ${tab === t.id ? 'bg-primary-600/15 text-primary-300 border border-primary-500/25' : 'text-surface-400 hover:text-surface-200 hover:bg-overlay-4 border border-transparent'}`}>
              <t.icon size={13} /> {t.label}
            </Tabs.Trigger>
          ))}
          <Tabs.Trigger value="danger"
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors outline-none ml-auto ${tab === 'danger' ? 'bg-error-bg text-error border border-error/25' : 'text-surface-500 hover:text-error hover:bg-error-bg border border-transparent'}`}>
            <ShieldAlert size={13} /> Delete
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="overview" className="outline-none"><OverviewTab server={server} onChange={load} /></Tabs.Content>
        <Tabs.Content value="connect" className="outline-none"><ConnectTab server={server} /></Tabs.Content>
        <Tabs.Content value="console" className="outline-none"><ConsoleTab server={server} isRunning={isRunning} /></Tabs.Content>
        <Tabs.Content value="properties" className="outline-none"><PropertiesTab server={server} onChange={load} /></Tabs.Content>
        <Tabs.Content value="players" className="outline-none"><PlayersTab server={server} isRunning={isRunning} /></Tabs.Content>
        <Tabs.Content value="backups" className="outline-none"><BackupsTab server={server} /></Tabs.Content>
        <Tabs.Content value="files" className="outline-none"><FilesTab server={server} /></Tabs.Content>
        <Tabs.Content value="content" className="outline-none"><ContentTab server={server} /></Tabs.Content>
        <Tabs.Content value="worlds" className="outline-none"><WorldsTab server={server} isRunning={isRunning} /></Tabs.Content>
        {server.edition === 'bedrock' && (
          <Tabs.Content value="packs" className="outline-none"><PacksTab server={server} /></Tabs.Content>
        )}
        <Tabs.Content value="danger" className="outline-none"><DangerZoneTab server={server} /></Tabs.Content>
      </Tabs.Root>
    </motion.div>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────
function OverviewTab({ server, onChange }: { server: MinecraftServer; onChange: () => void }) {
  const [stats, setStats] = useState<{
    pid: number | null; uptimeMs: number | null;
    cpuPercent: number | null; memoryBytes: number | null;
    metricsAvailable: boolean; metricsError?: string;
  } | null>(null);
  const isRunningNow = server.status === 'running' || server.status === 'starting';
  useEffect(() => {
    // Only poll while there's an actual process to measure — stopped/error
    // servers have nothing to query, and polling them would just burn a
    // PowerShell spawn every tick for no reason. Clearing stats on stop
    // also means a real "not running" state is shown immediately rather
    // than the last-seen numbers lingering after the process exits.
    if (!isRunningNow) { setStats(null); return; }
    let alive = true;
    const poll = () => window.electronAPI.minecraft.processStats(server.id).then((s) => alive && setStats(s)).catch(() => {});
    poll();
    const t = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [server.id, isRunningNow]);

  const toggleAutoRestart = async (v: boolean) => { await window.electronAPI.minecraft.setAutoRestart(server.id, v); onChange(); };

  const [javaCheck, setJavaCheck] = useState<{ ok: boolean; required: number; javaPath: string | null; major: number | null; error?: string } | null>(null);
  const [allRuntimes, setAllRuntimes] = useState<{ path: string; version: string; major: number; source: string }[]>([]);
  const isBedrock = server.edition === 'bedrock';
  const refreshJava = () => {
    if (isBedrock) return; // Bedrock never touches Java — nothing to resolve.
    window.electronAPI.minecraft.resolveLaunchJava(server.id).then(setJavaCheck).catch(() => setJavaCheck(null));
    window.electronAPI.minecraft.detectAllJava().then(setAllRuntimes).catch(() => setAllRuntimes([]));
  };
  useEffect(refreshJava, [server.id, server.javaPath, server.status]);
  const compatibleRuntimes = javaCheck ? allRuntimes.filter((r) => r.major >= javaCheck.required).sort((a, b) => a.major - b.major) : [];
  const pinRuntime = async (p: string) => { await window.electronAPI.minecraft.setJavaPath(server.id, p || null); refreshJava(); onChange(); };

  const [installingJava, setInstallingJava] = useState(false);
  const [javaInstallProgress, setJavaInstallProgress] = useState<{ pct: number; message: string } | null>(null);
  const installJava = async (major: number) => {
    setInstallingJava(true);
    const cleanup = window.electronAPI.onMinecraftInstallJavaProgress(setJavaInstallProgress);
    try {
      const result = await window.electronAPI.minecraft.installJava(major);
      if (result.success) { toast.success(`Java ${major} installed`); refreshJava(); }
      else toast.error(result.error || `Failed to install Java ${major}`);
    } catch (e: any) {
      toast.error(e?.message || `Failed to install Java ${major}`);
    } finally {
      cleanup?.(); setInstallingJava(false); setJavaInstallProgress(null);
    }
  };

  const cards = [
    { icon: Hash, label: 'PID', value: stats?.pid ?? server.pid ?? 'Not available' },
    { icon: Clock, label: 'Uptime', value: fmtUptime(stats?.uptimeMs ?? null) },
    { icon: Cpu, label: 'CPU', value: fmtCpu(stats) },
    { icon: MemoryStick, label: 'Memory Used', value: fmtMemory(stats) },
    // Bedrock has no JVM heap to allocate — its memory use isn't tuned via
    // a RAM setting the way Java's -Xmx is, so this card is meaningless there.
    ...(isBedrock ? [] : [{ icon: MemoryStick, label: 'RAM Allocated', value: `${server.ramMB} MB` }]),
  ];

  return (
    <div className="space-y-4">
      {server.status === 'error' && server.lastError && (
        <Panel className="border-error/30 bg-error-bg">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={16} className="text-error shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-error">Server stopped unexpectedly</p>
              <p className="text-xs text-surface-300 mt-1">{server.lastError}</p>
            </div>
          </div>
        </Panel>
      )}
      <div className={`grid gap-4 ${cards.length >= 5 ? 'grid-cols-5' : 'grid-cols-4'}`}>
        {cards.map((c) => (
          <Panel key={c.label} padding="sm">
            <c.icon size={15} className="text-surface-500 mb-2" />
            <p className="text-sm font-bold text-surface-100">{c.value}</p>
            <p className="text-[10px] text-surface-500 mt-0.5">{c.label}</p>
          </Panel>
        ))}
      </div>
      {!isBedrock && (
      <Panel>
        <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Java Runtime</p>
        {javaCheck && (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-surface-400">Required Java</span>
              <span className="font-mono font-semibold text-surface-100">Java {javaCheck.required}</span>
            </div>
            <div className="flex items-center justify-between text-sm mt-2">
              <span className="text-surface-400">Selected Runtime</span>
              <span className={`font-mono font-semibold ${javaCheck.ok ? 'text-success' : 'text-error'}`}>
                {javaCheck.major != null ? `Java ${javaCheck.major}` : 'None found'} {javaCheck.ok ? '✓' : '❌'}
              </span>
            </div>
            {!javaCheck.ok && javaCheck.error && (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-error flex items-start gap-1.5"><AlertTriangle size={12} className="shrink-0 mt-0.5" /> {javaCheck.error}</p>
                {javaInstallProgress ? (
                  <div>
                    <div className="flex items-center justify-between mb-1 text-[11px] text-surface-400"><span>{javaInstallProgress.message}</span><span>{javaInstallProgress.pct}%</span></div>
                    <div className="w-full h-1.5 bg-overlay-6 rounded-full overflow-hidden"><div className="h-full bg-primary-500 transition-all" style={{ width: `${javaInstallProgress.pct}%` }} /></div>
                  </div>
                ) : (
                  <button onClick={() => installJava(javaCheck.required)} disabled={installingJava} className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
                    {installingJava ? <Loader2 size={12} className="animate-spin" /> : null} Install Java {javaCheck.required}
                  </button>
                )}
              </div>
            )}
            {compatibleRuntimes.length > 1 && (
              <div className="mt-3">
                <label className="text-[11px] text-surface-500 mb-1.5 block">Pin a specific runtime (multiple compatible ones found):</label>
                <select value={server.javaPath || ''} onChange={(e) => pinRuntime(e.target.value)} className="input-field text-sm py-2">
                  <option value="">Auto-select ({compatibleRuntimes[0].major})</option>
                  {compatibleRuntimes.map((r) => <option key={r.path} value={r.path}>Java {r.major} — {r.source}</option>)}
                </select>
              </div>
            )}
          </>
        )}
      </Panel>
      )}
      <Panel>
        <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Server Details</p>
        <div className="grid grid-cols-2 gap-x-8 gap-y-4">
          {[
            { label: 'Version', value: server.version }, { label: 'Server Type', value: server.serverType === 'bedrock' ? 'Bedrock' : server.serverType === 'paper' ? 'Paper' : 'Vanilla' },
            { label: 'Port', value: String(server.port) }, { label: 'Directory', value: server.installPath },
            ...(isBedrock ? [] : [{ label: 'Jar File', value: server.jarFile }]),
            { label: 'Created', value: new Date(server.createdAt).toLocaleString() },
          ].map((r) => (
            <div key={r.label} className="min-w-0"><p className="text-[10px] text-surface-500 uppercase tracking-wider mb-0.5">{r.label}</p><p className="text-sm text-surface-200 font-medium truncate">{r.value}</p></div>
          ))}
        </div>
      </Panel>
      <Panel className="flex items-center gap-4">
        <div className="flex-1"><p className="text-sm font-semibold text-surface-100">Auto-restart on crash</p><p className="text-xs text-surface-500 mt-0.5">Only restarts after an unexpected exit — never after a normal Stop.</p></div>
        <Toggle checked={server.autoRestart} onChange={toggleAutoRestart} />
      </Panel>
    </div>
  );
}

// ── Connect ───────────────────────────────────────────────────────────────
const STATUS_CONNECT_META: Record<string, { label: string; className: string }> = {
  running: { label: 'Server online', className: 'text-success' },
  starting: { label: 'Server starting…', className: 'text-warning' },
  stopping: { label: 'Server stopping…', className: 'text-warning' },
  stopped: { label: 'Server offline', className: 'text-surface-500' },
  error: { label: 'Server error', className: 'text-error' },
};

function copyToClipboard(text: string, label: string) {
  navigator.clipboard.writeText(text);
  toast.success(`${label} copied`);
}

function ConnectTab({ server }: { server: MinecraftServer }) {
  const [info, setInfo] = useState<MinecraftConnectionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDetails, setShowDetails] = useState(false);

  const load = () => window.electronAPI.minecraft.connectionInfo(server.id).then((i) => { setInfo(i); setLoading(false); }).catch(() => setLoading(false));
  // Recomputed live on every poll and whenever the server's own record
  // changes (port/version/type edits — PropertiesTab now calls the parent's
  // onChange() on save, so a port change lands here immediately rather than
  // waiting for the next 5s tick) — never a cached snapshot, so it can't go
  // stale after a Properties change or a status transition.
  useEffect(() => { setLoading(true); load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [server.id, server.port, server.version, server.serverType, server.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading || !info) {
    return <Panel className="flex items-center justify-center py-16"><Loader2 size={20} className="animate-spin text-primary-400" /></Panel>;
  }

  const isBedrock = info.edition === 'bedrock';
  const statusMeta = STATUS_CONNECT_META[info.status] || STATUS_CONNECT_META.stopped;
  const localAddress = `127.0.0.1:${info.port}`;
  // The one address a normal user should actually use: the LAN address when
  // one exists (so friends on the same network can join too), falling back
  // to localhost — same precedence the old Copy IP:Port button already used.
  // NEVER a fabricated public address — info.lanAddress is null (not a
  // placeholder) when nothing real was detected, exactly as getConnectionInfo
  // already guarantees.
  const primaryAddress = info.lanAddress || localAddress;
  // Address alone, with no port baked in — primaryAddress is always
  // "ip:port" (see localAddress/info.lanAddress above), so splitting on the
  // colon is safe here (these are always IPv4 addresses, never IPv6).
  const primaryIp = primaryAddress.split(':')[0];
  const typeLabel = info.serverType === 'bedrock' ? 'Bedrock Edition' : info.serverType === 'paper' ? 'Paper' : 'Vanilla';

  // Real reachability, from the SAME live checks as before (TCP port-connect
  // for Java, RakNet Unconnected Ping for Bedrock) — just reduced here to a
  // single tri-state (true/false/null="nothing to check yet") the primary
  // panel can show as one line, with the full explanation still available
  // in the details section below.
  const reachable = isBedrock ? (info.raknet?.checked ? info.raknet.reachable : null) : info.portListening;
  const reachabilityNote = isBedrock
    ? info.raknet?.note ?? null
    : info.portListening !== null
      ? (info.portListening
          ? `Port ${info.port} is listening — verified with a real connection just now.`
          : info.status === 'starting'
            ? `Port ${info.port} isn't accepting connections yet — still starting up.`
            : info.status === 'stopping'
              ? `Port ${info.port} is no longer accepting connections — shutting down.`
              : `Port ${info.port} is NOT accepting connections — the process is running but something is wrong.`)
      : null;

  return (
    <div className="space-y-3">
      {/* PRIMARY: everything a normal Minecraft player needs, one glance. */}
      <Panel>
        <div className="flex items-center justify-between mb-4">
          <span className={`flex items-center gap-1.5 text-xs font-semibold ${statusMeta.className}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${info.status === 'running' ? 'bg-emerald-400' : info.status === 'error' ? 'bg-red-400' : 'bg-surface-600'}`} />
            {statusMeta.label}
          </span>
          <span className="text-xs text-surface-500">{isBedrock ? 'Bedrock Edition' : typeLabel} · {info.version}</span>
        </div>

        {/* Address and Port are always shown as separate fields — the port
            is never hardcoded, it's read fresh from info.port (itself
            always the server's real, current configured port) on every
            render, so it updates everywhere the moment it changes. */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[10px] text-surface-500 uppercase tracking-wider mb-1.5">Server Address</p>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 bg-overlay-3 border border-overlay-6 rounded-xl px-4 py-3">
                <p className="font-mono text-lg font-bold text-surface-100 truncate">{primaryIp}</p>
              </div>
              <button onClick={() => copyToClipboard(primaryIp, 'Address')} className="btn-secondary px-3.5 py-3 shrink-0" title="Copy Address"><Copy size={15} /></button>
            </div>
          </div>
          <div>
            <p className="text-[10px] text-surface-500 uppercase tracking-wider mb-1.5">Port{isBedrock ? ' (UDP)' : ''}</p>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 bg-overlay-3 border border-overlay-6 rounded-xl px-4 py-3">
                <p className="font-mono text-lg font-bold text-surface-100 truncate">{info.port}</p>
              </div>
              <button onClick={() => copyToClipboard(String(info.port), 'Port')} className="btn-secondary px-3.5 py-3 shrink-0" title="Copy Port"><Copy size={15} /></button>
            </div>
          </div>
        </div>
        {!info.lanAddress && (
          <p className="text-[11px] text-surface-600 mt-1.5">Showing this computer's own address — no LAN network was detected, so this only works for players on this same PC.</p>
        )}

        <p className="text-[10px] text-surface-500 uppercase tracking-wider mt-4 mb-1.5">Full Address</p>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 bg-overlay-3 border border-overlay-6 rounded-xl px-4 py-2.5">
            <p className="font-mono text-sm text-surface-200 truncate">{primaryAddress}</p>
          </div>
          <button onClick={() => copyToClipboard(primaryAddress, 'Full address')} className="btn-primary px-4 py-2.5 flex items-center gap-1.5 shrink-0"><Copy size={14} /> Copy</button>
        </div>

        <p className="text-[10px] text-surface-500 uppercase tracking-wider mt-4 mb-1.5">How to Join</p>
        {isBedrock ? (
          <ol className="space-y-1 text-sm text-surface-300">
            <li>1. Open Minecraft (Bedrock) → <strong>Play</strong> → <strong>Servers</strong> → <strong>Add Server</strong></li>
            <li>2. Address <span className="font-mono bg-overlay-6 px-1.5 py-0.5 rounded">{primaryIp}</span>, Port <span className="font-mono bg-overlay-6 px-1.5 py-0.5 rounded">{info.port}</span></li>
            <li>3. Select the server and join</li>
          </ol>
        ) : (
          <ol className="space-y-1 text-sm text-surface-300">
            <li>1. Open Minecraft: Java Edition {info.version} → <strong>Multiplayer</strong> → <strong>Add Server</strong></li>
            <li>2. Server Address: <span className="font-mono bg-overlay-6 px-1.5 py-0.5 rounded">{primaryAddress}</span> <span className="text-surface-500">(address and port together — Java's own client takes one combined field)</span></li>
            <li>3. Select the server and click <strong>Join Server</strong></li>
          </ol>
        )}
      </Panel>

      <button onClick={() => setShowDetails((v) => !v)} className="flex items-center gap-1.5 text-xs font-semibold text-surface-500 hover:text-surface-200 transition-colors px-1">
        <ChevronDown size={13} className={`transition-transform ${showDetails ? 'rotate-180' : ''}`} /> {showDetails ? 'Hide' : 'Show'} technical details
      </button>

      {/* SECONDARY: the same real detection/data as before, just tucked away
          so it doesn't compete with the instructions above for attention. */}
      {showDetails && (
        <div className="space-y-3">
          <Panel>
            <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-2">Connection Check</p>
            {reachabilityNote ? (
              <p className={`text-xs flex items-center gap-1.5 ${reachable ? 'text-success' : 'text-error'}`}>
                {reachable ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {reachabilityNote}
              </p>
            ) : (
              <p className="text-xs text-surface-500 flex items-center gap-1.5"><XCircle size={13} /> Connection unavailable — start the server first.</p>
            )}
          </Panel>

          <Panel>
            <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Server Details</p>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div><p className="text-[10px] text-surface-500 uppercase tracking-wider mb-0.5">Name</p><p className="text-sm text-surface-200 font-medium">{info.serverName}</p></div>
              <div><p className="text-[10px] text-surface-500 uppercase tracking-wider mb-0.5">Type</p><p className="text-sm text-surface-200 font-medium">{typeLabel}</p></div>
              <div><p className="text-[10px] text-surface-500 uppercase tracking-wider mb-0.5">Minecraft Version</p><p className="text-sm text-surface-200 font-medium">{info.version}</p></div>
              <div><p className="text-[10px] text-surface-500 uppercase tracking-wider mb-0.5">Edition</p><p className="text-sm text-surface-200 font-medium">{isBedrock ? 'Bedrock Edition' : 'Java Edition'}</p></div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-overlay-3 border border-overlay-6">
                <Home size={14} className="text-surface-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-surface-500">This computer{isBedrock ? ' (UDP)' : ''}</p>
                  <p className="text-sm font-mono text-surface-100 truncate">{localAddress}</p>
                </div>
                <button onClick={() => copyToClipboard(localAddress, 'Address')} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors" title="Copy address"><Copy size={13} /></button>
              </div>

              {info.lanAddress ? (
                <div className="flex items-center gap-2 p-2.5 rounded-lg bg-overlay-3 border border-overlay-6">
                  <Wifi size={14} className="text-primary-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-surface-500">LAN connection{isBedrock ? ' (UDP)' : ''} — other devices on this network</p>
                    <p className="text-sm font-mono text-surface-100 truncate">{info.lanAddress}</p>
                  </div>
                  <button onClick={() => copyToClipboard(info.lanAddress!, 'LAN address')} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors" title="Copy address"><Copy size={13} /></button>
                </div>
              ) : (
                <div className="flex items-center gap-2 p-2.5 rounded-lg bg-overlay-3 border border-overlay-6 text-xs text-surface-500">
                  <Wifi size={14} className="shrink-0" /> No LAN network address could be detected on this machine.
                </div>
              )}

              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-overlay-4 border border-overlay-8 text-xs text-surface-400">
                <Globe size={14} className="shrink-0 mt-0.5 text-surface-500" />
                <span>
                  <strong className="text-surface-300">Public/internet access is not configured.</strong> Mercy cannot detect or guarantee this automatically — a public IP alone doesn't mean the port is reachable.
                  To let people outside your network join, forward port <span className="font-mono">{info.port}</span> ({isBedrock ? 'UDP' : 'TCP'}) on your router to this computer, or use a tunneling service (e.g. playit.gg, ngrok), then share that address instead.
                </span>
              </div>
            </div>
          </Panel>

          {!isBedrock && (
            <Panel className={info.bedrock.possible ? 'border-primary-500/20' : ''}>
              <div className="flex items-center gap-2 mb-2">
                <Gamepad2 size={14} className={info.bedrock.possible ? 'text-primary-400' : 'text-surface-500'} />
                <p className="text-xs font-bold text-surface-400 uppercase tracking-wider">Bedrock Clients via Geyser</p>
              </div>
              <p className="text-xs text-surface-400">{info.bedrock.note}</p>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}

// ── Console ───────────────────────────────────────────────────────────────
function ConsoleTab({ server, isRunning }: { server: MinecraftServer; isRunning: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.electronAPI.minecraft.consoleBuffer(server.id).then(setLines).catch(() => {});
    const cleanup = window.electronAPI.onMinecraftConsole((data) => {
      if (data.serverId !== server.id) return;
      setLines((prev) => [...prev.slice(-1999), data.line]);
    });
    return cleanup;
  }, [server.id]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, autoScroll]);

  const send = () => {
    if (!command.trim() || !isRunning) return;
    window.electronAPI.minecraft.sendCommand(server.id, command.trim());
    setCommand('');
  };

  const filtered = search ? lines.filter((l) => l.toLowerCase().includes(search.toLowerCase())) : lines;
  const copyLogs = () => { navigator.clipboard.writeText(lines.join('\n')); toast.success('Copied console output'); };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search console output…" className="input-field flex-1 text-xs py-2" />
        <button onClick={() => setAutoScroll((v) => !v)} className={`btn-secondary text-xs py-2 px-3 ${autoScroll ? 'text-primary-300' : ''}`}>Auto-scroll</button>
        <button onClick={copyLogs} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><Copy size={12} /> Copy</button>
        <button onClick={() => setLines([])} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><Trash size={12} /> Clear</button>
      </div>
      <div ref={scrollRef} className="h-96 overflow-y-auto rounded-xl border border-overlay-6 bg-black/40 p-3 font-mono text-[11px] leading-relaxed">
        {filtered.length === 0 ? (
          <p className="text-surface-600">{isRunning ? 'Waiting for output…' : 'Server is offline — start it to see live console output.'}</p>
        ) : filtered.map((line, i) => (
          <div key={i} className={line.includes('[ERROR]') ? 'text-red-400' : 'text-surface-300'}>{line}</div>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()}
          disabled={!isRunning} placeholder={isRunning ? 'Type a command (e.g. say hello, whitelist add Steve)…' : 'Server must be running to send commands'}
          className="input-field flex-1 font-mono text-xs disabled:opacity-50" />
        <button onClick={send} disabled={!isRunning || !command.trim()} className="btn-primary text-xs px-4 disabled:opacity-40">Send</button>
      </div>
    </div>
  );
}

// ── Properties ────────────────────────────────────────────────────────────
const JAVA_PROPERTY_HINTS: Record<string, { label: string; type: 'bool' | 'number' | 'select' | 'text'; options?: string[] }> = {
  motd: { label: 'MOTD', type: 'text' },
  gamemode: { label: 'Game Mode', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
  difficulty: { label: 'Difficulty', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  'max-players': { label: 'Max Players', type: 'number' },
  'online-mode': { label: 'Online Mode (verify accounts)', type: 'bool' },
  pvp: { label: 'PvP', type: 'bool' },
  'view-distance': { label: 'View Distance', type: 'number' },
  'simulation-distance': { label: 'Simulation Distance', type: 'number' },
  'spawn-protection': { label: 'Spawn Protection Radius', type: 'number' },
  'allow-flight': { label: 'Allow Flight', type: 'bool' },
  'white-list': { label: 'Whitelist Enabled', type: 'bool' },
  'enable-command-block': { label: 'Command Blocks', type: 'bool' },
  'server-port': { label: 'Server Port', type: 'number' },
};

// Bedrock's server.properties uses a different (if partially overlapping)
// key set — no simulation-distance, no Java-style whitelist terminology,
// its own cheats/permission concepts — sourced from Microsoft's own
// Bedrock Dedicated Server properties reference, not guessed from Java's.
// Any key not listed here (including ones from future Bedrock versions)
// still shows up in the generic "Other Properties" section below, exactly
// like an unrecognized Java key does — nothing is ever hidden or dropped.
const BEDROCK_PROPERTY_HINTS: Record<string, { label: string; type: 'bool' | 'number' | 'select' | 'text'; options?: string[] }> = {
  'server-name': { label: 'Server Name', type: 'text' },
  gamemode: { label: 'Game Mode', type: 'select', options: ['survival', 'creative', 'adventure'] },
  difficulty: { label: 'Difficulty', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  'allow-cheats': { label: 'Allow Cheats', type: 'bool' },
  'max-players': { label: 'Max Players', type: 'number' },
  'online-mode': { label: 'Require Xbox Live Sign-in', type: 'bool' },
  'allow-list': { label: 'Allow-list Only', type: 'bool' },
  'server-port': { label: 'Server Port (IPv4)', type: 'number' },
  'server-portv6': { label: 'Server Port (IPv6)', type: 'number' },
  'view-distance': { label: 'View Distance', type: 'number' },
  'tick-distance': { label: 'Tick Distance', type: 'number' },
  'player-idle-timeout': { label: 'Player Idle Timeout (minutes)', type: 'number' },
  'default-player-permission-level': { label: 'Default Player Permission', type: 'select', options: ['visitor', 'member', 'operator'] },
  'texturepack-required': { label: 'Require Resource Pack', type: 'bool' },
  'level-name': { label: 'Level Name', type: 'text' },
};

function PropertiesTab({ server, onChange }: { server: MinecraftServer; onChange: () => void }) {
  const HINTS = server.edition === 'bedrock' ? BEDROCK_PROPERTY_HINTS : JAVA_PROPERTY_HINTS;
  const [entries, setEntries] = useState<{ key: string; value: string; isComment: boolean; raw: string }[]>([]);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = () => { setLoading(true); window.electronAPI.minecraft.readProperties(server.id).then((e) => { setEntries(e); setEdited({}); }).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, [server.id]);

  const known = entries.filter((e) => !e.isComment && HINTS[e.key]);
  const unknown = entries.filter((e) => !e.isComment && !HINTS[e.key]);

  const valueOf = (key: string, fallback: string) => edited[key] ?? fallback;
  const setValue = (key: string, value: string) => setEdited((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    if (Object.keys(edited).length === 0) return;
    setSaving(true);
    const result = await window.electronAPI.minecraft.writeProperties(server.id, edited);
    setSaving(false);
    if (result.success) {
      toast.success('server.properties saved — restart the server to apply changes');
      load();
      // Refreshes the PARENT's server record too (port/etc.) — without this,
      // e.g. a changed port stayed stale everywhere outside this tab
      // (Connect, Server Details, the header) until the next full page
      // load, even though the registry itself was already updated.
      onChange();
    }
    else toast.error(result.error || 'Failed to save');
  };

  if (loading) return <Panel className="flex items-center justify-center py-12"><Loader2 size={18} className="animate-spin text-primary-400" /></Panel>;
  if (entries.length === 0) return <Panel><EmptyState icon={Settings2} title="No server.properties found" description="This server hasn't generated its properties file yet — start it once to create one." /></Panel>;

  return (
    <div className="space-y-4">
      <Panel>
        <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Common Settings</p>
        <div className="grid grid-cols-2 gap-4">
          {known.map(({ key, value }) => {
            const hint = HINTS[key];
            const current = valueOf(key, value);
            return (
              <div key={key}>
                <label className="text-[11px] font-semibold text-surface-400 mb-1.5 block">{hint.label}</label>
                {hint.type === 'bool' ? (
                  <Toggle checked={current === 'true'} onChange={(v) => setValue(key, String(v))} />
                ) : hint.type === 'select' ? (
                  <select value={current} onChange={(e) => setValue(key, e.target.value)} className="input-field text-sm py-2">
                    {hint.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input value={current} onChange={(e) => setValue(key, e.target.value)} type={hint.type === 'number' ? 'number' : 'text'} className="input-field text-sm py-2" />
                )}
              </div>
            );
          })}
        </div>
      </Panel>
      {unknown.length > 0 && (
        <Panel>
          <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-1">Other Properties</p>
          <p className="text-[11px] text-surface-500 mb-3">{unknown.length} additional propert{unknown.length === 1 ? 'y is' : 'ies are'} preserved as-is and won't be touched by Mercy.</p>
          <div className="grid grid-cols-2 gap-2">
            {unknown.map(({ key, value }) => (
              <div key={key} className="text-[11px] font-mono text-surface-500 truncate">{key}={value}</div>
            ))}
          </div>
        </Panel>
      )}
      <div className="flex justify-end">
        <button onClick={save} disabled={saving || Object.keys(edited).length === 0} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-40">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save Properties
        </button>
      </div>
    </div>
  );
}

// ── Players (derived from real console join/leave lines) ───────────────────
function PlayersTab({ server, isRunning }: { server: MinecraftServer; isRunning: boolean }) {
  const [players, setPlayers] = useState<{ name: string; online: boolean; lastSeen: string }[]>([]);
  useEffect(() => {
    let alive = true;
    const poll = () => window.electronAPI.minecraft.players(server.id).then((p) => alive && setPlayers(p)).catch(() => {});
    poll();
    const t = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [server.id]);

  const online = players.filter((p) => p.online);

  return (
    <Panel>
      <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-1">Players</p>
      <p className="text-[11px] text-surface-500 mb-4">Derived from this server's own console output (join/leave messages) — no query protocol or RCON required. UUIDs aren't available this way.</p>
      {!isRunning ? (
        <EmptyState icon={Users} title="Server is offline" description="Start the server to see who's online." />
      ) : online.length === 0 ? (
        <EmptyState icon={Users} title="No players online" description={players.length > 0 ? `${players.length} known player${players.length === 1 ? '' : 's'} from this session, currently offline.` : "Nobody has joined yet this session."} />
      ) : (
        <div className="space-y-2">
          {online.map((p) => (
            <div key={p.name} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-overlay-3 border border-overlay-6">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
              <p className="text-sm font-semibold text-surface-100 flex-1">{p.name}</p>
              <p className="text-[10px] text-surface-500">Online</p>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── Backups ───────────────────────────────────────────────────────────────
function BackupsTab({ server }: { server: MinecraftServer }) {
  const [backups, setBackups] = useState<MinecraftBackup[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = () => window.electronAPI.minecraft.listBackups(server.id).then(setBackups).finally(() => setLoading(false));
  useEffect(() => { load(); }, [server.id]);

  const create = async () => {
    setCreating(true);
    const result = await window.electronAPI.minecraft.createBackup(server.id);
    setCreating(false);
    if (result.success) { toast.success('Backup created'); load(); } else toast.error(result.error || 'Backup failed');
  };
  const restore = async (id: string) => {
    const result = await window.electronAPI.minecraft.restoreBackup(id);
    if (result.success) toast.success('Backup restored'); else toast.error(result.error || 'Restore failed');
  };
  const del = async (id: string) => { await window.electronAPI.minecraft.deleteBackup(id); load(); };
  const fmtSize = (b: number) => b > 1024 * 1024 * 1024 ? `${(b / 1024 / 1024 / 1024).toFixed(2)} GB` : `${(b / 1024 / 1024).toFixed(1)} MB`;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={create} disabled={creating} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-60">
          {creating ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />} {creating ? 'Backing up…' : 'Create Backup'}
        </button>
      </div>
      {loading ? (
        <Panel className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-primary-400" /></Panel>
      ) : backups.length === 0 ? (
        <Panel><EmptyState icon={Archive} title="No backups yet" description="Create a backup before making risky changes to properties or the world." /></Panel>
      ) : (
        <div className="space-y-2">
          {backups.slice().reverse().map((b) => (
            <Panel key={b.id} padding="sm" className="flex items-center gap-3">
              <Archive size={16} className="text-primary-300 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-surface-100 truncate">{b.name}</p>
                <p className="text-[11px] text-surface-500">{new Date(b.createdAt).toLocaleString()} · {fmtSize(b.size)}</p>
              </div>
              <button onClick={() => restore(b.id)} className="btn-secondary text-xs py-1.5 px-2.5">Restore</button>
              <button onClick={() => del(b.id)} className="p-1.5 rounded-lg text-surface-500 hover:text-error hover:bg-overlay-6 transition-colors"><Trash2 size={13} /></button>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Files (restricted to this server's directory) ───────────────────────────
function FilesTab({ server }: { server: MinecraftServer }) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<{ name: string; path: string; type: 'file' | 'directory'; size: number }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  const load = (p: string) => {
    setLoading(true);
    window.electronAPI.minecraft.listFiles(server.id, p).then((e) => setEntries(e || [])).finally(() => setLoading(false));
  };
  useEffect(() => { load(path); }, [server.id, path]);

  const openFile = async (relPath: string) => {
    const c = await window.electronAPI.minecraft.readFile(server.id, relPath);
    if (c === null) { toast.error('Could not open this file (it may be binary).'); return; }
    setEditing(relPath); setContent(c);
  };
  const saveFile = async () => {
    if (!editing) return;
    const ok = await window.electronAPI.minecraft.writeFile(server.id, editing, content);
    if (ok) toast.success('File saved'); else toast.error('Failed to save file');
  };

  if (editing) {
    return (
      <Panel>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-bold text-surface-100 font-mono">{editing}</p>
          <div className="flex gap-2">
            <button onClick={() => setEditing(null)} className="btn-secondary text-xs py-1.5 px-3">Close</button>
            <button onClick={saveFile} className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"><Save size={12} /> Save</button>
          </div>
        </div>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false}
          className="w-full h-96 rounded-xl border border-overlay-6 bg-black/40 p-3 font-mono text-xs text-surface-200 resize-none focus:outline-none focus:border-primary-500/40" />
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="flex items-center gap-1.5 text-xs text-surface-500 mb-3">
        <button onClick={() => setPath('')} className="hover:text-primary-300">Server Root</button>
        {path.split(/[\\/]/).filter(Boolean).map((seg, i, arr) => (
          <React.Fragment key={i}>
            <ChevronRight size={12} />
            <button onClick={() => setPath(arr.slice(0, i + 1).join('/'))} className="hover:text-primary-300">{seg}</button>
          </React.Fragment>
        ))}
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-primary-400" /></div>
      ) : entries.length === 0 ? (
        <EmptyState icon={FolderOpen} title="Empty folder" />
      ) : (
        <div className="space-y-1">
          {entries.map((e) => (
            <button key={e.path} onClick={() => (e.type === 'directory' ? setPath(e.path) : openFile(e.path))}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-overlay-4 transition-colors text-left">
              {e.type === 'directory' ? <Folder size={15} className="text-amber-300 shrink-0" /> : <FileIcon size={15} className="text-surface-500 shrink-0" />}
              <span className="text-sm text-surface-200 flex-1 truncate">{e.name}</span>
              {e.type === 'file' && <span className="text-[10px] text-surface-600">{(e.size / 1024).toFixed(1)} KB</span>}
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── Drag-and-drop Content import (Part 4) — real content-based detection
// (see MinecraftManager.detectMinecraftContent) shown BEFORE anything is
// installed, then dispatched to whichever real, existing/new install method
// actually matches what was found. Never claims success for a format Mercy
// only stores rather than truly installs (structures/schematics/functions).
type DetectResult = Awaited<ReturnType<typeof window.electronAPI.minecraft.detectContent>>;

function ContentDropZone({ server, onImported }: { server: MinecraftServer; onImported: () => void }) {
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detected, setDetected] = useState<{ filePath: string; result: DetectResult } | null>(null);

  const handleFile = async (filePath: string) => {
    setBusy(true);
    setDetected(null);
    try {
      const result = await window.electronAPI.minecraft.detectContent(server.id, filePath);
      setDetected({ filePath, result });
    } finally { setBusy(false); }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
    if (file?.path) handleFile(file.path);
  };

  const pickFile = async () => {
    const src = await window.electronAPI.openFile([
      { name: 'Minecraft Content', extensions: ['zip', 'mcpack', 'mcaddon', 'mcworld', 'mcstructure', 'mcfunction', 'schem', 'schematic'] },
    ]);
    if (src) handleFile(src);
  };

  const doImport = async () => {
    if (!detected) return;
    const { filePath, result } = detected;
    setBusy(true);
    try {
      let outcome: { success: boolean; error?: string } = { success: false, error: 'Not supported.' };
      if (result.kind === 'resource_pack') outcome = await window.electronAPI.minecraft.installBedrockPack(server.id, 'resource_packs', filePath);
      else if (result.kind === 'behavior_pack') outcome = await window.electronAPI.minecraft.installBedrockPack(server.id, 'behavior_packs', filePath);
      else if (result.kind === 'addon') outcome = await window.electronAPI.minecraft.installBedrockAddon(server.id, filePath);
      else if (result.kind === 'datapack') outcome = await window.electronAPI.minecraft.installLocalDatapack(server.id, filePath);
      else if (result.kind === 'structure' || result.kind === 'schematic') outcome = await window.electronAPI.minecraft.storeStructure(server.id, filePath);
      else if (result.kind === 'function') outcome = await window.electronAPI.minecraft.storeFunction(server.id, filePath);
      else if (result.kind === 'world') return;

      if (outcome.success) { toast.success(`${result.label} imported successfully`); setDetected(null); onImported(); }
      else toast.error(outcome.error || 'Import failed');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={pickFile}
        className={`rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${dragOver ? 'border-primary-500 bg-primary-500/10' : 'border-overlay-10 hover:border-overlay-16 bg-overlay-2'}`}
      >
        <Upload size={20} className="mx-auto text-surface-500 mb-2" />
        <p className="text-sm font-semibold text-surface-200">Drop Minecraft content here</p>
        <p className="text-[11px] text-surface-500 mt-1">
          {server.edition === 'bedrock'
            ? '.mcpack, .mcaddon, .mcworld, .mcstructure, .mcfunction — or click to browse'
            : 'Datapacks (.zip), .schem/.schematic, .mcfunction — or click to browse'}
        </p>
      </div>

      {busy && !detected && <p className="text-xs text-surface-500 flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Detecting…</p>}

      {detected && (
        <Panel className={detected.result.compatible ? 'border-primary-500/30' : 'border-error/30'}>
          <div className="flex items-start gap-3">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${detected.result.compatible ? 'bg-primary-500/15 text-primary-300' : 'bg-error-bg text-error'}`}>
              {detected.result.compatible ? <PackageCheck size={16} /> : <PackageX size={16} />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-surface-100">Mercy detected: {detected.result.label}</p>
              {detected.result.reason && <p className="text-[11px] text-surface-500 mt-0.5">{detected.result.reason}</p>}
              {detected.result.compatible && (detected.result.kind === 'structure' || detected.result.kind === 'schematic' || detected.result.kind === 'function') && (
                <p className="text-[11px] text-amber-400/90 mt-0.5">
                  {detected.result.kind === 'schematic' ? 'Stored for later use — applying it in-game requires the WorldEdit plugin\'s own /schematic load command.'
                    : detected.result.kind === 'structure' ? 'Stored for later use — placing it in the world requires a structure block or a behavior pack that references it.'
                    : 'Stored for later use — it only runs once placed inside a behavior/data pack\'s own functions folder and referenced from there.'}
                </p>
              )}
            </div>
            <button onClick={() => setDetected(null)} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><Trash size={13} /></button>
          </div>
          {detected.result.compatible && detected.result.kind !== 'world' && (
            <button onClick={doImport} disabled={busy} className="btn-primary text-xs py-2 px-4 mt-3 flex items-center gap-1.5">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Import
            </button>
          )}
          {detected.result.kind === 'world' && detected.result.compatible && (
            <p className="text-[11px] text-surface-500 mt-3">Use the Worlds tab to import this — it needs to ask before replacing your current world.</p>
          )}
        </Panel>
      )}
    </div>
  );
}

// ── Content: Mods & Plugins (Paper) / Datapacks (both) / Bedrock Add-ons /
// Structures, Schematics & Functions ─────────────────────────────────────
function ContentTab({ server }: { server: MinecraftServer }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<(InstalledContent & { missingOnDisk: boolean })[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => { setLoading(true); window.electronAPI.minecraftMarketplace.listInstalled(server.id).then(setItems).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, [server.id]);

  const remove = async (id: string) => {
    setBusyId(id);
    const result = await window.electronAPI.minecraftMarketplace.removeContent(server.id, id);
    setBusyId(null);
    if (result.success) { toast.success('Removed'); load(); } else toast.error(result.error || 'Failed to remove');
  };
  const toggleEnabled = async (id: string, enabled: boolean) => {
    setBusyId(id);
    const result = await window.electronAPI.minecraftMarketplace.setContentEnabled(server.id, id, enabled);
    setBusyId(null);
    if (result.success) { toast.success(enabled ? 'Enabled' : 'Disabled — restart or /reload to apply'); load(); } else toast.error(result.error || 'Failed to update');
  };

  const plugins = items.filter((i) => i.kind === 'plugin');
  const datapacks = items.filter((i) => i.kind === 'datapack');
  const structures = items.filter((i) => i.kind === 'structure' || i.kind === 'schematic');
  const functions = items.filter((i) => i.kind === 'function');

  const Row = ({ item, toggleable = true }: { item: InstalledContent & { missingOnDisk: boolean }; toggleable?: boolean }) => (
    <Panel padding="sm" className="flex items-center gap-3">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${item.enabled ? 'bg-primary-500/15 text-primary-300' : 'bg-overlay-6 text-surface-500'}`}><Puzzle size={14} /></div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-surface-100 truncate">{item.projectName}{item.versionNumber && <span className="text-surface-500 font-normal"> v{item.versionNumber}</span>}</p>
        <p className="text-[11px] text-surface-500 truncate">
          {item.fileName} · {item.source === 'modrinth' ? 'Modrinth' : 'Imported'} · Installed {new Date(item.installedAt).toLocaleDateString()}
          {item.missingOnDisk && <span className="text-error"> · file missing from disk</span>}
          {item.dependencies.length > 0 && <> · {item.dependencies.length} dependenc{item.dependencies.length === 1 ? 'y' : 'ies'}</>}
        </p>
      </div>
      {toggleable && !item.enabled && <span className="text-[10px] font-semibold text-surface-500 px-2 py-0.5 rounded-full bg-overlay-6 shrink-0">Disabled</span>}
      {item.source === 'modrinth' && (
        <button onClick={() => window.electronAPI?.openExternal(`https://modrinth.com/project/${item.projectId}`)} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0" title="View on Modrinth"><ExternalLink size={13} /></button>
      )}
      {toggleable && (
        <button onClick={() => toggleEnabled(item.id, !item.enabled)} disabled={busyId === item.id || item.missingOnDisk} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0 disabled:opacity-40" title={item.enabled ? 'Disable' : 'Enable'}>
          {busyId === item.id ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
        </button>
      )}
      <button onClick={() => remove(item.id)} disabled={busyId === item.id} className="p-1.5 rounded-lg text-surface-500 hover:text-error hover:bg-overlay-6 transition-colors shrink-0"><Trash2 size={13} /></button>
    </Panel>
  );

  return (
    <div className="space-y-4">
      <ContentDropZone server={server} onImported={load} />

      {server.edition === 'java' && (
        <div className="flex justify-end">
          <button onClick={() => navigate(`/minecraft/marketplace?server=${server.id}`)} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"><Puzzle size={13} /> Browse Marketplace</button>
        </div>
      )}

      {loading ? (
        <Panel className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-primary-400" /></Panel>
      ) : (
        <>
          {server.edition === 'bedrock' && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-overlay-4 border border-overlay-8 text-xs text-surface-400">
              <Info size={14} className="shrink-0 mt-0.5" /> Resource/behavior packs and add-ons dropped above go straight to the <button onClick={() => navigate(`/minecraft/server/${server.id}?tab=packs`)} className="text-primary-400 hover:underline font-medium">Packs tab</button>. Structures and functions are stored here.
            </div>
          )}
          {server.edition === 'java' && server.serverType === 'paper' && (
            <div>
              <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-2">Plugins</p>
              {plugins.length === 0 ? (
                <Panel><EmptyState icon={Puzzle} title="No plugins installed" description="Paper plugins from the Marketplace will appear here." /></Panel>
              ) : (
                <div className="space-y-2">{plugins.map((i) => <Row key={i.id} item={i} />)}</div>
              )}
            </div>
          )}
          {server.edition === 'java' && server.serverType === 'vanilla' && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-overlay-4 border border-overlay-8 text-xs text-surface-400">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" /> Vanilla servers can't run plugins or mods — only datapacks, shown below.
            </div>
          )}
          {server.edition === 'java' && (
            <div>
              <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-2">Datapacks</p>
              {datapacks.length === 0 ? (
                <Panel><EmptyState icon={Puzzle} title="No datapacks installed" description="Datapacks work on both Vanilla and Paper — no mod loader needed." /></Panel>
              ) : (
                <div className="space-y-2">{datapacks.map((i) => <Row key={i.id} item={i} />)}</div>
              )}
            </div>
          )}
          <div>
            <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-2">{server.edition === 'bedrock' ? 'Structures' : 'Structures & Schematics'}</p>
            {structures.length === 0 ? (
              <Panel><EmptyState icon={Puzzle} title="Nothing stored yet" description={server.edition === 'bedrock' ? 'Drop a .mcstructure file above to store it here.' : 'Drop a .schem/.schematic file above to store it here.'} /></Panel>
            ) : (
              <div className="space-y-2">{structures.map((i) => <Row key={i.id} item={i} toggleable={false} />)}</div>
            )}
          </div>
          <div>
            <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-2">Functions</p>
            {functions.length === 0 ? (
              <Panel><EmptyState icon={Puzzle} title="No functions stored" description="Drop a .mcfunction file above to store it here." /></Panel>
            ) : (
              <div className="space-y-2">{functions.map((i) => <Row key={i.id} item={i} toggleable={false} />)}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── World: real, edition-aware export/import (never available while running) ─
function WorldsTab({ server, isRunning }: { server: MinecraftServer; isRunning: boolean }) {
  const [info, setInfo] = useState<{ levelName: string; exists: boolean; sizeBytes: number | null; edition: 'java' | 'bedrock' } | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pendingImportPath, setPendingImportPath] = useState<string | null>(null);
  const [pendingDetectedEdition, setPendingDetectedEdition] = useState<'java' | 'bedrock' | null>(null);

  const load = () => { setLoading(true); window.electronAPI.minecraft.worldInfo(server.id).then(setInfo).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, [server.id]);

  const fmtSize = (b: number | null) => b == null ? 'Unknown size' : b > 1024 * 1024 * 1024 ? `${(b / 1024 / 1024 / 1024).toFixed(2)} GB` : `${(b / 1024 / 1024).toFixed(1)} MB`;

  const doExport = async () => {
    const defaultPath = `${server.name.replace(/[^a-z0-9-_]/gi, '_')}-${info?.levelName || 'world'}.zip`;
    const dest = await window.electronAPI.showSaveDialog({ defaultPath, filters: [{ name: 'World Archive', extensions: ['zip'] }] });
    if (!dest) return;
    setExporting(true);
    try {
      const result = await window.electronAPI.minecraft.exportWorld(server.id, dest);
      if (result.success) toast.success('World exported'); else toast.error(result.error || 'Export failed');
    } finally { setExporting(false); }
  };

  const runImport = async (sourcePath: string, confirmReplace: boolean) => {
    setImporting(true);
    try {
      const result = await window.electronAPI.minecraft.importWorld(server.id, sourcePath, confirmReplace);
      if (result.success) {
        toast.success('World imported');
        setPendingImportPath(null); setPendingDetectedEdition(null);
        load();
      } else if (result.needsConfirmation) {
        setPendingImportPath(sourcePath);
        setPendingDetectedEdition(result.detectedEdition || null);
      } else {
        toast.error(result.error || 'Import failed');
        setPendingImportPath(null); setPendingDetectedEdition(null);
      }
    } finally { setImporting(false); }
  };

  const doImport = async () => {
    const src = await window.electronAPI.openFile([{ name: 'World Archive', extensions: ['zip'] }]);
    if (!src) return;
    await runImport(src, false);
  };

  const openFolder = async () => {
    const result = await window.electronAPI.minecraft.openWorldFolder(server.id);
    if (!result.success) toast.error(result.error || 'Could not open the world folder.');
  };

  const disabledReason = isRunning ? 'Stop the server before exporting or importing its world.' : null;

  return (
    <div className="space-y-4">
      {disabledReason && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-overlay-4 border border-overlay-8 text-xs text-surface-400">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {disabledReason}
        </div>
      )}

      {pendingImportPath && (
        <Panel className="border-amber-500/30">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-bold text-amber-300">Replace existing world?</p>
              <p className="text-xs text-surface-400 mt-1">
                A world ("{info?.levelName}") already exists for this server. Importing will replace it — the current world will be backed up first (visible in the Backups tab) so it isn't lost.
              </p>
              <div className="flex gap-2 mt-3">
                <button onClick={() => { setPendingImportPath(null); setPendingDetectedEdition(null); }} className="btn-secondary text-xs py-1.5 px-3">Cancel</button>
                <button onClick={() => runImport(pendingImportPath, true)} disabled={importing} className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5">
                  {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Back Up &amp; Replace
                </button>
              </div>
            </div>
          </div>
        </Panel>
      )}

      {loading ? (
        <Panel className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-primary-400" /></Panel>
      ) : (
        <Panel padding="sm" className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary-500/15 border border-primary-500/25 flex items-center justify-center shrink-0"><Map size={16} className="text-primary-300" /></div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-surface-100 truncate">{info?.levelName || 'world'}</p>
            <p className="text-[11px] text-surface-500">
              {info?.exists ? `${fmtSize(info.sizeBytes)} · ${server.edition === 'bedrock' ? 'Bedrock' : 'Java'} world on disk` : 'No world found on disk yet'}
            </p>
          </div>
          {info?.exists && (
            <button onClick={openFolder} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0" title="Open World Folder"><FolderOpen size={14} /></button>
          )}
        </Panel>
      )}

      <div className="flex gap-3">
        <button onClick={doExport} disabled={isRunning || exporting || !info?.exists} className="flex-1 btn-secondary text-xs py-2.5 flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed">
          {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} {exporting ? 'Exporting…' : 'Export World'}
        </button>
        <button onClick={doImport} disabled={isRunning || importing} className="flex-1 btn-primary text-xs py-2.5 flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed">
          {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} {importing ? 'Importing…' : 'Import World'}
        </button>
      </div>
      <p className="text-[11px] text-surface-500">
        Import only accepts a {server.edition === 'bedrock' ? 'Bedrock (db/ folder)' : 'Java (level.dat)'} world archive — a mismatched edition is refused automatically.
      </p>
    </div>
  );
}

// ── Bedrock Resource & Behavior Packs (real manifest-based, local-folder) ────
const PACK_KIND_META: Record<'resource_packs' | 'behavior_packs', { label: string; description: string }> = {
  resource_packs: { label: 'Resource Packs', description: 'Changes textures, sounds, models, UI, and other visual assets.' },
  behavior_packs: { label: 'Behavior Packs', description: 'Changes gameplay, entities, items, recipes, and other behavior.' },
};

function PacksTab({ server }: { server: MinecraftServer }) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<'resource_packs' | 'behavior_packs'>('resource_packs');
  const [packs, setPacks] = useState<{ folderName: string; uuid: string | null; name: string; version: string; description: string; valid: boolean; invalidReason?: string; enabled: boolean; installedViaMercy: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [busyFolder, setBusyFolder] = useState<string | null>(null);

  const load = () => { setLoading(true); window.electronAPI.minecraft.listBedrockPacks(server.id, kind).then(setPacks).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, [server.id, kind]);

  const install = async () => {
    const src = await window.electronAPI.openFile([{ name: 'Pack Archive', extensions: ['zip', 'mcpack'] }]);
    if (!src) return;
    setInstalling(true);
    try {
      const result = await window.electronAPI.minecraft.installBedrockPack(server.id, kind, src);
      if (result.success) { toast.success('Pack installed'); load(); } else toast.error(result.error || 'Install failed');
    } finally { setInstalling(false); }
  };

  const toggle = async (pack: typeof packs[number]) => {
    if (!pack.uuid) return;
    const versionArr = pack.version.split('.').map((n) => parseInt(n, 10));
    setBusyFolder(pack.folderName);
    try {
      const result = await window.electronAPI.minecraft.setBedrockPackEnabled(server.id, kind, pack.uuid, versionArr, !pack.enabled);
      if (result.success) load(); else toast.error(result.error || 'Failed to update');
    } finally { setBusyFolder(null); }
  };

  const remove = async (pack: typeof packs[number]) => {
    setBusyFolder(pack.folderName);
    try {
      const result = await window.electronAPI.minecraft.removeBedrockPack(server.id, kind, pack.folderName, pack.uuid);
      if (result.success) { toast.success('Pack removed'); load(); } else toast.error(result.error || 'Failed to remove');
    } finally { setBusyFolder(null); }
  };

  const openPack = async (pack: typeof packs[number]) => {
    const result = await window.electronAPI.minecraft.openPackFolder(server.id, kind, pack.folderName);
    if (!result.success) { toast.error(result.error || 'Could not open that pack\'s folder.'); load(); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-surface-100">Bedrock Packs</p>
          <p className="text-xs text-surface-500 mt-0.5">Manage add-ons already installed on this server. Looking to find new content? Use the <button onClick={() => navigate(`/minecraft/marketplace?server=${server.id}`)} className="text-primary-400 hover:underline font-medium">Marketplace</button>.</p>
        </div>
        <button onClick={install} disabled={installing} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-60 shrink-0">
          {installing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} {installing ? 'Installing…' : 'Install Pack'}
        </button>
      </div>

      <div>
        <div className="flex gap-1 p-1 rounded-xl bg-overlay-4 border border-overlay-8 w-fit">
          {(['resource_packs', 'behavior_packs'] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${kind === k ? 'bg-primary-600/20 text-primary-300' : 'text-surface-400 hover:text-surface-200'}`}>
              {PACK_KIND_META[k].label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-surface-500 mt-2">{PACK_KIND_META[kind].description}</p>
      </div>

      {loading ? (
        <Panel className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-primary-400" /></Panel>
      ) : packs.length === 0 ? (
        <Panel><EmptyState icon={kind === 'resource_packs' ? PackageCheck : PackageX} title={`No ${kind === 'resource_packs' ? 'resource' : 'behavior'} packs installed`} description="Install a real .zip/.mcpack pack with a valid manifest.json to see it here." /></Panel>
      ) : (
        <div className="space-y-2">
          {packs.map((p) => (
            <Panel key={p.folderName} padding="sm" className={`flex items-center gap-3 ${!p.valid ? 'border-error/30' : ''}`}>
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${!p.valid ? 'bg-error-bg text-error' : p.enabled ? 'bg-primary-500/15 text-primary-300' : 'bg-overlay-6 text-surface-500'}`}>
                {p.valid ? <PackageCheck size={15} /> : <PackageX size={15} />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-surface-100 truncate">{p.name} {p.valid && <span className="text-surface-500 font-normal">v{p.version}</span>}</p>
                <p className="text-[11px] text-surface-500 truncate">
                  {p.valid ? (p.description || 'No description available') : (p.invalidReason || 'Invalid pack')}
                  {!p.installedViaMercy && ' · Not installed via Mercy'}
                </p>
              </div>
              {p.valid && (
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${p.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-overlay-6 text-surface-500'}`}>
                  {p.enabled ? 'Enabled' : 'Disabled'}
                </span>
              )}
              {p.valid && (
                <button onClick={() => toggle(p)} disabled={busyFolder === p.folderName} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0" title={p.enabled ? 'Disable' : 'Enable'}>
                  {busyFolder === p.folderName ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
                </button>
              )}
              <button onClick={() => openPack(p)} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0" title="Open Pack"><FolderOpen size={13} /></button>
              <button onClick={() => remove(p)} disabled={busyFolder === p.folderName} className="p-1.5 rounded-lg text-surface-500 hover:text-error hover:bg-overlay-6 transition-colors shrink-0"><Trash2 size={13} /></button>
            </Panel>
          ))}
        </div>
      )}
      <div className="flex items-start gap-2 p-3 rounded-xl bg-overlay-4 border border-overlay-8 text-xs text-surface-400">
        <Info size={14} className="shrink-0 mt-0.5" /> Enabling a pack here applies it to this server's active world (world_{kind === 'resource_packs' ? 'resource' : 'behavior'}_packs.json) — a backup of that file is kept automatically before every change.
      </div>
    </div>
  );
}

// ── Danger Zone: permanent, deliberate server deletion ───────────────────────
function DangerZoneTab({ server }: { server: MinecraftServer }) {
  const navigate = useNavigate();
  const [confirmText, setConfirmText] = useState('');
  const [deleteBackups, setDeleteBackups] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canDelete = confirmText.trim() === server.name && !deleting;

  const doDelete = async () => {
    if (!canDelete) return;
    setDeleting(true);
    try {
      const result = await window.electronAPI.minecraft.delete(server.id, true, deleteBackups);
      if (result.success) {
        toast.success(`"${server.name}" was deleted`);
        navigate('/minecraft');
      } else {
        toast.error(result.error || 'Delete failed');
        setDeleting(false);
      }
    } catch (e: any) {
      toast.error(e?.message || 'Delete failed');
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Panel className="border-error/30">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-error-bg border border-error/25 flex items-center justify-center shrink-0"><ShieldAlert size={18} className="text-error" /></div>
          <div>
            <p className="text-sm font-bold text-error">Danger Zone</p>
            <p className="text-xs text-surface-400 mt-1">Deleting "{server.name}" is permanent and cannot be undone. This will:</p>
            <ul className="text-xs text-surface-400 mt-2 space-y-1 list-disc list-inside">
              <li>Stop the server if it's running</li>
              <li>Remove all server files, including the world</li>
              <li>Remove all installed mods, plugins, and datapacks</li>
              <li>Remove the server from Mercy Launcher</li>
            </ul>
            <p className="text-xs text-surface-500 mt-2">Backups are kept by default — they're stored separately and won't be touched unless you choose to delete them below.</p>
          </div>
        </div>
      </Panel>

      <Panel>
        <label className="flex items-center justify-between gap-4 cursor-pointer">
          <div>
            <p className="text-sm font-semibold text-surface-100">Also delete backups for this server</p>
            <p className="text-xs text-surface-500 mt-0.5">Off by default — backups are kept separately unless you explicitly choose this.</p>
          </div>
          <Toggle checked={deleteBackups} onChange={setDeleteBackups} />
        </label>
      </Panel>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">
          Type <span className="font-mono text-surface-200">{server.name}</span> to confirm
        </label>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className="input-field font-mono" placeholder={server.name} />
      </Panel>

      <div className="flex justify-end gap-2">
        <button onClick={() => setConfirmText('')} className="btn-secondary">Cancel</button>
        <button onClick={doDelete} disabled={!canDelete} className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-error text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2">
          {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete Server Permanently
        </button>
      </div>
    </div>
  );
}
