import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import * as Tabs from '@radix-ui/react-tabs';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Blocks, ArrowLeft, Play, Square, RotateCcw, Loader2, Terminal, Settings2, Users,
  Archive, FolderOpen, LayoutDashboard, Cpu, MemoryStick, Clock, Hash, Save, Trash2,
  Download, RefreshCw, AlertTriangle, File as FileIcon, Folder, ChevronRight, Copy, Trash,
  Puzzle, ExternalLink, ShieldAlert, Power, Wifi, CheckCircle2, XCircle, Globe, Home, Gamepad2,
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

export default function MinecraftServerPanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { upsertServer } = useMinecraftStore();
  const [server, setServer] = useState<MinecraftServer | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('overview');

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
        <Tabs.Content value="properties" className="outline-none"><PropertiesTab server={server} /></Tabs.Content>
        <Tabs.Content value="players" className="outline-none"><PlayersTab server={server} isRunning={isRunning} /></Tabs.Content>
        <Tabs.Content value="backups" className="outline-none"><BackupsTab server={server} /></Tabs.Content>
        <Tabs.Content value="files" className="outline-none"><FilesTab server={server} /></Tabs.Content>
        <Tabs.Content value="content" className="outline-none"><ContentTab server={server} /></Tabs.Content>
        <Tabs.Content value="danger" className="outline-none"><DangerZoneTab server={server} /></Tabs.Content>
      </Tabs.Root>
    </motion.div>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────
