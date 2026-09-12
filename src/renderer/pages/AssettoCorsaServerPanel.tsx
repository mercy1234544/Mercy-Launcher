import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import * as Tabs from '@radix-ui/react-tabs';
import { useNavigate, useParams } from 'react-router-dom';
import {
  FlagTriangleRight, ArrowLeft, Play, Square, RotateCcw, Loader2, Terminal, Settings2, Users,
  Archive, FolderOpen, LayoutDashboard, Cpu, MemoryStick, Clock, Hash, Trash2, Save,
  AlertTriangle, File as FileIcon, Folder, ChevronRight, Copy, Trash, Puzzle, ShieldAlert, Info, CheckCircle2, XCircle,
  Gamepad2, Share2, ChevronDown,
} from 'lucide-react';
import { Panel, SectionHeading, Toggle, EmptyState } from '../components/ui';
import { launchGameFor } from '../lib/launchGame';
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

export default function AssettoCorsaServerPanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [server, setServer] = useState<AssettoCorsaServer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('overview');
  const [runtimeRequired, setRuntimeRequired] = useState(false);
  const [settingUpRuntime, setSettingUpRuntime] = useState(false);

  // Real failure isolation (Part 2): an honest, recoverable error state
  // instead of a spinner that never resolves if the load genuinely fails.
  const load = async () => {
    if (!id) return;
    try {
      const s = await window.electronAPI.assettoCorsa.get(id);
      if (s) { setServer(s); setLoadError(null); }
      else setLoadError('This server could not be found — it may have been deleted.');
    } catch (e: any) {
      setLoadError(e?.message || 'Could not load this server.');
    }
  };
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!id) return;
    window.electronAPI.assettoCorsa.getServerReadiness(id).then((r) => { if (r) setRuntimeRequired(!r.executablePresent); });
  }, [id, server?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!id) return;
    const cleanup = window.electronAPI.onAssettoCorsaStatusChange((data) => { if (data.serverId === id) load(); });
    return cleanup;
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!server) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        {loadError ? (
          <Panel className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertTriangle size={22} className="text-error" />
            <p className="text-sm font-semibold text-surface-200">{loadError}</p>
            <div className="flex items-center gap-2">
              <button onClick={() => { setLoadError(null); load(); }} className="btn-secondary text-xs py-2 px-4">Retry</button>
              <button onClick={() => navigate('/assetto-corsa')} className="btn-primary text-xs py-2 px-4">Back to Assetto Corsa</button>
            </div>
          </Panel>
        ) : (
          <Panel className="flex items-center justify-center py-16"><Loader2 size={20} className="animate-spin text-primary-400" /></Panel>
        )}
      </div>
    );
  }

  const meta = STATUS_META[server.status] || STATUS_META.stopped;
  const isRunning = server.status === 'running' || server.status === 'starting';

  const handleStart = async () => {
    setBusy(true);
    const r = await window.electronAPI.assettoCorsa.start(server.id);
    if (!r.success) {
      if (r.runtimeRequired) setRuntimeRequired(true);
      else toast.error(r.error || 'Failed to start');
    } else {
      setRuntimeRequired(false);
    }
    setBusy(false);
    load();
  };

  const handleSelectRuntimeFolder = async () => {
    const dir = await window.electronAPI.openDirectory();
    if (!dir) return;
    setSettingUpRuntime(true);
    try {
      const result = await window.electronAPI.assettoCorsa.setRuntimePath(dir);
      if (!result.success) { toast.error(result.error || 'That folder is not a valid Assetto Corsa dedicated-server install.'); return; }
      const copyResult = await window.electronAPI.assettoCorsa.ensureRuntimeFilesPresent(server.id);
      if (!copyResult.success) { toast.error(copyResult.error || 'Could not set up this server with the runtime.'); return; }
      toast.success('Assetto Corsa dedicated-server runtime configured');
      setRuntimeRequired(false);
    } finally { setSettingUpRuntime(false); }
  };
  const handleStop = async () => { setBusy(true); await window.electronAPI.assettoCorsa.stop(server.id, false); setBusy(false); load(); };
  const handleForceStop = async () => { setBusy(true); await window.electronAPI.assettoCorsa.stop(server.id, true); setBusy(false); load(); };
  const handleRestart = async () => { setBusy(true); await window.electronAPI.assettoCorsa.restart(server.id); setBusy(false); load(); };
  const [launchingGame, setLaunchingGame] = useState(false);
  const handleLaunchGame = async () => {
    setLaunchingGame(true);
    try {
      // Never acServer.exe (the dedicated server Mercy itself already runs)
      // — this launches the PLAYER's own game client (Content Manager when
      // installed, otherwise the base Assetto Corsa executable).
      const result = await launchGameFor('assettocorsa');
      if (result.success && result.note) toast(result.note, { icon: 'ℹ️' });
      else if (!result.success) toast.error(result.error || 'Could not launch Assetto Corsa');
    } finally { setLaunchingGame(false); }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-5 max-w-5xl mx-auto pb-16">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/assetto-corsa')} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors"><ArrowLeft size={16} /></button>
        <SectionHeading
          icon={FlagTriangleRight} iconClass="bg-rose-500/15 border-rose-500/25 text-rose-300"
          title={server.name}
          subtitle={`${server.track || 'No track'} · ${server.cars.length} car${server.cars.length === 1 ? '' : 's'}`}
          action={
            <div className="flex items-center gap-2">
              <span className={`flex items-center gap-1.5 text-xs font-semibold ${meta.text}`}><span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} /> {meta.label}</span>
              {!isRunning ? (
                <button onClick={handleStart} disabled={busy} className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5">{busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Start</button>
              ) : (
                <>
                  {server.status === 'running' && (
                    <button onClick={handleLaunchGame} disabled={launchingGame} className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5" title="Launch your Assetto Corsa game client (never the dedicated server)">
                      {launchingGame ? <Loader2 size={13} className="animate-spin" /> : <Gamepad2 size={13} />} Launch Game
                    </button>
                  )}
                  <button onClick={handleRestart} disabled={busy} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><RotateCcw size={13} /> Restart</button>
                  <button onClick={handleStop} disabled={busy} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><Square size={13} /> Stop</button>
                  <button onClick={handleForceStop} disabled={busy} className="p-2 rounded-lg text-surface-500 hover:text-error hover:bg-overlay-6 transition-colors" title="Force stop"><AlertTriangle size={14} /></button>
                </>
              )}
            </div>
          }
        />
      </div>

      {runtimeRequired && (
        <Panel className="border-amber-500/30">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center shrink-0"><AlertTriangle size={18} className="text-amber-400" /></div>
            <div className="flex-1">
              <p className="text-sm font-bold text-amber-300">Assetto Corsa Dedicated Server Runtime Required</p>
              <p className="text-xs text-surface-400 mt-1">
                This server has been configured, but the real Assetto Corsa dedicated-server files (acServer.exe) have not been installed/configured yet.
                If you already own a legitimate Assetto Corsa dedicated-server installation, point Mercy at it — the files will be copied into this server automatically.
              </p>
              <button onClick={handleSelectRuntimeFolder} disabled={settingUpRuntime} className="btn-primary text-xs py-2 px-4 mt-3 flex items-center gap-1.5">
                {settingUpRuntime ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />} Select Runtime Folder
              </button>
            </div>
          </div>
        </Panel>
      )}

      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="flex flex-wrap gap-1 mb-4" aria-label="Server management">
          {[
            { id: 'overview', label: 'Overview', icon: LayoutDashboard },
            { id: 'join', label: 'How to Join', icon: Share2 },
            { id: 'console', label: 'Console', icon: Terminal },
            { id: 'players', label: 'Players', icon: Users },
            { id: 'settings', label: 'Settings', icon: Settings2 },
            { id: 'content', label: 'Content', icon: Puzzle },
            { id: 'backups', label: 'Backups', icon: Archive },
            { id: 'files', label: 'Files', icon: FolderOpen },
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

        <Tabs.Content value="overview" className="outline-none"><OverviewTab server={server} /></Tabs.Content>
        <Tabs.Content value="join" className="outline-none"><HowToJoinTab server={server} onLaunchGame={handleLaunchGame} launchingGame={launchingGame} /></Tabs.Content>
        <Tabs.Content value="console" className="outline-none"><ConsoleTab server={server} /></Tabs.Content>
        <Tabs.Content value="players" className="outline-none"><PlayersTab /></Tabs.Content>
        <Tabs.Content value="settings" className="outline-none"><SettingsTab server={server} onChange={load} /></Tabs.Content>
        <Tabs.Content value="content" className="outline-none"><ContentTab server={server} onChange={load} /></Tabs.Content>
        <Tabs.Content value="backups" className="outline-none"><BackupsTab server={server} /></Tabs.Content>
        <Tabs.Content value="files" className="outline-none"><FilesTab server={server} /></Tabs.Content>
        <Tabs.Content value="danger" className="outline-none"><DangerZoneTab server={server} /></Tabs.Content>
      </Tabs.Root>
    </motion.div>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────
function OverviewTab({ server }: { server: AssettoCorsaServer }) {
  const [stats, setStats] = useState<{ pid: number | null; uptimeMs: number | null; cpuPercent: number | null; memoryBytes: number | null; metricsAvailable: boolean } | null>(null);
  const [connPlan, setConnPlan] = useState<EndpointPlan | null | undefined>(undefined);
  const isRunning = server.status === 'running' || server.status === 'starting';

  useEffect(() => {
    if (!isRunning) { setStats(null); return; }
    let cancelled = false;
    const poll = () => window.electronAPI.assettoCorsa.processStats(server.id).then((s) => { if (!cancelled) setStats(s); });
    poll();
    const t = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [server.id, isRunning]);

  // Real check of whether a friend could actually reach this server right
  // now — the SAME negotiation a friend's Join approval actually uses (see
  // useFriendsPresence.ts's approveJoin), never a separate, only-for-display
  // guess. Only meaningful once the real UDP port is confirmed bound.
  useEffect(() => {
    if (server.status !== 'running') { setConnPlan(undefined); return; }
    let cancelled = false;
    window.electronAPI.connection?.negotiateAssettoCorsaEndpoint?.(server.id).then((plan) => { if (!cancelled) setConnPlan(plan); }).catch(() => { if (!cancelled) setConnPlan(null); });
    return () => { cancelled = true; };
  }, [server.id, server.status]);

  const cards = [
    { label: 'Mercy Server', value: server.status === 'running' ? 'Running' : server.status === 'starting' ? 'Starting' : server.status === 'stopping' ? 'Stopping' : server.status === 'error' ? 'Error' : 'Stopped', icon: FlagTriangleRight },
    { label: 'Track', value: server.track ? `${server.track}${server.trackLayout ? ` (${server.trackLayout})` : ''}` : 'Not set', icon: Hash },
    { label: 'Cars', value: `${server.cars.length} / ${server.maxClients} slots`, icon: Users },
    { label: 'Port', value: `${server.udpPort} (UDP/TCP)`, icon: Hash },
    { label: 'Uptime', value: fmtUptime(stats?.uptimeMs ?? null), icon: Clock },
    { label: 'CPU', value: fmtCpu(stats), icon: Cpu },
    { label: 'Memory Used', value: fmtMemory(stats), icon: MemoryStick },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map((c) => (
          <Panel key={c.label} padding="sm">
            <div className="flex items-center gap-1.5 text-surface-500 mb-1"><c.icon size={12} /><span className="text-[10px] uppercase tracking-wider">{c.label}</span></div>
            <p className="text-sm font-bold text-surface-100 truncate">{c.value}</p>
          </Panel>
        ))}
      </div>
      {/* Deliberately separate from "Mercy Server" above (Part 5/8): the
          official AC public lobby rejecting a server as unreachable (no
          port forwarding) does not mean the local/LAN/Mercy-relay server is
          broken — those are two different, independently-tracked states. */}
      {server.registerToLobby && (
        <Panel padding="sm" className={server.lobbyStatus === 'unreachable' ? 'border-amber-500/30' : ''}>
          <div className="flex items-center gap-2">
            {server.lobbyStatus === 'unreachable' ? <XCircle size={13} className="text-amber-400 shrink-0" /> : <Info size={13} className="text-surface-500 shrink-0" />}
            <p className="text-xs text-surface-300">
              <span className="font-semibold">AC Public Lobby:</span>{' '}
              {server.lobbyStatus === 'unreachable' ? 'Unavailable (rejected as unreachable — likely no port forwarding)' : 'Unknown — the base server has no confirmed "registered" signal'}
            </p>
          </div>
          {server.lobbyStatus === 'unreachable' && (
            <p className="text-[11px] text-surface-500 mt-1">This only affects public matchmaking visibility. Friends can still connect directly, over LAN, or through the Mercy relay.</p>
          )}
        </Panel>
      )}
      {/* Real result of the SAME negotiation a friend's Join approval uses
          (never a separate, display-only guess) — distinct from both
          "Mercy Server" (is the local process/port genuinely up) and
          "AC Public Lobby" (does the official lobby accept it) above. */}
      {server.status === 'running' && (
        <Panel padding="sm">
          <div className="flex items-center gap-2">
            {connPlan === undefined ? (
              <><Loader2 size={13} className="animate-spin text-surface-500 shrink-0" /><p className="text-xs text-surface-400">Checking Mercy Connection…</p></>
            ) : connPlan && (connPlan.candidates.length > 0 || connPlan.relayAvailable) ? (
              <><CheckCircle2 size={13} className="text-emerald-400 shrink-0" /><p className="text-xs text-surface-300"><span className="font-semibold">Mercy Connection:</span> Ready — friends can join {connPlan.candidates[0]?.strategy === 'relay' ? 'through the Mercy relay' : 'directly'}, no port forwarding required.</p></>
            ) : (
              <><XCircle size={13} className="text-amber-400 shrink-0" /><p className="text-xs text-surface-300"><span className="font-semibold">Mercy Connection:</span> {connPlan?.unavailableExplanation || 'Not available yet.'}</p></>
            )}
          </div>
        </Panel>
      )}
      {server.pid && isRunning && (
        <Panel padding="sm" className="text-xs text-surface-500">Process ID: <span className="font-mono text-surface-300">{server.pid}</span></Panel>
      )}
      {server.lastError && (
        <Panel className="border-error/30">
          <p className="text-xs font-bold text-error mb-1">Last Error</p>
          <p className="text-xs text-surface-400">{server.lastError}</p>
        </Panel>
      )}
      <StartupDiagnosticsPanel serverId={server.id} />
    </div>
  );
}

// ── Real startup diagnostics (Part 4) — collapsed by default (advanced,
// not for normal players); every field reflects what was actually spawned/
// observed, never secrets. ───────────────────────────────────────────────
function StartupDiagnosticsPanel({ serverId }: { serverId: string }) {
  const [open, setOpen] = useState(false);
  const [diag, setDiag] = useState<AcStartupDiagnostics | null>(null);
  useEffect(() => {
    if (!open) return;
    window.electronAPI.assettoCorsa.startupDiagnostics(serverId).then(setDiag).catch(() => setDiag(null));
  }, [open, serverId]);

  return (
    <Panel padding="sm">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between text-xs font-semibold text-surface-400 uppercase tracking-wider">
        Startup Diagnostics <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        diag ? (
          <div className="mt-3 space-y-1 text-[11px] font-mono text-surface-300">
            <p>Executable: <span className="text-surface-400">{diag.executablePath}</span></p>
            <p>Working directory: <span className="text-surface-400">{diag.workingDirectory}</span></p>
            <p>Config: <span className="text-surface-400">{diag.configPath}</span></p>
            <p>Entry list: <span className="text-surface-400">{diag.entryListPath}</span></p>
            <p>Track: <span className="text-surface-400">{diag.track}{diag.trackLayout ? ` (${diag.trackLayout})` : ''}</span></p>
            <p>Cars: <span className="text-surface-400">{diag.cars.join(', ') || 'none'}</span></p>
            <p>Ports: <span className="text-surface-400">TCP {diag.tcpPort} · UDP {diag.udpPort} · HTTP {diag.httpPort}</span></p>
            <p>PID: <span className="text-surface-400">{diag.pid ?? 'not running'}</span></p>
            <p>Started: <span className="text-surface-400">{new Date(diag.startedAt).toLocaleString()}</span></p>
            {diag.exitedAt && (
              <>
                <p>Exited: <span className="text-surface-400">{new Date(diag.exitedAt).toLocaleString()}</span></p>
                <p>Exit code / signal: <span className="text-surface-400">{diag.exitCode ?? 'null'} / {diag.exitSignal ?? 'null'}</span></p>
              </>
            )}
            {diag.lastConsoleLines.length > 0 && (
              <div className="pt-2">
                <p className="text-surface-500 uppercase tracking-wider text-[10px] mb-1">Final console output</p>
                <div className="rounded-lg bg-black/40 p-2 space-y-0.5 max-h-40 overflow-y-auto">
                  {diag.lastConsoleLines.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-surface-500">No diagnostics available yet — this server hasn't been started this session.</p>
        )
      )}
    </Panel>
  );
}

// ── How to Join — real, truthful instructions reflecting exactly what the
// current implementation supports; never router port-forwarding, never a
// public-IP instruction, and never claims relay availability that wasn't
// actually confirmed by the same negotiation Join approval itself uses. ───
function HowToJoinTab({ server, onLaunchGame, launchingGame }: { server: AssettoCorsaServer; onLaunchGame: () => void; launchingGame: boolean }) {
  const [connPlan, setConnPlan] = useState<EndpointPlan | null | undefined>(undefined);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (server.status !== 'running') { setConnPlan(undefined); return; }
    let cancelled = false;
    window.electronAPI.connection?.negotiateAssettoCorsaEndpoint?.(server.id).then((plan) => { if (!cancelled) setConnPlan(plan); }).catch(() => { if (!cancelled) setConnPlan(null); });
    return () => { cancelled = true; };
  }, [server.id, server.status]);

  const connectionState: { label: string; tone: 'ok' | 'warn' | 'idle' } =
    server.status !== 'running' ? { label: 'Start the server to enable joining', tone: 'idle' }
    : connPlan === undefined ? { label: 'Checking Mercy connection…', tone: 'idle' }
    : connPlan && (connPlan.candidates.length > 0 || connPlan.relayAvailable) ? { label: 'Ready to connect — friends can join now', tone: 'ok' }
    : { label: connPlan?.unavailableExplanation ? `Mercy connection unavailable: ${connPlan.unavailableExplanation}` : 'Mercy connection unavailable', tone: 'warn' };

  const steps = [
    'Start the Assetto Corsa server (above).',
    'Launch Assetto Corsa or Content Manager — use the "Launch Game" button.',
    'Your friend finds this server through their own Mercy Launcher (Friends & Presence).',
    'Your friend clicks Join.',
    'Accept the request in Mercy if approval is required.',
    'Mercy establishes the connection automatically — no router port forwarding needed.',
  ];

  return (
    <div className="space-y-4">
      <Panel padding="sm" className={connectionState.tone === 'ok' ? 'border-emerald-500/30' : connectionState.tone === 'warn' ? 'border-amber-500/30' : ''}>
        <div className="flex items-center gap-2">
          {connectionState.tone === 'ok' ? <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
            : connectionState.tone === 'warn' ? <XCircle size={14} className="text-amber-400 shrink-0" />
            : <Info size={14} className="text-surface-500 shrink-0" />}
          <p className="text-sm text-surface-200 font-semibold">{connectionState.label}</p>
        </div>
      </Panel>

      <Panel>
        <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">How to Join</p>
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm text-surface-300">
              <span className="w-5 h-5 rounded-full bg-overlay-6 text-surface-400 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        {server.status === 'running' && (
          <button onClick={onLaunchGame} disabled={launchingGame} className="btn-primary text-xs py-2 px-4 mt-4 flex items-center gap-1.5">
            {launchingGame ? <Loader2 size={13} className="animate-spin" /> : <Gamepad2 size={13} />} Launch Game
          </button>
        )}
      </Panel>

      <Panel padding="sm">
        <button onClick={() => setShowAdvanced((v) => !v)} className="w-full flex items-center justify-between text-xs font-semibold text-surface-500">
          Advanced (networking details) <ChevronDown size={13} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
        </button>
        {showAdvanced && (
          <div className="mt-3 space-y-1 text-[11px] font-mono text-surface-400">
            <p>Mercy Server: {server.status}</p>
            <p>AC Public Lobby: {server.lobbyStatus === 'unreachable' ? 'Unavailable (rejected as unreachable)' : 'Unknown'}</p>
            <p>Mercy Connection candidates: {connPlan?.candidates.length ?? 0}</p>
            {connPlan?.candidates.map((c, i) => <p key={i}>&nbsp;&nbsp;- {c.strategy}: {c.address}</p>)}
            {connPlan?.unavailableExplanation && <p>Reason unavailable: {connPlan.unavailableExplanation}</p>}
          </div>
        )}
      </Panel>
    </div>
  );
}