function OverviewTab({ server, onChange }: { server: MinecraftServer; onChange: () => void }) {
  const [stats, setStats] = useState<{ pid: number | null; uptimeMs: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => window.electronAPI.minecraft.processStats(server.id).then((s) => alive && setStats(s)).catch(() => {});
    poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [server.id]);

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
    { icon: Cpu, label: 'CPU', value: 'Not available' },
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
      <div className={`grid gap-4 ${cards.length === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>
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

  const load = () => window.electronAPI.minecraft.connectionInfo(server.id).then((i) => { setInfo(i); setLoading(false); }).catch(() => setLoading(false));
  // Recomputed live on every poll and whenever the server's own record
  // changes (port/version/type edits) — never a cached snapshot, so it
  // can't go stale after a Properties change or a status transition.
  useEffect(() => { setLoading(true); load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [server.id, server.port, server.version, server.serverType, server.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading || !info) {
    return <Panel className="flex items-center justify-center py-16"><Loader2 size={20} className="animate-spin text-primary-400" /></Panel>;
  }

  const isBedrock = info.edition === 'bedrock';
  const statusMeta = STATUS_CONNECT_META[info.status] || STATUS_CONNECT_META.stopped;
  const localAddress = `127.0.0.1:${info.port}`;
  const typeLabel = info.serverType === 'bedrock' ? 'Bedrock Edition' : info.serverType === 'paper' ? 'Paper' : 'Vanilla';
  const instructions = isBedrock
    ? 'This is a Bedrock Dedicated Server. Bedrock clients (mobile, console, Windows Bedrock, and Java clients bridged via a separate tool) connect differently from Java: use the server address below directly in the Bedrock client\'s "Add Server" screen — there is no server jar or Java client involved.'
    : info.serverType === 'paper'
      ? `This is a Paper server — it's joined exactly like a normal Java Edition server (Paper only adds plugin support on the server side; the client connection is identical).`
      : `This is a Vanilla Java Edition server.`;

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-bold text-surface-400 uppercase tracking-wider">Connection Status</p>
          <span className={`flex items-center gap-1.5 text-xs font-semibold ${statusMeta.className}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${info.status === 'running' ? 'bg-emerald-400' : info.status === 'error' ? 'bg-red-400' : 'bg-surface-600'}`} />
            {statusMeta.label}
          </span>
        </div>
        {isBedrock ? (
          info.raknet?.checked ? (
            <p className={`text-xs mt-2 flex items-center gap-1.5 ${info.raknet.reachable ? 'text-success' : 'text-error'}`}>
              {info.raknet.reachable ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
              {info.raknet.note}
            </p>
          ) : info.raknet ? (
            <p className="text-xs mt-2 text-surface-500 flex items-center gap-1.5"><XCircle size={13} /> {info.raknet.note}</p>
          ) : null
        ) : info.portListening !== null ? (
          <p className={`text-xs mt-2 flex items-center gap-1.5 ${info.portListening ? 'text-success' : 'text-error'}`}>
            {info.portListening ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
            {info.portListening
              ? `Port ${info.port} is listening — verified with a real connection just now.`
              : info.status === 'starting'
                ? `Port ${info.port} isn't accepting connections yet — still starting up.`
                : info.status === 'stopping'
                  ? `Port ${info.port} is no longer accepting connections — shutting down.`
                  : `Port ${info.port} is NOT accepting connections — the process is running but something is wrong.`}
          </p>
        ) : (
          <p className="text-xs mt-2 text-surface-500 flex items-center gap-1.5"><XCircle size={13} /> Connection unavailable — start the server first.</p>
        )}
      </Panel>

      <Panel>
        <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Server Address</p>
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

        <div className="flex items-center gap-2 mt-3">
          <button onClick={() => copyToClipboard(info.lanAddress || localAddress, 'IP:Port')} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"><Copy size={12} /> Copy IP:Port</button>
          <button
            onClick={() => copyToClipboard(
              isBedrock
                ? `Join "${info.serverName}" (Bedrock Edition ${info.version}):\n1. Open Minecraft (Bedrock, any platform)\n2. Play → Servers → Add Server\n3. Server Address: ${(info.lanAddress || localAddress).split(':')[0]}, Port: ${info.port}\n4. Join`
                : `Join "${info.serverName}" (${typeLabel} ${info.version}):\n1. Open Minecraft Java Edition ${info.version}\n2. Multiplayer → Add Server\n3. Server Address: ${info.lanAddress || localAddress}\n4. Join`,
              'Connection instructions',
            )}
            className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
          ><Copy size={12} /> Copy Instructions</button>
        </div>
      </Panel>

      <Panel>
        <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-2">How to Join</p>
        <p className="text-xs text-surface-400 mb-3">{instructions}</p>
        {isBedrock ? (
          <ol className="space-y-2 text-sm text-surface-300">
            <li className="flex gap-2"><span className="text-primary-400 font-bold shrink-0">1.</span> Open Minecraft (Bedrock Edition) on any supported platform.</li>
            <li className="flex gap-2"><span className="text-primary-400 font-bold shrink-0">2.</span> Go to <strong>Play</strong> → <strong>Servers</strong> → <strong>Add Server</strong>.</li>
            <li className="flex gap-2"><span className="text-primary-400 font-bold shrink-0">3.</span> Enter <span className="font-mono bg-overlay-6 px-1.5 py-0.5 rounded">{(info.lanAddress || localAddress).split(':')[0]}</span> as the address and <span className="font-mono bg-overlay-6 px-1.5 py-0.5 rounded">{info.port}</span> as the port.</li>
            <li className="flex gap-2"><span className="text-primary-400 font-bold shrink-0">4.</span> Select the server and join.</li>
          </ol>
        ) : (
          <ol className="space-y-2 text-sm text-surface-300">
            <li className="flex gap-2"><span className="text-primary-400 font-bold shrink-0">1.</span> Open Minecraft: Java Edition, version <strong>{info.version}</strong> (or a compatible version).</li>
            <li className="flex gap-2"><span className="text-primary-400 font-bold shrink-0">2.</span> Go to <strong>Multiplayer</strong> → <strong>Add Server</strong>.</li>
            <li className="flex gap-2"><span className="text-primary-400 font-bold shrink-0">3.</span> Enter <span className="font-mono bg-overlay-6 px-1.5 py-0.5 rounded">{info.lanAddress || localAddress}</span> as the Server Address.</li>
            <li className="flex gap-2"><span className="text-primary-400 font-bold shrink-0">4.</span> Select the server and click <strong>Join Server</strong>.</li>
          </ol>
        )}
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

function PropertiesTab({ server }: { server: MinecraftServer }) {
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
    if (result.success) { toast.success('server.properties saved — restart the server to apply changes'); load(); }
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

// ── Content: Mods & Plugins (Paper) / Datapacks (both) ──────────────────────
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

  if (server.edition === 'bedrock') {
    return (
      <Panel>
        <EmptyState
          icon={Puzzle}
          title="Marketplace isn't supported for Bedrock yet"
          description="Bedrock uses a structurally different add-on system (behavior packs and resource packs, not Java plugins/mods/datapacks). Mercy's current Marketplace is built around Modrinth's Java ecosystem and doesn't install Bedrock add-ons — that's a planned future milestone, not something Mercy will pretend to do here."
        />
      </Panel>
    );
  }

  const Row = ({ item }: { item: InstalledContent & { missingOnDisk: boolean } }) => (
    <Panel padding="sm" className="flex items-center gap-3">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${item.enabled ? 'bg-primary-500/15 text-primary-300' : 'bg-overlay-6 text-surface-500'}`}><Puzzle size={14} /></div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-surface-100 truncate">{item.projectName} <span className="text-surface-500 font-normal">v{item.versionNumber}</span></p>
        <p className="text-[11px] text-surface-500 truncate">
          {item.fileName} · Modrinth · Installed {new Date(item.installedAt).toLocaleDateString()}
          {item.missingOnDisk && <span className="text-error"> · file missing from disk</span>}
          {item.dependencies.length > 0 && <> · {item.dependencies.length} dependenc{item.dependencies.length === 1 ? 'y' : 'ies'}</>}
        </p>
      </div>
      {!item.enabled && <span className="text-[10px] font-semibold text-surface-500 px-2 py-0.5 rounded-full bg-overlay-6 shrink-0">Disabled</span>}
      <button onClick={() => window.electronAPI?.openExternal(`https://modrinth.com/project/${item.projectId}`)} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0" title="View on Modrinth"><ExternalLink size={13} /></button>
      <button onClick={() => toggleEnabled(item.id, !item.enabled)} disabled={busyId === item.id || item.missingOnDisk} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0 disabled:opacity-40" title={item.enabled ? 'Disable' : 'Enable'}>
        {busyId === item.id ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
      </button>
      <button onClick={() => remove(item.id)} disabled={busyId === item.id} className="p-1.5 rounded-lg text-surface-500 hover:text-error hover:bg-overlay-6 transition-colors shrink-0"><Trash2 size={13} /></button>
    </Panel>
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => navigate(`/minecraft/marketplace?server=${server.id}`)} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"><Puzzle size={13} /> Browse Marketplace</button>
      </div>
      {loading ? (
        <Panel className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-primary-400" /></Panel>
      ) : (
        <>
          {server.serverType === 'paper' && (
            <div>
              <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-2">Plugins</p>
              {plugins.length === 0 ? (
                <Panel><EmptyState icon={Puzzle} title="No plugins installed" description="Paper plugins from the Marketplace will appear here." /></Panel>
              ) : (
                <div className="space-y-2">{plugins.map((i) => <Row key={i.id} item={i} />)}</div>
              )}
            </div>
          )}
          {server.serverType === 'vanilla' && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-overlay-4 border border-overlay-8 text-xs text-surface-400">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" /> Vanilla servers can't run plugins or mods — only datapacks, shown below.
            </div>
          )}
          <div>
            <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-2">Datapacks</p>
            {datapacks.length === 0 ? (
              <Panel><EmptyState icon={Puzzle} title="No datapacks installed" description="Datapacks work on both Vanilla and Paper — no mod loader needed." /></Panel>
            ) : (
              <div className="space-y-2">{datapacks.map((i) => <Row key={i.id} item={i} />)}</div>
            )}
          </div>
        </>
      )}
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