// ── Console — real, read-only stdout/stderr tail. No command input: the
// real dedicated server has no documented interactive stdin protocol (see
// AssettoCorsaManager.ts's own header comment) — pretending otherwise would
// be a fake capability. ───────────────────────────────────────────────────
function ConsoleTab({ server }: { server: AssettoCorsaServer }) {
  const [lines, setLines] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.electronAPI.assettoCorsa.consoleBuffer(server.id).then(setLines).catch(() => {});
    const cleanup = window.electronAPI.onAssettoCorsaConsole((data) => {
      if (data.serverId !== server.id) return;
      setLines((prev) => [...prev.slice(-1999), data.line]);
    });
    return cleanup;
  }, [server.id]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, autoScroll]);

  const filtered = search ? lines.filter((l) => l.toLowerCase().includes(search.toLowerCase())) : lines;
  const copyLogs = () => { navigator.clipboard.writeText(lines.join('\n')); toast.success('Copied console output'); };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 p-3 rounded-xl bg-overlay-4 border border-overlay-8 text-xs text-surface-400">
        <Info size={14} className="shrink-0 mt-0.5" /> This is a real, read-only view of the server process's own output. The Assetto Corsa dedicated server has no documented interactive console commands, so there's no command box here — Mercy doesn't fake one.
      </div>
      <div className="flex items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search console output…" className="input-field flex-1 text-xs py-2" />
        <button onClick={() => setAutoScroll((v) => !v)} className={`btn-secondary text-xs py-2 px-3 ${autoScroll ? 'text-primary-300' : ''}`}>Auto-scroll</button>
        <button onClick={copyLogs} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><Copy size={12} /> Copy</button>
        <button onClick={() => setLines([])} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"><Trash size={12} /> Clear</button>
      </div>
      <div ref={scrollRef} className="h-[420px] overflow-y-auto rounded-xl border border-overlay-6 bg-black/40 p-3 font-mono text-xs text-surface-300 space-y-0.5">
        {filtered.length === 0 ? (
          <p className="text-surface-600">No console output yet.</p>
        ) : filtered.map((line, i) => <div key={i} className={line.startsWith('[ERROR]') ? 'text-error' : line.startsWith('[Mercy]') ? 'text-primary-300' : ''}>{line}</div>)}
      </div>
    </div>
  );
}

// ── Players — honest: the base dedicated server exposes no stable, parseable
// real-time player-join/leave protocol over stdout the way Minecraft's
// console does, so this is deliberately NOT faked with invented names/counts. ─
function PlayersTab() {
  return (
    <Panel>
      <EmptyState
        icon={Users}
        title="Live player list isn't available yet"
        description="The base Assetto Corsa dedicated server doesn't expose a stable, parseable real-time player list over its console output the way Minecraft does. Rather than guess or fake player names, Mercy doesn't show one here — this is a real extension point for a future UDP plugin/query-based player list."
      />
    </Panel>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────
function SettingsTab({ server, onChange }: { server: AssettoCorsaServer; onChange: () => void }) {
  const [maxClients, setMaxClients] = useState(server.maxClients);
  const [password, setPassword] = useState(server.password);
  const [adminPassword, setAdminPassword] = useState(server.adminPassword);
  const [registerToLobby, setRegisterToLobby] = useState(server.registerToLobby);
  const [damageMultiplier, setDamageMultiplier] = useState(server.damageMultiplier);
  const [fuelRate, setFuelRate] = useState(server.fuelRate);
  const [tyreWearRate, setTyreWearRate] = useState(server.tyreWearRate);
  const [sunAngle, setSunAngle] = useState(server.sunAngle);
  const [saving, setSaving] = useState(false);
  const isRunning = server.status !== 'stopped';

  const save = async () => {
    setSaving(true);
    try {
      const result = await window.electronAPI.assettoCorsa.update(server.id, { maxClients, password, adminPassword, registerToLobby, damageMultiplier, fuelRate, tyreWearRate, sunAngle });
      if (result.success) { toast.success('Settings saved'); onChange(); } else toast.error(result.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      {isRunning && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-overlay-4 border border-overlay-8 text-xs text-surface-400">
          <AlertTriangle size={14} className="shrink-0" /> Stop the server before changing its configuration.
        </div>
      )}
      <Panel>
        <div className="grid grid-cols-2 gap-4">
          <div><label className="text-[11px] text-surface-500 mb-1 block">Max Clients</label><input type="number" min={1} max={128} value={maxClients} onChange={(e) => setMaxClients(parseInt(e.target.value) || 1)} disabled={isRunning} className="input-field disabled:opacity-50" /></div>
          <div className="flex items-center justify-between pt-4"><span className="text-xs text-surface-300">Register to Lobby</span><Toggle checked={registerToLobby} onChange={setRegisterToLobby} /></div>
          <div><label className="text-[11px] text-surface-500 mb-1 block">Password</label><input value={password} onChange={(e) => setPassword(e.target.value)} disabled={isRunning} className="input-field disabled:opacity-50" /></div>
          <div><label className="text-[11px] text-surface-500 mb-1 block">Admin Password</label><input value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} disabled={isRunning} className="input-field disabled:opacity-50" /></div>
        </div>
      </Panel>
      <Panel>
        <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Rules</p>
        <div className="grid grid-cols-3 gap-4">
          <div><label className="text-[11px] text-surface-500 mb-1 block">Damage %</label><input type="number" min={0} value={damageMultiplier} onChange={(e) => setDamageMultiplier(parseInt(e.target.value) || 0)} disabled={isRunning} className="input-field disabled:opacity-50" /></div>
          <div><label className="text-[11px] text-surface-500 mb-1 block">Fuel Rate %</label><input type="number" min={0} value={fuelRate} onChange={(e) => setFuelRate(parseInt(e.target.value) || 0)} disabled={isRunning} className="input-field disabled:opacity-50" /></div>
          <div><label className="text-[11px] text-surface-500 mb-1 block">Tyre Wear %</label><input type="number" min={0} value={tyreWearRate} onChange={(e) => setTyreWearRate(parseInt(e.target.value) || 0)} disabled={isRunning} className="input-field disabled:opacity-50" /></div>
        </div>
      </Panel>
      <Panel>
        <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-3">Time of Day</p>
        <div><label className="text-[11px] text-surface-500 mb-1 block">Sun Angle</label><input type="number" min={0} max={360} value={sunAngle} onChange={(e) => setSunAngle(parseInt(e.target.value) || 0)} disabled={isRunning} className="input-field disabled:opacity-50" /></div>
      </Panel>
      <button onClick={save} disabled={saving || isRunning} className="btn-primary py-2.5 px-6 flex items-center gap-2 disabled:opacity-40">
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save Settings
      </button>
    </div>
  );
}

// ── Content — this server's assigned track/cars (read display; changing
// them happens via Settings/re-create to keep this foundation simple). ────
function ContentTab({ server, onChange }: { server: AssettoCorsaServer; onChange: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="space-y-4">
      <Panel padding="sm" className="flex items-center justify-between gap-3">
        <p className="text-xs text-surface-400">Looking to install more cars or tracks? Use the Content Library.</p>
        <button onClick={() => navigate('/assetto-corsa/content')} className="btn-secondary text-xs py-1.5 px-3 shrink-0">Open Content Library</button>
      </Panel>
      <Panel>
        <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-2">Track</p>
        <p className="text-sm text-surface-200">{server.track || 'Not set'}{server.trackLayout ? ` — ${server.trackLayout}` : ''}</p>
      </Panel>
      <Panel>
        <p className="text-xs font-bold text-surface-400 uppercase tracking-wider mb-2">Cars ({server.cars.length})</p>
        {server.cars.length === 0 ? (
          <p className="text-xs text-surface-500">No cars assigned.</p>
        ) : (
          <div className="space-y-1.5">
            {server.cars.map((c) => (
              <div key={c.model} className="flex items-center gap-2 text-sm text-surface-200">
                <FlagTriangleRight size={12} className="text-surface-500 shrink-0" /> {c.model} {c.skin && <span className="text-surface-500">({c.skin})</span>}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

// ── Backups ───────────────────────────────────────────────────────────────
function BackupsTab({ server }: { server: AssettoCorsaServer }) {
  const [backups, setBackups] = useState<{ id: string; serverId: string; name: string; path: string; size: number; createdAt: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = () => window.electronAPI.assettoCorsa.listBackups(server.id).then(setBackups).finally(() => setLoading(false));
  useEffect(() => { load(); }, [server.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setCreating(true);
    const result = await window.electronAPI.assettoCorsa.createBackup(server.id);
    setCreating(false);
    if (result.success) { toast.success('Backup created'); load(); } else toast.error(result.error || 'Backup failed');
  };
  const restore = async (id: string) => {
    const result = await window.electronAPI.assettoCorsa.restoreBackup(id);
    if (result.success) toast.success('Backup restored'); else toast.error(result.error || 'Restore failed');
  };
  const del = async (id: string) => { await window.electronAPI.assettoCorsa.deleteBackup(id); load(); };
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
        <Panel><EmptyState icon={Archive} title="No backups yet" description="Create a backup before making risky changes to this server's configuration." /></Panel>
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

// ── Files ─────────────────────────────────────────────────────────────────
function FilesTab({ server }: { server: AssettoCorsaServer }) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<{ name: string; path: string; type: 'file' | 'directory'; size: number }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  const load = (p: string) => {
    setLoading(true);
    window.electronAPI.assettoCorsa.listFiles(server.id, p).then((e) => setEntries(e || [])).finally(() => setLoading(false));
  };
  useEffect(() => { load(path); }, [server.id, path]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFile = async (relPath: string) => {
    const c = await window.electronAPI.assettoCorsa.readFile(server.id, relPath);
    if (c === null) { toast.error('Could not open this file (it may be binary).'); return; }
    setEditing(relPath); setContent(c);
  };
  const saveFile = async () => {
    if (!editing) return;
    const ok = await window.electronAPI.assettoCorsa.writeFile(server.id, editing, content);
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

// ── Danger Zone ───────────────────────────────────────────────────────────
function DangerZoneTab({ server }: { server: AssettoCorsaServer }) {
  const navigate = useNavigate();
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const canDelete = confirmText.trim() === server.name && !deleting;

  const doDelete = async () => {
    if (!canDelete) return;
    setDeleting(true);
    try {
      const result = await window.electronAPI.assettoCorsa.delete(server.id, true);
      if (result.success) {
        toast.success(`"${server.name}" was deleted`);
        navigate('/assetto-corsa');
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
              <li>Remove all server files (cfg/, the server executable, and any presets stored here)</li>
              <li>Remove the server from Mercy Launcher</li>
            </ul>
            <p className="text-xs text-surface-500 mt-2">Backups are kept by default — they're stored separately and won't be touched.</p>
          </div>
        </div>
      </Panel>

      <Panel>
        <label className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2 block">Type "{server.name}" to confirm</label>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className="input-field" placeholder={server.name} />
        <button onClick={doDelete} disabled={!canDelete} className="w-full mt-4 py-2.5 rounded-xl text-sm font-bold bg-error text-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2">
          {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} {deleting ? 'Deleting…' : 'Delete Server Permanently'}
        </button>
      </Panel>
    </div>
  );
}
